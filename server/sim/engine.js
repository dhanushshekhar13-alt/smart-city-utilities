// The city clock. One tick = 15 city minutes (every TICK_MS real milliseconds while running):
//   1. city time moves on in sim_clock (PostgreSQL)
//   2. every reporting meter sends a reading; readings are validated and inserted into MongoDB
//   3. the anomaly rules and the automation jobs run on the new batch
//   4. at city midnight the nightly jobs run; past a month end the cycle is closed and billed
// Everything that changes simulator state goes through exclusive(), so a tick never overlaps an admin action.
const mongo = require('../db/mongo');
const { query } = require('../db/pg');
const config = require('../config');
const activity = require('../activity');
const { S, load, saveSwitches, loadMeters } = require('./state');
const { makeReading, validateReading, registerOf } = require('./meters');
const { makeRand } = require('./random');
const detector = require('./detector');
const automation = require('./automation');
const billing = require('../services/billing');
const { TICK, HOUR, nextMonthStart, cityDate } = require('../time');

const rand = makeRand((Date.now() & 0x7fffffff) || 7);
const registers = new Map();
let timer = null, lock = Promise.resolve(), busy = false;

function exclusive(fn) {
  const p = lock.then(() => { busy = true; return fn(); }).finally(() => { busy = false; });
  lock = p.catch(() => {});
  return p;
}

async function start({ timer: withTimer = true } = {}) {
  await load();
  activity.setClock(() => S.cityNow);
  // the register of each meter carries on from its latest reading in MongoDB
  const last = await mongo.col('meter_readings').aggregate([
    { $match: { ts: { $lte: new Date(S.cityNow) } } }, { $sort: { ts: 1 } },
    { $group: { _id: '$meta.meter_code', d: { $last: '$$ROOT' } } }]).toArray();
  for (const r of last) registers.set(r._id, registerOf(r.d));
  await detector.load(S.cityNow);
  automation.resetCache();
  if (withTimer) {
    timer = setInterval(() => { if (S.running && !busy) exclusive(() => tick()).catch(e => console.error('tick failed:', e.message)); }, config.tickMs);
    if (!config.autoStartClock && S.running) await saveSwitches(null, { running: false });
  }
}
function stop() { if (timer) clearInterval(timer); timer = null; }

// one 15-minute step; quiet = part of a fast-forward (the rail gets one summary line instead)
async function tick({ quiet = false } = {}) {
  const prev = S.cityNow, now = prev + TICK;
  const { rows: [c] } = await query('UPDATE sim_clock SET city_now = $1, version = version + 1 WHERE id = 1 RETURNING version', [new Date(now)]);
  S.cityNow = now; S.version = c.version;
  const docs = [], rejected = [];
  for (const m of S.meters) {
    if (S.offline.has(m.meter_code) || !m.is_active) continue;
    const st = { register: registers.get(m.meter_code) ?? 0, fault: S.faults[m.meter_code], supplyOn: m.supply_on, valveOpen: m.valve_open };
    const d = makeReading(m, now, st, rand);
    const errs = validateReading(d);
    if (errs.length) { rejected.push({ meter: m.meter_code, errs }); continue; }
    registers.set(m.meter_code, st.register);
    docs.push(d);
  }
  if (docs.length) await mongo.col('meter_readings').insertMany(docs, { ordered: false });
  if (!quiet) {
    await mongo.col('ingestion_batches').insertOne({ source: 'live meters', count: docs.length, from: new Date(now), to: new Date(now), status: rejected.length ? 'PARTIAL' : 'DONE', rejected });
    const w = docs.find(d => d.meta.utility === 'WATER') || docs[0];
    activity.log({ db: 'mg', title: `Smart meters reported ${docs.length} readings`, collapse: 'ingest',
      stmt: `db.meter_readings.insertMany([ …${docs.length} docs… ], { ordered: false })\n// e.g. ${w ? JSON.stringify({ ts: w.ts, meta: w.meta, flow_lpm: w.flow_lpm, kw: w.kw }) : ''}` });
  }
  detector.ingest(docs, now);
  await detector.detect(now);
  await automation.afterBatch(now, prev);
  // past the end of an open cycle: close and bill it
  const { rows: open } = await query("SELECT cycle_id, cycle_end_date FROM billing_cycle WHERE status = 'OPEN'");
  if (open.some(o => nextMonthStart(o.cycle_end_date) <= now)) await billing.closeDue(now);
  return docs.length;
}

async function fastForward(to) {
  const from = S.cityNow;
  let n = 0, ticks = 0;
  while (S.cityNow + TICK <= to) { n += await tick({ quiet: true }); ticks++; }
  if (ticks) {
    await mongo.col('ingestion_batches').insertOne({ source: 'fast-forward', count: n, from: new Date(from + TICK), to: new Date(S.cityNow), status: 'DONE', meters: S.meters.length });
    const f = t => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    activity.log({ db: 'mg', title: `Smart meters reported ${n.toLocaleString('en-IN')} readings (${f(from)} → ${f(S.cityNow)})`,
      stmt: `db.meter_readings.insertMany([ …${n} docs, one per meter every 15 min… ], { ordered: false })\n// ${ticks} ticks; detection and automation ran after every tick` });
  }
  return { readings: n, ticks };
}

// ---------- admin controls ----------
const advance = hours => exclusive(() => fastForward(S.cityNow + hours * HOUR));
async function monthEnd() {
  return exclusive(async () => {
    const { rows: [c] } = await query("SELECT cycle_end_date FROM billing_cycle WHERE status = 'OPEN' ORDER BY cycle_id LIMIT 1");
    if (!c) return { readings: 0, ticks: 0 };
    return fastForward(nextMonthStart(c.cycle_end_date));
  });
}
const setRunning = (user, on) => exclusive(() => saveSwitches(user, { running: !!on }));

const SCENARIOS = {
  burst: { meter: 'MTR-W-0001', fault: 'BURST' },
  spike: { meter: 'MTR-E-0004', fault: 'SPIKE' },
  outage: { ward: 7 },
};
function scenarioOn(id) {
  const s = SCENARIOS[id];
  if (s.ward) return S.meters.some(m => m.zone_id === s.ward && S.offline.has(m.meter_code));
  return S.faults[s.meter] === s.fault;
}
const scenario = (user, id, on) => exclusive(async () => {
  const s = SCENARIOS[id];
  if (!s) throw Object.assign(new Error('No such scenario.'), { status: 404 });
  if (s.ward) {
    const codes = S.meters.filter(m => m.zone_id === s.ward).map(m => m.meter_code);
    const off = new Set(S.offline);
    codes.forEach(c => on ? off.add(c) : off.delete(c));
    await saveSwitches(user, { offline: off });
  } else {
    const faults = { ...S.faults };
    if (on) faults[s.meter] = s.fault; else delete faults[s.meter];
    await saveSwitches(user, { faults });
  }
  activity.log({ db: 'pg', title: `Scenario ${on ? 'started' : 'ended'}: ${id}`, scope: 'admin',
    stmt: s.ward ? `UPDATE sim_clock SET offline = ${on ? `'{${S.meters.filter(m => m.zone_id === s.ward).map(m => m.meter_code).join(',')}}'` : `'{}'`};   -- those meters stop sending readings`
      : `UPDATE sim_clock SET faults = faults ${on ? `|| '{"${s.meter}": "${s.fault}"}'` : `- '${s.meter}'`};   -- the simulator now sends ${on ? s.fault.toLowerCase() : 'normal'} readings` });
});
const setPolicy = (user, key, on) => exclusive(async () => {
  if (!(key in S.policies)) throw Object.assign(new Error('No such policy.'), { status: 404 });
  await saveSwitches(user, { policies: { ...S.policies, [key]: !!on } });
});
// clear the injected fault of a meter (and bring its property's meters back online) once its ticket is resolved
const clearFault = (user, meterCode, propertyId) => exclusive(async () => {
  const faults = { ...S.faults }; delete faults[meterCode];
  const off = new Set(S.offline);
  if (propertyId) S.meters.filter(m => m.property_id === propertyId).forEach(m => off.delete(m.meter_code));
  if (JSON.stringify(faults) !== JSON.stringify(S.faults) || off.size !== S.offline.size) await saveSwitches(user, { faults, offline: off });
});

module.exports = { start, stop, tick, fastForward, advance, monthEnd, setRunning, scenario, scenarioOn, setPolicy, clearFault, exclusive, SCENARIOS,
  reloadMeters: () => exclusive(loadMeters), registers, cityDate: () => cityDate(S.cityNow) };
