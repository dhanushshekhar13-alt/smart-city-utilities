// The MongoDB → PostgreSQL bridge and the monthly billing run.
//   aggregate(): first and last cumulative register per meter in the cycle window (MongoDB pipeline),
//                written as one meter_reading row per meter (UPSERT; billed rows are locked by trigger)
//   invoices():  CALL sp_generate_invoice for every property (idempotent)
//   closeDue():  what the nightly job does when the clock passes a month end
const mongo = require('../db/mongo');
const { asSystem, asOwner, query } = require('../db/pg');
const activity = require('../activity');
const { S, ctx, properties } = require('../sim/state');
const { nextMonthStart } = require('../time');
const { ownerOf, notify } = require('./notify');

const MONTH = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const inr = paise => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const REG = { $ifNull: ['$kwh_total', { $ifNull: ['$m3_total', { $divide: ['$volume_l_total', 1000] }] }] };
const istMidnight = d => Date.parse(`${d}T00:00:00+05:30`);

const pipeline = (from, to) => [
  { $match: { ts: { $gte: new Date(from), $lte: new Date(to) } } },
  { $sort: { 'meta.meter_code': 1, ts: 1 } },
  { $group: { _id: '$meta.meter_code', opening: { $first: REG }, closing: { $last: REG }, docs: { $sum: 1 } } },
];
const pipelineText = (from, to) => `db.meter_readings.aggregate([
  { $match: { ts: { $gte: ISODate("${new Date(from).toISOString()}"), $lte: ISODate("${new Date(to).toISOString()}") } } },
  { $sort:  { "meta.meter_code": 1, ts: 1 } },
  { $group: { _id: "$meta.meter_code",
      opening: { $first: { $ifNull: ["$kwh_total", { $ifNull: ["$m3_total", { $divide: ["$volume_l_total", 1000] }] }] } },
      closing: { $last:  { …same… } },
      docs:    { $sum: 1 } } }
])`;

const run = (user, actor) => user ? fn => asOwner(user, fn) : fn => asSystem(actor, fn);

async function getCycle(cycleId) {
  const { rows: [c] } = await query('SELECT * FROM billing_cycle WHERE cycle_id = $1', [cycleId]);
  if (!c) throw Object.assign(new Error(`Billing cycle ${cycleId} does not exist.`), { status: 404 });
  c.name = `${MONTH[c.month]} ${c.year}`;
  c.from = istMidnight(c.cycle_start_date);
  c.to = nextMonthStart(c.cycle_end_date);      // midnight after the last day: closing reading of this cycle, opening of the next
  return c;
}

async function aggregate(cycleId, { user = null, actor = 'billing-job', upTo = S.cityNow } = {}) {
  const c = await getCycle(cycleId);
  const to = Math.min(upTo, c.to);
  const exec = run(user, actor);
  const { rows: [r] } = await exec(q => q.query(`INSERT INTO aggregation_run (cycle_id, started_at, status, meters_total)
    VALUES ($1, fn_city_now(), 'RUNNING', $2) RETURNING run_id`, [cycleId, S.meters.length]));
  const totals = await mongo.col('meter_readings').aggregate(pipeline(c.from, to)).toArray();
  activity.log({ db: 'mg', title: `Aggregated ${c.name} usage for ${totals.length} meters`, stmt: pipelineText(c.from, to) });
  const byCode = new Map(totals.map(t => [t._id, t]));
  let written = 0, locked = 0;
  const errors = [];
  await exec(async q => {
    for (const m of S.meters) {
      const t = byCode.get(m.meter_code);
      if (!t) continue;
      await q.query('SAVEPOINT one_meter');
      try {
        await q.query(`INSERT INTO meter_reading (meter_id, cycle_id, run_id, opening_register, closing_register, source_doc_count, reading_timestamp)
          VALUES ($1, $2, $3, round($4::numeric, 3), round($5::numeric, 3), $6, fn_city_now())
          ON CONFLICT (meter_id, cycle_id) DO UPDATE SET opening_register = EXCLUDED.opening_register, closing_register = EXCLUDED.closing_register,
            source_doc_count = EXCLUDED.source_doc_count, run_id = EXCLUDED.run_id, reading_timestamp = EXCLUDED.reading_timestamp`,
          [m.meter_id, cycleId, r.run_id, t.opening, t.closing, t.docs]);
        await q.query('RELEASE SAVEPOINT one_meter');
        written++;
      } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT one_meter');
        if (/READING_LOCKED/.test(e.message)) locked++; else errors.push(e.message);
      }
    }
    await q.query(`UPDATE aggregation_run SET finished_at = fn_city_now(), status = $2, meters_written = $3, error = $4 WHERE run_id = $1`,
      [r.run_id, errors.length ? 'FAILED' : 'SUCCEEDED', written, errors[0] || (locked ? `${locked} meters already invoiced (READING_LOCKED)` : null)]);
  });
  activity.log({ db: 'pg', title: `Bridge wrote ${written} meter readings${locked ? `, ${locked} locked because already invoiced` : ''}`, err: errors[0] || null,
    stmt: `INSERT INTO meter_reading (meter_id, cycle_id, run_id, opening_register, closing_register, source_doc_count)\nVALUES ($1, ${cycleId}, '${r.run_id.slice(0, 8)}…', $2, $3, $4)\nON CONFLICT (meter_id, cycle_id) DO UPDATE\n  SET closing_register = EXCLUDED.closing_register, run_id = EXCLUDED.run_id;\n-- one SAVEPOINT per meter; trg_reading_locked rejects rows that are already invoiced` });
  return { cycle: c, run_id: r.run_id, written, locked, errors, upTo: to };
}

async function invoices(cycleId, { user = null, actor = 'billing-job' } = {}) {
  const c = await getCycle(cycleId);
  const created = [], existed = [], errors = [];
  for (const p of properties()) {
    try {
      const r = await run(user, actor)(async q => {
        const { rows: [o] } = await q.query('CALL sp_generate_invoice($1, $2)', [p.property_id, cycleId]);
        const { rows: [i] } = await q.query('SELECT invoice_id, invoice_no, total_amount, property_id FROM invoice WHERE invoice_id = $1', [o.p_invoice]);
        return { ...i, created: o.p_created, property_code: p.property_code };
      });
      (r.created ? created : existed).push(r);
    } catch (e) { errors.push(`${p.property_code}: ${e.message}`); }
  }
  activity.log({ db: 'pg', title: `sp_generate_invoice: ${created.length} created, ${existed.length} already existed${errors.length ? `, ${errors.length} rolled back` : ''}`, err: errors[0] || null,
    stmt: `-- one transaction per property\nCALL sp_generate_invoice(property_id, ${cycleId});   -- × ${properties().length} properties\n--  1. pg_advisory_xact_lock(hash(property), cycle)\n--  2. invoice exists → return it (no duplicate)\n--  3. every meter needs a meter_reading, else RAISE MISSING_READING\n--  4. fn_tiered_charge() per utility → line items\n--  5. trg_invoice_total keeps invoice.total_amount = SUM(lines)` });
  return { cycle: c, created, existed, errors };
}

// close every open cycle whose last day is over, open the next one and tell residents their bill is ready
async function closeDue(now, { user = null } = {}) {
  const { rows: open } = await query("SELECT cycle_id, cycle_end_date FROM billing_cycle WHERE status = 'OPEN' ORDER BY cycle_id");
  const results = [];
  for (const o of open) {
    if (nextMonthStart(o.cycle_end_date) > now) continue;
    const actor = 'nightly-billing';
    const agg = await aggregate(o.cycle_id, { user, actor, upTo: now });
    const inv = await invoices(o.cycle_id, { user, actor });
    if (inv.errors.length) { results.push({ agg, inv, closed: false }); continue; }
    const next = await run(user, actor)(async q => {
      await q.query("UPDATE billing_cycle SET status = 'CLOSED' WHERE cycle_id = $1 AND status = 'OPEN'", [o.cycle_id]);
      const { rows: [n] } = await q.query(`INSERT INTO billing_cycle (year, month, cycle_start_date, cycle_end_date, due_date, late_penalty_percent)
        SELECT EXTRACT(YEAR FROM s)::int, EXTRACT(MONTH FROM s)::int, s, e, e + 30, c.late_penalty_percent
        FROM billing_cycle c, LATERAL (SELECT (c.cycle_end_date + 1) AS s) a, LATERAL (SELECT (a.s::timestamp + interval '1 month' - interval '1 day')::date AS e) b
        WHERE c.cycle_id = $1
        ON CONFLICT (year, month) DO NOTHING RETURNING cycle_id, year, month`, [o.cycle_id]);
      return n;
    });
    activity.log({ db: 'pg', title: `${inv.cycle.name} closed${next ? `; ${MONTH[next.month]} ${next.year} opened` : ''}`,
      stmt: `UPDATE billing_cycle SET status = 'CLOSED' WHERE cycle_id = ${o.cycle_id};\nINSERT INTO billing_cycle (year, month, cycle_start_date, cycle_end_date, due_date)\nVALUES (…next month…, cycle_end_date + 30)\nON CONFLICT (year, month) DO NOTHING;` });
    for (const i of inv.created) {
      const owner = await ownerOf(i.property_id);
      if (owner) await notify(ctx(actor, user), owner.user_id, 'BILL', `${MONTH[inv.cycle.month]} bill ready for ${i.property_code}`,
        `${i.invoice_no}: ${inr(i.total_amount)}, due ${new Date(istMidnight(inv.cycle.due_date)).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}. Open Bills & payments to see the slabs and pay.`);
    }
    if (inv.created.length) activity.log({ db: 'mg', title: `Bill alerts sent for ${inv.created.length} invoices`, stmt: 'db.notifications.insertMany([ { kind: "BILL", title: "… bill ready for P-…" }, … ])' });
    results.push({ agg, inv, closed: true, next });
  }
  return results;
}

module.exports = { aggregate, invoices, closeDue, getCycle, pipeline, pipelineText, MONTH };
