// What the simulator needs in memory: the city clock row and the 24 meters with their switches.
// PostgreSQL stays the source of truth: every change is written there first and then reloaded here.
const { query, asOwner, asSystem } = require('../db/pg');

const S = {
  cityNow: 0, running: true, version: 0, gridKw: 15,
  policies: { autoDispatch: true, autoValve: true, demandResponse: true },
  faults: {},             // meter_code → 'BURST' | 'SPIKE'
  offline: new Set(),     // meter codes that stopped reporting
  meters: [], byCode: new Map(),
};

async function loadClock() {
  const { rows: [c] } = await query('SELECT city_now, running, policies, faults, offline, grid_kw, version FROM sim_clock WHERE id = 1');
  if (!c) throw new Error('sim_clock is empty: run "npm run setup" first');
  Object.assign(S, { cityNow: c.city_now, running: c.running, policies: c.policies, faults: c.faults, offline: new Set(c.offline), gridKw: Number(c.grid_kw), version: c.version });
}

async function loadMeters() {
  const { rows } = await query(`SELECT m.meter_id, m.meter_code, m.utility_type, m.supply_on, m.valve_open, m.is_active,
      p.property_id, p.property_code, p.property_type, p.zone_id, p.address_line, z.name AS zone_name, z.parent_zone_id AS district_id
    FROM utility_meter m JOIN property p USING (property_id) JOIN zone z ON z.zone_id = p.zone_id
    WHERE m.is_active ORDER BY m.meter_code`);
  S.meters = rows;
  S.byCode = new Map(rows.map(m => [m.meter_code, m]));
}

async function load() { await loadClock(); await loadMeters(); }

// change the scenario switches (faults, offline meters, automation policies) as a named person; audited by trg_audit
async function saveSwitches(user, patch) {
  const run = user ? fn => asOwner(user, fn) : fn => asSystem('simulator', fn);
  const { rows: [c] } = await run(c => c.query(`UPDATE sim_clock SET
      faults = COALESCE($1::jsonb, faults), offline = COALESCE($2::text[], offline), policies = COALESCE($3::jsonb, policies),
      running = COALESCE($4, running), version = version + 1
    WHERE id = 1 RETURNING version`,
    [patch.faults ? JSON.stringify(patch.faults) : null, patch.offline ? [...patch.offline] : null,
     patch.policies ? JSON.stringify(patch.policies) : null, patch.running ?? null]));
  await loadClock();
  return c.version;
}

async function bump() {
  const { rows: [c] } = await query('UPDATE sim_clock SET version = version + 1 WHERE id = 1 RETURNING version');
  S.version = c.version;
}

const metersOf = propertyId => S.meters.filter(m => m.property_id === propertyId);
const properties = () => [...new Map(S.meters.map(m => [m.property_id, m])).values()];
const ctx = (actor, user) => ({ actor: user ? user.display_name : actor, actorId: user ? user.user_id : null, cityAt: S.cityNow });

module.exports = { S, load, loadClock, loadMeters, saveSwitches, bump, metersOf, properties, ctx };
