// /api/me: the resident portal. Every PostgreSQL read runs as resident_role, so row-level security decides
// which properties, meters, invoices and tickets come back.
const express = require('express');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { requireRole } = require('../auth');
const { asUser, asOwner, query } = require('../db/pg');
const mongo = require('../db/mongo');
const { S, ctx, loadMeters } = require('../sim/state');
const engine = require('../sim/engine');
const automation = require('../sim/automation');
const { forecast } = require('../services/forecast');
const { ecoReport } = require('../services/eco');
const { logEntry } = require('../services/notify');
const { HOUR } = require('../time');
const { h, need, isUuid, logPg, logMg } = require('./util');

const r = express.Router();
r.use(requireRole('RESIDENT'));
const RATE = { ELECTRICITY: 'kw', WATER: 'flow_lpm', GAS: 'flow_m3h' };

const PROPS_SQL = `SELECT p.property_id, p.property_code, p.address_line, p.city, p.pincode, p.property_type, p.square_feet, p.service_status,
    z.name AS zone_name, d.name AS district_name
  FROM property p JOIN zone z ON z.zone_id = p.zone_id LEFT JOIN zone d ON d.zone_id = z.parent_zone_id ORDER BY p.property_code`;

async function series(code, hours = 24) {
  const f = RATE[code[4] === 'E' ? 'ELECTRICITY' : code[4] === 'W' ? 'WATER' : 'GAS'];
  const docs = await mongo.col('meter_readings').find({ 'meta.meter_code': code, ts: { $gt: new Date(S.cityNow - hours * HOUR), $lte: new Date(S.cityNow) } })
    .project({ _id: 0, ts: 1, [f]: 1 }).sort({ ts: 1 }).toArray();
  return docs.map(d => ({ t: d.ts.getTime(), v: d[f] }));
}
const meterFlags = code => { const m = S.byCode.get(code); return m ? { offline: S.offline.has(code), supply_on: m.supply_on, valve_open: m.valve_open, fault: S.faults[code] || null } : {}; };

r.get('/properties', h(async (req, res) => {
  res.json({ properties: await asUser(req.user, async c => (await c.query(PROPS_SQL)).rows) });
}));

r.get('/home', h(async (req, res) => {
  const ut = ['ELECTRICITY', 'WATER', 'GAS'].includes(req.query.ut) ? req.query.ut : 'ELECTRICITY';
  const out = await asUser(req.user, async c => {
    const props = (await c.query(PROPS_SQL)).rows;
    need(props.length, 404, 'No property is linked to your account.');
    const p = props.find(x => x.property_id === req.query.property) || props[0];
    const meters = (await c.query('SELECT meter_code, utility_type, meter_model, installation_date FROM utility_meter WHERE property_id = $1 ORDER BY utility_type', [p.property_id])).rows;
    const unpaid = (await c.query(`SELECT i.invoice_no, i.total_amount, i.payment_status, bc.due_date FROM invoice i JOIN billing_cycle bc USING (cycle_id)
      WHERE i.property_id = $1 AND i.payment_status <> 'PAID' ORDER BY bc.due_date`, [p.property_id])).rows;
    const f = await forecast(c, p.property_id, S.cityNow);
    const eco = await ecoReport(c, p.property_id, S.cityNow);
    return { props, p, meters, unpaid, f, eco };
  });
  const m = out.meters.find(x => x.utility_type === ut);
  const unread = await mongo.col('notifications').countDocuments({ user_id: req.user.user_id, read_at: null });
  res.json({ properties: out.props, property: out.p, meters: out.meters.map(x => ({ ...x, ...meterFlags(x.meter_code) })), unpaid: out.unpaid,
    forecast: out.f, eco: { score: out.eco.score, grade: out.eco.grade }, unread, ut, meter: m && { ...m, ...meterFlags(m.meter_code) },
    series: m ? await series(m.meter_code) : [] });
}));

r.get('/invoices', h(async (req, res) => {
  const invoices = await asUser(req.user, async c => (await c.query(`SELECT i.invoice_id, i.invoice_no, i.cycle_id, i.total_amount, i.payment_status, i.paid_at,
      p.property_code, bc.month, bc.year, bc.due_date, bc.status AS cycle_status
    FROM invoice i JOIN property p USING (property_id) JOIN billing_cycle bc USING (cycle_id)
    ORDER BY i.cycle_id DESC, i.invoice_no`)).rows);
  // the row-level security demo: someone else's latest invoice (looked up with owner rights, then requested as you)
  const { rows: [other] } = await query(`SELECT i.invoice_id, r.full_name FROM invoice i JOIN property p USING (property_id) JOIN resident r USING (resident_id)
    WHERE r.resident_id <> $1 ORDER BY (r.email = 'vikram@example.test') DESC, (r.email = 'asha@example.test') DESC, i.cycle_id DESC LIMIT 1`, [req.user.resident_id]);
  res.json({ invoices, other: other ? { invoice_id: other.invoice_id, owner: other.full_name.split(' ')[0] } : null });
}));

r.get('/invoices/:id', h(async (req, res) => {
  need(isUuid(req.params.id), 404, 'No such invoice.');
  const out = await asUser(req.user, async c => {
    const { rows: [inv] } = await c.query(`SELECT i.*, p.property_code, p.address_line, p.city, p.pincode, p.property_type, z.name AS zone_name, d.name AS district_name,
        r.full_name, r.citizen_ref, bc.month, bc.year, bc.cycle_start_date, bc.cycle_end_date, bc.due_date, bc.late_penalty_percent
      FROM invoice i JOIN property p USING (property_id) JOIN resident r USING (resident_id) JOIN zone z ON z.zone_id = p.zone_id
      LEFT JOIN zone d ON d.zone_id = z.parent_zone_id JOIN billing_cycle bc USING (cycle_id) WHERE i.invoice_id = $1`, [req.params.id]);
    if (!inv) return null;
    const lines = (await c.query(`SELECT li.utility_type, li.line_kind, li.tier_level, li.units_consumed, li.rate_applied, li.line_total, ur.min_units, ur.max_units
      FROM invoice_line_item li LEFT JOIN utility_rate ur USING (rate_id) WHERE li.invoice_id = $1
      ORDER BY li.line_kind = 'LATE_FEE', li.utility_type, li.tier_level`, [req.params.id])).rows;
    const payments = (await c.query('SELECT payment_date, payment_method, status, transaction_id, failure_reason, amount_paid FROM payment WHERE invoice_id = $1 ORDER BY payment_date', [req.params.id])).rows;
    return { invoice: inv, lines, payments };
  });
  need(out, 404, 'No such invoice.');
  res.json(out);
}));

// try to read another resident's invoice: PostgreSQL returns 0 rows to resident_role
r.get('/rls-probe/:id', h(async (req, res) => {
  need(isUuid(req.params.id), 404, 'No such invoice.');
  const { rowCount } = await asUser(req.user, c => c.query('SELECT * FROM invoice WHERE invoice_id = $1', [req.params.id]));
  const { rows: [real] } = await query('SELECT i.invoice_no, r.full_name FROM invoice i JOIN property p USING (property_id) JOIN resident r USING (resident_id) WHERE i.invoice_id = $1', [req.params.id]);
  logPg(req.user, rowCount ? 'Invoice returned' : `Row-level security returned 0 rows for ${real ? real.invoice_no : 'that invoice'}`,
    `SELECT * FROM invoice WHERE invoice_id = '${req.params.id.slice(0, 8)}…';\n-- policy invoice_resident_read: property_id IN (SELECT app_property_ids())\n-- (${rowCount} rows)`);
  res.json({ rows: rowCount, invoice_no: real && real.invoice_no, owner: real && real.full_name });
}));

r.post('/invoices/:id/pay', h(async (req, res) => {
  need(isUuid(req.params.id), 404, 'No such invoice.');
  const { method = 'UPI_SIM', outcome = 'OK', twice = false } = req.body || {};
  need(['UPI_SIM', 'CARD_SIM', 'NETBANK_SIM'].includes(method), 400, 'Pick a payment method.');
  need(['OK', 'FAIL'].includes(outcome), 400, 'Pick a gateway outcome.');
  const key = String((req.body && req.body.key) || 'idem-' + crypto.randomBytes(6).toString('hex')).slice(0, 80);
  const call = async () => asUser(req.user, async c => (await c.query('CALL sp_record_payment($1, $2, $3, $4)', [req.params.id, method, key, outcome])).rows[0]);
  const stmt = `CALL sp_record_payment('${req.params.id.slice(0, 8)}…', '${method}', '${key}', '${outcome}');`;
  const results = [];
  try {
    results.push(await call());
    logPg(req.user, results[0].p_status === 'SUCCEEDED' ? 'Payment succeeded: invoice is now PAID (trigger trg_payment_settles_invoice)' : 'Payment declined: attempt stored as FAILED, bill stays unpaid', stmt);
    if (twice) {
      results.push(await call());
      logPg(req.user, 'Same request received again: original result returned, nothing new written', `${stmt}\n-- idempotency_key '${key}' already exists → returns payment ${results[1].p_payment.slice(0, 8)}…`);
    }
  } catch (e) {
    logPg(req.user, 'Payment rejected', stmt, e);
    throw e;
  }
  const count = (await asUser(req.user, c => c.query('SELECT count(*)::int AS n FROM payment WHERE idempotency_key = $1', [key]))).rows[0].n;
  res.json({ key, results: results.map(x => ({ payment_id: x.p_payment, status: x.p_status, repeat: x.p_repeat })), stored: count });
}));

r.get('/tickets', h(async (req, res) => {
  const tickets = await asUser(req.user, async c => (await c.query(`SELECT t.ticket_id, t.ticket_no, t.issue_type, t.severity, t.status, t.source, t.reported_timestamp,
      t.sla_due_at, t.resolved_at, p.property_code, sd.display_name AS assigned_name
    FROM maintenance_ticket t JOIN property p USING (property_id) LEFT JOIN staff_directory sd ON sd.user_id = t.assigned_to
    ORDER BY t.reported_timestamp DESC`)).rows);
  res.json({ tickets });
}));

r.post('/tickets', h(async (req, res) => {
  const { property_id, issue_type, description } = req.body || {};
  need(isUuid(property_id), 400, 'Pick a property.');
  need(['LOW_PRESSURE', 'POWER_OUTAGE', 'METER_MALFUNCTION', 'BILLING', 'OTHER'].includes(issue_type), 400, 'Pick an issue.');
  const desc = String(description || '').trim().slice(0, 1000);
  need(desc.length >= 5, 400, 'Describe the problem in a few words.');
  const stmt = `INSERT INTO maintenance_ticket (property_id, source, issue_type, severity, description, reported_timestamp, last_seen_at)\nVALUES ('${property_id.slice(0, 8)}…', 'RESIDENT', '${issue_type}', 'MEDIUM', $desc, fn_city_now(), fn_city_now())\nRETURNING ticket_no;   -- policy ticket_resident_insert: own property, status OPEN, unassigned`;
  let t;
  try {
    t = await asUser(req.user, async c => (await c.query(`INSERT INTO maintenance_ticket (property_id, source, issue_type, severity, description, reported_timestamp, last_seen_at)
      VALUES ($1, 'RESIDENT', $2, 'MEDIUM', $3, fn_city_now(), fn_city_now()) RETURNING ticket_id, ticket_no`, [property_id, issue_type, desc])).rows[0]);
  } catch (e) { logPg(req.user, 'Complaint rejected', stmt, e); throw e; }
  logPg(req.user, `Complaint ${t.ticket_no} created`, stmt);
  await logEntry(ctx(null, req.user), t.ticket_no, 'NOTE', desc);
  logMg(req.user, `Ticket log started for ${t.ticket_no}`, `db.maintenance_logs.updateOne({ ticket_no: "${t.ticket_no}" },\n  { $push: { entries: { by: "${req.user.display_name}", kind: "NOTE", text: $desc } } }, { upsert: true })`);
  const pick = await engine.exclusive(() => automation.autoDispatch(t));
  res.json({ ticket_no: t.ticket_no, assigned_to: pick ? pick.display_name : null });
}));

r.get('/notifications', h(async (req, res) => {
  const docs = await mongo.col('notifications').find({ user_id: req.user.user_id }).sort({ created_at: -1, _id: -1 }).limit(100).toArray();
  res.json({ notifications: docs });
}));
r.post('/notifications/read-all', h(async (req, res) => {
  const r2 = await mongo.write(ctx(null, req.user), 'notifications', 'updateMany', { user_id: req.user.user_id, read_at: null }, { $set: { read_at: new Date(S.cityNow) } });
  logMg(req.user, `${r2.modifiedCount} alerts marked as read`, `db.notifications.updateMany({ user_id: "${req.user.user_id.slice(0, 8)}…", read_at: null }, { $set: { read_at: ISODate(…) } })`);
  res.json({ updated: r2.modifiedCount });
}));
r.post('/notifications/:id/read', h(async (req, res) => {
  need(ObjectId.isValid(req.params.id), 404, 'No such alert.');
  const f = { _id: new ObjectId(req.params.id), user_id: req.user.user_id };
  const r2 = await mongo.write(ctx(null, req.user), 'notifications', 'update', f, { $set: { read_at: new Date(S.cityNow) } });
  need(r2.matchedCount, 404, 'No such alert.');
  logMg(req.user, 'Alert marked as read', `db.notifications.updateOne({ _id: ObjectId("${req.params.id}"), user_id: <you> }, { $set: { read_at: ISODate("${new Date(S.cityNow).toISOString()}") } })`);
  res.json({ ok: true });
}));
r.delete('/notifications/:id', h(async (req, res) => {
  need(ObjectId.isValid(req.params.id), 404, 'No such alert.');
  const r2 = await mongo.write(ctx(null, req.user), 'notifications', 'delete', { _id: new ObjectId(req.params.id), user_id: req.user.user_id });
  need(r2.deletedCount, 404, 'No such alert.');
  logMg(req.user, 'Alert dismissed', `db.notifications.deleteOne({ _id: ObjectId("${req.params.id}"), user_id: <you> })`);
  res.json({ ok: true });
}));

r.get('/eco', h(async (req, res) => {
  const out = await asUser(req.user, async c => {
    const props = (await c.query(PROPS_SQL)).rows;
    need(props.length, 404, 'No property is linked to your account.');
    const p = props.find(x => x.property_id === req.query.property) || props[0];
    return { properties: props, report: await ecoReport(c, p.property_id, S.cityNow) };
  });
  res.json(out);
}));

// switch a supply on or off at one of my own properties (the meter keeps reporting, usage reads 0)
r.post('/supply', h(async (req, res) => {
  const { meter_code, on } = req.body || {};
  const visible = await asUser(req.user, async c => (await c.query('SELECT meter_code FROM utility_meter WHERE meter_code = $1', [meter_code])).rowCount);
  need(visible, 404, 'That meter is not at one of your properties.');
  await engine.exclusive(async () => {
    await asOwner(req.user, c => c.query('UPDATE utility_meter SET supply_on = $2 WHERE meter_code = $1', [meter_code, !!on]));
    await loadMeters();
  });
  logPg(req.user, `${meter_code} ${on ? 'switched back on' : 'switched off (usage 0, meter still reporting)'}`, `UPDATE utility_meter SET supply_on = ${!!on} WHERE meter_code = '${meter_code}';   -- audited by trg_audit`);
  res.json({ ok: true });
}));

module.exports = { router: r, series, meterFlags, PROPS_SQL };
