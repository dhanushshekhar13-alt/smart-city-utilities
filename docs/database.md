# Database design

## PostgreSQL

### Tables (`db/postgres/01_schema.sql`)

| Table | Holds | Notable rules |
|---|---|---|
| `zone` | City → district → ward hierarchy | Self-referencing `parent_zone_id`; only the city has no parent |
| `resident` | People on the utility register | `citizen_ref` must look like `SYN-00000`, so real ID numbers are refused |
| `property` | Homes and shops | Owned by a resident, located in a ward; `service_status` is NORMAL or UNDER_INVESTIGATION |
| `utility_meter` | One meter per utility per property | Code `MTR-[EWG]-0000`; supply switch and smart valve state |
| `billing_cycle` | One row per month | Unique `(year, month)`; status OPEN or CLOSED; late fee percentage |
| `utility_rate` | Tariff slabs | Exclusion constraint: two prices for the same utility and slab can never be valid on the same day |
| `aggregation_run` | Each run of the MongoDB → PostgreSQL bridge | Status, counts and timings |
| `meter_reading` | Usage per meter per cycle | Unique `(meter_id, cycle_id)`; `total_units_consumed` is a generated column (closing − opening) |
| `invoice` | One bill per property per cycle | Unique `(property_id, cycle_id)`; total kept equal to the lines |
| `invoice_line_item` | Usage lines (one per tariff slab) and late-fee lines | Rate copied onto the line so old bills never change |
| `payment` | Every payment attempt | Unique `idempotency_key`; at most one SUCCEEDED payment per invoice (partial unique index) |
| `maintenance_ticket` | Repair tickets | State machine, SLA due time, one active ticket per anomaly key (partial unique index) |
| `ticket_status_history` | Every status change | Written only by trigger |
| `app_user` | Sign-in accounts | Role RESIDENT, STAFF or ADMIN; resident or district link checked against the role |
| `user_session` | Server-side sessions | Only the SHA-256 of the token; kept after sign-out with `end_reason` |
| `auth_event` | Sign-in log | Successes, failures, lockouts, sign-outs, password changes and new accounts |
| `audit_log` | Every INSERT, UPDATE and DELETE on the main tables | Actor, database role, real and city time, changed columns, old and new row |
| `sim_clock` | The city's clock | Single row (`CHECK (id = 1)`) |

Views: `staff_directory` lists staff names without account details, and `v_cycle_revenue` shows billed and collected amounts per cycle.

### Functions and procedures (`02_functions.sql`)

| Name | What it does |
|---|---|
| `fn_tiered_charge(utility, units, as_of)` | Splits usage across tariff slabs and returns one row per slab |
| `sp_generate_invoice(property, cycle)` | Creates the invoice and its lines in one transaction. It takes an advisory lock and returns the existing invoice instead of creating a duplicate |
| `sp_record_payment(invoice, method, key, outcome)` | Records a simulated gateway result. Sending the same idempotency key again returns the original payment |
| `fn_mark_overdue()` | Nightly job: marks unpaid bills past their due date OVERDUE and adds one late-fee line per utility |
| `fn_open_anomaly_ticket(...)` | Opens a ticket for a new anomaly, or increments `occurrence_count` on the active one |
| `fn_auto_assign(ticket)` | Lists the engineers in the ticket's district, fewest open jobs first (ties go by email); the dispatcher assigns the first |
| `fn_escalate_overdue_tickets()` | Marks active tickets past their SLA with `escalated_at` |
| `fn_zone_subtree(zone)` | Recursive CTE returning a zone and everything under it |
| `fn_peer_usage(property, cycle)` | Usage of comparable properties for the eco report. It returns anonymous peer numbers and needs no access to other residents' rows |
| `app_uid()`, `app_property_ids()`, ... | Read `app.user_id` for the row-level security policies |

### Triggers (`03_triggers.sql`)

| Trigger | Rule |
|---|---|
| `trg_invoice_total` | Keeps `invoice.total_amount` equal to the sum of its lines |
| `trg_invoice_locked` | A PAID invoice's lines cannot change |
| `trg_reading_locked` | A reading for a cycle that is already invoiced cannot change (`READING_LOCKED`) |
| `trg_payment_settles_invoice` | A SUCCEEDED payment marks the invoice PAID |
| `trg_ticket_transition` | Allows only OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED (or RESOLVED → IN_PROGRESS); anything else raises `ILLEGAL_TRANSITION`. Also stamps `resolved_at` |
| `trg_ticket_sla` | Sets `sla_due_at` from severity: 4, 8, 24 or 72 hours |
| `trg_ticket_history` | Writes `ticket_status_history` |
| `trg_ticket_property_status` | Marks the property UNDER_INVESTIGATION while it has an active ticket |
| `audit_*` → `trg_audit()` | Writes `audit_log` for 13 tables. Password and token hashes are left out, and meter heartbeat columns are skipped |

### Roles and row-level security (`04_security.sql`)

The API runs every request inside a transaction with `SET LOCAL ROLE <role>` and `set_config('app.user_id', ...)`.

| Role | Can read | Can change |
|---|---|---|
| `resident_role` | Own resident row, own properties, their meters, readings, invoices, lines, payments and tickets, own account and sessions | Insert tickets for own properties; record payments on own invoices |
| `staff_role` | Properties, meters, readings and tickets in their district (no billing tables) | Ticket `status`, `assigned_to` and `resolution_notes` on tickets that are open or assigned to them |
| `admin_role` | Everything except secret columns; `audit_log` and `auth_event` are read-only | Master data, billing and tickets |

No app role can select `app_user.password_hash` or `user_session.token_hash`, and none can modify `audit_log`.

## MongoDB (`server/db/mongo.js`)

| Collection | Type | Contents | Indexes |
|---|---|---|---|
| `meter_readings` | Time series (`ts`, `meta`, minutes) | One document per meter per 15 minutes. Electricity has `kw`, `kwh_register` and `voltage`; water has `flow_lpm`, `kl_register` and `pressure_psi`; gas has `m3h` and `m3_register` | `(meta.meter_code, ts)` |
| `anomaly_events` | Validated | Rule, meter, reason, hit count, status, ticket number, `synced_to_sql` | `(key, status)`, `last_seen` |
| `maintenance_logs` | Validated | One document per ticket with an `entries` array (sensor snapshot, dispatch, device, status, note) | `ticket_no` unique |
| `notifications` | Validated | Alerts per user: ALERT, BILL, OVERDUE, FORECAST, DEMAND | `(user_id, created_at)`, `ref` unique (no duplicate alerts) |
| `device_commands` | Validated | CLOSE_VALVE and OPEN_VALVE commands with SENT → ACKED status | `(meter_code, issued_at)` |
| `demand_events` | Validated | Peak demand events with start, peak and end load | `(status, started_at)` |
| `ingestion_batches` | Validated | One document per batch of readings | — |
| `change_log` | Validated | Every MongoDB write made through the app: who, when (real and city time), collection, operation, filter and change | `at` |

Time-series collections cannot have a validator, so readings are checked by `validateReading()` in the server before insert. The **Database rules** page shows both the validator and the server check rejecting bad documents.

## Synthetic data (`scripts/seed.js`)

- 7 zones, 6 residents (`SYN-00001` to `SYN-00006`), 8 properties and 24 meters.
- 4 billing cycles: July to September are closed and October is open.
- 8 tariff slabs, 72 monthly readings and 24 invoices with payments. Some invoices are left unpaid or overdue.
- About 56,000 meter readings in MongoDB (1 to 25 October), generated with a fixed random seed so every setup gives the same numbers.
- 6 accounts.
