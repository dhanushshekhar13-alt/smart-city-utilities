# Smart City Utilities & Infrastructure Management

A DBMS mini-project that runs electricity, water and gas for a small synthetic city on **PostgreSQL 17** and **MongoDB 8**, with a **Node.js (Express)** server and a browser front end.

- Smart meters write a reading every 15 city minutes into a MongoDB time-series collection.
- Rules spot leaks, power spikes and offline meters. Each finding opens a repair ticket in PostgreSQL and is dispatched to an engineer, and a smart valve closes on a leak.
- At month end the readings are turned into one usage row per meter. Stored procedures then apply the tariff slabs and create the invoices.
- Residents, maintenance staff and city admins sign in with real accounts. Each person sees only what row-level security in PostgreSQL allows.
- Every change is recorded: `audit_log` covers PostgreSQL writes, `change_log` covers MongoDB writes, and `auth_event` covers sign-ins and sign-outs.

All people, addresses, emails and ID numbers are synthetic (`SYN-00001`, `@example.test`). No real citizen data is used.

## Quick start (Docker)

You need [Node.js 20.11+](https://nodejs.org) and [Docker](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/dhanushshekhar13-alt/smart-city-utilities.git
cd smart-city-utilities
cp .env.example .env        # then edit .env and choose your own database password
npm install
npm run db:up               # starts PostgreSQL 17 and MongoDB 8 (data is stored in ./data)
npm run setup               # creates tables, functions, triggers, roles, collections and the demo city
npm start                   # http://localhost:8080
```

The databases keep their files in `data/postgres` and `data/mongo`. Every change you make in the app is written there and survives a restart. To start again from the demo city, run `npm run reset`. This drops everything in both databases.

### Without Docker

Install PostgreSQL 15+ and MongoDB 7+ yourself. Create an empty database, put both connection strings in `.env` (`DATABASE_URL`, `MONGO_URL`), then run `npm run setup` and `npm start`. The PostgreSQL user needs permission to create roles, because the setup creates `resident_role`, `staff_role` and `admin_role` for row-level security.

## Accounts

The demo city comes with six accounts. Every one uses the password `demo123`:

| Who | Email | Role |
|---|---|---|
| Asha Rao | asha@example.test | Resident (home P-0001 and shop P-0007) |
| Vikram Iyer | vikram@example.test | Resident (two properties) |
| Ravi Kumar | ravi.staff@city.example.test | Maintenance staff, North District |
| Neha Joshi | neha.staff@city.example.test | Maintenance staff, North District |
| Kavya Shetty | kavya.staff@city.example.test | Maintenance staff, South District |
| City Admin | admin@city.example.test | Municipal admin |

Meera, Rahul, Fatima and Arjun are on the city register without an account. They can sign up under **Create an account**, for example with `meera@example.test`. Admins can create staff and admin accounts, reset passwords, unlock accounts and sign people out under **Accounts**.

Five wrong passwords lock an account for 15 minutes. Sessions last 8 hours, and **Sign out** ends the session in the database. Set `DEMO_MODE=false` in `.env` to hide the demo account cards on the sign-in page.

## Demo script (about 10 minutes)

1. **Asha** opens her dashboard. The property comes from PostgreSQL, the live meters come from MongoDB, and the bill forecast mixes both. **Footprint & savings** shows her carbon footprint and eco score.
2. **Asha → Bills & payments** shows her September bill INV-2026-09-0017 for ₹4,860, with the electricity slabs 100 × ₹5 + 200 × ₹8 + 150 × ₹12. **Try to open Vikram's invoice** returns 0 rows, because row-level security hides it.
3. **Admin → Disaster simulator → Pipe burst**, then **+1 hour** in the top bar. A critical leak ticket opens and is assigned to **Neha**: she and Ravi both have zero open jobs, and the tie goes by email. The smart valve closes and Asha gets an alert.
4. **Electricity spike**, then **+1 hour**. Kavya gets a spike ticket, and City operations shows a peak demand event.
5. **Asha → Complaints** submits a complaint. It goes to **Ravi**, who now has fewer open jobs than Neha.
6. **Neha** first tries **Try to close directly**, and the trigger rejects it. She then moves the ticket to in progress, adds a field note (stored in MongoDB) and resolves it with notes. The valve reopens.
7. **Admin → Jump to month end** runs the meters to 1 November, closes October and creates 8 new invoices. Overnight, Asha's unpaid September bill gets a 5% late fee. Asha then pays with **Send the same request twice**: both requests use one idempotency key, so only one payment is stored.
8. **Admin → Audit trail** shows every change above and who made it. **Database rules** shows both databases rejecting bad data. **SQL lab** runs recursive, correlated, window and `HAVING` queries. **Inside the databases** shows the raw tables and documents, filtered for whoever is signed in.

## Commands

| Command | What it does |
|---|---|
| `npm run db:up` / `npm run db:down` | Start or stop the database containers |
| `npm run setup` | First-time setup (does nothing if the tables already exist) |
| `npm run reset` | Drop both databases and load the demo city again |
| `npm start` | Run the server (`npm run dev` restarts on file changes) |
| `npm test` | Run the tests against separate `*_test` databases |
| `npm run export` | Write every table to CSV and every collection to NDJSON in `data/export/` |

## How it is built

```
browser (public/)  ──HTTP + session cookie──▶  Express API (server/)  ──▶  PostgreSQL 17   accounts, properties, tariffs, bills,
                                                    │                                  payments, tickets, audit_log
                                                    └──────────────────────▶  MongoDB 8      meter readings (time series), anomalies,
                                                                                         field notes, alerts, device commands, change_log
```

- `db/postgres/` holds the schema (`01`), functions and procedures (`02`), triggers (`03`), and roles, grants and row-level security (`04`).
- `server/db/mongo.js` defines the collections, `$jsonSchema` validators and indexes.
- `server/sim/` contains the city clock, the meter simulator, anomaly detection and the automatic responses.
- `server/services/` contains the billing run, the bill forecast, the eco report and notifications.
- `server/routes/` contains the JSON API. Each request runs as the signed-in person's database role.
- `public/` is the single-page front end (plain JavaScript, no build step).
- `tests/` contains integration tests run with `node:test` against real databases.

More detail is in [docs/architecture.md](docs/architecture.md), [docs/database.md](docs/database.md) and [docs/api.md](docs/api.md).

## Security notes

- Passwords are hashed with scrypt and a random salt for each user. Session tokens are random 32-byte values; only their SHA-256 hash is stored.
- Cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` when `SECURE_COOKIES=true`. Every state-changing request must carry the `X-Requested-With: smart-city` header.
- Row-level security is enforced inside PostgreSQL. The app roles cannot read `password_hash` or `token_hash`, and cannot change `audit_log`.
- Credentials live only in `.env`, which is git-ignored. `.env.example` contains placeholders only.

## Team

Dhanush and Gagan, DBMS mini-project, 2026.
