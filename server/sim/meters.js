// Smart meter model: what a meter reports every 15 city minutes, and the checks every reading must pass
// before it is written to MongoDB.
const { TICK_MIN, istHour } = require('../time');

const UNIT = { ELECTRICITY: 'kWh', WATER: 'kL', GAS: 'm³' };

// demand at time t, shaped by the hour of day: kW for electricity, L/min for water, m³/h for gas
function profile(m, t, rand) {
  const h = istHour(t), com = m.property_type === 'COMMERCIAL';
  const day = com ? (h >= 8 && h < 20 ? 1 : 0.25) : (h >= 6 && h < 9 ? 1 : h >= 18 && h < 23 ? 1.25 : h < 5 ? 0.25 : 0.55);
  if (m.utility_type === 'ELECTRICITY') return (com ? 2.6 : 0.75) * day * rand(0.85, 1.15);
  if (m.utility_type === 'WATER') return Math.max(0.05, (com ? 0.9 : 0.5) * day * rand(0.6, 1.3) - (h < 5 ? 0.3 : 0));
  return (com ? 0.12 : 0.04) * day * rand(0.8, 1.2);
}

const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

// One reading. `state` = { register, fault, supplyOn, valveOpen }; the register (cumulative total) is advanced in place.
// fault: BURST (pipe burst), SPIKE (electricity spike) or undefined.
function makeReading(m, t, state, rand, advance = true) {
  let rate = profile(m, t, rand);
  if (state.fault === 'BURST') rate = rand(13.5, 15.5);
  if (state.fault === 'SPIKE') rate = rand(8.5, 10.5);
  const shut = !state.supplyOn || (m.utility_type === 'WATER' && !state.valveOpen);
  if (shut) rate = 0;                                   // supply off or valve closed: the meter still reports, usage stays 0
  const inc = m.utility_type === 'WATER' ? rate * TICK_MIN / 1000 : rate * TICK_MIN / 60;   // kL, kWh or m³ in 15 minutes
  if (advance) state.register = r3(state.register + inc);   // advance=false: an opening reading at the start of a cycle
  const doc = { ts: new Date(t), meta: { meter_code: m.meter_code, property_code: m.property_code, utility: m.utility_type, zone: m.zone_name } };
  if (m.utility_type === 'ELECTRICITY') {
    Object.assign(doc, { kwh_total: state.register, kw: r3(rate), voltage: r1(rand(226, 234)), current: r1(rate * 1000 / 230), power_factor: r2(rand(0.9, 0.98)) });
  } else if (m.utility_type === 'WATER') {
    const psi = state.fault === 'BURST' && !shut ? rand(22, 28) : !state.valveOpen ? 0 : rand(55, 62);
    Object.assign(doc, { volume_l_total: Math.round(state.register * 1000), flow_lpm: r2(rate), pressure_psi: r1(psi) });
  } else {
    Object.assign(doc, { m3_total: state.register, flow_m3h: r3(rate), pressure_kpa: r2(rand(2.0, 2.2)) });
  }
  return doc;
}

// cumulative register in billing units (kWh, kL, m³) and the instantaneous rate, whatever the meter type
const registerOf = d => d.kwh_total ?? (d.volume_l_total != null ? d.volume_l_total / 1000 : d.m3_total);
const rateOf = d => d.kw ?? d.flow_lpm ?? d.flow_m3h ?? 0;

// Ingestion checks (MongoDB time-series collections cannot have a $jsonSchema validator).
function validateReading(d) {
  const errs = [];
  const num = (k, min = 0) => { if (typeof d[k] !== 'number' || !Number.isFinite(d[k]) || d[k] < min) errs.push(`${k} must be a number ≥ ${min}`); };
  if (!(d.ts instanceof Date) || Number.isNaN(d.ts.getTime())) errs.push('ts must be a date');
  if (!d.meta || !/^MTR-[EWG]-[0-9]{4}$/.test(d.meta.meter_code || '')) errs.push('meta.meter_code is missing or malformed');
  if (!d.meta || !/^P-[0-9]{4}$/.test(d.meta.property_code || '')) errs.push('meta.property_code is missing or malformed');
  const u = d.meta && d.meta.utility;
  if (u === 'ELECTRICITY') { num('kwh_total'); num('kw'); num('voltage', 100); }
  else if (u === 'WATER') { num('volume_l_total'); num('flow_lpm'); num('pressure_psi'); }
  else if (u === 'GAS') { num('m3_total'); num('flow_m3h'); num('pressure_kpa'); }
  else errs.push('meta.utility must be ELECTRICITY, WATER or GAS');
  if (d.meta && d.meta.meter_code && u && d.meta.meter_code[4] !== u[0]) errs.push('meter_code does not match the utility');
  return errs;
}

module.exports = { UNIT, profile, makeReading, registerOf, rateOf, validateReading };
