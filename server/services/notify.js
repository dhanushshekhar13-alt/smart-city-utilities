// Small shared writers: resident alerts (MongoDB notifications) and ticket field notes (MongoDB maintenance_logs).
const { ObjectId } = require('mongodb');
const { query } = require('../db/pg');
const mongo = require('../db/mongo');
const { S } = require('../sim/state');

// the account that belongs to the owner of a property (residents without an account get no alerts)
async function ownerOf(propertyId) {
  const { rows: [u] } = await query(`SELECT u.user_id, u.display_name FROM property p JOIN app_user u ON u.resident_id = p.resident_id
    WHERE p.property_id = $1 AND u.is_active`, [propertyId]);
  return u || null;
}

async function notify(ctx, userId, kind, title, body, ref) {
  const doc = { user_id: String(userId), kind, title, body, created_at: new Date(S.cityNow), read_at: null };
  if (ref) doc.ref = ref;
  try { return await mongo.write(ctx, 'notifications', 'insert', null, doc); }
  catch (e) { if (e.code === 11000) return null; throw e; }        // same ref already sent (unique index)
}

async function logEntry(ctx, ticketNo, kind, text, data) {
  const entry = { id: new ObjectId().toHexString(), at: new Date(S.cityNow), by: ctx.actor || 'system', kind, text: String(text).slice(0, 2000) };
  if (data) entry.data = data;
  await mongo.write(ctx, 'maintenance_logs', 'update', { ticket_no: ticketNo }, { $push: { entries: entry } }, { upsert: true });
  return entry;
}

module.exports = { ownerOf, notify, logEntry };
