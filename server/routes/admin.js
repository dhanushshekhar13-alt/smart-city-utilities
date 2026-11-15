// /api/admin: city operations, map, analytics, CSV export, disaster simulator, billing run, accounts and the audit trail.
// PostgreSQL reads run as admin_role (row-level security still applies; the admin policies allow every row).
const express = require('express');
const { ObjectId } = require('mongodb');
const { requireRole, hashPassword, passwordProblem, authEvent } = require('../auth');
const { asUser, asOwner } = require('../db/pg');
const mongo = require('../db/mongo');
const activity = require('../activity');
const { S, ctx, loadMeters, properties } = require('../sim/state');
const engine = require('../sim/engine');
const automation = require('../sim/automation');
const detector = require('../sim/detector');
const billing = require('../services/billing');
const { forecast } = require('../services/forecast');
const { ecoReport, CO2, grade } = require('../services/eco');
const { HOUR, cityDate } = require('../time');
const { h, need, isUuid, logPg, logMg } = require('./util');

const r = express.Router();
r.use(requireRole('ADMIN'));
const ACTIVE = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];
const as = (req, fn) => asUser(req.user, fn);

// ---------- live state per property (shared by operations and the map) ----------
async function propertyStates(c) {
  const { rows: props } = await c.query(`SELECT p.property_id, p.property_code, p.property_type, p.address_line, p.zone_id, p.service_status, z.name AS zone_name
    FROM property p JOIN zone z ON z.zone_id = p.zone_id ORDER BY p.property_code`);
  const { rows: tk } = await c.query(`SELECT t.property_id, t.ticket_id, t.ticket_no, t.issue_type, t.severity, t.status, t.sla_due_at, t.resolved_at, sd.display_name AS assigned_name
    FROM maintenance_ticket t LEFT JOIN staff_directory sd ON sd.user_id = t.assigned_to WHERE t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')`);
  const { rows: od } = await c.query("SELECT property_id, SUM(total_amount)::bigint AS owed, bool_or(payment_status = 'OVERDUE') AS overdue FROM invoice WHERE payment_status <> 'PAID' GROUP BY property_id");
  return props.map(p => {
    const ms = S.meters.filter(m => m.property_id === p.property_id);
    const tickets = tk.filter(t => t.property_id === p.property_id);
    const o = od.find(x => x.property_id === p.property_id) || { owed: 0, overdue: false };
    const crit = tickets.some(t => t.severity === 'CRITICAL' || t.severity === 'HIGH');
    const offline = ms.some(m => S.offline.has(m.meter_code)), valve = ms.some(m => !m.valve_open), off = ms.some(m => !m.supply_on);
    const k = crit ? 'crit' : tickets.length ? 'warn' : offline ? 'off' : 'ok';
    return { ...p, tickets, owed: o.owed, overdue: o.overdue, crit, offline, valve, off, k, label: crit ? 'Critical fault' : tickets.length ? 'Open ticket' : offline ? 'Meter offline' : 'Normal' };
  });
}

r.get('/ops', h(async (req, res) => {
  const now = S.cityNow;
  const out = await as(req, async c => {
    const { rows: [money] } = await c.query(`SELECT COALESCE(SUM(total_amount) FILTER (WHERE payment_status <> 'PAID'), 0)::bigint AS outstanding,
      COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'OVERDUE'), 0)::bigint AS overdue FROM invoice`);
    const { rows: active } = await c.query("SELECT ticket_no, severity, sla_due_at FROM maintenance_ticket WHERE status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')");
    const { rows: esc } = await c.query('SELECT ticket_no, severity, escalated_at FROM maintenance_ticket WHERE escalated_at IS NOT NULL ORDER BY escalated_at DESC LIMIT 6');
    const { rows: wards } = await c.query("SELECT w.zone_id, w.name, d.name AS district FROM zone w JOIN zone d ON d.zone_id = w.parent_zone_id WHERE w.zone_level = 'WARD' ORDER BY w.zone_id");
    return { money, active, esc, wards, states: await propertyStates(c) };
  });
  const rows = await mongo.col('meter_readings').aggregate([
    { $match: { ts: { $gt: new Date(now - 24 * HOUR), $lte: new Date(now) } } },
    { $group: { _id: { u: '$meta.utility', ts: '$ts' }, v: { $sum: { $ifNull: ['$kw', { $ifNull: ['$flow_lpm', '$flow_m3h'] }] } } } },
    { $sort: { '_id.ts': 1 } }]).toArray();
  const city = { ELECTRICITY: [], WATER: [], GAS: [] };
  for (const x of rows) city[x._id.u].push({ t: x._id.ts.getTime(), v: x.v });
  const health = await mongo.col('meter_readings').aggregate([
    { $match: { ts: { $gt: new Date(now - 25 * HOUR), $lte: new Date(now) } } }, { $sort: { ts: 1 } },
    { $group: { _id: '$meta.meter_code', property: { $last: '$meta.property_code' }, last: { $last: '$ts' } } }, { $sort: { last: 1 } }, { $limit: 6 }]).toArray();
  const events = await mongo.col('anomaly_events').find().sort({ last_seen: -1 }).limit(6).toArray();
  const cmds = await mongo.col('device_commands').find().sort({ issued_at: -1 }).limit(6).toArray();
  const demand = await mongo.col('demand_events').find().sort({ started_at: -1 }).limit(6).toArray();
  const wards = out.wards.map(z => {
    const ps = out.states.filter(p => p.zone_id === z.zone_id);
    const ms = S.meters.filter(m => m.zone_id === z.zone_id);
    const sum = u => ms.filter(m => m.utility_type === u).reduce((s, m) => s + (detector.liveRate(m.meter_code, now) || 0), 0);
    return { ...z, kw: sum('ELECTRICITY'), flow: sum('WATER'), tickets: ps.reduce((s, p) => s + p.tickets.length, 0), critical: ps.some(p => p.crit),
      owed: ps.reduce((s, p) => s + Number(p.owed), 0), offline: ms.filter(m => S.offline.has(m.meter_code)).length };
  });
  const kw = detector.gridLoad(now);
  const auto = [
    ...cmds.map(x => ({ t: x.issued_at, k: 'valve', txt: `${x.command === 'CLOSE_VALVE' ? 'Closed' : 'Opened'} the water valve at ${x.property_code} (${x.reason})` })),
    ...demand.map(e => ({ t: e.started_at, k: 'grid', txt: `Peak demand ${e.start_kw.toFixed(1)} kW: ${e.notified} residents asked to shift load${e.ended_at ? `; ended, peak ${e.peak_kw.toFixed(1)} kW` : ''}` })),
    ...out.esc.map(t => ({ t: new Date(t.escalated_at), k: 'sla', txt: `${t.ticket_no} missed its SLA and was escalated` })),
  ].sort((a, b) => b.t - a.t).slice(0, 6);
  res.json({ now, city, money: out.money, active: out.active, wards, events, health: health.map(x => ({ meter_code: x._id, property_code: x.property, last: x.last.getTime() })),
    grid: { kw, capacity: S.gridKw, demand: demand.find(e => e.status === 'ACTIVE') || null }, auto });
}));

r.post('/anomalies/:id/ack', h(async (req, res) => {
  need(ObjectId.isValid(req.params.id), 404, 'No such anomaly.');
  const r2 = await mongo.write(ctx(null, req.user), 'anomaly_events', 'update', { _id: new ObjectId(req.params.id), status: 'OPEN' },
    { $set: { status: 'ACK', ack_by: req.user.display_name, ack_at: new Date(S.cityNow) } });
  need(r2.modifiedCount, 404, 'That anomaly is not open.');
  logMg(req.user, 'Anomaly acknowledged', `db.anomaly_events.updateOne({ _id: ObjectId("${req.params.id}"), status: "OPEN" },\n  { $set: { status: "ACK", ack_by: "${req.user.display_name}", ack_at: ISODate(…) } })`);
  res.json({ ok: true });
}));

// ---------- city map ----------
r.get('/map', h(async (req, res) => {
  const states = await as(req, c => propertyStates(c));
  res.json({ properties: states, grid: { kw: detector.gridLoad(S.cityNow), capacity: S.gridKw } });
}));

r.get('/map/:id', h(async (req, res) => {
  need(isUuid(req.params.id), 404, 'No such property.');
  const out = await as(req, async c => {
    const { rows: [p] } = await c.query(`SELECT p.*, z.name AS zone_name, r.full_name, r.citizen_ref FROM property p JOIN zone z ON z.zone_id = p.zone_id JOIN resident r USING (resident_id) WHERE p.property_id = $1`, [req.params.id]);
    if (!p) return null;
    const st = (await propertyStates(c)).find(x => x.property_id === p.property_id);
    return { p, st, f: await forecast(c, p.property_id, S.cityNow), eco: await ecoReport(c, p.property_id, S.cityNow) };
  });
  need(out, 404, 'No such property.');
  const meters = S.meters.filter(m => m.property_id === req.params.id).map(m => ({ meter_code: m.meter_code, utility_type: m.utility_type, rate: detector.liveRate(m.meter_code, S.cityNow),
    offline: S.offline.has(m.meter_code), supply_on: m.supply_on, valve_open: m.valve_open, fault: S.faults[m.meter_code] || null }));
  res.json({ property: out.p, state: out.st, meters, forecast: out.f && { total: out.f.total, high: out.f.high, name: out.f.cycle.name }, eco: { score: out.eco.score, grade: out.eco.grade } });
}));

r.post('/valve', h(async (req, res) => {
  const { meter_code, open } = req.body || {};
  need(S.byCode.has(meter_code), 404, 'No such meter.');
  const changed = await engine.exclusive(() => automation.valve(meter_code, !open, open ? 'reopened by the city admin' : 'closed by the city admin', req.user));
  res.json({ changed });
}));

// ---------- analytics and CSV ----------
r.get('/analytics', h(async (req, res) => {
  const today = cityDate(S.cityNow);
  const out = await as(req, async c => {
    const money = (await c.query('SELECT * FROM v_cycle_revenue ORDER BY cycle_id')).rows;
    const use = (await c.query(`SELECT mr.cycle_id, bc.month, um.utility_type, SUM(mr.total_units_consumed)::float AS units
      FROM meter_reading mr JOIN utility_meter um USING (meter_id) JOIN billing_cycle bc USING (cycle_id) GROUP BY 1, 2, 3 ORDER BY 1`)).rows;
    const tickets = (await c.query(`SELECT issue_type, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS'))::int AS open,
        COUNT(resolved_at)::int AS resolved, EXTRACT(EPOCH FROM AVG(resolved_at - reported_timestamp))::float * 1000 AS avg_fix_ms,
        COUNT(*) FILTER (WHERE resolved_at <= sla_due_at)::int AS sla_met, COUNT(escalated_at)::int AS escalated
      FROM maintenance_ticket GROUP BY issue_type ORDER BY total DESC`)).rows;
    const last = (await c.query('SELECT MAX(cycle_id) AS c FROM invoice')).rows[0].c;
    const wards = (await c.query(`SELECT w.zone_id, w.name, d.name AS district, COUNT(DISTINCT p.property_id)::int AS n,
        SUM(mr.total_units_consumed * CASE um.utility_type WHEN 'ELECTRICITY' THEN ${CO2.ELECTRICITY} WHEN 'WATER' THEN ${CO2.WATER} ELSE ${CO2.GAS} END)::float AS kg,
        (SELECT SUM(i.total_amount) FROM invoice i JOIN property q USING (property_id) WHERE q.zone_id = w.zone_id)::float AS billed,
        (SELECT SUM(i.total_amount) FROM invoice i JOIN property q USING (property_id) WHERE q.zone_id = w.zone_id AND i.payment_status = 'PAID')::float AS paid
      FROM zone w JOIN zone d ON d.zone_id = w.parent_zone_id JOIN property p ON p.zone_id = w.zone_id
      JOIN utility_meter um ON um.property_id = p.property_id LEFT JOIN meter_reading mr ON mr.meter_id = um.meter_id AND mr.cycle_id = $1
      WHERE w.zone_level = 'WARD' GROUP BY w.zone_id, w.name, d.name`, [last])).rows;
    const scores = {};
    for (const p of properties()) { const e = await ecoReport(c, p.property_id, S.cityNow); (scores[p.zone_id] = scores[p.zone_id] || []).push(e.score); }
    const cyc = (await c.query('SELECT year, month FROM billing_cycle WHERE cycle_id = $1', [last])).rows[0];
    return { money, use, tickets, wards, scores, last: cyc };
  });
  const due = out.money.filter(m => m.due_date < today);
  const billed = due.reduce((s, m) => s + m.billed, 0), collected = due.reduce((s, m) => s + m.collected, 0);
  const t = out.tickets, resolved = t.reduce((s, x) => s + x.resolved, 0);
  res.json({
    kpi: { billed, collected, late: out.money.reduce((s, m) => s + m.late_fees, 0), total: t.reduce((s, x) => s + x.total, 0), resolved,
      avg_fix_ms: resolved ? t.reduce((s, x) => s + (x.avg_fix_ms || 0) * x.resolved, 0) / resolved : 0,
      sla_met: t.reduce((s, x) => s + x.sla_met, 0), escalated: t.reduce((s, x) => s + x.escalated, 0) },
    money: out.money, use: out.use, tickets: out.tickets, last: out.last,
    wards: out.wards.map(w => { const sc = out.scores[w.zone_id] || []; const avg = sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : 0;
      return { ...w, kg_per: w.n ? w.kg / w.n : 0, score: avg, grade: grade(avg), paid_share: w.billed ? w.paid / w.billed : 0 }; }).sort((a, b) => a.kg_per - b.kg_per),
  });
}));

const CSV = {
  invoices: { file: 'invoices.csv', sql: `SELECT i.invoice_no, bc.year, bc.month, p.property_code, z.name AS ward, round(i.total_amount / 100.0, 2) AS total_inr,
      round(COALESCE((SELECT SUM(line_total) FROM invoice_line_item l WHERE l.invoice_id = i.invoice_id AND l.line_kind = 'LATE_FEE'), 0) / 100.0, 2) AS late_fee_inr,
      i.payment_status, to_char(i.paid_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS paid_at_ist
    FROM invoice i JOIN billing_cycle bc USING (cycle_id) JOIN property p USING (property_id) JOIN zone z ON z.zone_id = p.zone_id ORDER BY i.cycle_id, i.invoice_no` },
  readings: { file: 'monthly-readings.csv', sql: `SELECT bc.year, bc.month, um.meter_code, p.property_code, um.utility_type, mr.opening_register, mr.closing_register, mr.total_units_consumed, mr.source_doc_count
    FROM meter_reading mr JOIN utility_meter um USING (meter_id) JOIN property p USING (property_id) JOIN billing_cycle bc USING (cycle_id) ORDER BY mr.cycle_id, um.meter_code` },
  tickets: { file: 'tickets.csv', sql: `SELECT t.ticket_no, p.property_code, t.issue_type, t.severity, t.status, t.source,
      to_char(t.reported_timestamp AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS reported_ist, to_char(t.sla_due_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS sla_due_ist,
      to_char(t.resolved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS resolved_ist, sd.display_name AS assigned_to
    FROM maintenance_ticket t JOIN property p USING (property_id) LEFT JOIN staff_directory sd ON sd.user_id = t.assigned_to ORDER BY t.ticket_no` },
};
const csvCell = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
r.get('/csv/:what', h(async (req, res) => {
  const spec = CSV[req.params.what];
  need(spec, 404, 'No such export.');
  const { rows, fields } = await as(req, c => c.query(spec.sql));
  const text = [fields.map(f => f.name), ...rows.map(x => fields.map(f => x[f.name]))].map(l => l.map(csvCell).join(',')).join('\n') + '\n';
  logPg(req.user, `Exported ${req.params.what} as CSV (${rows.length} rows)`, `${spec.sql.split('\n')[0]} …;`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${spec.file}"`);
  res.send(text);
}));

// ---------- disaster simulator, automation switches, supply ----------
r.get('/sim', h(async (req, res) => {
  const props = await as(req, async c => (await c.query('SELECT p.property_id, p.property_code, p.address_line, z.name AS zone_name FROM property p JOIN zone z USING (zone_id) ORDER BY p.property_code')).rows);
  res.json({
    scenarios: Object.keys(engine.SCENARIOS).map(id => ({ id, on: engine.scenarioOn(id), contained: id === 'burst' && S.byCode.get('MTR-W-0001') && !S.byCode.get('MTR-W-0001').valve_open })),
    policies: S.policies, grid_kw: S.gridKw, rules: detector.RULES,
    supply: props.map(p => ({ ...p, meters: S.meters.filter(m => m.property_id === p.property_id).map(m => ({ meter_code: m.meter_code, utility_type: m.utility_type, supply_on: m.supply_on, valve_open: m.valve_open })) })),
  });
}));
r.post('/scenarios/:id', h(async (req, res) => { await engine.scenario(req.user, req.params.id, !!(req.body && req.body.on)); res.json({ ok: true }); }));
r.post('/policies/:key', h(async (req, res) => {
  await engine.setPolicy(req.user, req.params.key, !!(req.body && req.body.on));
  activity.log({ db: 'pg', title: `Automation ${req.params.key} switched ${S.policies[req.params.key] ? 'on' : 'off'}`, scope: 'admin', stmt: `UPDATE sim_clock SET policies = jsonb_set(policies, '{${req.params.key}}', '${S.policies[req.params.key]}');   -- audited` });
  res.json({ policies: S.policies });
}));
r.post('/supply', h(async (req, res) => {
  const { meter_code, on } = req.body || {};
  need(S.byCode.has(meter_code), 404, 'No such meter.');
  await engine.exclusive(async () => { await as(req, c => c.query('UPDATE utility_meter SET supply_on = $2 WHERE meter_code = $1', [meter_code, !!on])); await loadMeters(); });
  logPg(req.user, `${meter_code} ${on ? 'switched back on' : 'switched off (usage 0, meter still reporting)'}`, `UPDATE utility_meter SET supply_on = ${!!on} WHERE meter_code = '${meter_code}';`);
  res.json({ ok: true });
}));

// ---------- billing run ----------
r.get('/billing', h(async (req, res) => {
  const out = await as(req, async c => {
    const cycles = (await c.query('SELECT cycle_id, year, month, cycle_start_date, cycle_end_date, due_date, status FROM billing_cycle ORDER BY cycle_id')).rows;
    const pick = cycles.find(x => String(x.cycle_id) === String(req.query.cycle)) || cycles.find(x => x.status === 'OPEN') || cycles[cycles.length - 1];
    const runs = (await c.query('SELECT run_id, started_at, finished_at, status, meters_total, meters_written, error FROM aggregation_run WHERE cycle_id = $1 ORDER BY started_at DESC', [pick.cycle_id])).rows;
    const readings = (await c.query(`SELECT um.meter_code, um.utility_type, p.property_code, mr.opening_register, mr.closing_register, mr.total_units_consumed, mr.source_doc_count,
        i.invoice_no, i.total_amount FROM meter_reading mr JOIN utility_meter um USING (meter_id) JOIN property p USING (property_id)
      LEFT JOIN invoice i ON i.property_id = p.property_id AND i.cycle_id = mr.cycle_id WHERE mr.cycle_id = $1 ORDER BY um.meter_code`, [pick.cycle_id])).rows;
    const invoices = (await c.query('SELECT COUNT(*)::int AS n FROM invoice WHERE cycle_id = $1', [pick.cycle_id])).rows[0].n;
    return { cycles, pick, runs, readings, invoices };
  });
  const c = await billing.getCycle(out.pick.cycle_id);
  res.json({ ...out, pipeline: billing.pipelineText(c.from, Math.min(S.cityNow, c.to)), meters: S.meters.length, properties: properties().length, now: S.cityNow, ends_at: c.to });
}));
r.post('/billing/aggregate', h(async (req, res) => {
  const cycle = Number(req.body && req.body.cycle);
  const out = await engine.exclusive(() => billing.aggregate(cycle, { user: req.user }));
  res.json({ written: out.written, locked: out.locked, errors: out.errors });
}));
r.post('/billing/invoices', h(async (req, res) => {
  const cycle = Number(req.body && req.body.cycle);
  const out = await engine.exclusive(() => billing.invoices(cycle, { user: req.user }));
  res.json({ created: out.created.length, existed: out.existed.length, errors: out.errors });
}));

// ---------- accounts ----------
r.get('/users', h(async (req, res) => {
  const out = await as(req, async c => ({
    users: (await c.query(`SELECT u.user_id, u.email, u.role, u.display_name, u.is_active, u.failed_logins, u.locked_until, u.created_at, u.last_login_at,
        z.name AS zone_name, (SELECT COUNT(*)::int FROM user_session s WHERE s.user_id = u.user_id AND s.ended_at IS NULL AND s.expires_at > now()) AS live_sessions
      FROM app_user u LEFT JOIN zone z ON z.zone_id = u.staff_zone_id ORDER BY CASE u.role WHEN 'ADMIN' THEN 3 WHEN 'STAFF' THEN 2 ELSE 1 END, u.display_name`)).rows,
    unclaimed: (await c.query('SELECT r.resident_id, r.full_name, r.email FROM resident r WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.resident_id = r.resident_id) ORDER BY r.full_name')).rows,
    zones: (await c.query("SELECT zone_id, name FROM zone WHERE zone_level IN ('CITY', 'DISTRICT') ORDER BY zone_id")).rows,
  }));
  res.json(out);
}));

r.post('/users', h(async (req, res) => {
  const { email, display_name, role, staff_zone_id, resident_id, password } = req.body || {};
  need(['RESIDENT', 'STAFF', 'ADMIN'].includes(role), 400, 'Pick a role.');
  const bad = passwordProblem(password);
  need(!bad, 400, bad);
  const hash = await hashPassword(password);
  const u = await asOwner(req.user, async c => {
    let em = String(email || '').trim().toLowerCase(), name = String(display_name || '').trim();
    if (role === 'RESIDENT') {
      need(isUuid(resident_id), 400, 'Pick the resident this account is for.');
      const { rows: [rr] } = await c.query('SELECT email, full_name FROM resident WHERE resident_id = $1', [resident_id]);
      need(rr, 404, 'No such resident.');
      em = rr.email; name = name || rr.full_name;
    }
    need(em && name, 400, 'Enter an email and a name.');
    const { rows: [nu] } = await c.query(`INSERT INTO app_user (email, password_hash, role, resident_id, staff_zone_id, display_name)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, email, role, display_name`,
      [em, hash, role, role === 'RESIDENT' ? resident_id : null, role === 'STAFF' ? Number(staff_zone_id) || null : null, name]);
    await authEvent(c, 'ACCOUNT_CREATED', em, nu.user_id, req.ip, `created by ${req.user.display_name}`);
    return nu;
  });
  logPg(req.user, `Account created for ${u.display_name} (${u.role})`, `INSERT INTO app_user (email, password_hash, role, …) VALUES ('${u.email}', 'scrypt$…', '${u.role}', …);\nINSERT INTO auth_event (kind, email) VALUES ('ACCOUNT_CREATED', '${u.email}');`);
  res.json({ user: u });
}));

async function userAction(req, sql, params, title) {
  need(isUuid(req.params.id), 404, 'No such account.');
  const n = await asOwner(req.user, async c => {
    const { rowCount } = await c.query(sql, [req.params.id, ...params]);
    return rowCount;
  });
  need(n, 404, 'No such account.');
  logPg(req.user, title, sql.replace(/\s+/g, ' ').trim() + ';');
}
r.post('/users/:id/active', h(async (req, res) => {
  const on = !!(req.body && req.body.on);
  need(req.params.id !== req.user.user_id, 400, 'You cannot deactivate your own account.');
  await userAction(req, 'UPDATE app_user SET is_active = $2 WHERE user_id = $1', [on], `Account ${on ? 'reactivated' : 'deactivated'}`);
  if (!on) await asOwner(req.user, c => c.query("UPDATE user_session SET ended_at = now(), end_reason = 'REVOKED' WHERE user_id = $1 AND ended_at IS NULL", [req.params.id]));
  res.json({ ok: true });
}));
r.post('/users/:id/unlock', h(async (req, res) => {
  await userAction(req, 'UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [], 'Account unlocked');
  res.json({ ok: true });
}));
r.post('/users/:id/password', h(async (req, res) => {
  const bad = passwordProblem(req.body && req.body.password);
  need(!bad, 400, bad);
  const hash = await hashPassword(req.body.password);
  await userAction(req, 'UPDATE app_user SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE user_id = $1', [hash], 'Password reset by the admin');
  await asOwner(req.user, async c => {
    await c.query("UPDATE user_session SET ended_at = now(), end_reason = 'PASSWORD_CHANGED' WHERE user_id = $1 AND ended_at IS NULL", [req.params.id]);
    const { rows: [u] } = await c.query('SELECT email FROM app_user WHERE user_id = $1', [req.params.id]);
    await authEvent(c, 'PASSWORD_CHANGED', u.email, req.params.id, req.ip, `reset by ${req.user.display_name}`);
  });
  res.json({ ok: true });
}));
r.post('/users/:id/revoke', h(async (req, res) => {
  need(isUuid(req.params.id), 404, 'No such account.');
  const n = await asOwner(req.user, async c => (await c.query("UPDATE user_session SET ended_at = now(), end_reason = 'REVOKED' WHERE user_id = $1 AND ended_at IS NULL AND session_id <> $2", [req.params.id, req.user.session_id])).rowCount);
  logPg(req.user, `${n} session${n === 1 ? '' : 's'} signed out by the admin`, "UPDATE user_session SET ended_at = now(), end_reason = 'REVOKED' WHERE user_id = $1 AND ended_at IS NULL;");
  res.json({ ended: n });
}));

// ---------- audit trail ----------
r.get('/audit', h(async (req, res) => {
  const source = req.query.source || 'pg';
  const limit = Math.min(300, Number(req.query.limit) || 100);
  if (source === 'mongo') {
    const f = req.query.table ? { collection: String(req.query.table) } : {};
    const rows = await mongo.col('change_log').find(f).sort({ _id: -1 }).limit(limit).toArray();
    const counts = await mongo.col('change_log').aggregate([{ $group: { _id: '$collection', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    return res.json({ rows, counts: counts.map(x => ({ name: x._id, n: x.n })) });
  }
  const out = await as(req, async c => {
    if (source === 'auth') return { rows: (await c.query('SELECT event_id, at, kind, email, ip, detail FROM auth_event ORDER BY event_id DESC LIMIT $1', [limit])).rows,
      counts: (await c.query('SELECT kind AS name, COUNT(*)::int AS n FROM auth_event GROUP BY kind ORDER BY n DESC')).rows };
    if (source === 'sessions') return { rows: (await c.query(`SELECT s.session_id, u.email, u.display_name, s.created_at, s.expires_at, s.last_seen_at, s.ended_at, s.end_reason, s.ip, s.user_agent
      FROM user_session s JOIN app_user u USING (user_id) ORDER BY s.created_at DESC LIMIT $1`, [limit])).rows, counts: [] };
    const t = String(req.query.table || '');
    return { rows: (await c.query(`SELECT audit_id, at, city_at, actor, db_role, table_name, operation, row_key, changed, old_row, new_row FROM audit_log
        WHERE ($1 = '' OR table_name = $1) ORDER BY audit_id DESC LIMIT $2`, [t, limit])).rows,
      counts: (await c.query('SELECT table_name AS name, COUNT(*)::int AS n FROM audit_log GROUP BY table_name ORDER BY n DESC')).rows };
  });
  res.json(out);
}));

module.exports = r;

