// Footprint & savings: carbon footprint, comparison with similar properties, eco score and habit tips.
// Monthly figures come from PostgreSQL (meter_reading, via fn_peer_usage); habit checks read the last
// 24 hours of MongoDB readings.
const mongo = require('../db/mongo');
const { HOUR, istHour } = require('../time');
const { forecast, UT } = require('./forecast');

const CO2 = { ELECTRICITY: 0.71, WATER: 0.35, GAS: 2.0 };   // kg CO2e per kWh, kL, m³ (approximate)
const CAR_KG_PER_KM = 0.17, TREE_KG_PER_MONTH = 1.75;
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const kgOf = u => Object.keys(CO2).reduce((s, k) => s + (u[k] || 0) * CO2[k], 0);
const n1 = v => (Math.round(v * 10) / 10).toLocaleString('en-IN'), n2 = v => (Math.round(v * 100) / 100).toFixed(2);
const grade = s => s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'E';

async function habits(codes, now) {
  const docs = await mongo.col('meter_readings').find({ 'meta.meter_code': { $in: codes }, ts: { $gt: new Date(now - 24 * HOUR), $lte: new Date(now) } })
    .project({ ts: 1, 'meta.utility': 1, kw: 1, flow_lpm: 1 }).sort({ ts: 1 }).toArray();
  const ed = docs.filter(d => d.meta.utility === 'ELECTRICITY'), wd = docs.filter(d => d.meta.utility === 'WATER');
  const base = ed.length ? Math.min(...ed.map(d => d.kw)) : 0;
  const tot = ed.reduce((s, d) => s + d.kw, 0);
  const peak = ed.filter(d => { const h = istHour(d.ts.getTime()); return h >= 18 && h < 22; }).reduce((s, d) => s + d.kw, 0);
  const night = wd.filter(d => { const h = istHour(d.ts.getTime()); return h >= 1 && h < 5; });
  const nightMin = night.length ? Math.min(...night.map(d => d.flow_lpm)) : null;
  const rec = wd.filter(d => d.ts.getTime() > now - 3 * HOUR);
  const recentMin = rec.length >= 8 ? Math.min(...rec.map(d => d.flow_lpm)) : 0;
  return { base, peakShare: tot ? peak / tot : 0, nightMin, recentMin, hours: ed.length / 4 };
}

// q: the caller's pg client (RLS applies) or the pool for admin views
async function ecoReport(q, propertyId, now) {
  const { rows: [p] } = await q.query(`SELECT p.property_id, p.property_code, p.property_type, p.address_line, z.name AS zone_name, d.name AS district_name
    FROM property p JOIN zone z ON z.zone_id = p.zone_id LEFT JOIN zone d ON d.zone_id = z.parent_zone_id WHERE p.property_id = $1`, [propertyId]);
  if (!p) return null;
  const { rows: [{ cyc }] } = await q.query(`SELECT MAX(mr.cycle_id) AS cyc FROM meter_reading mr JOIN utility_meter um USING (meter_id)
    JOIN invoice i ON i.property_id = um.property_id AND i.cycle_id = mr.cycle_id WHERE um.property_id = $1`, [propertyId]);
  const { rows: [cycle] } = await q.query('SELECT cycle_id, year, month, cycle_end_date FROM billing_cycle WHERE cycle_id = $1', [cyc]);
  const { rows: peerRows } = await q.query('SELECT * FROM fn_peer_usage($1, $2)', [propertyId, cyc]);
  const { rows: rates } = await q.query(`SELECT utility_type, min_units, max_units, price_per_unit FROM utility_rate
    WHERE effective_start_date <= $1 AND (effective_end_date IS NULL OR $1 < effective_end_date)`, [cycle.cycle_end_date]);
  const { rows: meters } = await q.query('SELECT meter_code, utility_type FROM utility_meter WHERE property_id = $1', [propertyId]);
  // marginal price in paise: the slab the next unit falls in
  const marginal = (ut, units) => { const s = rates.find(r => r.utility_type === ut && units >= r.min_units && (r.max_units == null || units < r.max_units)); return s ? s.price_per_unit * 100 : 0; };

  const peers = new Map();
  for (const r of peerRows) { if (!peers.has(r.peer)) peers.set(r.peer, { self: r.is_self, u: {} }); peers.get(r.peer).u[r.utility_type] = r.units; }
  const list = [...peers.values()], mine = (list.find(x => x.self) || { u: {} }).u;
  const scope = peerRows[0] ? peerRows[0].peer_scope : 'CITY';
  const noun = p.property_type === 'COMMERCIAL' ? 'businesses' : 'homes';
  const label = scope === 'DISTRICT' ? `${noun} in ${p.district_name}` : `${noun} across the city`;
  const cmp = Object.keys(UT).map(ut => {
    const vals = list.map(x => x.u[ut]).filter(v => v != null), med = median(vals), you = mine[ut] || 0;
    return { ut, label: UT[ut].label, unit: UT[ut].unit, you, med, min: Math.min(...vals), max: Math.max(...vals), ratio: med ? you / med : 1,
      more: list.filter(x => !x.self && x.u[ut] > you).length, others: list.length - 1, vals };
  });
  const kg = kgOf(mine), peerKg = median(list.map(x => kgOf(x.u)));
  const f = await forecast(q, propertyId, now);
  const soFarKg = f ? f.rows.reduce((s, r) => s + r.used * CO2[r.utility], 0) : 0, projKg = f ? f.rows.reduce((s, r) => s + r.proj * CO2[r.utility], 0) : 0;
  const h = await habits(meters.filter(m => m.utility_type !== 'GAS').map(m => m.meter_code), now);
  const com = p.property_type === 'COMMERCIAL';

  const tips = [];
  if (h.recentMin > 2) {
    const kl = h.recentMin * 60 * 24 * 30 / 1000;
    tips.push({ lvl: 'crit', title: 'Water has not stopped for 3 hours', body: `Flow never fell below ${n2(h.recentMin)} L/min in the last 3 hours. Normal use comes and goes, so this is almost certainly a burst or leak. At this rate it would waste about ${n1(kl)} kL in a month.`, save: kl * marginal('WATER', mine.WATER || 0) });
  } else if (h.nightMin != null && h.nightMin > 0.5) {
    const kl = h.nightMin * 60 * 24 * 30 / 1000;
    tips.push({ lvl: 'crit', title: 'Water keeps running at night', body: `Between 1 and 5 am the lowest flow was ${n2(h.nightMin)} L/min. A home with every tap closed drops close to zero, so this looks like a leak or a running toilet. Left alone it wastes about ${n1(kl)} kL a month.`, save: kl * marginal('WATER', mine.WATER || 0) });
  } else if (h.nightMin != null) tips.push({ lvl: 'ok', title: 'No hidden water leak', body: `Night-time flow fell to ${n2(h.nightMin)} L/min between 1 and 5 am, which is what a sealed system looks like.`, save: 0 });
  const baseLimit = com ? 1.0 : 0.15, baseTarget = com ? 0.6 : 0.1;
  if (h.base > baseLimit) {
    const kwh = (h.base - baseTarget) * 24 * 30;
    tips.push({ lvl: 'warn', title: 'High always-on electricity', body: `Even at the quietest hour this ${com ? 'business' : 'home'} drew ${n2(h.base)} kW. Fridges, routers and devices on standby add up to about ${Math.round(h.base * 720)} kWh a month. Switching standby loads off at the wall could save around ${Math.round(kwh)} kWh.`, save: kwh * marginal('ELECTRICITY', mine.ELECTRICITY || 0) });
  } else tips.push({ lvl: 'ok', title: 'Low standby load', body: `The lowest draw in the last day was ${n2(h.base)} kW, so little is left running when nobody needs it.`, save: 0 });
  if (h.peakShare > 0.35) tips.push({ lvl: 'warn', title: 'Much of your power is used at peak time', body: `${Math.round(h.peakShare * 100)}% of the last day's electricity was used between 6 and 10 pm, when the city grid is busiest. Running the washing machine, geyser or pump earlier in the day eases the load that triggers peak-demand events.`, save: 0 });
  else tips.push({ lvl: 'ok', title: 'Peak hours under control', body: `Only ${Math.round(h.peakShare * 100)}% of the last day's electricity was used between 6 and 10 pm.`, save: 0 });
  const worst = cmp.slice().sort((a, b) => b.ratio - a.ratio)[0];
  if (worst.ratio > 1.05) {
    const ideas = { ELECTRICITY: 'LED bulbs, a 5-star fridge and setting the AC to 24 °C are the usual big wins.', WATER: 'Tap aerators and a dual-flush toilet cut use by a quarter in most homes.', GAS: 'A pressure cooker and lids on pans cut cooking gas by up to a third.' };
    tips.push({ lvl: 'warn', title: `${worst.label} is above similar ${noun}`, body: `Last month you used ${n1(worst.you)} ${worst.unit} against a typical ${n1(worst.med)}. ${ideas[worst.ut]}`, save: (worst.you - worst.med) * marginal(worst.ut, worst.you) });
  }
  // eco score: start at 70, move with each utility against the peer median, then adjust for habits
  let score = 70 + cmp.reduce((s, c) => s + Math.max(-15, Math.min(10, (1 - c.ratio) * 30)), 0);
  if (h.recentMin > 2 || (h.nightMin != null && h.nightMin > 0.5)) score -= 25;
  if (h.base > baseLimit) score -= 5;
  score += h.peakShare > 0.35 ? -5 : 5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const order = { crit: 0, warn: 1, ok: 2 };
  return { property: p, cycle, mine, label, noun, cmp, kg, peerKg, soFarKg, projKg, forecast: f, habits: h,
    tips: tips.sort((a, b) => order[a.lvl] - order[b.lvl]), score, grade: grade(score), saving: tips.reduce((s, t) => s + t.save, 0),
    car_km: kg / CAR_KG_PER_KM, trees: kg / TREE_KG_PER_MONTH, factors: CO2 };
}

module.exports = { ecoReport, CO2, kgOf, grade };
