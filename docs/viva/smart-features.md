# Smart features: how they work and what to say in the viva

Each feature below is built on data the system already stores. For each one: what it does, which tables or collections it uses, and short answers to the questions examiners usually ask.

## 1. Smart dispatch with SLA deadlines

**What it does.** When the anomaly detector (or a resident's complaint) opens a ticket, it is assigned straight away to the engineer who covers that property's district and has the fewest open jobs. Every ticket gets a deadline from its severity: critical 4 h, high 8 h, medium 24 h, low 72 h. A ticket past its deadline is escalated once.

**Data.**
- `maintenance_ticket.assigned_to`, `sla_due_at` and `escalated_at`.
- `app_user.staff_zone_id`, plus `zone.parent_zone_id` to walk from ward to district.
- Every change is written to `ticket_status_history` by the trigger, with `changed_by = NULL` for automatic actions.

**Query behind it (recursive CTE):**

```sql
WITH RECURSIVE up AS (
  SELECT zone_id, parent_zone_id FROM zone
  WHERE zone_id = (SELECT zone_id FROM property WHERE property_code = 'P-0001')
  UNION ALL
  SELECT z.zone_id, z.parent_zone_id FROM zone z JOIN up ON z.zone_id = up.parent_zone_id)
SELECT u.user_id, COUNT(t.ticket_id) AS open_jobs
FROM app_user u
LEFT JOIN maintenance_ticket t ON t.assigned_to = u.user_id AND t.status IN ('ASSIGNED','IN_PROGRESS')
WHERE u.role = 'STAFF' AND u.staff_zone_id IN (SELECT zone_id FROM up)
GROUP BY u.user_id ORDER BY open_jobs, u.user_id LIMIT 1;
```

**If asked:**
- *Why recursive?* Staff are attached to a district, but properties sit in wards. The CTE walks up the zone tree, so it still works if we add more levels, such as sub-wards.
- *What about ties?* `ORDER BY open_jobs, user_id` makes the choice deterministic.

## 2. Automatic valve shut-off

**What it does.** When a critical leak ticket opens, the system sends a CLOSE_VALVE command to that meter's smart valve. Water flow drops to 0 and the waste stops. Resolving the ticket sends OPEN_VALVE.

**Data.**
- MongoDB `device_commands`: `{ meter_code, command, reason, issued_by, issued_at, status, acked_at }`.
- A DEVICE entry in the ticket's `maintenance_logs`, and a notification to the resident.

**If asked:**
- *Why MongoDB?* Commands are device events with a flexible shape (different devices take different commands). They are not financial records.
- *Can it be turned off?* Yes. Admin → Disaster simulator → Smart automation.

## 3. Peak demand response

**What it does.** The app adds up the latest electricity reading of every meter and compares it with the feeder capacity (15 kW for our 8 properties). Above 90% it starts a demand event and asks residents to delay heavy appliances. Below 80% the event ends. The gap between 90% and 80% (hysteresis) stops the alert from flapping on and off.

**Data.** MongoDB `demand_events`: `{ started_at, start_kw, peak_kw, notified, ended_at, status }`, plus one notification per resident.

## 4. Bill forecast and high-bill warning

**What it does.**
- Forecast = units used so far this month + (last 24 hours' rate × hours left).
- The forecast is priced with the same `fn_tiered_charge` slabs as the real bill.
- It is compared with the usage lines of the last three invoices.
- An alert is sent once per property per month if the forecast is 20% above usual, or one utility is heading for 1.5× its usual units.
- No alert is sent in the first 3 days of a month, when there is too little data.

**Data.**
- Units so far: the first and last register in MongoDB `meter_readings`.
- History: `invoice_line_item` (line_kind = 'USAGE') and `meter_reading.total_units_consumed`.
- Duplicate alerts are stopped by a unique `ref` on the notification, `FORECAST:<property>:<cycle>`, written with an upsert.

**If asked:**
- *Why not machine learning?* Three months of history is too little to train on. A rate-based projection is explainable: a resident can check it by hand.

## 5. Footprint & savings (carbon, neighbour comparison, eco score, tips)

**What it does.**
- **Carbon:** units × an emission factor. Electricity ≈ 0.71 kg CO₂ per kWh (Indian grid average), gas ≈ 2.0 kg per m³, water ≈ 0.35 kg per kL (pumping and treatment). These are approximate and used only for comparison.
- **Neighbour comparison:** your units against the median of properties of the same type in the same district. If there are fewer than 3, the comparison widens to the whole city.
- **Eco score (0–100, A to E):** starts at 70. It moves with each utility against the median, then adjusts for habits:
  - −25 for a likely leak
  - −5 for a high always-on load
  - ±5 for the share of use at peak hours
- **Habit checks on the last 24 h of readings:**
  - Leak test: the lowest water flow between 1 and 5 am should be close to 0.
  - Continuous flow: flow that never stops for 3 hours.
  - Always-on load: the lowest electricity draw.
  - Peak share: the share of electricity used between 6 and 10 pm.
- **Savings:** each tip's saving uses the resident's marginal tariff slab, which is the price of the next unit they would have used.

**Query (window function):**

```sql
SELECT m.utility_type, r.total_units_consumed,
  PERCENT_RANK() OVER (PARTITION BY p.property_type, w.parent_zone_id, m.utility_type
                       ORDER BY r.total_units_consumed) AS pct_rank
FROM meter_reading r JOIN utility_meter m USING (meter_id)
JOIN property p USING (property_id) JOIN zone w ON w.zone_id = p.zone_id
WHERE r.cycle_id = 3;
```

**If asked:**
- *Why compare only similar properties?* A bakery and a flat cannot be compared fairly. The `PARTITION BY` on type and district is what makes the comparison fair.

## 6. Late fees and printable bills

**What it does.** A nightly job runs at city midnight. It marks PENDING bills past their due date as OVERDUE and adds one LATE_FEE line per utility at the cycle's `late_penalty_percent` (5%). The `invoice.total_amount` trigger updates the total, and the resident gets an alert. Any bill can be printed or saved as a PDF from the browser.

```sql
UPDATE invoice i SET payment_status = 'OVERDUE'
FROM billing_cycle c
WHERE c.cycle_id = i.cycle_id AND i.payment_status = 'PENDING' AND c.due_date < CURRENT_DATE;

INSERT INTO invoice_line_item (invoice_id, utility_type, line_kind, rate_applied, line_total)
SELECT i.invoice_id, l.utility_type, 'LATE_FEE', c.late_penalty_percent,
       ROUND(SUM(l.line_total) * c.late_penalty_percent / 100)
FROM invoice i JOIN billing_cycle c USING (cycle_id) JOIN invoice_line_item l USING (invoice_id)
WHERE i.payment_status = 'OVERDUE' AND l.line_kind = 'USAGE'
  AND NOT EXISTS (SELECT 1 FROM invoice_line_item x WHERE x.invoice_id = i.invoice_id AND x.line_kind = 'LATE_FEE')
GROUP BY i.invoice_id, l.utility_type, c.late_penalty_percent;
```

**If asked:**
- *Can it charge twice?* No. The `NOT EXISTS` makes the job safe to re-run.
- *Why is the fee a separate line?* So the bill shows exactly why the amount changed, and a refund means removing one line.

## 7. Live city map and analytics

**City map.**
- Each property is a pin on its ward, coloured by live state: green normal, amber open ticket, red critical (pulsing), grey meter offline.
- A dashed ring means the valve is closed.
- The map joins PostgreSQL (tickets, bills) with the latest MongoDB reading per meter.

**Analytics.**
- **Collection rate:** only bills past their due date count, so new bills do not drag it down.
- Late fees, ticket resolution time and SLA met %.
- Billed vs collected per month (`GROUP BY ROLLUP` with `FILTER`).
- City consumption and CO₂ by month, from `meter_reading`.
- A greenest-wards ranking by CO₂ per property.
- **CSV export:** invoices, monthly readings and tickets. In production this is a `COPY (...) TO STDOUT WITH CSV HEADER`.

## One-line answers

- **What makes it smart?** It acts on its own data: it detects faults, dispatches engineers, closes valves, sheds peak load, forecasts bills and coaches residents. None of these needs a person to start it.
- **Is any of it random?** Readings are simulated, but every decision follows a fixed rule that you can read in the statement log.
- **What would change in production?** The same rules run as PostgreSQL jobs (pg_cron) and a MongoDB change stream instead of browser timers. The tables and collections stay the same.
