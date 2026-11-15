-- =====================================================================
-- Functions and stored procedures: the business rules live here, so
-- every client (API, psql, a future mobile app) gets the same result.
-- =====================================================================

-- ---------- context of the current request ----------
-- The API runs each request in a transaction with:
--   SET LOCAL ROLE resident_role | staff_role | admin_role;
--   SELECT set_config('app.user_id', <uuid>, true), set_config('app.actor', <name>, true);
CREATE FUNCTION fn_city_now() RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$ SELECT city_now FROM sim_clock WHERE id = 1 $$;

CREATE FUNCTION app_uid() RETURNS UUID
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_actor() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('app.actor', true), ''), 'system') $$;

-- SECURITY DEFINER: these read app_user and zone with the owner's rights,
-- so the row-level security policies that call them do not call themselves.
CREATE FUNCTION app_resident_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT resident_id FROM app_user WHERE user_id = app_uid() AND is_active
$$;

-- all zones under a zone, the zone included (recursive CTE)
CREATE FUNCTION fn_zone_subtree(p_zone INT) RETURNS SETOF INT
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE subtree AS (
    SELECT zone_id FROM zone WHERE zone_id = p_zone
    UNION ALL
    SELECT z.zone_id FROM zone z JOIN subtree s ON z.parent_zone_id = s.zone_id
  )
  SELECT zone_id FROM subtree
$$;

-- the district a ward belongs to (a district is its own district)
CREATE FUNCTION fn_district_of(p_zone INT) RETURNS INT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN zone_level = 'WARD' THEN parent_zone_id ELSE zone_id END FROM zone WHERE zone_id = p_zone
$$;

-- properties the signed-in user may see: own (resident), district (staff), all (admin)
CREATE FUNCTION app_property_ids() RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.property_id
  FROM property p, app_user u
  WHERE u.user_id = app_uid() AND u.is_active
    AND (u.role = 'ADMIN'
      OR (u.role = 'RESIDENT' AND p.resident_id = u.resident_id)
      OR (u.role = 'STAFF' AND p.zone_id IN (SELECT fn_zone_subtree(u.staff_zone_id))))
$$;

-- ---------- tariff slabs ----------
-- Splits a month's units over the slabs valid on p_as_of. Amounts are in paise.
CREATE FUNCTION fn_tiered_charge(p_utility TEXT, p_units NUMERIC, p_as_of DATE)
RETURNS TABLE (rate_id INT, tier_level INT, units NUMERIC, price NUMERIC, amount BIGINT)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE
  s RECORD; in_tier NUMERIC; found_any BOOLEAN := FALSE;
BEGIN
  FOR s IN
    SELECT r.rate_id, r.tier_level, r.min_units, r.max_units, r.price_per_unit
    FROM utility_rate r
    WHERE r.utility_type = p_utility
      AND r.effective_start_date <= p_as_of
      AND (r.effective_end_date IS NULL OR p_as_of < r.effective_end_date)
    ORDER BY r.tier_level
  LOOP
    found_any := TRUE;
    in_tier := LEAST(p_units, COALESCE(s.max_units, p_units)) - s.min_units;
    CONTINUE WHEN in_tier <= 0;
    rate_id := s.rate_id; tier_level := s.tier_level;
    units := round(in_tier, 3); price := s.price_per_unit;
    amount := round(units * price * 100)::bigint;
    RETURN NEXT;
  END LOOP;
  IF NOT found_any THEN
    RAISE EXCEPTION 'NO_TARIFF: no % tariff valid on %', p_utility, p_as_of USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ---------- invoice for one property and one cycle ----------
-- Idempotent: calling it twice returns the existing invoice.
CREATE PROCEDURE sp_generate_invoice(p_property UUID, p_cycle INT, INOUT p_invoice UUID DEFAULT NULL, INOUT p_created BOOLEAN DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  c billing_cycle; m RECORD; t RECORD; v_no TEXT; v_missing TEXT;
BEGIN
  -- two runs for the same property and cycle wait for each other instead of racing
  PERFORM pg_advisory_xact_lock(hashtext(p_property::text), p_cycle);

  SELECT invoice_id INTO p_invoice FROM invoice WHERE property_id = p_property AND cycle_id = p_cycle;
  IF FOUND THEN p_created := FALSE; RETURN; END IF;

  SELECT * INTO c FROM billing_cycle WHERE cycle_id = p_cycle;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_CYCLE: billing cycle % does not exist', p_cycle; END IF;

  SELECT string_agg(um.meter_code, ', ') INTO v_missing
  FROM utility_meter um
  WHERE um.property_id = p_property AND um.is_active
    AND NOT EXISTS (SELECT 1 FROM meter_reading r WHERE r.meter_id = um.meter_id AND r.cycle_id = p_cycle);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'MISSING_READING: no meter_reading for % in cycle %', v_missing, p_cycle;
  END IF;

  v_no := format('INV-%s-%s-%s', c.year, lpad(c.month::text, 2, '0'), lpad(nextval('invoice_no_seq')::text, 4, '0'));
  INSERT INTO invoice (invoice_no, property_id, cycle_id, invoice_date)
  VALUES (v_no, p_property, p_cycle, c.cycle_end_date)
  RETURNING invoice_id INTO p_invoice;

  FOR m IN
    SELECT um.utility_type, r.total_units_consumed
    FROM utility_meter um JOIN meter_reading r ON r.meter_id = um.meter_id AND r.cycle_id = p_cycle
    WHERE um.property_id = p_property AND um.is_active
    ORDER BY um.utility_type
  LOOP
    FOR t IN SELECT * FROM fn_tiered_charge(m.utility_type, m.total_units_consumed, c.cycle_end_date) LOOP
      INSERT INTO invoice_line_item (invoice_id, utility_type, line_kind, rate_id, tier_level, units_consumed, rate_applied, line_total)
      VALUES (p_invoice, m.utility_type, 'USAGE', t.rate_id, t.tier_level, t.units, t.price, t.amount);
    END LOOP;
  END LOOP;
  p_created := TRUE;
END $$;

-- ---------- payment (simulated gateway) ----------
-- The same idempotency key always returns the first result; a paid bill cannot be paid again.
CREATE PROCEDURE sp_record_payment(p_invoice UUID, p_method TEXT, p_key TEXT, p_outcome TEXT,
                                   INOUT p_payment UUID DEFAULT NULL, INOUT p_status TEXT DEFAULT NULL, INOUT p_repeat BOOLEAN DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT payment_id, status INTO p_payment, p_status FROM payment WHERE idempotency_key = p_key;
  IF FOUND THEN p_repeat := TRUE; RETURN; END IF;
  p_repeat := FALSE;

  -- two payments for the same bill queue up instead of racing
  PERFORM pg_advisory_xact_lock(hashtext(p_invoice::text));
  -- row-level security applies here: a resident cannot even find someone else's invoice
  SELECT invoice_id, invoice_no, total_amount, payment_status INTO inv FROM invoice WHERE invoice_id = p_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND: no such invoice' USING ERRCODE = 'P0002'; END IF;
  IF inv.payment_status = 'PAID' THEN RAISE EXCEPTION 'ALREADY_PAID: invoice % is already paid', inv.invoice_no; END IF;

  INSERT INTO payment (invoice_id, idempotency_key, amount_paid, payment_method, status, payment_date)
  VALUES (p_invoice, p_key, inv.total_amount, p_method, 'INITIATED', fn_city_now())
  RETURNING payment_id INTO p_payment;

  IF p_outcome = 'FAIL' THEN
    UPDATE payment SET status = 'FAILED', failure_reason = 'Declined by simulated gateway' WHERE payment_id = p_payment;
    p_status := 'FAILED';
  ELSE
    UPDATE payment SET status = 'SUCCEEDED', transaction_id = 'SIMTXN-' || nextval('txn_no_seq') WHERE payment_id = p_payment;
    p_status := 'SUCCEEDED';   -- trigger trg_payment_settles_invoice marks the invoice PAID
  END IF;
END $$;

-- ---------- nightly job: overdue bills and late fees ----------
-- Unpaid bills past their due date become OVERDUE and get one LATE_FEE line per utility.
CREATE FUNCTION fn_mark_overdue(p_today DATE)
RETURNS TABLE (invoice_id UUID, invoice_no TEXT, property_id UUID, fee BIGINT, newly_overdue BOOLEAN)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  r RECORD; v_fee BIGINT;
BEGIN
  FOR r IN
    SELECT i.invoice_id, i.invoice_no, i.property_id, i.payment_status, bc.late_penalty_percent
    FROM invoice i JOIN billing_cycle bc USING (cycle_id)
    WHERE i.payment_status IN ('PENDING', 'OVERDUE') AND bc.due_date < p_today
    ORDER BY i.invoice_no
  LOOP
    IF r.payment_status = 'PENDING' THEN
      UPDATE invoice SET payment_status = 'OVERDUE' WHERE invoice.invoice_id = r.invoice_id;
    END IF;
    v_fee := 0;
    IF NOT EXISTS (SELECT 1 FROM invoice_line_item f WHERE f.invoice_id = r.invoice_id AND f.line_kind = 'LATE_FEE') THEN
      WITH fees AS (
        INSERT INTO invoice_line_item (invoice_id, utility_type, line_kind, units_consumed, rate_applied, line_total)
        SELECT r.invoice_id, li.utility_type, 'LATE_FEE', 0, r.late_penalty_percent,
               round(SUM(li.line_total) * r.late_penalty_percent / 100)::bigint
        FROM invoice_line_item li
        WHERE li.invoice_id = r.invoice_id AND li.line_kind = 'USAGE'
        GROUP BY li.utility_type
        RETURNING line_total)
      SELECT COALESCE(SUM(line_total), 0) INTO v_fee FROM fees;
    END IF;
    IF r.payment_status = 'PENDING' OR v_fee > 0 THEN
      invoice_id := r.invoice_id; invoice_no := r.invoice_no; property_id := r.property_id;
      fee := v_fee; newly_overdue := (r.payment_status = 'PENDING');
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- ---------- tickets ----------
CREATE FUNCTION fn_sla_hours(p_severity TEXT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 8 WHEN 'MEDIUM' THEN 24 ELSE 72 END
$$;

-- Opens a ticket for an anomaly, or touches the active one: never a duplicate.
CREATE FUNCTION fn_open_anomaly_ticket(p_meter_code TEXT, p_key TEXT, p_issue TEXT, p_severity TEXT, p_reason TEXT)
RETURNS TABLE (ticket_id UUID, ticket_no TEXT, created BOOLEAN, occurrence_count INT)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  m RECORD; v_now TIMESTAMPTZ := fn_city_now();
BEGIN
  SELECT um.meter_id, um.property_id INTO m FROM utility_meter um WHERE um.meter_code = p_meter_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'NO_METER: meter % does not exist', p_meter_code; END IF;
  -- the usual case: the anomaly is still going on, so its active ticket is touched
  RETURN QUERY
  UPDATE maintenance_ticket t SET last_seen_at = v_now, occurrence_count = t.occurrence_count + 1, description = p_reason
  WHERE t.anomaly_key = p_key AND t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')
  RETURNING t.ticket_id, t.ticket_no, FALSE, t.occurrence_count;
  IF FOUND THEN RETURN; END IF;
  -- a new anomaly; ON CONFLICT still protects against two detectors inserting at the same moment
  RETURN QUERY
  INSERT INTO maintenance_ticket AS t (property_id, meter_id, source, anomaly_key, issue_type, severity, description, reported_timestamp, last_seen_at)
  VALUES (m.property_id, m.meter_id, 'ANOMALY', p_key, p_issue, p_severity, p_reason, v_now, v_now)
  ON CONFLICT (anomaly_key) WHERE status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')
  DO UPDATE SET last_seen_at = v_now, occurrence_count = t.occurrence_count + 1, description = EXCLUDED.description
  RETURNING t.ticket_id, t.ticket_no, (xmax = 0), t.occurrence_count;   -- xmax = 0 only for a fresh insert
  UPDATE property SET service_status = 'UNDER_INVESTIGATION'
  WHERE property_id = m.property_id AND service_status = 'NORMAL';
END $$;

-- Smart dispatch: engineer whose zone contains the property, fewest open jobs, then by email.
CREATE FUNCTION fn_auto_assign(p_ticket UUID)
RETURNS TABLE (user_id UUID, display_name TEXT, open_jobs BIGINT)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_zone INT;
BEGIN
  SELECT p.zone_id INTO v_zone FROM maintenance_ticket t JOIN property p USING (property_id)
  WHERE t.ticket_id = p_ticket AND t.status = 'OPEN';
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  WITH RECURSIVE up AS (                          -- the ward, its district, the city
    SELECT z.zone_id, z.parent_zone_id FROM zone z WHERE z.zone_id = v_zone
    UNION ALL
    SELECT z.zone_id, z.parent_zone_id FROM zone z JOIN up ON z.zone_id = up.parent_zone_id
  ), pick AS (
    SELECT u.user_id, u.display_name, COUNT(t.ticket_id) AS open_jobs
    FROM app_user u
    LEFT JOIN maintenance_ticket t ON t.assigned_to = u.user_id AND t.status IN ('ASSIGNED', 'IN_PROGRESS')
    WHERE u.role = 'STAFF' AND u.is_active AND u.staff_zone_id IN (SELECT zone_id FROM up)
    GROUP BY u.user_id, u.display_name, u.email
    ORDER BY open_jobs, u.email
    LIMIT 1
  )
  SELECT * FROM pick;
END $$;

-- SLA watch: tickets still active after their deadline are escalated once.
CREATE FUNCTION fn_escalate_overdue_tickets()
RETURNS TABLE (ticket_id UUID, ticket_no TEXT, severity TEXT)
LANGUAGE sql AS $$
  UPDATE maintenance_ticket t SET escalated_at = fn_city_now()
  WHERE t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS') AND t.sla_due_at < fn_city_now() AND t.escalated_at IS NULL
  RETURNING t.ticket_id, t.ticket_no, t.severity
$$;

-- Usage of similar properties for the eco comparison: same type in the same district, or the whole city
-- when the district has fewer than 3. Only numbers come back, never whose they are, so a resident can
-- compare without row-level security letting them read anyone else's meter_reading rows.
CREATE FUNCTION fn_peer_usage(p_property UUID, p_cycle INT)
RETURNS TABLE (peer_scope TEXT, peer INT, is_self BOOLEAN, utility_type TEXT, units NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT p.property_id, p.property_type, fn_district_of(p.zone_id) AS district
    FROM property p
    WHERE p.property_id = p_property
      AND (app_uid() IS NULL OR p.property_id IN (SELECT app_property_ids()))   -- the caller must be allowed to see this property
  ), grp AS (
    SELECT CASE WHEN COUNT(*) >= 3 THEN 'DISTRICT' ELSE 'CITY' END AS peer_scope
    FROM property q, me WHERE q.property_type = me.property_type AND fn_district_of(q.zone_id) = me.district
  )
  SELECT grp.peer_scope, dense_rank() OVER (ORDER BY q.property_id)::int, q.property_id = p_property, um.utility_type, mr.total_units_consumed
  FROM me CROSS JOIN grp
  JOIN property q ON q.property_type = me.property_type AND (grp.peer_scope = 'CITY' OR fn_district_of(q.zone_id) = me.district)
  JOIN utility_meter um ON um.property_id = q.property_id
  JOIN meter_reading mr ON mr.meter_id = um.meter_id AND mr.cycle_id = p_cycle
$$;

-- ---------- reporting views ----------
-- Names of staff for "assigned to" columns. A view runs with its owner's rights,
-- so residents can see who is fixing their ticket without reading app_user.
CREATE VIEW staff_directory AS
  SELECT user_id, display_name, role, staff_zone_id FROM app_user WHERE role IN ('STAFF', 'ADMIN');

-- billed and collected per cycle (used by Analytics)
CREATE VIEW v_cycle_revenue AS
  SELECT c.cycle_id, c.year, c.month, c.due_date,
         COUNT(i.invoice_id) AS invoices,
         COUNT(i.invoice_id) FILTER (WHERE i.payment_status = 'PAID') AS paid_invoices,
         COALESCE(SUM(i.total_amount), 0) AS billed,
         COALESCE(SUM(p.amount_paid), 0) AS collected,
         COALESCE(SUM(lf.fee), 0) AS late_fees
  FROM billing_cycle c
  JOIN invoice i ON i.cycle_id = c.cycle_id
  LEFT JOIN payment p ON p.invoice_id = i.invoice_id AND p.status = 'SUCCEEDED'
  LEFT JOIN LATERAL (SELECT SUM(line_total) AS fee FROM invoice_line_item l
                     WHERE l.invoice_id = i.invoice_id AND l.line_kind = 'LATE_FEE') lf ON TRUE
  GROUP BY c.cycle_id;
