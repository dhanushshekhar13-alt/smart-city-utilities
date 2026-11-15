// Bill forecast for the open cycle:
//   used so far = register now − register at the start of the cycle   (MongoDB, first/last document)
//   projection  = used + (last 24 hours' rate) × hours left in the cycle
//   price       = the same fn_tiered_charge slabs the real bill uses     (PostgreSQL)
// Past months are the usage lines of the property's last three invoices.
const mongo = require('../db/mongo');
const { pool } = require('../db/pg');
const { HOUR, nextMonthStart } = require('../time');
const { MONTH } = require('./billing');

const UT = { ELECTRICITY: { label: 'Electricity', unit: 'kWh' }, WATER: { label: 'Water', unit: 'kL' }, GAS: { label: 'Gas', unit: 'm³' } };
const REG = { $ifNull: ['$kwh_total', { $ifNull: ['$m3_total', { $divide: ['$volume_l_total', 1000] }] }] };
const SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function firstLast(codes, from, to) {
  const rows = await mongo.col('meter_readings').aggregate([
    { $match: { 'meta.meter_code': { $in: codes }, ts: { $gte: new Date(from), $lte: new Date(to) } } },
    { $sort: { ts: 1 } },
    { $group: { _id: '$meta.meter_code', opening: { $first: REG }, closing: { $last: REG }, t0: { $first: '$ts' }, t1: { $last: '$ts' } } },
  ]).toArray();
  return new Map(rows.map(r => [r._id, r]));
}

// q is a pg client (inside the signed-in person's transaction, so RLS applies) or the pool for system jobs
async function forecast(q, propertyId, now) {
  const { rows: [c] } = await q.query("SELECT * FROM billing_cycle WHERE status = 'OPEN' ORDER BY cycle_id LIMIT 1");
  if (!c) return null;
  const from = Date.parse(`${c.cycle_start_date}T00:00:00+05:30`), to = nextMonthStart(c.cycle_end_date);
  const left = Math.max(0, (to - now) / HOUR);
  const { rows: meters } = await q.query('SELECT meter_id, meter_code, utility_type FROM utility_meter WHERE property_id = $1 AND is_active ORDER BY utility_type', [propertyId]);
  if (!meters.length) return null;
  const codes = meters.map(m => m.meter_code);
  const [cyc, day] = await Promise.all([firstLast(codes, from, now), firstLast(codes, now - 24 * HOUR, now)]);

  const { rows: prev } = await q.query(`SELECT i.cycle_id, bc.month, SUM(li.line_total) FILTER (WHERE li.line_kind = 'USAGE')::bigint AS usage
    FROM invoice i JOIN billing_cycle bc USING (cycle_id) JOIN invoice_line_item li USING (invoice_id)
    WHERE i.property_id = $1 AND i.cycle_id < $2 GROUP BY i.cycle_id, bc.month ORDER BY i.cycle_id DESC LIMIT 3`, [propertyId, c.cycle_id]);
  prev.reverse();
  const { rows: usual } = await q.query(`SELECT um.utility_type, AVG(mr.total_units_consumed)::float AS avg_units
    FROM meter_reading mr JOIN utility_meter um USING (meter_id)
    WHERE um.property_id = $1 AND mr.cycle_id = ANY($2::int[]) GROUP BY um.utility_type`, [propertyId, prev.map(p => p.cycle_id)]);
  const usualOf = Object.fromEntries(usual.map(u => [u.utility_type, u.avg_units]));

  const rows = meters.map(m => {
    const a = cyc.get(m.meter_code), d = day.get(m.meter_code);
    const used = a ? Math.max(0, a.closing - a.opening) : 0;
    const hrs = d ? (d.t1 - d.t0) / HOUR : 0;
    const perH = d && hrs > 0 ? Math.max(0, (d.closing - d.opening) / hrs) : 0;
    const proj = used + perH * left, avgUnits = usualOf[m.utility_type] || 0;
    return { utility: m.utility_type, meter_code: m.meter_code, ...UT[m.utility_type], used, perH, proj, avgUnits, ratio: avgUnits ? proj / avgUnits : 1 };
  });
  // price "used so far" and "projected" with the database's slab function in one round trip
  const { rows: priced } = await q.query(`SELECT x.tag, x.utility, COALESCE(SUM(t.amount), 0)::bigint AS amount
    FROM unnest($1::text[], $2::text[], $3::numeric[]) AS x(tag, utility, units)
    LEFT JOIN LATERAL fn_tiered_charge(x.utility, x.units, $4::date) t ON TRUE
    GROUP BY x.tag, x.utility`,
    [[...rows.map(() => 'now'), ...rows.map(() => 'proj')], [...rows.map(r => r.utility), ...rows.map(r => r.utility)],
     [...rows.map(r => r.used.toFixed(3)), ...rows.map(r => r.proj.toFixed(3))], c.cycle_end_date]);
  const price = (tag, u) => (priced.find(p => p.tag === tag && p.utility === u) || { amount: 0 }).amount;
  for (const r of rows) { r.costNow = price('now', r.utility); r.costProj = price('proj', r.utility); }

  const total = rows.reduce((s, r) => s + r.costProj, 0), soFar = rows.reduce((s, r) => s + r.costNow, 0);
  const hist = prev.map(p => ({ label: SHORT[p.month], amt: p.usage }));
  const avg = hist.length ? hist.reduce((s, h) => s + h.amt, 0) / hist.length : 0;
  const worst = rows.slice().sort((a, b) => b.ratio - a.ratio)[0];
  return {
    cycle: { id: c.cycle_id, name: MONTH[c.month], short: SHORT[c.month], start: c.cycle_start_date, end: c.cycle_end_date, from, to },
    rows, total, soFar, hist, avg, ratio: avg ? total / avg : 1, worst, high: (avg > 0 && total >= 1.2 * avg) || worst.ratio >= 1.5,
    daysLeft: left / 24,
  };
}

const forecastSystem = (propertyId, now) => forecast(pool, propertyId, now);
module.exports = { forecast, forecastSystem, UT };
