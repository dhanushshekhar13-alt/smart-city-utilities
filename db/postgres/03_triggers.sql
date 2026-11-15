-- =====================================================================
-- Triggers: rules PostgreSQL enforces on every write, whoever makes it.
-- Functions that write to other tables are SECURITY DEFINER so a
-- resident's statement can, for example, mark their own invoice PAID
-- without the resident role having UPDATE rights on invoice.
-- =====================================================================

-- ---------- tickets ----------
-- SLA deadline from the severity when a ticket is created
CREATE FUNCTION trg_ticket_sla() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.sla_due_at := NEW.reported_timestamp + make_interval(hours => fn_sla_hours(NEW.severity));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ticket_sla BEFORE INSERT ON maintenance_ticket
  FOR EACH ROW EXECUTE FUNCTION trg_ticket_sla();

-- the ticket state machine:
--   OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED, and RESOLVED → IN_PROGRESS to reopen
CREATE FUNCTION trg_ticket_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed TEXT[] := CASE OLD.status
    WHEN 'OPEN'        THEN ARRAY['ASSIGNED']
    WHEN 'ASSIGNED'    THEN ARRAY['IN_PROGRESS']
    WHEN 'IN_PROGRESS' THEN ARRAY['RESOLVED']
    WHEN 'RESOLVED'    THEN ARRAY['CLOSED', 'IN_PROGRESS']
    ELSE ARRAY[]::TEXT[] END;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT NEW.status = ANY (allowed) THEN
      RAISE EXCEPTION 'ILLEGAL_TRANSITION: % -> % is not allowed', OLD.status, NEW.status
        USING HINT = 'Allowed next states: ' || COALESCE(array_to_string(allowed, ', '), 'none');
    END IF;
    IF NEW.status = 'ASSIGNED' AND NEW.assigned_to IS NULL THEN
      RAISE EXCEPTION 'ASSIGNEE_REQUIRED: a ticket must have assigned_to before ASSIGNED';
    END IF;
    IF NEW.status = 'RESOLVED' THEN
      NEW.resolved_at := fn_city_now();
    ELSIF NEW.status = 'IN_PROGRESS' AND OLD.status = 'RESOLVED' THEN   -- reopened
      NEW.resolved_at := NULL; NEW.resolution_notes := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ticket_transition BEFORE UPDATE OF status ON maintenance_ticket
  FOR EACH ROW EXECUTE FUNCTION trg_ticket_transition();

-- one history row for every status change, with who made it
CREATE FUNCTION trg_ticket_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, changed_at)
    VALUES (NEW.ticket_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status, app_uid(), fn_city_now());
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_ticket_history AFTER INSERT OR UPDATE OF status ON maintenance_ticket
  FOR EACH ROW EXECUTE FUNCTION trg_ticket_history();

-- when the last active ticket of a property is resolved, the property is back to NORMAL
CREATE FUNCTION trg_ticket_property_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('RESOLVED', 'CLOSED') AND NOT EXISTS (
       SELECT 1 FROM maintenance_ticket t
       WHERE t.property_id = NEW.property_id AND t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')) THEN
    UPDATE property SET service_status = 'NORMAL'
    WHERE property_id = NEW.property_id AND service_status = 'UNDER_INVESTIGATION';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_ticket_property_status AFTER UPDATE OF status ON maintenance_ticket
  FOR EACH ROW EXECUTE FUNCTION trg_ticket_property_status();

-- ---------- billing ----------
-- a meter reading that has been billed can no longer change
CREATE FUNCTION trg_reading_locked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT um.meter_code INTO v_code
  FROM utility_meter um JOIN invoice i ON i.property_id = um.property_id AND i.cycle_id = OLD.cycle_id
  WHERE um.meter_id = OLD.meter_id;
  IF FOUND THEN
    RAISE EXCEPTION 'READING_LOCKED: meter % is already invoiced for cycle %', v_code, OLD.cycle_id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_reading_locked BEFORE UPDATE OR DELETE ON meter_reading
  FOR EACH ROW EXECUTE FUNCTION trg_reading_locked();

-- a paid invoice is frozen: its lines cannot be added, changed or removed
CREATE FUNCTION trg_invoice_locked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v RECORD;
BEGIN
  SELECT invoice_no, payment_status INTO v FROM invoice
  WHERE invoice_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF v.payment_status = 'PAID' THEN
    RAISE EXCEPTION 'INVOICE_LOCKED: invoice % is paid and cannot change', v.invoice_no;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_invoice_locked BEFORE INSERT OR UPDATE OR DELETE ON invoice_line_item
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_locked();

-- invoice.total_amount always equals the sum of its lines
CREATE FUNCTION trg_invoice_total() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
BEGIN
  UPDATE invoice SET total_amount = (SELECT COALESCE(SUM(line_total), 0) FROM invoice_line_item WHERE invoice_id = v_id)
  WHERE invoice_id = v_id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_invoice_total AFTER INSERT OR UPDATE OR DELETE ON invoice_line_item
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_total();

-- a successful payment settles its invoice
CREATE FUNCTION trg_payment_settles_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'SUCCEEDED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'SUCCEEDED') THEN
    UPDATE invoice SET payment_status = 'PAID', paid_at = NEW.payment_date WHERE invoice_id = NEW.invoice_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_payment_settles_invoice AFTER INSERT OR UPDATE OF status ON payment
  FOR EACH ROW EXECUTE FUNCTION trg_payment_settles_invoice();

-- ---------- audit trail ----------
-- Records every change with who made it (app user), which database role ran it,
-- the city time, and the row before and after. Secrets are never copied.
CREATE FUNCTION trg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o JSONB := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'password_hash' - 'token_hash' END;
  n JSONB := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'password_hash' - 'token_hash' END;
  k TEXT := TG_ARGV[0];
  diff TEXT[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO diff
    FROM jsonb_each(n) WHERE n -> key IS DISTINCT FROM o -> key;
    IF diff IS NULL THEN
      -- only a secret column changed (e.g. a new password hash): record that it changed, not its value
      IF to_jsonb(NEW) IS NOT DISTINCT FROM to_jsonb(OLD) THEN RETURN NULL; END IF;
      diff := ARRAY['password_hash'];
    END IF;
    IF diff <@ ARRAY['last_seen_at', 'version', 'city_now'] THEN RETURN NULL; END IF;   -- heartbeat columns are not history
  END IF;
  INSERT INTO audit_log (city_at, actor_id, actor, db_role, table_name, operation, row_key, changed, old_row, new_row)
  VALUES (fn_city_now(), app_uid(), app_actor(), session_user || CASE WHEN current_setting('role') <> 'none' THEN ' as ' || current_setting('role') ELSE '' END,
          TG_TABLE_NAME, TG_OP, COALESCE(n, o) ->> k, diff, o, n);
  RETURN NULL;
END $$;

-- which tables are audited, and which column identifies a row in the log
CREATE TRIGGER audit_resident      AFTER INSERT OR UPDATE OR DELETE ON resident           FOR EACH ROW EXECUTE FUNCTION trg_audit('citizen_ref');
CREATE TRIGGER audit_property      AFTER INSERT OR UPDATE OR DELETE ON property           FOR EACH ROW EXECUTE FUNCTION trg_audit('property_code');
CREATE TRIGGER audit_meter         AFTER INSERT OR UPDATE OR DELETE ON utility_meter      FOR EACH ROW EXECUTE FUNCTION trg_audit('meter_code');
CREATE TRIGGER audit_cycle         AFTER INSERT OR UPDATE OR DELETE ON billing_cycle      FOR EACH ROW EXECUTE FUNCTION trg_audit('cycle_id');
CREATE TRIGGER audit_rate          AFTER INSERT OR UPDATE OR DELETE ON utility_rate       FOR EACH ROW EXECUTE FUNCTION trg_audit('rate_id');
CREATE TRIGGER audit_reading       AFTER INSERT OR UPDATE OR DELETE ON meter_reading      FOR EACH ROW EXECUTE FUNCTION trg_audit('reading_id');
CREATE TRIGGER audit_invoice       AFTER INSERT OR UPDATE OR DELETE ON invoice            FOR EACH ROW EXECUTE FUNCTION trg_audit('invoice_no');
CREATE TRIGGER audit_line_item     AFTER INSERT OR UPDATE OR DELETE ON invoice_line_item  FOR EACH ROW EXECUTE FUNCTION trg_audit('line_item_id');
CREATE TRIGGER audit_payment       AFTER INSERT OR UPDATE OR DELETE ON payment            FOR EACH ROW EXECUTE FUNCTION trg_audit('idempotency_key');
CREATE TRIGGER audit_ticket        AFTER INSERT OR UPDATE OR DELETE ON maintenance_ticket FOR EACH ROW EXECUTE FUNCTION trg_audit('ticket_no');
CREATE TRIGGER audit_app_user      AFTER INSERT OR UPDATE OR DELETE ON app_user           FOR EACH ROW EXECUTE FUNCTION trg_audit('email');
CREATE TRIGGER audit_user_session  AFTER INSERT OR UPDATE OR DELETE ON user_session       FOR EACH ROW EXECUTE FUNCTION trg_audit('session_id');
CREATE TRIGGER audit_sim_clock     AFTER UPDATE OF running, policies, faults, offline, grid_kw ON sim_clock FOR EACH ROW EXECUTE FUNCTION trg_audit('id');
