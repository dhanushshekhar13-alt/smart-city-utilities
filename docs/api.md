# API

All endpoints are under `/api` and return JSON.

- **Sign-in:** after signing in, the browser holds an `sc_session` cookie (`HttpOnly`, `SameSite=Lax`).
- **CSRF header:** every POST and DELETE must send `X-Requested-With: smart-city`. Without it the request gets `403`.
- **Database role:** each request runs as the signed-in person's role (`resident_role`, `staff_role` or `admin_role`), so row-level security in PostgreSQL applies.

**Errors** come back as `{ "error": "..." }`. When PostgreSQL rejected the request, the response also has `pg`, which holds psql-style text with the message, detail, hint, constraint and SQLSTATE.

| Status | Meaning |
|---|---|
| 400 | Bad input, or a database rule refused it (for example `ILLEGAL_TRANSITION` or `READING_LOCKED`) |
| 401 | Not signed in, or the session ended |
| 403 | Wrong role, or a PostgreSQL permission error (`42501`) |
| 404 | Not found, or hidden by row-level security |
| 409 | Already exists, or the ticket was already taken |
| 423 | Account locked |

## Accounts — `/api/auth`

| Method | Path | Who | Body / query | Returns |
|---|---|---|---|---|
| POST | `/login` | anyone | `{ email, password }` | `{ user }` and sets the cookie |
| POST | `/logout` | anyone | — | Ends the session in the database and clears the cookie |
| GET | `/me` | anyone | — | `{ user \| null, demo }` |
| GET | `/demo-accounts` | anyone | — | Demo cards for the sign-in page (empty when `DEMO_MODE=false`) |
| POST | `/register` | anyone | `{ email, display_name?, password }` | Creates a resident account for an email on the register and signs in |
| POST | `/password` | signed in | `{ current, next }` | Changes the password and ends the person's other sessions |
| GET | `/sessions` | signed in | — | `{ current, sessions, events }`: own sessions and sign-in log |
| POST | `/sessions/end-others` | signed in | — | `{ ended }` |

## City clock — `/api`

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/clock` | anyone | `{ city_now, running, version, activity, open_cycle }`. The front end polls this every 2 s |
| POST | `/clock/run` | admin | `{ on }`: pause or resume |
| POST | `/clock/advance` | admin | `{ hours }` (1–48): runs those ticks now |
| POST | `/clock/month-end` | admin | Runs the meters to the end of the open cycle, then bills it |
| GET | `/activity` | signed in | Recent statements for the "Under the hood" rail |

## Residents — `/api/me` (RESIDENT)

| Method | Path | Notes |
|---|---|---|
| GET | `/properties` | Own properties |
| GET | `/home?property=&ut=` | Dashboard: property, meters, unpaid bills, forecast, eco score, last 24 h series |
| GET | `/invoices` | Own invoices (row-level security) |
| GET | `/invoices/:id` | Invoice, lines and payment attempts |
| GET | `/rls-probe/:id` | Demo: how many rows PostgreSQL returns for that invoice id |
| POST | `/invoices/:id/pay` | `{ method: UPI_SIM\|CARD_SIM\|NETBANK_SIM, outcome: OK\|FAIL, key?, twice? }` → `{ key, results, stored }` |
| GET / POST | `/tickets` | List own complaints / `{ property_id, issue_type, description }` → `{ ticket_no, assigned_to }` |
| GET | `/notifications` | Own alerts from MongoDB |
| POST | `/notifications/read-all`, `/notifications/:id/read` | Mark read |
| DELETE | `/notifications/:id` | Dismiss |
| GET | `/eco?property=` | Footprint, peer comparison, habits and tips |
| POST | `/supply` | `{ meter_code, on }`: switch own supply off or on |

## Tickets — `/api/tickets` (any role, filtered by row-level security)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/` | all | Tickets the person can see |
| GET | `/:id` | all | `{ ticket, history, entries }` (entries come from MongoDB `maintenance_logs`) |
| POST | `/:id/take` | staff | Assign an OPEN ticket to yourself. `409` if someone already took it |
| POST | `/:id/status` | staff | `{ to, notes? }`. Notes are required to resolve. Resolving clears the fault and reopens a closed valve |
| POST | `/:id/notes` | staff | `{ text }`: adds a field note |
| DELETE | `/:id/notes/:entry` | staff | Delete your own note |

## Admin — `/api/admin` (ADMIN)

| Method | Path | Notes |
|---|---|---|
| GET | `/ops` | City operations: live demand, grid load, wards, anomalies, meter health, automatic actions |
| POST | `/anomalies/:id/ack` | Acknowledge an anomaly event |
| GET | `/map`, `/map/:id` | Live map pins and one property's detail |
| POST | `/valve` | `{ meter_code, open }` |
| GET | `/analytics` | Revenue, collection and usage analytics |
| GET | `/csv/:what` | `invoices`, `readings` or `tickets` as CSV |
| GET | `/sim` | Scenarios and automation switches |
| POST | `/scenarios/:id` | `{ on }` for `burst`, `spike` or `outage` |
| POST | `/policies/:key` | `{ on }` for `autoDispatch`, `autoValve` or `demandResponse` |
| POST | `/supply` | `{ meter_code, on }` for any meter |
| GET | `/billing?cycle=` | Cycle, readings, runs and invoices |
| POST | `/billing/aggregate` | `{ cycle }`: run the MongoDB → PostgreSQL bridge |
| POST | `/billing/invoices` | `{ cycle }`: call `sp_generate_invoice` for every property |
| GET / POST | `/users` | List accounts / `{ email, display_name, role, password, staff_zone_id?, resident_id? }` |
| POST | `/users/:id/active`, `/unlock`, `/password`, `/revoke` | Enable or disable, unlock, reset password, sign out everywhere |
| GET | `/audit?source=pg\|auth\|sessions\|mongo&table=` | `audit_log`, `auth_event`, `user_session` or `change_log` |

## Inside the databases — `/api/db`

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/table/:name` | signed in | First 25 rows, read as your own role. A permission error comes back as `error` |
| GET | `/collection/:name` | signed in | Newest 12 documents with the filter for your role, or `hidden: true` |
| GET / POST | `/rules`, `/rules/:i` | admin | Tries a bad insert or update and returns the database's rejection. The transaction is always rolled back |
| GET | `/sql`, `/sql/:id` | admin | SQL lab: zone roll-up (recursive), overdue residents (nested + `HAVING`), correlated and window queries |
