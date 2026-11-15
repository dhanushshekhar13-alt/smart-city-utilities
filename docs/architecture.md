# Architecture

## Pieces

| Piece | Where | Job |
|---|---|---|
| PostgreSQL 17 | `db/postgres/*.sql` | System of record: people, properties, meters, tariffs, billing cycles, monthly readings, invoices, payments, tickets, accounts, sessions, sign-in log, audit log |
| MongoDB 8 | `server/db/mongo.js` | Sensor diary: raw meter readings (time series), anomaly events, ticket field notes, notifications, device commands, demand events, ingestion batches, change log |
| API server | `server/` | Express app. Owns every database connection; the browser never talks to a database |
| Simulator | `server/sim/` | City clock, 24 smart meters, anomaly rules and the automatic responses |
| Front end | `public/` | Single-page app in plain JavaScript. Every number on screen comes from the API |

## Why two databases

- **PostgreSQL** is used where correctness matters more than volume. Money is stored as `BIGINT` paise. Constraints, triggers and stored procedures guarantee that an invoice always equals its lines, that a reading cannot change once billed, that a payment is recorded once and that a ticket follows its state machine. Row-level security decides who can see which rows.
- **MongoDB** is used where data is high-volume, append-mostly and differently shaped. Electricity, water and gas readings have different fields, and there are about 2,900 readings per meter per month. A time-series collection stores them compactly and serves "last 24 hours of meter X" from the `(meta.meter_code, ts)` index.

## The bridge between them

```
MongoDB meter_readings ──(month end)──▶ aggregation pipeline: first and last register per meter in the cycle
                                         │
                                         ▼
PostgreSQL meter_reading (opening, closing, total_units, source_doc_count, run_id)   ← upsert per meter
                                         │
                                         ▼
CALL sp_generate_invoice(property, cycle)   → invoice + invoice_line_item (one line per tariff slab)
```

`aggregation_run` records each bridge run. If a meter's row is already invoiced, `trg_reading_locked` rejects the upsert. The run counts it as locked and does not fail.

The opposite direction happens live. When the anomaly detector finds a problem, it upserts an `anomaly_events` document in MongoDB. It then calls `fn_open_anomaly_ticket()` in PostgreSQL, which inserts or updates one ticket per active anomaly key, and marks the event `synced_to_sql`.

## City clock

`sim_clock` holds the city's time. With the clock running, each tick moves the city 15 minutes forward every 2 seconds (`TICK_MS`). Each tick runs these steps in order:

1. Generate one reading per online meter and validate it. Invalid readings are rejected before insert.
2. `insertMany` the readings into `meter_readings` and record an `ingestion_batches` document.
3. Run the leak, spike and missing-data rules on the new batch.
4. Run the automatic responses: dispatch new tickets, close a valve on a leak, start or end a peak demand event, escalate tickets past their SLA, and send high-bill warnings once an hour.
5. At IST midnight, run `fn_mark_overdue()`, which adds late fees and sends OVERDUE alerts.
6. When the clock passes the end of the open billing cycle, run the bridge, generate invoices, close the cycle, open the next one and send bill alerts.

Admins can pause the clock, run one hour at once, or jump to the end of the month. Ticks and admin actions run one at a time through a single queue (`engine.exclusive`), so they never overlap.

## A request, end to end

1. The browser sends `POST /api/tickets/:id/status` with the `sc_session` cookie and the `X-Requested-With: smart-city` header.
2. `csrfGuard` checks the header. `attachUser` hashes the cookie and looks up a live `user_session` row joined to `app_user`.
3. The route runs its SQL inside `asUser()`. That opens a transaction, runs `SET LOCAL ROLE staff_role`, and sets `app.user_id` and `app.actor`.
4. PostgreSQL applies the `ticket_staff_update` policy, `trg_ticket_transition` (the state machine), `trg_ticket_history` (writes a history row) and `trg_audit` (writes `audit_log` with the actor, the role and the old and new row).
5. The route writes a STATUS entry to `maintenance_logs` through `mongo.write()`, which also records a `change_log` document.
6. A short description of what ran goes to the in-memory activity list. The "Under the hood" rail reads it, and it is a teaching aid, not the audit trail.

## Accounts and sessions

- `app_user` stores the email, role, a link to a resident (for residents) or a district (for staff), and the scrypt hash.
- Sign-in creates a `user_session` row holding the SHA-256 of a random token, and the token goes into an `HttpOnly` cookie. Sign-out sets `ended_at` and `end_reason = 'LOGOUT'`; the row is kept as history.
- `auth_event` logs every successful sign-in, failure, lockout, sign-out, password change and new account.
- Five failures in a row set `locked_until` for 15 minutes.

## Front end

`public/index.html` loads six scripts in order:

1. `core.js`: API calls, formatting and the chart.
2. `resident.js`, `staff.js` and `admin.js`: the pages for each role.
3. `common.js`: database browser, account and how-it-works pages.
4. `app.js`: the shell, the sign-in page, events and the clock poll.

The app polls `GET /api/clock` every 2 seconds. When the city's data version changes, live pages re-render, unless someone is typing in a form. The Content-Security-Policy allows scripts only from the server itself; there are no inline scripts.
