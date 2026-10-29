# Smart City Utilities & Infrastructure Management System

DBMS Level 3 mini-project (PES University, Aug–Dec 2026) by **Dhanush** and **Gagan**.

A system that runs a simulated city's electricity, water and gas: smart meters report readings, residents get correct slab-based bills, and leaks or outages turn into maintenance tickets automatically.

It is built on **polyglot persistence**:

- **PostgreSQL** is the system of record for residents, properties, meters, tariffs, billing cycles, invoices, payments and tickets.
- **MongoDB** stores the raw smart-meter readings (time-series), anomaly events, ticket notes and notifications.
- A monthly **bridge** turns a meter's MongoDB readings into one `meter_reading` row in PostgreSQL, which the billing procedure uses.

> **About this version.** This is a working browser prototype. Both databases are simulated in memory in JavaScript, using the same 15 tables, 5 collections, constraints, triggers, procedures and row-level-security rules as our design. The side panel shows the exact SQL or MongoDB statement behind every action. All data is synthetic. The full build on real PostgreSQL 17, MongoDB 8 and Next.js follows the plan in [`docs/design/project-plan.md`](docs/design/project-plan.md).

## How to run

You only need a web browser. There is nothing to install and no database to set up.

```bash
# 1. Get the code
git clone https://github.com/dhanushshekhar13-alt/smart-city-utilities.git
cd smart-city-utilities
```

Then pick **one** way to open it:

```bash
# Option A: open the file directly
open index.html            # macOS
xdg-open index.html        # Linux
start index.html           # Windows (Command Prompt or PowerShell)

# Option B: Python's built-in web server
python3 -m http.server 8080        # Windows: py -m http.server 8080
# then open http://localhost:8080

# Option C: Node.js (needs Node 18+)
npm start
# then open http://localhost:8080
```

Stop a server with `Ctrl + C`. Reloading the page resets all data to the starting state (seed 42).

## Demo accounts

Every account uses the password **`demo123`**.

| Role | Email | What they can do |
|---|---|---|
| Resident | `asha@example.test` | Dashboard, live usage, bills, pay, complaints, alerts |
| Resident | `vikram@example.test` | Same, for Vikram's properties only |
| Staff (North District) | `ravi.staff@city.example.test` | Ticket queue for North District, status changes, notes |
| Staff (South District) | `kavya.staff@city.example.test` | Ticket queue for South District |
| Admin | `admin@city.example.test` | City operations, disaster simulator, billing run, database rules, SQL lab |

The top bar has **Pause meters** and **+1 hour** (skips 4 readings) to speed up the demo. One tick is 2 real seconds and 15 city minutes.

## Demo script (about 8 minutes)

1. **Asha:** her dashboard shows her property from PostgreSQL next to live meter charts from MongoDB. Her September electricity bill is 100 × ₹5 + 200 × ₹8 + 150 × ₹12 = **₹3,900**.
2. **Asha → Bills:** press *Try to open Vikram's invoice*; row-level security returns 0 rows.
3. Pay with *Send the same request twice*: one payment row, the invoice becomes PAID. Set the outcome to *Decline* on another bill: the attempt is stored, the bill stays unpaid.
4. **Admin → Disaster simulator → Pipe burst**, then press **+1 hour**: a CRITICAL leak ticket appears with the reason it fired; later readings raise its count instead of creating duplicates.
5. **Ravi:** take the ticket, try *Try to close directly* (a trigger blocks it), add a note (MongoDB), resolve it. The leak stops.
6. **Admin → Billing run:** run the aggregation, generate invoices, then generate again: nothing is duplicated.
7. **Admin → Database rules** and **SQL lab:** watch bad data get rejected, and run the recursive, correlated, JOIN, CTE and window-function queries.

## Project structure

```text
index.html            Page shell; loads the scripts below in order
css/styles.css        Styles (light and dark theme)
js/db.js              In-memory PostgreSQL and MongoDB stores, constraint engine,
                      triggers, row-level security, activity log
js/billing.js         fn_tiered_charge and sp_generate_invoice
js/seed.js            Synthetic city: 7 zones, 6 residents, 8 properties, 24 meters,
                      4 billing cycles, 8 tariff slabs, history, 5 users
js/simulator.js       Smart-meter simulator, anomaly rules (leak, spike, missing data),
                      Mongo-to-PostgreSQL ticket hand-off, aggregations
js/app.js             Sessions, resident / staff / admin screens, events
docs/design/          Project plan, ER diagram (Mermaid source) and schema PDF
docs/viva/            Viva question bank (Markdown and PDF)
```

## Database design at a glance

- **15 PostgreSQL tables:** `zone`, `resident`, `property`, `utility_meter`, `billing_cycle`, `utility_rate`, `aggregation_run`, `meter_reading`, `invoice`, `invoice_line_item`, `payment`, `maintenance_ticket`, `ticket_status_history`, `app_user`, `user_session`.
- **MongoDB collections:** `meter_readings` (time-series), `anomaly_events`, `maintenance_logs`, `notifications`, `ingestion_batches`.
- **Rules shown in the app:** CHECK, UNIQUE, partial unique indexes, an EXCLUDE constraint on tariff dates, six triggers, idempotent payments, and RLS for three roles (`resident_role`, `staff_role`, `admin_role`).

Full details: [`docs/design/er-diagram-and-schema.pdf`](docs/design/er-diagram-and-schema.pdf) and [`docs/design/project-plan.pdf`](docs/design/project-plan.pdf).

## Limitations of this version

- Databases are simulated in the browser; data resets on reload.
- Login uses a shared demo password; there is no real password hashing.
- Payments are simulated; no money moves.
- Small synthetic dataset (8 properties, 24 meters); no performance claims.

## Team

- **Dhanush:** PostgreSQL schema, billing, security
- **Gagan:** MongoDB, simulator, user interface
