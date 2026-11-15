// The city reacting on its own: anomaly → ticket → dispatch → valve, then a repair by staff, all recorded in the audit trail.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers');

let pg, mongo, admin, asha, neha, ravi;
const one = async (sql, p) => (await pg.query(sql, p)).rows[0];
const ticket = type => one(`SELECT t.ticket_id, t.ticket_no, t.status, t.severity, t.anomaly_key, u.display_name AS assigned
  FROM maintenance_ticket t LEFT JOIN app_user u ON u.user_id = t.assigned_to WHERE t.issue_type = $1 ORDER BY t.reported_timestamp DESC LIMIT 1`, [type]);

before(async () => {
  ({ pg, mongo } = await T.fresh());
  admin = await T.as(T.EMAIL.admin); asha = await T.as(T.EMAIL.asha); neha = await T.as(T.EMAIL.neha); ravi = await T.as(T.EMAIL.ravi);
});
after(T.close);

test('a pipe burst opens one critical leak ticket, dispatches it and closes the smart valve', async () => {
  assert.equal((await admin.post('/admin/scenarios/burst', { on: true })).status, 200);
  await admin.post('/clock/advance', { hours: 2 });
  const t = await ticket('LEAK');
  assert.equal(t.severity, 'CRITICAL');
  assert.equal(t.status, 'ASSIGNED');
  assert.equal(t.assigned, 'Neha Joshi', 'Ravi and Neha are tied on open jobs; the tie goes by email, so Neha');
  await admin.post('/clock/advance', { hours: 1 });
  const n = await one("SELECT count(*)::int AS n FROM maintenance_ticket WHERE issue_type = 'LEAK'");
  assert.equal(n.n, 1, 'repeat detections update the same ticket instead of opening new ones');
  const valve = await one("SELECT valve_open FROM utility_meter WHERE meter_code = 'MTR-W-0001'");
  assert.equal(valve.valve_open, false);
  const cmd = await mongo.col('device_commands').findOne({ meter_code: 'MTR-W-0001', command: 'CLOSE_VALVE' });
  assert.equal(cmd.status, 'ACKED');
  const ev = await mongo.col('anomaly_events').findOne({ type: 'LEAK' });
  assert.equal(ev.synced_to_sql, true);
  assert.equal(ev.ticket_no, t.ticket_no);
  const alerts = (await asha.get('/me/notifications')).body.notifications;
  assert.ok(alerts.some(a => a.kind === 'ALERT'));
});

test('a resident complaint goes to the engineer with fewer open jobs', async () => {
  const { body } = await asha.get('/me/properties');
  const p = body.properties.find(x => x.property_code === 'P-0001');
  const r = await asha.post('/me/tickets', { property_id: p.property_id, issue_type: 'LOW_PRESSURE', description: 'Very low water pressure in the kitchen.' });
  assert.equal(r.status, 200);
  const t = await one('SELECT u.display_name FROM maintenance_ticket t JOIN app_user u ON u.user_id = t.assigned_to WHERE t.ticket_no = $1', [r.body.ticket_no]);
  assert.equal(t.display_name, 'Ravi Kumar');
});

test('staff follow the state machine, need notes to resolve, and resolving reopens the valve', async () => {
  const t = await ticket('LEAK');
  assert.equal((await ravi.post(`/tickets/${t.ticket_id}/status`, { to: 'IN_PROGRESS' })).status, 403, "Ravi cannot move Neha's ticket");
  const bad = await neha.post(`/tickets/${t.ticket_id}/status`, { to: 'CLOSED' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.pg, /ILLEGAL_TRANSITION/);
  assert.equal((await neha.post(`/tickets/${t.ticket_id}/status`, { to: 'IN_PROGRESS' })).status, 200);
  assert.equal((await neha.post(`/tickets/${t.ticket_id}/notes`, { text: 'Crew on site, main valve isolated.' })).status, 200);
  assert.equal((await neha.post(`/tickets/${t.ticket_id}/status`, { to: 'RESOLVED' })).status, 400);
  assert.equal((await neha.post(`/tickets/${t.ticket_id}/status`, { to: 'RESOLVED', notes: 'Replaced the burst joint.' })).status, 200);
  const after = await ticket('LEAK');
  assert.equal(after.status, 'RESOLVED');
  assert.equal((await one("SELECT valve_open FROM utility_meter WHERE meter_code = 'MTR-W-0001'")).valve_open, true);
  const ev = await mongo.col('anomaly_events').findOne({ key: t.anomaly_key });
  assert.equal(ev.status, 'RESOLVED');
  const hist = (await pg.query('SELECT from_status, to_status FROM ticket_status_history WHERE ticket_id = $1 ORDER BY history_id', [t.ticket_id])).rows;
  assert.deepEqual(hist.map(h => h.to_status), ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED']);
  const log = await mongo.col('maintenance_logs').findOne({ ticket_no: t.ticket_no });
  assert.deepEqual([...new Set(log.entries.map(e => e.kind))].sort(), ['DEVICE', 'DISPATCH', 'NOTE', 'SENSOR_SNAPSHOT', 'STATUS']);
});

test('every change is in the audit trail with who made it', async () => {
  const t = await ticket('LEAK');
  const rows = (await pg.query("SELECT actor, db_role, operation, changed FROM audit_log WHERE table_name = 'maintenance_ticket' AND row_key = $1 ORDER BY audit_id", [t.ticket_no])).rows;
  assert.equal(rows[0].operation, 'INSERT');
  assert.equal(rows[0].actor, 'anomaly-detector');
  const byNeha = rows.filter(r => r.actor === 'Neha Joshi');
  assert.ok(byNeha.length >= 2);
  assert.ok(byNeha.every(r => /staff_role/.test(r.db_role)), 'ran under the staff role, so RLS applied');
  assert.ok(byNeha.some(r => r.changed.includes('status')));
  const valve = await one("SELECT actor FROM audit_log WHERE table_name = 'utility_meter' AND 'valve_open' = ANY(changed) ORDER BY audit_id DESC LIMIT 1");
  assert.equal(valve.actor, 'Neha Joshi');
  // MongoDB writes are mirrored in change_log
  const notes = await mongo.col('change_log').countDocuments({ collection: 'maintenance_logs', actor: 'Neha Joshi' });
  assert.ok(notes >= 3);
  const audit = await admin.get('/admin/audit?source=pg&table=maintenance_ticket');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.rows.length > 0);
  assert.equal((await asha.get('/admin/audit?source=pg')).status, 403);
});

test('peak demand response starts when grid load passes 90%', async () => {
  await admin.post('/admin/scenarios/spike', { on: true });
  await admin.post('/clock/advance', { hours: 2 });
  const ev = await mongo.col('demand_events').findOne({}, { sort: { started_at: -1 } });
  assert.ok(ev, 'a demand event was recorded');
  assert.ok(ev.peak_kw >= 0.9 * ev.capacity_kw);
  const spike = await ticket('VOLTAGE_SPIKE');
  assert.equal(spike.assigned, 'Kavya Shetty');
});
