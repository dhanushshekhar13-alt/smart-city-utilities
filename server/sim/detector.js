// Explainable anomaly rules. Each reading batch is checked against a 25-hour window per meter kept in memory
// (rebuilt from MongoDB when the server starts). A rule that fires:
//   1. upserts an anomaly_events document in MongoDB (one open event per key, hits counted),
//   2. calls fn_open_anomaly_ticket in PostgreSQL (one active ticket per key, enforced by a partial unique index),
//   3. for a new ticket: starts its field log, alerts the owner and hands it to the automation jobs.
const mongo = require('../db/mongo');
const { asSystem } = require('../db/pg');
const activity = require('../activity');
const { S, metersOf, properties, ctx } = require('./state');
const { TICK, TICK_MIN, HOUR } = require('../time');
const { rateOf } = require('./meters');
const { ownerOf, notify, logEntry } = require('../services/notify');

const RULES = { LEAK: { min_flow: 2, window_ticks: 4 }, SPIKE: { factor: 3, min_kw: 3 }, MISSING: { ticks: 3 } };
const ISSUE = { LEAK: 'LEAK', VOLTAGE_SPIKE: 'VOLTAGE_SPIKE', MISSING_DATA: 'POWER_OUTAGE' };
const LABEL = { ELECTRICITY: 'Electricity', WATER: 'Water', GAS: 'Gas' };
const n1 = v => (Math.round(v * 10) / 10).toString(), n2 = v => (Math.round(v * 100) / 100).toFixed(2);
const hhmm = t => new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

const win = new Map();          // meter_code → readings, oldest first
const KEEP = 25 * HOUR + TICK;
const newTicketHooks = [];

async function load(now) {
  win.clear();
  const docs = await mongo.col('meter_readings').find({ ts: { $gt: new Date(now - KEEP), $lte: new Date(now) } }).sort({ ts: 1 }).toArray();
  for (const d of docs) push(d);
}
function push(d) {
  const k = d.meta.meter_code;
  if (!win.has(k)) win.set(k, []);
  win.get(k).push(d);
}
function ingest(docs, now) {
  for (const d of docs) push(d);
  for (const a of win.values()) { let i = 0; while (i < a.length - 1 && a[i].ts.getTime() <= now - KEEP) i++; if (i) a.splice(0, i); }
}
const lastDoc = code => { const a = win.get(code); return a && a.length ? a[a.length - 1] : null; };
const recent = (code, from) => (win.get(code) || []).filter(d => d.ts.getTime() > from);

function baselineKw(code, now) {
  const a = (win.get(code) || []).filter(d => { const t = d.ts.getTime(); return t < now - HOUR && t >= now - 25 * HOUR; });
  if (!a.length) return 0.6;
  return Math.max(0.1, a.reduce((s, d) => s + d.kw, 0) / a.length);   // floor: a meter that was switched off has no baseline
}

async function detect(now) {
  for (const m of S.meters) {
    const a = win.get(m.meter_code) || [], last = a[a.length - 1];
    if (!last || last.ts.getTime() !== now) continue;                 // only judge fresh readings
    if (m.utility_type === 'WATER') {
      const w = a.slice(-RULES.LEAK.window_ticks);
      if (w.length === RULES.LEAK.window_ticks && w.every(d => d.flow_lpm > RULES.LEAK.min_flow)) {
        await raise(m, 'LEAK', 'CRITICAL', `Water kept flowing above ${RULES.LEAK.min_flow} L/min for ${RULES.LEAK.window_ticks * TICK_MIN}+ min (now ${n1(last.flow_lpm)} L/min, pressure ${last.pressure_psi} psi). This home normally uses 0.1–0.7 L/min.`,
          { flow_lpm: last.flow_lpm, pressure_psi: last.pressure_psi }, now);
      }
    }
    if (m.utility_type === 'ELECTRICITY') {
      const base = baselineKw(m.meter_code, now);
      if (last.kw > RULES.SPIKE.min_kw && last.kw > RULES.SPIKE.factor * base) {
        await raise(m, 'VOLTAGE_SPIKE', 'HIGH', `Demand is ${n1(last.kw)} kW, ${n1(last.kw / base)}× the 24-hour baseline of ${n2(base)} kW (rule: above ${RULES.SPIKE.factor}× and above ${RULES.SPIKE.min_kw} kW).`,
          { kw: last.kw, baseline_kw: Math.round(base * 100) / 100 }, now);
      }
    }
  }
  // missing data: one ticket per property, listing every silent meter
  for (const p of properties()) {
    const silent = metersOf(p.property_id).filter(m => { const d = lastDoc(m.meter_code); return !d || now - d.ts.getTime() >= RULES.MISSING.ticks * TICK; });
    if (!silent.length) continue;
    const d = lastDoc(silent[0].meter_code), ls = d ? d.ts.getTime() : now - KEEP;
    await raise(silent[0], 'MISSING_DATA', 'MEDIUM', `${silent.length} meter${silent.length > 1 ? 's' : ''} silent for ${Math.round((now - ls) / 60e3)} min (${silent.map(m => m.meter_code).join(', ')}; last seen ${hhmm(ls)}). Rule: no reading for ${RULES.MISSING.ticks * TICK_MIN}+ min. Likely a local outage.`,
      { silent_meters: silent.map(m => m.meter_code), last_seen: new Date(ls) }, now, `MISSING_DATA:${p.property_code}`);
  }
}

async function raise(m, type, severity, reason, observed, now, keyOverride) {
  const key = keyOverride || `${type}:${m.meter_code}`;
  const c = ctx('anomaly-detector');
  const events = mongo.col('anomaly_events');
  // 1) MongoDB: one open event per key; repeats count hits
  let ev = await events.findOne({ key, status: { $ne: 'RESOLVED' } });
  if (ev) {
    await mongo.write(c, 'anomaly_events', 'update', { _id: ev._id }, { $set: { last_seen: new Date(now), reason, observed }, $inc: { hits: 1 } });
    ev.hits += 1;
  } else {
    ev = { key, type, meter_code: m.meter_code, property_code: m.property_code, zone: m.zone_name, severity, detected_at: new Date(now), last_seen: new Date(now),
      hits: 1, observed, reason, status: 'OPEN', ticket_no: null, synced_to_sql: false };
    const r = await mongo.write(c, 'anomaly_events', 'insert', null, ev);
    ev._id = r.insertedId;
  }
  activity.log({ db: 'mg', title: ev.hits === 1 ? `Anomaly detected: ${type} on ${m.meter_code}` : `Anomaly continues: ${type} on ${m.meter_code} (×${ev.hits})`, collapse: 'ev-' + key,
    stmt: `db.anomaly_events.updateOne(\n  { key: "${key}", status: { $ne: "RESOLVED" } },\n  { $set: { last_seen: ISODate("${new Date(now).toISOString()}"), reason: … }, $inc: { hits: 1 } })   // inserted when none is open` });

  // 2) PostgreSQL: open or touch the ticket
  const t = await asSystem('anomaly-detector', async q => (await q.query('SELECT * FROM fn_open_anomaly_ticket($1, $2, $3, $4, $5)', [m.meter_code, key, ISSUE[type], severity, reason])).rows[0]);
  const stmt = `SELECT * FROM fn_open_anomaly_ticket('${m.meter_code}', '${key}', '${ISSUE[type]}', '${severity}', $reason);\n-- INSERT … ON CONFLICT (anomaly_key) WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS')\n--   DO UPDATE SET last_seen_at = fn_city_now(), occurrence_count = occurrence_count + 1`;
  if (!t.created) {
    activity.log({ db: 'pg', title: `Ticket ${t.ticket_no} updated (occurrence ${t.occurrence_count}), no duplicate created`, stmt, collapse: 'tk-' + key });
  } else {
    activity.log({ db: 'pg', title: `Ticket ${t.ticket_no} opened automatically (${severity}); ${m.property_code} marked UNDER_INVESTIGATION`, stmt });
    await logEntry(c, t.ticket_no, 'SENSOR_SNAPSHOT', reason, observed);
    const owner = await ownerOf(m.property_id);
    if (owner) {
      await notify(c, owner.user_id, 'ALERT', type === 'MISSING_DATA' ? `Meters offline at ${m.property_code}` : `${LABEL[m.utility_type]} alert at ${m.property_code}`, reason);
      activity.log({ db: 'mg', title: `Alert sent to ${owner.display_name}`, scope: owner.user_id,
        stmt: `db.notifications.insertOne({ user_id: "${owner.user_id.slice(0, 8)}…", kind: "ALERT", title: "… alert at ${m.property_code}" })` });
    }
    for (const f of newTicketHooks) await f({ ...t, type, meter: m });
  }
  // 3) the event doubles as the outbox: mark it synced once PostgreSQL has the ticket
  if (!ev.synced_to_sql || ev.ticket_no !== t.ticket_no) {
    await mongo.write(c, 'anomaly_events', 'update', { _id: ev._id }, { $set: { synced_to_sql: true, ticket_no: t.ticket_no } });
  }
}

// latest reading per meter, if it is fresh (no older than two ticks)
const liveRate = (code, now) => { const d = lastDoc(code); return d && now - d.ts.getTime() < TICK * 2 ? rateOf(d) : null; };
const gridLoad = now => S.meters.filter(m => m.utility_type === 'ELECTRICITY').reduce((s, m) => s + (liveRate(m.meter_code, now) || 0), 0);

module.exports = { RULES, load, ingest, detect, lastDoc, recent, liveRate, gridLoad, onNewTicket: f => newTicketHooks.push(f), window: win };
