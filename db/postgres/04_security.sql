-- =====================================================================
-- Roles, privileges and row-level security.
-- The API connects as the database owner, then for every request runs
--   SET LOCAL ROLE resident_role | staff_role | admin_role
-- so PostgreSQL itself decides which rows the signed-in person can see.
-- Background jobs (meter simulator, billing) keep the owner's rights.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resident_role') THEN CREATE ROLE resident_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staff_role')    THEN CREATE ROLE staff_role NOLOGIN;    END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_role')    THEN CREATE ROLE admin_role NOLOGIN;    END IF;
END $$;

-- the connecting user may switch into the three roles
GRANT resident_role, staff_role, admin_role TO CURRENT_USER;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO resident_role, staff_role, admin_role;

-- ---------- privileges (what a role may do at all) ----------
-- reference data everyone reads
GRANT SELECT ON zone, billing_cycle, utility_rate, staff_directory, sim_clock TO resident_role, staff_role, admin_role;

-- residents: read their own data, raise complaints, pay bills
GRANT SELECT ON resident, property, utility_meter, meter_reading, invoice, invoice_line_item, payment,
                maintenance_ticket, ticket_status_history TO resident_role;
GRANT INSERT ON maintenance_ticket TO resident_role;
GRANT INSERT, UPDATE (status, transaction_id, failure_reason) ON payment TO resident_role;

-- staff: read their district's properties and tickets, work the tickets
GRANT SELECT ON property, utility_meter, meter_reading, maintenance_ticket, ticket_status_history TO staff_role;
GRANT UPDATE (status, assigned_to, resolution_notes) ON maintenance_ticket TO staff_role;

-- admins: everything except the audit trail, which nobody can edit
GRANT SELECT, INSERT, UPDATE, DELETE ON resident, property, utility_meter, billing_cycle, utility_rate,
      aggregation_run, meter_reading, invoice, invoice_line_item, payment, maintenance_ticket,
      ticket_status_history TO admin_role;
GRANT SELECT ON audit_log, auth_event, v_cycle_revenue TO admin_role;

-- app_user and user_session: the secret columns are never readable through a role
GRANT SELECT (user_id, email, role, resident_id, staff_zone_id, display_name, is_active, failed_logins,
              locked_until, created_at, last_login_at) ON app_user TO resident_role, staff_role, admin_role;
GRANT SELECT (session_id, user_id, created_at, expires_at, last_seen_at, ended_at, end_reason, ip, user_agent)
      ON user_session TO resident_role, staff_role, admin_role;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO resident_role, staff_role, admin_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO resident_role, staff_role, admin_role;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA public TO resident_role, staff_role, admin_role;

-- ---------- row-level security (which rows) ----------
ALTER TABLE resident              ENABLE ROW LEVEL SECURITY;
ALTER TABLE property              ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_meter         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_reading         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice               ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_item     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment               ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_ticket    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user              ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session          ENABLE ROW LEVEL SECURITY;

-- admins see and change every row
CREATE POLICY admin_all_resident  ON resident              TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_property  ON property              TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_meter     ON utility_meter         TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_reading   ON meter_reading         TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_invoice   ON invoice               TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_line      ON invoice_line_item     TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_payment   ON payment               TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_ticket    ON maintenance_ticket    TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_history   ON ticket_status_history TO admin_role USING (true) WITH CHECK (true);
CREATE POLICY admin_all_user      ON app_user              TO admin_role USING (true);
CREATE POLICY admin_all_session   ON user_session          TO admin_role USING (true);

-- everyone sees their own account and sessions
CREATE POLICY own_user    ON app_user     TO resident_role, staff_role USING (user_id = app_uid());
CREATE POLICY own_session ON user_session TO resident_role, staff_role USING (user_id = app_uid());

-- residents: only their own person record
CREATE POLICY resident_self ON resident TO resident_role USING (resident_id = app_resident_id());

-- properties and everything hanging off them: app_property_ids() is own (resident) or district (staff)
CREATE POLICY property_visible ON property TO resident_role, staff_role
  USING (property_id IN (SELECT app_property_ids()));
CREATE POLICY meter_visible ON utility_meter TO resident_role, staff_role
  USING (property_id IN (SELECT app_property_ids()));
CREATE POLICY reading_visible ON meter_reading TO resident_role, staff_role
  USING (meter_id IN (SELECT meter_id FROM utility_meter));          -- utility_meter is itself filtered

-- bills are private to the resident; staff never see money
CREATE POLICY invoice_resident_read ON invoice TO resident_role
  USING (property_id IN (SELECT app_property_ids()));
CREATE POLICY line_resident_read ON invoice_line_item TO resident_role
  USING (invoice_id IN (SELECT invoice_id FROM invoice));
CREATE POLICY payment_resident_read ON payment TO resident_role
  USING (invoice_id IN (SELECT invoice_id FROM invoice));
CREATE POLICY payment_resident_insert ON payment FOR INSERT TO resident_role
  WITH CHECK (invoice_id IN (SELECT invoice_id FROM invoice) AND payment_method <> 'CASH');
CREATE POLICY payment_resident_update ON payment FOR UPDATE TO resident_role
  USING (invoice_id IN (SELECT invoice_id FROM invoice));

-- tickets: residents see their properties' tickets and may raise a complaint for them;
-- staff see their district and may update those tickets
CREATE POLICY ticket_visible ON maintenance_ticket FOR SELECT TO resident_role, staff_role
  USING (property_id IN (SELECT app_property_ids()));
CREATE POLICY ticket_resident_insert ON maintenance_ticket FOR INSERT TO resident_role
  WITH CHECK (property_id IN (SELECT app_property_ids()) AND source = 'RESIDENT' AND status = 'OPEN' AND assigned_to IS NULL);
CREATE POLICY ticket_staff_update ON maintenance_ticket FOR UPDATE TO staff_role
  USING (property_id IN (SELECT app_property_ids()))
  WITH CHECK (property_id IN (SELECT app_property_ids()) AND (assigned_to IS NULL OR assigned_to = app_uid() OR status <> 'ASSIGNED'));
CREATE POLICY history_visible ON ticket_status_history FOR SELECT TO resident_role, staff_role
  USING (ticket_id IN (SELECT ticket_id FROM maintenance_ticket));
