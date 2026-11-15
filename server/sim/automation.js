// What the city does on its own: smart dispatch, valve shut-off on leaks, peak-demand response,
// SLA escalation, high-bill warnings and the nightly overdue job. Each can be switched off (sim_clock.policies)
// except the SLA monitor and the billing jobs.
const mongo = require('../db/mongo');
const { asSystem, asOwner, query } = require('../db/pg');
const activity = require('../activity');
const { S, ctx, loadMeters, properties } = require('./state');
const detector = require('./detector');
const { ownerOf, notify, logEntry } = require('../services/notify');
const { HOUR, cityDate, istHour, IST_OFFSET } = require('../time');

const inr = paise => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = t => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

// ---------- smart dispatch ----------
async function autoDispatch(ticket) {
  if (!S.policies.autoDispatch) return null;
  const res = await asSystem('dispatcher', async c => {
    // everyone who could take it, with their current load, for the explanation
    const { rows: team } = await c.query(`WITH RECURSIVE up AS (
        SELECT z.zone_id, z.parent_zone_id FROM zone z WHERE z.zone_id = (SELECT p.zone_id FROM maintenance_ticket t JOIN property p USING (property_id) WHERE t.ticket_id = $1)
        UNION ALL SELECT z.zone_id, z.parent_zone_id FROM zone z JOIN up ON z.zone_id = up.parent_zone_id)
      SELECT u.display_name, COUNT(t.ticket_id)::int AS open_jobs FROM app_user u
      LEFT JOIN maintenance_ticket t ON t.assigned_to = u.user_id AND t.status IN ('ASSIGNED', 'IN_PROGRESS')
      WHERE u.role = 'STAFF' AND u.is_active AND u.staff_zone_id IN (SELECT zone_id FROM up)
      GROUP BY u.user_id ORDER BY open_jobs, u.email`, [ticket.ticket_id]);
    const { rows: [pick] } = await c.query('SELECT * FROM fn_auto_assign($1)', [ticket.ticket_id]);
    if (!pick) return null;
    const { rows: [t] } = await c.query(`UPDATE maintenance_ticket SET status = 'ASSIGNED', assigned_to = $2 WHERE ticket_id = $1 AND status = 'OPEN'
      RETURNING ticket_no, severity, sla_due_at, (SELECT name FROM zone WHERE zone_id = fn_district_of((SELECT zone_id FROM property WHERE property_id = maintenance_ticket.property_id))) AS district`, [ticket.ticket_id, pick.user_id]);
    return t && { t, pick, team };
  });
  if (!res) return null;
  const { t, pick, team } = res;
  const others = team.filter(x => x.display_name !== pick.display_name);
  const why = `Auto-assigned to ${pick.display_name}: covers ${t.district}, ${pick.open_jobs} open job${pick.open_jobs == 1 ? '' : 's'}${others.length ? ` (vs ${others.map(o => `${o.display_name.split(' ')[0]} ${o.open_jobs}`).join(', ')})` : ''}. SLA due ${dt(t.sla_due_at)}.`;
  await logEntry(ctx('dispatcher'), t.ticket_no, 'DISPATCH', why);
  activity.log({ db: 'pg', title: `${t.ticket_no} auto-assigned to ${pick.display_name}`,
    stmt: `SELECT * FROM fn_auto_assign('${ticket.ticket_id.slice(0, 8)}…');\n-- staff whose zone contains the property (recursive CTE up the zone tree),\n-- fewest ASSIGNED/IN_PROGRESS jobs first, then by email\nUPDATE maintenance_ticket SET status = 'ASSIGNED', assigned_to = '${pick.user_id.slice(0, 8)}…'\nWHERE ticket_id = $1 AND status = 'OPEN';   -- history row by trg_ticket_history` });
  return pick;
}

// ---------- smart valve ----------
async function valve(meterCode, close, reason, user) {
  const m = S.byCode.get(meterCode);
  if (!m || m.utility_type !== 'WATER') throw Object.assign(new Error('Only water meters have a valve.'), { status: 400 });
  const run = user ? fn => asOwner(user, fn) : fn => asSystem('leak-rule', fn);
  const by = user ? user.display_name : 'leak-rule';
  const { rows: [r] } = await run(c => c.query('UPDATE utility_meter SET valve_open = $2 WHERE meter_code = $1 AND valve_open <> $2 RETURNING meter_code', [meterCode, !close]));
  await loadMeters();
  if (!r) return false;
  const c = ctx(by, user);
  const cmd = { meter_code: meterCode, property_code: m.property_code, command: close ? 'CLOSE_VALVE' : 'OPEN_VALVE', reason, issued_by: by, issued_at: new Date(S.cityNow), status: 'SENT' };
  const ins = await mongo.write(c, 'device_commands', 'insert', null, cmd);
  // the simulated gateway acknowledges at once
  await mongo.write(c, 'device_commands', 'update', { _id: ins.insertedId }, { $set: { status: 'ACKED', acked_at: new Date(S.cityNow) } });
  activity.log({ db: 'mg', title: `Smart valve ${close ? 'closed' : 'opened'} at ${m.property_code} (${meterCode})`, scope: user ? user.user_id : 'all',
    stmt: `UPDATE utility_meter SET valve_open = ${!close} WHERE meter_code = '${meterCode}';\ndb.device_commands.insertOne({ meter_code: "${meterCode}", command: "${cmd.command}", reason: "${reason}", status: "SENT" })\ndb.device_commands.updateOne({ _id: … }, { $set: { status: "ACKED", acked_at: ISODate(…) } })` });
  const { rows: [t] } = await query(`SELECT ticket_no FROM maintenance_ticket t JOIN utility_meter m USING (meter_id)
    WHERE m.meter_code = $1 AND t.issue_type = 'LEAK' ORDER BY t.reported_timestamp DESC LIMIT 1`, [meterCode]);
  if (t) await logEntry(c, t.ticket_no, 'DEVICE', `${cmd.command} sent to ${meterCode}: ${reason}`);
  const owner = await ownerOf(m.property_id);
  if (owner) await notify(c, owner.user_id, 'ALERT', close ? `Water valve closed at ${m.property_code}` : `Water back on at ${m.property_code}`,
    close ? 'We detected a leak and closed your smart water valve automatically to stop the waste. An engineer has been assigned; water comes back on when the repair is done.'
      : 'The repair is done and your water valve is open again.');
  return true;
}

detector.onNewTicket(async t => {
  await autoDispatch(t);
  if (t.type === 'LEAK' && S.policies.autoValve) await valve(t.meter.meter_code, true, 'Leak rule fired (critical)', null);
});

// ---------- peak demand response ----------
let activeEvent;   // cached ACTIVE demand_events document (undefined = not loaded yet)
async function demandResponse(now) {
  if (activeEvent === undefined) activeEvent = await mongo.col('demand_events').findOne({ status: 'ACTIVE' });
  const kw = detector.gridLoad(now), c = ctx('demand-response');
  if (activeEvent) {
    if (kw < 0.8 * S.gridKw) {
      await mongo.write(c, 'demand_events', 'update', { _id: activeEvent._id }, { $set: { status: 'ENDED', ended_at: new Date(now), end_kw: kw } });
      activity.log({ db: 'mg', title: `Peak demand event ended (${kw.toFixed(1)} kW)`, stmt: `db.demand_events.updateOne({ _id: … }, { $set: { status: "ENDED", ended_at: ISODate("${new Date(now).toISOString()}") } })` });
      activeEvent = null;
    } else if (kw > activeEvent.peak_kw) {
      await mongo.write(c, 'demand_events', 'update', { _id: activeEvent._id }, { $set: { peak_kw: kw } });
      activeEvent.peak_kw = kw;
    }
    return;
  }
  if (!S.policies.demandResponse || kw < 0.9 * S.gridKw) return;
  const { rows: residents } = await query("SELECT user_id FROM app_user WHERE role = 'RESIDENT' AND is_active");
  const ev = { started_at: new Date(now), ended_at: null, start_kw: kw, peak_kw: kw, capacity_kw: S.gridKw, status: 'ACTIVE', notified: residents.length };
  ev._id = (await mongo.write(c, 'demand_events', 'insert', null, ev)).insertedId;
  activeEvent = ev;
  const pct = Math.round(kw / S.gridKw * 100);
  for (const r of residents) await notify(c, r.user_id, 'DEMAND', 'Peak demand: please ease off for an hour',
    `The city grid is at ${pct}% of capacity. Please delay the washing machine, geyser, iron and EV charging for the next hour. Your supply is not cut; this only spreads the load.`);
  activity.log({ db: 'mg', title: `Peak demand event: ${kw.toFixed(1)} kW of ${S.gridKw} kW; ${residents.length} residents asked to shift load`,
    stmt: `db.demand_events.insertOne({ started_at: ISODate(…), start_kw: ${kw.toFixed(2)}, capacity_kw: ${S.gridKw}, status: "ACTIVE" })\ndb.notifications.insertMany([ …${residents.length} × { kind: "DEMAND" } ])` });
}

// ---------- SLA watch ----------
async function slaWatch() {
  const rows = await asSystem('sla-monitor', async c => (await c.query('SELECT * FROM fn_escalate_overdue_tickets()')).rows);
  for (const t of rows) {
    const h = { CRITICAL: 4, HIGH: 8, MEDIUM: 24, LOW: 72 }[t.severity];
    await logEntry(ctx('sla-monitor'), t.ticket_no, 'ESCALATION', `SLA of ${h} h missed. Escalated to the district supervisor.`);
    activity.log({ db: 'pg', title: `${t.ticket_no} missed its ${h} h SLA and was escalated`,
      stmt: `SELECT * FROM fn_escalate_overdue_tickets();\n-- UPDATE maintenance_ticket SET escalated_at = fn_city_now()\n-- WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS') AND sla_due_at < fn_city_now() AND escalated_at IS NULL` });
  }
}

// ---------- high-bill warning (once per IST hour, at most once per property per cycle) ----------
async function forecastWarnings(now) {
  if ((now + IST_OFFSET) % HOUR !== 0) return;
  const forecast = require('../services/forecast');
  const { rows: [cyc] } = await query("SELECT cycle_id, cycle_start_date FROM billing_cycle WHERE status = 'OPEN' ORDER BY cycle_id LIMIT 1");
  if (!cyc || now - Date.parse(`${cyc.cycle_start_date}T00:00:00+05:30`) < 3 * 24 * HOUR) return;   // too early for a fair forecast
  for (const p of properties()) {
    const ref = `FORECAST:${p.property_code}:${cyc.cycle_id}`;
    if (await mongo.col('notifications').findOne({ ref }, { projection: { _id: 1 } })) continue;
    const owner = await ownerOf(p.property_id);
    if (!owner) continue;
    const f = await forecast.forecastSystem(p.property_id, now);
    if (!f || !f.high) continue;
    const w = f.worst;
    await notify(ctx('forecast'), owner.user_id, 'FORECAST', `${f.cycle.name} bill for ${p.property_code} is heading higher than usual`,
      `At the current rate it will be about ${inr(f.total)} (usual ${inr(f.avg)}). ${w.label} is the biggest change: ${w.proj.toFixed(1)} ${w.unit} forecast against ${w.avgUnits.toFixed(1)} usually.`, ref);
    activity.log({ db: 'mg', title: `High-bill warning sent for ${p.property_code}`, scope: owner.user_id,
      stmt: `db.notifications.insertOne({ ref: "${ref}", kind: "FORECAST", … })   // unique index on ref: at most one per cycle` });
  }
}

// ---------- nightly job at 00:00 city time ----------
async function nightly(now) {
  const today = cityDate(now);
  const rows = await asSystem('nightly-billing', async c => (await c.query('SELECT * FROM fn_mark_overdue($1)', [today])).rows);
  if (!rows.length) return [];
  const fees = rows.reduce((s, r) => s + r.fee, 0);
  activity.log({ db: 'pg', title: `Nightly job: ${rows.filter(r => r.newly_overdue).length} bills now OVERDUE, late fees ${inr(fees)} added`,
    stmt: `SELECT * FROM fn_mark_overdue(DATE '${today}');\n-- unpaid bills past due_date → OVERDUE, plus one LATE_FEE line per utility\n-- (late_penalty_percent of the usage lines); trg_invoice_total updates the total` });
  for (const r of rows) {
    if (!r.fee) continue;
    const owner = await ownerOf(r.property_id);
    const { rows: [i] } = await query('SELECT total_amount FROM invoice WHERE invoice_id = $1', [r.invoice_id]);
    if (owner) await notify(ctx('nightly-billing'), owner.user_id, 'OVERDUE', `Bill overdue: ${r.invoice_no}`,
      `Your bill ${r.invoice_no} was not paid by its due date. A late fee of ${inr(r.fee)} was added; the amount due is now ${inr(i.total_amount)}.`);
  }
  return rows;
}

async function afterBatch(now, prev) {
  await demandResponse(now);
  await slaWatch();
  await forecastWarnings(now);
  if (cityDate(now) !== cityDate(prev) && istHour(now) === 0) await nightly(now);
}

module.exports = { autoDispatch, valve, demandResponse, slaWatch, forecastWarnings, nightly, afterBatch, activeDemand: () => activeEvent, resetCache: () => { activeEvent = undefined; } };
