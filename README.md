# Smart City Utilities & Infrastructure Management System

DBMS Level 3 mini-project (PES University, Aug–Dec 2026) by **Dhanush** and **Gagan**.

A system that runs a simulated city's electricity, water and gas: smart meters report readings, residents get correct slab-based bills, and leaks or outages turn into maintenance tickets automatically.

It is built on **polyglot persistence**:

- **PostgreSQL** is the system of record for residents, properties, meters, tariffs, billing cycles, invoices, payments and tickets.
- **MongoDB** stores the raw smart-meter readings (time-series), anomaly events, ticket notes and notifications.
- A monthly **bridge** turns a meter's MongoDB readings into one `meter_reading` row in PostgreSQL, which the billing procedure uses.

> **About this version.** This is a working browser prototype. Both databases are simulated in memory in JavaScript, using the same 15 tables, 5 collections, constraints, triggers, procedures and row-level-security rules as our design. The side panel shows the exact SQL or MongoDB statement behind every action. All data is synthetic. The full build on real PostgreSQL 17, MongoDB 8 and Next.js follows the plan in [`docs/design/project-plan.md`](docs/design/project-plan.md).

## Smart features

What makes the city "smart" is that it acts on its own data, not only stores it:

| Feature | What happens | Where |
|---|---|---|
| **Fault detection** | Leak, spike and missing-data rules run on every batch of meter readings and open a ticket with the reason. Repeats raise the count instead of creating duplicates. | Admin → City operations |
| **Smart dispatch with SLAs** | A new ticket goes straight to the engineer whose district contains the property and who has the fewest open jobs. Each severity has a deadline (critical 4 h, high 8 h, medium 24 h, low 72 h); a missed deadline is escalated once. | Staff → Ticket queue, Admin → All tickets |
| **Automatic valve shut-off** | When a critical leak is detected the smart water valve closes by itself, and it reopens when the repair is resolved. | Admin → Disaster simulator |
| **Peak demand response** | When the electricity feeder passes 90% of capacity, residents are asked to delay heavy appliances; the event ends below 80%. | Admin → City operations |
| **Bill forecast and high-bill warning** | Residents see what this month's bill is heading for, compared with their last three bills. If it is 20% above usual, or one utility is heading for 1.5× its usual units, they get an alert. | Resident → My dashboard |
| **Footprint & savings** | Carbon footprint per utility, comparison with similar homes in the same district, an eco score from A to E, and habit checks (night-time leak test, always-on load, peak-hour share) with the money each tip would save. | Resident → Footprint & savings |
| **Late fees and printable bills** | A nightly job marks unpaid bills past their due date as OVERDUE, adds a late-fee line at the cycle's penalty rate and alerts the resident. Any bill can be printed or saved as PDF. | Resident → Bills & payments |
| **Live city map** | Every property is a pin on the ward map, coloured by its live state; critical faults pulse. Click a pin for readings, bills, eco score and tickets. | Admin → City map |
| **Analytics and CSV export** | Collection rate, late fees, SLA performance, billed vs collected, consumption and CO₂ by month, a greenest-wards ranking, and CSV downloads of invoices, readings and tickets. | Admin → Analytics |

The three automatic actions (dispatch, valve shut-off, demand response) can be switched off in **Admin → Disaster simulator → Smart automation**, so you can show the difference.

## How to run

```bash
# 1. Get the code
git clone https://github.com/dhanushshekhar13-alt/smart-city-utilities.git
cd smart-city-utilities
```

### Recommended: shared data (needs Node.js 18+)

```bash
npm start              # same as: node server.js
```

Open the link it prints (http://localhost:8080). Nothing else to install: the server uses only Node's built-in modules.

With this server, the data lives on the server, not in the browser. Every browser that opens the site sees the **same** bills, tickets, payments and meter readings, and changes show up everywhere within about a second. Data is saved in `data/state.json`, so it survives a reload or a restart. To start again from the original city:

```bash
npm run reset          # same as: node server.js --reset
```

The top bar shows **Live · N browsers** while sharing is working.

### Two laptops (you and a friend) on the same data

Only **one** laptop runs the server (the host). The other laptop (the friend) only needs a browser.

1. Connect both laptops to the **same Wi-Fi**. College or office Wi-Fi often blocks laptops from seeing each other; if the steps below do not work, turn on a **phone hotspot** and connect both laptops to it.
2. **Host:** run `npm start`. It prints two links, for example:

   ```text
   On this laptop:      http://localhost:8080
   On another laptop:   http://192.168.1.23:8080   (same Wi-Fi or hotspot)
   ```

   If it does not print a second link, find the host's IP address yourself:
   - **Windows:** run `ipconfig` and use the **IPv4 Address** under your Wi-Fi adapter.
   - **macOS:** run `ipconfig getifaddr en0`.
   - **Linux:** run `hostname -I`.
3. **Allow the connection** the first time. Windows shows a Windows Defender Firewall prompt for Node.js: tick **Private networks** and press **Allow access**. macOS may ask whether node may accept incoming connections: press **Allow**.
4. **Friend:** open `http://<host-IP>:8080` in a browser, for example `http://192.168.1.23:8080`. No clone or install is needed on the friend's laptop.
5. Sign in on both laptops (for example Asha on one and Ravi on the other). A complaint Asha files appears in Ravi's queue; a bill paid on one laptop shows as PAID on the other; **Pause clock** pauses the city for both.

Keep the host's terminal open; closing it (or `Ctrl + C`) stops sharing. If the friend's top bar says **Offline · reconnecting**, the host's server has stopped or the laptops lost the network.

How it works: `server.js` keeps one copy of the data and serves the site. Each browser sends its changes to the server and checks for changes every second (`js/sync.js`). Only one browser at a time runs the meter clock, so the city time does not advance twice; if that laptop leaves, another one takes over within a few seconds. If two people change something in the same second, the later change wins.

### Without a server (single laptop, data not shared)

```bash
# Option A: open the file directly
open index.html            # macOS
xdg-open index.html        # Linux
start index.html           # Windows (Command Prompt or PowerShell)

# Option B: Python's built-in web server
python3 -m http.server 8080        # Windows: py -m http.server 8080
# then open http://localhost:8080
```

In this mode each browser has its own copy of the data and reloading the page resets it to the starting state (seed 42).

Stop any server with `Ctrl + C`.

## Demo accounts

Every account uses the password **`demo123`**.

| Role | Email | What they can do |
|---|---|---|
| Resident | `asha@example.test` | Dashboard, bill forecast, live usage, bills, pay, footprint & savings, complaints, alerts |
| Resident | `vikram@example.test` | Same, for Vikram's properties only |
| Staff (North District) | `ravi.staff@city.example.test` | Ticket queue for North District, status changes, notes |
| Staff (North District) | `neha.staff@city.example.test` | Second North District engineer, so smart dispatch has a choice |
| Staff (South District) | `kavya.staff@city.example.test` | Ticket queue for South District |
| Admin | `admin@city.example.test` | City operations, city map, analytics, disaster simulator, billing run, database rules, SQL lab |

The top bar has **Pause clock**, **+1 hour** (skips 4 readings) and **Jump to month end** to speed up the demo. Jump to month end runs the meters to midnight on 1 November, then the nightly job aggregates October, issues one bill per property, opens the November cycle and sends each resident a bill alert. If you skip ahead with **+1 hour** instead, the same job runs on its own when the clock passes midnight. It works once per run; `npm run reset` (or reloading the static page) starts October again. One tick is 2 real seconds and 15 city minutes.

To stop one home's usage without stopping the city, use **Turn off** next to a utility: on a resident's dashboard (Live usage panel) or for any home in **Admin → Disaster simulator → Switch a home's supply on or off**. The meter keeps reporting every 15 city-minutes with a usage of 0, so the clock keeps running and the bill counts only what was used while the supply was on. **Pause clock** in the top bar still stops the whole city.

## Demo script (about 10 minutes)

Run `npm run reset` first so the city starts on 25 October.

1. **Asha → My dashboard:** her property from PostgreSQL next to live meter charts from MongoDB, and the **October bill forecast** against her last three bills. Her eco score is on the property card.
2. **Asha → Bills & payments:** her September bill shows each tariff slab (100 × ₹5 + 200 × ₹8 + 150 × ₹12 = ₹3,900 for electricity) and is due on 30 October. Press **Print or save as PDF**. Press *Try to open Vikram's invoice*: row-level security returns 0 rows.
3. **Asha → Footprint & savings:** carbon footprint, how she compares with similar homes in North District, and the habit checks with what each tip saves.
4. **Admin → City map:** every pin is green. Open **Disaster simulator**, start **Pipe burst**, press **+1 hour**. A CRITICAL leak ticket opens, is assigned to Ravi automatically, and the water valve closes by itself. Back on the City map, Asha's pin pulses red.
5. **Admin → Disaster simulator → Electricity spike**, then **+1 hour**: grid load passes 90% and **City operations** shows the peak demand event and the residents who were asked to shift load.
6. **Asha → Complaints:** file a complaint while the leak is still open. It is dispatched to Neha, because she has fewer open jobs than Ravi.
7. **Ravi:** the ticket is already in his queue with an SLA countdown. Try *Try to close directly* (a trigger blocks it), move it to in progress, add a note (MongoDB), resolve it. The valve reopens and Asha gets a "water back on" alert.
8. **Jump to month end:** October closes and 8 new bills appear (on the other laptop too). Asha's unpaid September bill is now OVERDUE with a 5% late-fee line and she has an overdue alert. Pay it with *Send the same request twice*: one payment row, the invoice becomes PAID. **Admin → Analytics** shows billed vs collected and consumption by month; press **Invoices CSV** to download.
9. **Admin → Database rules** and **SQL lab:** watch bad data get rejected, and run the recursive, correlated, JOIN, CTE and window-function queries.

To show the high-bill warning: switch off **Automatic valve shut-off** in the Smart automation panel, start the pipe burst and press **+1 hour** a few times. Asha's forecast turns amber and she gets an alert.

## Project structure

```text
index.html            Page shell; loads the scripts below in order
server.js             Optional Node server: serves the site and shares one copy of the
                      data between browsers and laptops (data/state.json)
css/styles.css        Styles (light and dark theme)
js/db.js              In-memory PostgreSQL and MongoDB stores, constraint engine,
                      triggers, row-level security, activity log
js/billing.js         fn_tiered_charge and sp_generate_invoice
js/seed.js            Synthetic city: 7 zones, 6 residents, 8 properties, 24 meters,
                      4 billing cycles, 8 tariff slabs, history, 5 users
js/simulator.js       Smart-meter simulator, anomaly rules (leak, spike, missing data),
                      Mongo-to-PostgreSQL ticket hand-off, aggregations
js/app.js             Sessions, resident / staff / admin screens, events, smart dispatch,
                      valve shut-off, demand response, bill forecast, late fees
js/eco.js             Footprint & savings: carbon, neighbour comparison, eco score, tips
js/city.js            Admin city map, analytics and CSV export
js/sync.js            Live sharing with server.js (does nothing when opened without it)
docs/design/          Project plan, Chen ER diagram and schema PDF
docs/viva/            Viva question bank (Markdown and PDF) and smart-features notes
```

## Database design at a glance

- **15 PostgreSQL tables:** `zone`, `resident`, `property`, `utility_meter`, `billing_cycle`, `utility_rate`, `aggregation_run`, `meter_reading`, `invoice`, `invoice_line_item`, `payment`, `maintenance_ticket`, `ticket_status_history`, `app_user`, `user_session`.
- **MongoDB collections:** `meter_readings` (time-series), `anomaly_events`, `maintenance_logs`, `notifications`, `ingestion_batches`, `device_commands` (valve commands) and `demand_events` (peak demand).
- **Rules shown in the app:** CHECK, UNIQUE, partial unique indexes, an EXCLUDE constraint on tariff dates, six triggers, idempotent payments, and RLS for three roles (`resident_role`, `staff_role`, `admin_role`).

Chen-notation ER diagram: [`docs/design/er-diagram-chen.pdf`](docs/design/er-diagram-chen.pdf) (also as [PNG](docs/design/er-diagram-chen.png)). Full details: [`docs/design/er-diagram-and-schema.pdf`](docs/design/er-diagram-and-schema.pdf) and [`docs/design/project-plan.pdf`](docs/design/project-plan.pdf).

## Limitations of this version

- Databases are simulated in the browser. With `server.js` the data is shared and saved to a file; without it, data resets on reload.
- Login uses a shared demo password; there is no real password hashing.
- Payments are simulated; no money moves.
- Small synthetic dataset (8 properties, 24 meters); no performance claims.
- Carbon factors are approximate averages, for comparison only.

## Team

- **Dhanush:** PostgreSQL schema, billing, security
- **Gagan:** MongoDB, simulator, user interface
