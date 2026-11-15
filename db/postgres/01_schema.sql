-- =====================================================================
-- Smart City Utilities: PostgreSQL schema (system of record)
-- Money is stored in paise (BIGINT) so no rounding errors creep in.
-- All business timestamps use the city clock (sim_clock.city_now);
-- audit and session times use the real wall clock.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets an EXCLUDE constraint mix = and && (tariff overlap rule)
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), digest()

-- ---------- the city clock (one row) ----------
CREATE TABLE sim_clock (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  city_now    TIMESTAMPTZ NOT NULL,
  running     BOOLEAN     NOT NULL DEFAULT TRUE,
  policies    JSONB       NOT NULL DEFAULT '{"autoDispatch": true, "autoValve": true, "demandResponse": true}',
  faults      JSONB       NOT NULL DEFAULT '{}',      -- injected scenarios, e.g. {"MTR-W-0001": "BURST"}
  offline     TEXT[]      NOT NULL DEFAULT '{}',      -- meters that stopped reporting (outage scenario)
  grid_kw     NUMERIC(6,1) NOT NULL DEFAULT 15 CHECK (grid_kw > 0),
  version     BIGINT      NOT NULL DEFAULT 0          -- bumped on every tick and every change, so screens know to refresh
);

-- ---------- places and people ----------
CREATE TABLE zone (
  zone_id        INT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  zone_level     TEXT NOT NULL CHECK (zone_level IN ('CITY', 'DISTRICT', 'WARD')),
  parent_zone_id INT REFERENCES zone (zone_id),
  CHECK ((zone_level = 'CITY') = (parent_zone_id IS NULL))
);

CREATE TABLE resident (
  resident_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_ref     TEXT NOT NULL UNIQUE CHECK (citizen_ref ~ '^SYN-[0-9]{5}$'),   -- synthetic IDs only, never a real ID number
  full_name       TEXT NOT NULL CHECK (length(trim(full_name)) >= 2),
  email           TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '_%@_%.__%'),
  phone           TEXT CHECK (phone ~ '^\+91[0-9]{10}$'),
  registered_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE property (
  property_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_code  TEXT NOT NULL UNIQUE CHECK (property_code ~ '^P-[0-9]{4}$'),
  resident_id    UUID NOT NULL REFERENCES resident (resident_id),
  zone_id        INT  NOT NULL REFERENCES zone (zone_id),
  address_line   TEXT NOT NULL,
  city           TEXT NOT NULL DEFAULT 'Synthetic City',
  pincode        TEXT NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  property_type  TEXT NOT NULL CHECK (property_type IN ('RESIDENTIAL', 'COMMERCIAL')),
  square_feet    INT  NOT NULL CHECK (square_feet > 0),
  service_status TEXT NOT NULL DEFAULT 'NORMAL' CHECK (service_status IN ('NORMAL', 'UNDER_INVESTIGATION', 'DISCONNECTED'))
);
CREATE INDEX property_resident_idx ON property (resident_id);
CREATE INDEX property_zone_idx ON property (zone_id);

CREATE TABLE utility_meter (
  meter_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_code        TEXT NOT NULL UNIQUE CHECK (meter_code ~ '^MTR-[EWG]-[0-9]{4}$'),
  property_id       UUID NOT NULL REFERENCES property (property_id),
  utility_type      TEXT NOT NULL CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
  installation_date DATE NOT NULL,
  meter_model       TEXT NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  supply_on         BOOLEAN NOT NULL DEFAULT TRUE,   -- switched off for an empty or disconnected home
  valve_open        BOOLEAN NOT NULL DEFAULT TRUE,   -- smart water valve; only water meters can close it
  UNIQUE (property_id, utility_type),
  CHECK (valve_open OR utility_type = 'WATER')
);

-- ---------- tariffs and billing cycles ----------
CREATE TABLE billing_cycle (
  cycle_id             SERIAL PRIMARY KEY,
  year                 INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month                INT  NOT NULL CHECK (month BETWEEN 1 AND 12),
  cycle_start_date     DATE NOT NULL,
  cycle_end_date       DATE NOT NULL,
  due_date             DATE NOT NULL,
  late_penalty_percent NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (late_penalty_percent BETWEEN 0 AND 50),
  status               TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  UNIQUE (year, month),
  CHECK (cycle_start_date < cycle_end_date AND cycle_end_date < due_date)
);

CREATE TABLE utility_rate (
  rate_id              SERIAL PRIMARY KEY,
  utility_type         TEXT NOT NULL CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
  tier_level           INT  NOT NULL CHECK (tier_level BETWEEN 1 AND 10),
  min_units            NUMERIC(12,3) NOT NULL CHECK (min_units >= 0),
  max_units            NUMERIC(12,3) CHECK (max_units > min_units),          -- NULL = no upper limit
  price_per_unit       NUMERIC(10,2) NOT NULL CHECK (price_per_unit > 0),    -- rupees per kWh, kL or m³
  effective_start_date DATE NOT NULL,
  effective_end_date   DATE CHECK (effective_end_date > effective_start_date),
  -- two prices for the same slab may never be valid on the same day
  CONSTRAINT utility_rate_excl_no_overlap EXCLUDE USING gist (
    utility_type WITH =, tier_level WITH =,
    daterange(effective_start_date, effective_end_date) WITH &&)
);

-- ---------- monthly usage (written by the MongoDB → PostgreSQL bridge) ----------
CREATE TABLE aggregation_run (
  run_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       INT  NOT NULL REFERENCES billing_cycle (cycle_id),
  started_at     TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  meters_total   INT  NOT NULL DEFAULT 0,
  meters_written INT  NOT NULL DEFAULT 0,
  error          TEXT
);

CREATE TABLE meter_reading (
  reading_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id             UUID NOT NULL REFERENCES utility_meter (meter_id),
  cycle_id             INT  NOT NULL REFERENCES billing_cycle (cycle_id),
  run_id               UUID REFERENCES aggregation_run (run_id),
  opening_register     NUMERIC(14,3) NOT NULL CHECK (opening_register >= 0),
  closing_register     NUMERIC(14,3) NOT NULL,
  total_units_consumed NUMERIC(14,3) GENERATED ALWAYS AS (closing_register - opening_register) STORED,
  source_doc_count     INT NOT NULL DEFAULT 0 CHECK (source_doc_count >= 0),
  is_estimated         BOOLEAN NOT NULL DEFAULT FALSE,
  reading_timestamp    TIMESTAMPTZ NOT NULL,
  UNIQUE (meter_id, cycle_id),
  CHECK (closing_register >= opening_register)
);
CREATE INDEX meter_reading_cycle_idx ON meter_reading (cycle_id);

-- ---------- invoices and payments ----------
CREATE SEQUENCE invoice_no_seq;
CREATE SEQUENCE txn_no_seq START 1001;

CREATE TABLE invoice (
  invoice_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no     TEXT NOT NULL UNIQUE,
  property_id    UUID NOT NULL REFERENCES property (property_id),
  cycle_id       INT  NOT NULL REFERENCES billing_cycle (cycle_id),
  invoice_date   DATE NOT NULL,
  total_amount   BIGINT NOT NULL DEFAULT 0 CHECK (total_amount >= 0),   -- paise; kept equal to the lines by trigger
  payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'OVERDUE', 'DISPUTED')),
  paid_at        TIMESTAMPTZ,
  UNIQUE (property_id, cycle_id),
  CHECK ((payment_status = 'PAID') = (paid_at IS NOT NULL))
);
CREATE INDEX invoice_cycle_idx ON invoice (cycle_id);

CREATE TABLE invoice_line_item (
  line_item_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoice (invoice_id) ON DELETE CASCADE,
  utility_type   TEXT NOT NULL CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
  line_kind      TEXT NOT NULL CHECK (line_kind IN ('USAGE', 'LATE_FEE')),
  rate_id        INT REFERENCES utility_rate (rate_id),
  tier_level     INT,
  units_consumed NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
  rate_applied   NUMERIC(10,2) NOT NULL,            -- price copied onto the bill, or the late-fee percent
  line_total     BIGINT NOT NULL CHECK (line_total >= 0),
  CONSTRAINT invoice_line_item_unique UNIQUE NULLS NOT DISTINCT (invoice_id, utility_type, line_kind, tier_level),
  CHECK ((line_kind = 'USAGE') = (rate_id IS NOT NULL AND tier_level IS NOT NULL))
);

CREATE TABLE payment (
  payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoice (invoice_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_paid     BIGINT NOT NULL CHECK (amount_paid > 0),
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('UPI_SIM', 'CARD_SIM', 'NETBANK_SIM', 'CASH')),
  status          TEXT NOT NULL CHECK (status IN ('INITIATED', 'SUCCEEDED', 'FAILED')),
  transaction_id  TEXT,
  failure_reason  TEXT,
  payment_date    TIMESTAMPTZ NOT NULL
);
-- at most one successful payment per invoice
CREATE UNIQUE INDEX uq_one_success_per_invoice ON payment (invoice_id) WHERE status = 'SUCCEEDED';

-- ---------- accounts, sessions, sign-in history ----------
CREATE TABLE app_user (
  user_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '_%@_%.__%'),
  password_hash  TEXT NOT NULL,                     -- scrypt, never the password itself
  role           TEXT NOT NULL CHECK (role IN ('RESIDENT', 'STAFF', 'ADMIN')),
  resident_id    UUID UNIQUE REFERENCES resident (resident_id),
  staff_zone_id  INT REFERENCES zone (zone_id),
  display_name   TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ,
  CHECK ((role = 'RESIDENT') = (resident_id IS NOT NULL)),
  CHECK ((role = 'STAFF') = (staff_zone_id IS NOT NULL))
);

CREATE TABLE user_session (
  session_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,                -- SHA-256 of the cookie value; the token itself is never stored
  user_id      UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,                         -- set on sign-out; the row is kept as history
  end_reason   TEXT CHECK (end_reason IN ('LOGOUT', 'EXPIRED', 'REVOKED', 'PASSWORD_CHANGED')),
  ip           TEXT,
  user_agent   TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_session_user_idx ON user_session (user_id);

CREATE TABLE auth_event (
  event_id  BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  email     TEXT NOT NULL,
  user_id   UUID REFERENCES app_user (user_id) ON DELETE SET NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('LOGIN_OK', 'LOGIN_FAILED', 'LOCKED', 'LOGOUT', 'PASSWORD_CHANGED', 'ACCOUNT_CREATED')),
  ip        TEXT,
  detail    TEXT
);
CREATE INDEX auth_event_at_idx ON auth_event (at DESC);

-- ---------- repair tickets ----------
CREATE SEQUENCE ticket_no_seq;

CREATE TABLE maintenance_ticket (
  ticket_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no          TEXT NOT NULL UNIQUE DEFAULT 'MT-' || lpad(nextval('ticket_no_seq')::text, 4, '0'),
  property_id        UUID NOT NULL REFERENCES property (property_id),
  meter_id           UUID REFERENCES utility_meter (meter_id),
  source             TEXT NOT NULL CHECK (source IN ('ANOMALY', 'RESIDENT', 'STAFF')),
  anomaly_key        TEXT,                                          -- e.g. LEAK:MTR-W-0001
  issue_type         TEXT NOT NULL CHECK (issue_type IN ('LEAK', 'VOLTAGE_SPIKE', 'POWER_OUTAGE', 'LOW_PRESSURE', 'METER_MALFUNCTION', 'BILLING', 'OTHER')),
  severity           TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  description        TEXT NOT NULL CHECK (length(trim(description)) >= 5),
  status             TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
  assigned_to        UUID REFERENCES app_user (user_id),
  reported_timestamp TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL,
  occurrence_count   INT NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  sla_due_at         TIMESTAMPTZ NOT NULL,                          -- filled by trigger from the severity
  escalated_at       TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  resolution_notes   TEXT,
  CHECK (status NOT IN ('RESOLVED', 'CLOSED') OR (resolved_at IS NOT NULL AND length(trim(resolution_notes)) > 0)),
  CHECK ((source = 'ANOMALY') = (anomaly_key IS NOT NULL))
);
-- one active ticket per anomaly: repeats raise occurrence_count instead of creating duplicates
CREATE UNIQUE INDEX uq_active_anomaly_ticket ON maintenance_ticket (anomaly_key)
  WHERE status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS');
CREATE INDEX maintenance_ticket_property_idx ON maintenance_ticket (property_id);
CREATE INDEX maintenance_ticket_assigned_idx ON maintenance_ticket (assigned_to) WHERE status IN ('ASSIGNED', 'IN_PROGRESS');

CREATE TABLE ticket_status_history (
  history_id  BIGSERIAL PRIMARY KEY,
  ticket_id   UUID NOT NULL REFERENCES maintenance_ticket (ticket_id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  UUID REFERENCES app_user (user_id),                 -- NULL = done by the system
  changed_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ticket_status_history_ticket_idx ON ticket_status_history (ticket_id);

-- ---------- audit trail: every insert, update and delete on the main tables ----------
CREATE TABLE audit_log (
  audit_id    BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),     -- real time
  city_at     TIMESTAMPTZ,                                        -- city clock at that moment
  actor_id    UUID,                                               -- app user, NULL = system
  actor       TEXT NOT NULL,                                      -- display name or system job
  db_role     TEXT NOT NULL DEFAULT current_user,                 -- PostgreSQL role that ran the statement
  table_name  TEXT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  row_key     TEXT NOT NULL,
  changed     TEXT[],                                             -- columns that changed (UPDATE only)
  old_row     JSONB,
  new_row     JSONB
);
CREATE INDEX audit_log_at_idx ON audit_log (audit_id DESC);
CREATE INDEX audit_log_table_idx ON audit_log (table_name, audit_id DESC);
