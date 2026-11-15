// Synthetic city (seed 42). Every name, email, phone and ID is made up: citizen_ref is SYN-xxxxx and the
// database rejects anything else. Bills are produced by the real stored procedure, not typed in.
const { makeRand } = require('../server/sim/random');
const { makeReading } = require('../server/sim/meters');
const { hashPassword } = require('../server/auth');
const { SIM_START, TICK, HOUR } = require('../server/time');

const OCT1 = Date.parse('2026-10-01T00:00:00+05:30');

async function seed(pg, mongo, log = console.log) {
  const rand = makeRand(42);
  const q = (text, params) => pg.query(text, params);

  // ---------- PostgreSQL ----------
  await q("SELECT set_config('app.actor', 'seed', false)");
  await q('INSERT INTO sim_clock (id, city_now, running) VALUES (1, $1, true)', [new Date(SIM_START)]);

  const zones = [[1, 'Synthetic City', 'CITY', null], [2, 'North District', 'DISTRICT', 1], [3, 'South District', 'DISTRICT', 1],
    [4, 'Ward N-1', 'WARD', 2], [5, 'Ward N-2', 'WARD', 2], [6, 'Ward S-1', 'WARD', 3], [7, 'Ward S-2', 'WARD', 3]];
  for (const z of zones) await q('INSERT INTO zone (zone_id, name, zone_level, parent_zone_id) VALUES ($1, $2, $3, $4)', z);
  const zoneName = Object.fromEntries(zones.map(z => [z[0], z[1]]));

  const RES = [['Asha Rao', 'asha'], ['Vikram Iyer', 'vikram'], ['Meera Nair', 'meera'], ['Rahul Desai', 'rahul'], ['Fatima Sheikh', 'fatima'], ['Arjun Menon', 'arjun']];
  const resident = {};
  for (const [i, [name, handle]] of RES.entries()) {
    const { rows } = await q(`INSERT INTO resident (citizen_ref, full_name, email, phone, registered_date)
      VALUES ($1, $2, $3, $4, '2025-04-01') RETURNING resident_id`,
      [`SYN-${String(i + 1).padStart(5, '0')}`, name, `${handle}@example.test`, `+91900000000${i + 1}`]);
    resident[handle] = rows[0].resident_id;
  }

  const PROPS = [['asha', 4, 'RESIDENTIAL', '12 Lake View Road'], ['vikram', 4, 'RESIDENTIAL', '7 Temple Street'], ['meera', 5, 'RESIDENTIAL', '44 Hill Crest Layout'],
    ['rahul', 6, 'COMMERCIAL', 'Desai Bakery, 3 Market Lane'], ['fatima', 6, 'RESIDENTIAL', '19 Garden Colony'], ['arjun', 7, 'RESIDENTIAL', '5 River Bank Road'],
    ['asha', 7, 'COMMERCIAL', 'Rao Print Shop, 88 Station Road'], ['vikram', 5, 'RESIDENTIAL', '2 Orchard Avenue']];
  const props = [];
  for (const [i, [h, zone, type, addr]] of PROPS.entries()) {
    const code = `P-${String(i + 1).padStart(4, '0')}`;
    const { rows } = await q(`INSERT INTO property (property_code, resident_id, zone_id, address_line, pincode, property_type, square_feet)
      VALUES ($1, $2, $3, $4, '560001', $5, $6) RETURNING property_id`, [code, resident[h], zone, addr, type, type === 'COMMERCIAL' ? 1800 : 1200]);
    props.push({ property_id: rows[0].property_id, property_code: code, property_type: type, zone_id: zone, zone_name: zoneName[zone] });
  }

  const UT = { ELECTRICITY: ['E', 'SM-3P-200'], WATER: ['W', 'UFM-25'], GAS: ['G', 'GSM-G4'] };
  const meters = [];
  for (const [i, p] of props.entries()) {
    for (const [u, [letter, model]] of Object.entries(UT)) {
      const code = `MTR-${letter}-${String(i + 1).padStart(4, '0')}`;
      const { rows } = await q(`INSERT INTO utility_meter (meter_code, property_id, utility_type, installation_date, meter_model)
        VALUES ($1, $2, $3, '2025-04-10', $4) RETURNING meter_id`, [code, p.property_id, u, model]);
      meters.push({ meter_id: rows[0].meter_id, meter_code: code, utility_type: u, ...p });
    }
  }

  const cycles = [[1, 7, '2026-07-01', '2026-07-31', '2026-08-30', 'CLOSED'], [2, 8, '2026-08-01', '2026-08-31', '2026-09-30', 'CLOSED'],
    [3, 9, '2026-09-01', '2026-09-30', '2026-10-30', 'CLOSED'], [4, 10, '2026-10-01', '2026-10-31', '2026-11-30', 'OPEN']];
  for (const c of cycles) {
    await q(`INSERT INTO billing_cycle (cycle_id, year, month, cycle_start_date, cycle_end_date, due_date, late_penalty_percent, status)
      VALUES ($1, 2026, $2, $3, $4, $5, 5, $6)`, c);
  }
  await q("SELECT setval('billing_cycle_cycle_id_seq', 4)");

  const RATES = [['ELECTRICITY', 1, 0, 100, 5], ['ELECTRICITY', 2, 100, 300, 8], ['ELECTRICITY', 3, 300, null, 12],
    ['WATER', 1, 0, 10, 8], ['WATER', 2, 10, 25, 15], ['WATER', 3, 25, null, 25], ['GAS', 1, 0, 20, 30], ['GAS', 2, 20, null, 40]];
  for (const r of RATES) {
    await q(`INSERT INTO utility_rate (utility_type, tier_level, min_units, max_units, price_per_unit, effective_start_date)
      VALUES ($1, $2, $3, $4, $5, '2026-04-01')`, r);
  }

  // monthly usage for July, August and September (what the bridge wrote at each month end)
  const BASE = { RESIDENTIAL: { ELECTRICITY: [260, 420], WATER: [12, 22], GAS: [14, 26] }, COMMERCIAL: { ELECTRICITY: [650, 980], WATER: [20, 34], GAS: [30, 55] } };
  const register = {};
  for (const m of meters) register[m.meter_code] = Math.round(m.utility_type === 'ELECTRICITY' ? rand(8000, 15000) : m.utility_type === 'WATER' ? rand(400, 900) : rand(300, 700));
  const { rows: [run] } = await q(`INSERT INTO aggregation_run (cycle_id, started_at, finished_at, status, meters_total, meters_written)
    VALUES (3, '2026-10-01 01:00+05:30', '2026-10-01 01:02+05:30', 'SUCCEEDED', 24, 24) RETURNING run_id`);
  for (const cyc of [1, 2, 3]) {
    for (const m of meters) {
      const [a, b] = BASE[m.property_type][m.utility_type];
      const scale = m.utility_type === 'ELECTRICITY' ? 1 : 10;
      let units = Math.round(rand(a, b) * scale) / scale;
      if (m.property_code === 'P-0001' && cyc === 3) units = { ELECTRICITY: 450, WATER: 18, GAS: 24 }[m.utility_type];   // Asha's September bill: ₹4,860
      if (m.property_code === 'P-0004' && m.utility_type === 'ELECTRICITY' && cyc === 3) units = 1240;                  // the bakery's new oven
      const open = register[m.meter_code], close = Math.round((open + units) * 1000) / 1000;
      register[m.meter_code] = close;
      await q(`INSERT INTO meter_reading (meter_id, cycle_id, run_id, opening_register, closing_register, source_doc_count, reading_timestamp)
        VALUES ($1, $2, $3, $4, $5, 2880, $6)`,
        [m.meter_id, cyc, cyc === 3 ? run.run_id : null, open, close, `2026-${String(cyc + 7).padStart(2, '0')}-01 01:00+05:30`]);
    }
  }

  // July to September bills through the real procedure; some are left unpaid on purpose
  const UNPAID = (code, cyc) => (code === 'P-0004' && cyc < 3) || (code === 'P-0006' && cyc === 2) || (cyc === 3 && ['P-0001', 'P-0002', 'P-0004', 'P-0006'].includes(code));
  const METHODS = ['UPI_SIM', 'NETBANK_SIM', 'CARD_SIM'];
  for (const cyc of [1, 2, 3]) {
    for (const p of props) {
      const { rows: [r] } = await q('CALL sp_generate_invoice($1, $2)', [p.property_id, cyc]);
      if (UNPAID(p.property_code, cyc)) continue;
      const due = cycles[cyc - 1][4];
      await q(`INSERT INTO payment (invoice_id, idempotency_key, amount_paid, payment_method, status, transaction_id, payment_date)
        SELECT invoice_id, 'seed-' || invoice_no, total_amount, $2, 'SUCCEEDED', 'SIMTXN-' || nextval('txn_no_seq'), ($3::date - 5) + time '10:00' AT TIME ZONE 'Asia/Kolkata'
        FROM invoice WHERE invoice_id = $1`, [r.p_invoice, METHODS[Math.floor(rand.raw() * 3)], due]);
    }
  }
  // bills already past their due date get the late fee, exactly as the nightly job would have done
  await q("SELECT * FROM fn_mark_overdue('2026-10-25')");

  // accounts (password demo123 for every demo account; each gets its own random salt)
  const USERS = [['asha@example.test', 'RESIDENT', 'asha', null, 'Asha Rao'], ['vikram@example.test', 'RESIDENT', 'vikram', null, 'Vikram Iyer'],
    ['ravi.staff@city.example.test', 'STAFF', null, 2, 'Ravi Kumar'], ['neha.staff@city.example.test', 'STAFF', null, 2, 'Neha Joshi'],
    ['kavya.staff@city.example.test', 'STAFF', null, 3, 'Kavya Shetty'], ['admin@city.example.test', 'ADMIN', null, null, 'City Admin']];
  for (const [email, role, res, zone, name] of USERS) {
    await q(`INSERT INTO app_user (email, password_hash, role, resident_id, staff_zone_id, display_name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [email, await hashPassword('demo123'), role, res ? resident[res] : null, zone, name]);
  }
  log(`PostgreSQL: 7 zones, 6 residents, ${props.length} properties, ${meters.length} meters, 4 cycles, 8 tariff slabs, 72 monthly readings, 24 invoices, 6 accounts`);

  // ---------- MongoDB: every 15-minute reading from 1 October 00:00 to the start of the demo ----------
  let docs = [], total = 0;
  const flush = async () => { if (docs.length) { await mongo.col('meter_readings').insertMany(docs, { ordered: false }); total += docs.length; docs = []; } };
  const state = Object.fromEntries(meters.map(m => [m.meter_code, { register: register[m.meter_code], supplyOn: true, valveOpen: true }]));
  for (let t = OCT1; t <= SIM_START; t += TICK) {
    for (const m of meters) docs.push(makeReading(m, t, state[m.meter_code], rand, t !== OCT1));
    if (docs.length >= 6000) await flush();
  }
  await flush();
  await mongo.col('ingestion_batches').insertOne({ source: 'seed-42 backfill', count: total, from: new Date(OCT1), to: new Date(SIM_START), status: 'DONE', meters: meters.length });
  log(`MongoDB: ${total.toLocaleString('en-IN')} meter readings (24 meters, every 15 minutes from 1 Oct to 25 Oct 08:00)`);

  // the audit trail starts empty: it records what people and jobs do from here on
  await q('TRUNCATE audit_log');
  return { total, hours: (SIM_START - OCT1) / HOUR };
}

module.exports = { seed };
