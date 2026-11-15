// /api/db: "Inside the databases" for every role, plus the admin's Database rules and SQL lab.
// Table browsing runs as the signed-in person's role, so row-level security and column grants decide what comes back.
const express = require('express');
const { requireUser, requireRole } = require('../auth');
const { asUser } = require('../db/pg');
const mongo = require('../db/mongo');
const { S } = require('../sim/state');
const { validateReading } = require('../sim/meters');
const { cityDate } = require('../time');
const { h, need, pgErrorText, logPg, logMg } = require('./util');

const r = express.Router();
r.use(requireUser);

const TABLES = {
  zone: 'zone_id', resident: 'citizen_ref', property: 'property_code', utility_meter: 'meter_code', billing_cycle: 'cycle_id DESC', utility_rate: 'rate_id',
  aggregation_run: 'started_at DESC', meter_reading: 'reading_timestamp DESC', invoice: 'invoice_no DESC', invoice_line_item: 'invoice_id, utility_type, tier_level',
  payment: 'payment_date DESC', maintenance_ticket: 'ticket_no DESC', ticket_status_history: 'history_id DESC', app_user: 'email', user_session: 'created_at DESC',
  auth_event: 'event_id DESC', audit_log: 'audit_id DESC', sim_clock: 'id',
};
// the secret columns are not granted to any role, so these two tables are read with an explicit column list
const COLS = {
  app_user: 'user_id, email, role, resident_id, staff_zone_id, display_name, is_active, failed_logins, locked_until, created_at, last_login_at',
  user_session: 'session_id, user_id, created_at, expires_at, last_seen_at, ended_at, end_reason, ip, user_agent',
};

r.get('/table/:name', h(async (req, res) => {
  const t = req.params.name;
  need(TABLES[t], 404, 'No such table.');
  const sql = `SELECT ${COLS[t] || '*'} FROM ${t} ORDER BY ${TABLES[t]} LIMIT 25`;
  try {
    const out = await asUser(req.user, async c => {
      const { rows, fields } = await c.query(sql);
      const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
      return { rows, columns: fields.map(f => f.name), total: n };
    });
    res.json({ ...out, sql, tables: Object.keys(TABLES) });
  } catch (e) {
    if (!e.code) throw e;
    logPg(req.user, `Reading ${t} was refused`, sql + ';', e);
    res.json({ rows: [], columns: [], total: 0, sql, error: pgErrorText(e), tables: Object.keys(TABLES) });
  }
}));

const COLLECTIONS = ['meter_readings', 'anomaly_events', 'maintenance_logs', 'notifications', 'device_commands', 'demand_events', 'ingestion_batches', 'change_log'];
async function mongoFilter(user, name) {
  if (user.role === 'ADMIN') return {};
  const { codes, tickets } = await asUser(user, async c => ({
    codes: (await c.query('SELECT property_code FROM property')).rows.map(x => x.property_code),
    tickets: (await c.query('SELECT ticket_no FROM maintenance_ticket')).rows.map(x => x.ticket_no),
  }));
  if (name === 'meter_readings') return { 'meta.property_code': { $in: codes } };
  if (user.role === 'RESIDENT') {
    if (name === 'notifications') return { user_id: user.user_id };
    return null;
  }
  if (['anomaly_events', 'device_commands'].includes(name)) return { property_code: { $in: codes } };
  if (name === 'maintenance_logs') return { ticket_no: { $in: tickets } };
  return null;
}

r.get('/collection/:name', h(async (req, res) => {
  const name = req.params.name;
  need(COLLECTIONS.includes(name), 404, 'No such collection.');
  const f = await mongoFilter(req.user, name);
  if (!f) return res.json({ docs: [], total: 0, hidden: true, collections: COLLECTIONS });
  const sort = name === 'meter_readings' ? { ts: -1 } : { _id: -1 };
  const [docs, total] = await Promise.all([mongo.col(name).find(f).sort(sort).limit(12).toArray(), mongo.col(name).countDocuments(f)]);
  const info = (await mongo.db.listCollections({ name }).toArray())[0];
  res.json({ docs, total, collections: COLLECTIONS, filter: f, options: info ? { type: info.type, timeseries: info.options.timeseries, validator: !!info.options.validator } : null });
}));

// ---------- Database rules: statements PostgreSQL and MongoDB must refuse (always rolled back) ----------
const RULES = [
  { title: 'Billing cycle with month 13', db: 'pg', sql: "INSERT INTO billing_cycle (year, month, cycle_start_date, cycle_end_date, due_date)\nVALUES (2026, 13, '2026-12-01', '2026-12-31', '2027-01-30');", why: 'CHECK (month BETWEEN 1 AND 12)' },
  { title: 'Second invoice for the same property and month', db: 'pg', sql: "INSERT INTO invoice (invoice_no, property_id, cycle_id, invoice_date)\nVALUES ('INV-DUP-1', (SELECT property_id FROM property WHERE property_code = 'P-0001'), 3, '2026-09-30');", why: 'UNIQUE (property_id, cycle_id)' },
  { title: 'Overlapping electricity tariff', db: 'pg', sql: "INSERT INTO utility_rate (utility_type, tier_level, min_units, max_units, price_per_unit, effective_start_date)\nVALUES ('ELECTRICITY', 1, 0, 100, 4.50, '2026-10-01');", why: 'EXCLUDE USING gist (… daterange WITH &&)' },
  { title: 'Resident with a real-looking ID number', db: 'pg', sql: "INSERT INTO resident (citizen_ref, full_name, email, phone)\nVALUES ('1234-5678-9012', 'Test Person', 'test@example.test', '+919000000099');", why: "CHECK (citizen_ref ~ '^SYN-[0-9]{5}$')" },
  { title: "Change a meter reading that's already billed", db: 'pg', sql: "UPDATE meter_reading SET closing_register = closing_register - 50\nWHERE meter_id = (SELECT meter_id FROM utility_meter WHERE meter_code = 'MTR-E-0001') AND cycle_id = 3;", why: 'trigger trg_reading_locked' },
  { title: 'Second successful payment for a paid invoice', db: 'pg', sql: "INSERT INTO payment (invoice_id, idempotency_key, amount_paid, payment_method, status, payment_date)\nSELECT invoice_id, 'manual-retry-77', total_amount, 'CASH', 'SUCCEEDED', now()\nFROM invoice WHERE invoice_no = 'INV-2026-07-0001';", why: "partial unique index uq_one_success_per_invoice" },
  { title: 'Edit the audit trail', db: 'pg', sql: "DELETE FROM audit_log WHERE table_name = 'payment';", why: 'admin_role has SELECT only on audit_log' },
  { title: 'Malformed anomaly event (MongoDB validator)', db: 'mg', sql: 'db.anomaly_events.insertOne({\n  key: "LEAK:MTR-W-0001", type: "FLOOD",   // not an allowed type\n  meter_code: "W-1",                       // wrong pattern\n  property_code: "P-0001", severity: "URGENT",\n  detected_at: new Date(), last_seen: new Date(), hits: 0, status: "OPEN"\n})', why: '$jsonSchema validator, validationAction: "error"' },
  { title: 'Malformed meter reading (ingestion check)', db: 'mg', sql: '// time-series collections cannot carry a validator,\n// so the server checks every reading before insertMany\n{ ts: ISODate("2026-10-25T09:00:00Z"),\n  meta: { utility: "WATER" },     // meter_code missing\n  flow_lpm: -4.2 }                // negative flow', why: 'validateReading() in server/sim/meters.js' },
];

r.get('/rules', requireRole('ADMIN'), (req, res) => res.json({ rules: RULES.map(({ title, db, sql, why }) => ({ title, db, sql, why })) }));

r.post('/rules/:i', requireRole('ADMIN'), h(async (req, res) => {
  const rule = RULES[Number(req.params.i)];
  need(rule, 404, 'No such rule.');
  if (rule.db === 'pg') {
    let error = null;
    const ROLLBACK = new Error('rollback');
    try {
      await asUser(req.user, async c => { await c.query(rule.sql); throw ROLLBACK; });   // never kept, even if it were accepted
    } catch (e) { if (e !== ROLLBACK) error = e; }
    logPg(req.user, error ? `Rejected: ${rule.title}` : `Accepted (rolled back): ${rule.title}`, rule.sql, error || { message: 'rolled back' });
    return res.json({ rejected: !!error, error: error ? pgErrorText(error) : 'Accepted (unexpected). The transaction was rolled back anyway.' });
  }
  if (rule.title.startsWith('Malformed anomaly')) {
    try {
      const doc = { key: 'LEAK:MTR-W-0001', type: 'FLOOD', meter_code: 'W-1', property_code: 'P-0001', severity: 'URGENT', detected_at: new Date(S.cityNow), last_seen: new Date(S.cityNow), hits: 0, status: 'OPEN' };
      const ins = await mongo.col('anomaly_events').insertOne(doc);
      await mongo.col('anomaly_events').deleteOne({ _id: ins.insertedId });
      return res.json({ rejected: false, error: 'Accepted (unexpected); the document was removed again.' });
    } catch (e) {
      const text = `MongoServerError: ${e.message}\n${e.errInfo ? JSON.stringify(e.errInfo.details, null, 1).slice(0, 1800) : ''}`;
      logMg(req.user, `Rejected: ${rule.title}`, rule.sql, text);
      return res.json({ rejected: true, error: text });
    }
  }
  const errs = validateReading({ ts: new Date('2026-10-25T09:00:00Z'), meta: { utility: 'WATER' }, flow_lpm: -4.2 });
  const text = `400 Bad Request: reading rejected before insert\n${errs.map(e => '  - ' + e).join('\n')}`;
  logMg(req.user, `Rejected: ${rule.title}`, rule.sql, text);
  res.json({ rejected: true, error: text });
}));

// ---------- SQL lab: the query catalogue, run for real ----------
const QUERIES = {
  q1: { title: 'Recursive CTE: zone roll-up', param: 'zone', sql: `WITH RECURSIVE subtree AS (
  SELECT zone_id FROM zone WHERE zone_id = $1          -- anchor
  UNION ALL
  SELECT z.zone_id FROM zone z
  JOIN subtree s ON z.parent_zone_id = s.zone_id     -- walk down
)
SELECT um.utility_type, COUNT(DISTINCT p.property_id) AS properties,
       SUM(mr.total_units_consumed) AS units_september
FROM subtree s
JOIN property p        ON p.zone_id = s.zone_id
JOIN utility_meter um  ON um.property_id = p.property_id
JOIN meter_reading mr  ON mr.meter_id = um.meter_id AND mr.cycle_id = 3
GROUP BY um.utility_type
ORDER BY um.utility_type;` },
  q3: { title: 'Nested + JOIN + HAVING: residents with overdue bills', param: 'th', sql: `SELECT z.name AS zone, r.full_name, r.email, COUNT(*) AS overdue_bills,
       round(SUM(i.total_amount) / 100.0, 2) AS overdue_inr
FROM resident r
JOIN property p ON p.resident_id = r.resident_id
JOIN zone z     ON z.zone_id = p.zone_id
JOIN invoice i  ON i.property_id = p.property_id
WHERE i.payment_status = 'OVERDUE'
  AND r.resident_id IN (SELECT resident_id FROM resident WHERE is_active)
GROUP BY z.name, r.full_name, r.email
HAVING COUNT(*) >= $1
ORDER BY overdue_inr DESC;` },
  q2: { title: 'Correlated subquery: above the district average', sql: `SELECT p.property_code, p.property_type, mr.total_units_consumed AS kwh
FROM property p
JOIN utility_meter um ON um.property_id = p.property_id AND um.utility_type = 'ELECTRICITY'
JOIN meter_reading mr ON mr.meter_id = um.meter_id AND mr.cycle_id = 3
WHERE mr.total_units_consumed > 1.3 * (
  SELECT AVG(mr2.total_units_consumed)          -- re-evaluated for every outer row
  FROM property p2
  JOIN zone z2           ON z2.zone_id = p2.zone_id
  JOIN utility_meter um2 ON um2.property_id = p2.property_id AND um2.utility_type = 'ELECTRICITY'
  JOIN meter_reading mr2 ON mr2.meter_id = um2.meter_id AND mr2.cycle_id = 3
  WHERE z2.parent_zone_id = (SELECT parent_zone_id FROM zone WHERE zone_id = p.zone_id)
    AND p2.property_id <> p.property_id
);` },
  c1: { title: 'CTE + window function: month-over-month change', sql: `WITH monthly AS (
  SELECT p.property_code, mr.cycle_id, mr.total_units_consumed AS kwh
  FROM meter_reading mr
  JOIN utility_meter um ON um.meter_id = mr.meter_id AND um.utility_type = 'ELECTRICITY'
  JOIN property p       ON p.property_id = um.property_id
), changes AS (
  SELECT property_code, cycle_id, kwh,
         LAG(kwh) OVER (PARTITION BY property_code ORDER BY cycle_id) AS prev_kwh
  FROM monthly
)
SELECT property_code, prev_kwh AS august, kwh AS september,
       ROUND(100.0 * (kwh - prev_kwh) / prev_kwh, 1) AS change_pct
FROM changes WHERE cycle_id = 3
ORDER BY change_pct DESC;` },
  c2: { title: 'CTE: receivables ageing', param: 'today', sql: `WITH open_bills AS (
  SELECT i.invoice_no, i.total_amount, bc.due_date,
         $1::date - bc.due_date AS days_late           -- $1 = today on the city clock
  FROM invoice i JOIN billing_cycle bc USING (cycle_id)
  WHERE i.payment_status IN ('PENDING', 'OVERDUE')
)
SELECT CASE WHEN days_late <= 0  THEN 'not yet due'
            WHEN days_late <= 30 THEN '1–30 days'
            WHEN days_late <= 60 THEN '31–60 days'
            ELSE '60+ days' END AS bucket,
       COUNT(*) AS bills, round(SUM(total_amount) / 100.0, 2) AS amount_inr
FROM open_bills GROUP BY 1 ORDER BY MIN(days_late);` },
};

r.get('/sql', requireRole('ADMIN'), h(async (req, res) => {
  const zones = await asUser(req.user, async c => (await c.query('SELECT zone_id, name FROM zone ORDER BY zone_id')).rows);
  res.json({ queries: Object.entries(QUERIES).map(([id, q]) => ({ id, title: q.title, param: q.param || null })), zones });
}));

r.get('/sql/:id', requireRole('ADMIN'), h(async (req, res) => {
  const q = QUERIES[req.params.id];
  need(q, 404, 'No such query.');
  const params = q.param === 'zone' ? [Number(req.query.zone) || 2] : q.param === 'th' ? [Number(req.query.th) || 2] : q.param === 'today' ? [cityDate(S.cityNow)] : [];
  const t0 = process.hrtime.bigint();
  const { rows, fields } = await asUser(req.user, c => c.query(q.sql, params));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  logPg(req.user, `SQL lab: ${q.title} (${rows.length} rows)`, q.sql.replace('$1', `$1 /* = ${JSON.stringify(params[0])} */`));
  res.json({ id: req.params.id, title: q.title, sql: q.sql, params, columns: fields.map(f => f.name), rows: rows.map(x => fields.map(f => x[f.name])), ms });
}));

module.exports = r;
