// /api/tickets: the maintenance queue. Reads go through row-level security (staff: their district,
// admin: everything, resident: their own properties); status changes go through the state-machine trigger.
const express = require('express');
const { requireUser, requireRole } = require('../auth');
const { asUser } = require('../db/pg');
const mongo = require('../db/mongo');
const { S, ctx } = require('../sim/state');
const engine = require('../sim/engine');
const automation = require('../sim/automation');
const { logEntry } = require('../services/notify');
const { h, need, isUuid, logPg, logMg } = require('./util');

const r = express.Router();
r.use(requireUser);

const LIST_SQL = `SELECT t.ticket_id, t.ticket_no, t.issue_type, t.severity, t.status, t.source, t.reported_timestamp, t.last_seen_at, t.occurrence_count,
    t.sla_due_at, t.escalated_at, t.resolved_at, t.assigned_to, sd.display_name AS assigned_name,
    p.property_code, z.name AS zone_name, d.name AS district_name
  FROM maintenance_ticket t JOIN property p USING (property_id) JOIN zone z ON z.zone_id = p.zone_id LEFT JOIN zone d ON d.zone_id = z.parent_zone_id
  LEFT JOIN staff_directory sd ON sd.user_id = t.assigned_to`;

r.get('/', h(async (req, res) => {
  const tickets = await asUser(req.user, async c => (await c.query(`${LIST_SQL}
    ORDER BY (t.status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')) DESC, (t.assigned_to = app_uid()) DESC NULLS LAST, t.reported_timestamp DESC`)).rows);
  res.json({ tickets });
}));

async function detail(user, id) {
  return asUser(user, async c => {
    const { rows: [t] } = await c.query(`SELECT t.*, sd.display_name AS assigned_name, p.property_code, p.address_line, z.name AS zone_name, d.name AS district_name, um.meter_code
      FROM maintenance_ticket t JOIN property p USING (property_id) JOIN zone z ON z.zone_id = p.zone_id LEFT JOIN zone d ON d.zone_id = z.parent_zone_id
      LEFT JOIN staff_directory sd ON sd.user_id = t.assigned_to LEFT JOIN utility_meter um ON um.meter_id = t.meter_id
      WHERE t.ticket_id = $1`, [id]);
    if (!t) return null;
    const { rows: history } = await c.query(`SELECT h.from_status, h.to_status, h.changed_at, COALESCE(sd.display_name, 'system') AS changed_by_name
      FROM ticket_status_history h LEFT JOIN staff_directory sd ON sd.user_id = h.changed_by WHERE h.ticket_id = $1 ORDER BY h.history_id`, [id]);
    return { t, history };
  });
}

r.get('/:id', h(async (req, res) => {
  need(isUuid(req.params.id), 404, 'No such ticket.');
  const d = await detail(req.user, req.params.id);
  need(d, 404, 'No such ticket.');
  const log = await mongo.col('maintenance_logs').findOne({ ticket_no: d.t.ticket_no });
  res.json({ ticket: d.t, history: d.history, entries: log ? log.entries : [] });
}));

// staff act only on tickets in their district (RLS) that are open or assigned to them
async function staffTicket(req) {
  need(isUuid(req.params.id), 404, 'No such ticket.');
  const d = await detail(req.user, req.params.id);
  need(d, 404, 'No such ticket.');
  return d.t;
}

r.post('/:id/take', requireRole('STAFF'), h(async (req, res) => {
  const t = await staffTicket(req);
  const stmt = `UPDATE maintenance_ticket SET status = 'ASSIGNED', assigned_to = app_uid()\nWHERE ticket_no = '${t.ticket_no}' AND status = 'OPEN';   -- policy ticket_staff_update; trigger trg_ticket_transition checks OPEN → ASSIGNED`;
  let n;
  // AND status = 'OPEN': if someone took it a moment earlier, this matches nothing instead of taking it from them
  try { n = (await asUser(req.user, c => c.query("UPDATE maintenance_ticket SET status = 'ASSIGNED', assigned_to = app_uid() WHERE ticket_id = $1 AND status = 'OPEN'", [t.ticket_id]))).rowCount; }
  catch (e) { logPg(req.user, `Rejected: ${t.ticket_no} → ASSIGNED`, stmt, e); throw e; }
  need(n, 409, t.assigned_name ? `This ticket is already assigned to ${t.assigned_name}.` : 'This ticket is no longer open.');
  logPg(req.user, `${t.ticket_no} taken by ${req.user.display_name}`, stmt);
  await logEntry(ctx(null, req.user), t.ticket_no, 'STATUS', 'Status changed to ASSIGNED');
  res.json({ ok: true });
}));

r.post('/:id/status', requireRole('STAFF'), h(async (req, res) => {
  const t = await staffTicket(req);
  const to = String((req.body && req.body.to) || '');
  need(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(to), 400, 'Unknown status.');
  need(!t.assigned_to || t.assigned_to === req.user.user_id, 403, `This ticket is assigned to ${t.assigned_name}.`);
  const notes = req.body && req.body.notes != null ? String(req.body.notes).trim().slice(0, 2000) : null;
  need(to !== 'RESOLVED' || notes, 400, 'Write the resolution notes before resolving.');
  const stmt = `UPDATE maintenance_ticket SET status = '${to}'${notes && to === 'RESOLVED' ? ', resolution_notes = $notes' : ''}\nWHERE ticket_no = '${t.ticket_no}'\nRETURNING status, resolved_at;   -- trg_ticket_transition enforces the state machine`;
  try {
    await asUser(req.user, c => c.query('UPDATE maintenance_ticket SET status = $2, resolution_notes = CASE WHEN $2 = \'RESOLVED\' THEN $3 ELSE resolution_notes END WHERE ticket_id = $1',
      [t.ticket_id, to, notes || null]));
  } catch (e) { logPg(req.user, `Rejected: ${t.ticket_no} → ${to}`, stmt, e); throw e; }
  logPg(req.user, `${t.ticket_no}: ${to.replace('_', ' ').toLowerCase()} (history row written by trigger)`, stmt);
  const c = ctx(null, req.user);
  await logEntry(c, t.ticket_no, 'STATUS', `Status changed to ${to}`);
  logMg(req.user, 'Status mirrored to the ticket log', `db.maintenance_logs.updateOne({ ticket_no: "${t.ticket_no}" },\n  { $push: { entries: { by: "${req.user.display_name}", kind: "STATUS", text: "Status changed to ${to}" } } })`);
  if (to === 'RESOLVED') {
    // the fix is done: the meter is back to normal readings and a closed valve opens again
    if (t.meter_code) {
      await engine.clearFault(req.user, t.meter_code, t.issue_type === 'POWER_OUTAGE' ? t.property_id : null);
      const m = S.byCode.get(t.meter_code);
      if (m && !m.valve_open) await engine.exclusive(() => automation.valve(t.meter_code, false, `Ticket ${t.ticket_no} resolved`, req.user));
    }
    if (t.anomaly_key) await mongo.write(c, 'anomaly_events', 'updateMany', { key: t.anomaly_key, status: { $ne: 'RESOLVED' } }, { $set: { status: 'RESOLVED', resolved_at: new Date(S.cityNow) } });
  }
  res.json({ ok: true });
}));

r.post('/:id/notes', requireRole('STAFF'), h(async (req, res) => {
  const t = await staffTicket(req);
  const text = String((req.body && req.body.text) || '').trim();
  need(text.length >= 1 && text.length <= 2000, 400, 'Write a note first.');
  const e = await logEntry(ctx(null, req.user), t.ticket_no, 'NOTE', text);
  logMg(req.user, `Note added to ${t.ticket_no}`, `db.maintenance_logs.updateOne({ ticket_no: "${t.ticket_no}" },\n  { $push: { entries: { id: "${e.id}", at: ISODate(…), by: "${req.user.display_name}", kind: "NOTE", text: $text } } })`);
  res.json({ entry: e });
}));

r.delete('/:id/notes/:entry', requireRole('STAFF'), h(async (req, res) => {
  const t = await staffTicket(req);
  const r2 = await mongo.write(ctx(null, req.user), 'maintenance_logs', 'update', { ticket_no: t.ticket_no },
    { $pull: { entries: { id: String(req.params.entry), by: req.user.display_name, kind: 'NOTE' } } });
  need(r2.modifiedCount, 404, 'You can only delete your own notes.');
  logMg(req.user, 'Field note deleted', `db.maintenance_logs.updateOne({ ticket_no: "${t.ticket_no}" },\n  { $pull: { entries: { id: "${req.params.entry}", by: "${req.user.display_name}", kind: "NOTE" } } })`);
  res.json({ ok: true });
}));

module.exports = r;
