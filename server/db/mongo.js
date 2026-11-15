// MongoDB access: the sensor diary (meter readings), repair notes, alerts, device commands and events.
// Every write a person or a job makes goes through write(), which also records it in change_log.
const { MongoClient } = require('mongodb');
const config = require('../config');

const client = new MongoClient(config.mongoUrl);
let db = null;

async function connect() {
  if (!db) { await client.connect(); db = client.db(); }
  return db;
}
const col = name => db.collection(name);

// JSON-schema validators: MongoDB itself rejects malformed documents.
// (Time-series collections cannot carry a validator, so meter readings are checked by the ingestion code instead.)
const date = { bsonType: 'date' };
const str = { bsonType: 'string' };
const VALIDATORS = {
  anomaly_events: {
    required: ['key', 'type', 'meter_code', 'property_code', 'severity', 'detected_at', 'last_seen', 'hits', 'status'],
    properties: {
      key: str, meter_code: { bsonType: 'string', pattern: '^MTR-[EWG]-[0-9]{4}$' }, property_code: str,
      type: { enum: ['LEAK', 'VOLTAGE_SPIKE', 'MISSING_DATA'] },
      severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
      status: { enum: ['OPEN', 'ACK', 'RESOLVED'] },
      detected_at: date, last_seen: date, hits: { bsonType: ['int', 'long'], minimum: 1 },
    },
  },
  maintenance_logs: {
    required: ['ticket_no', 'entries'],
    properties: {
      ticket_no: { bsonType: 'string', pattern: '^MT-[0-9]{4,}$' },
      entries: { bsonType: 'array', items: { bsonType: 'object', required: ['id', 'at', 'by', 'kind', 'text'],
        properties: { at: date, by: str, kind: { enum: ['SENSOR_SNAPSHOT', 'DISPATCH', 'STATUS', 'NOTE', 'DEVICE', 'ESCALATION'] },
          text: { bsonType: 'string', minLength: 1, maxLength: 2000 } } } },
    },
  },
  notifications: {
    required: ['user_id', 'kind', 'title', 'body', 'created_at'],
    properties: { user_id: str, kind: { enum: ['ALERT', 'BILL', 'OVERDUE', 'DEMAND', 'FORECAST', 'ACCOUNT'] },
      title: { bsonType: 'string', minLength: 1 }, body: str, created_at: date, read_at: { bsonType: ['date', 'null'] } },
  },
  device_commands: {
    required: ['meter_code', 'property_code', 'command', 'reason', 'issued_by', 'issued_at', 'status'],
    properties: { meter_code: { bsonType: 'string', pattern: '^MTR-W-[0-9]{4}$' },
      command: { enum: ['CLOSE_VALVE', 'OPEN_VALVE'] }, status: { enum: ['SENT', 'ACKED', 'FAILED'] }, issued_at: date },
  },
  demand_events: {
    required: ['started_at', 'start_kw', 'peak_kw', 'capacity_kw', 'status'],
    properties: { status: { enum: ['ACTIVE', 'ENDED'] }, start_kw: { bsonType: 'number', minimum: 0 }, started_at: date },
  },
  ingestion_batches: { required: ['source', 'count', 'from', 'to', 'status'], properties: { count: { bsonType: ['int', 'long'], minimum: 0 } } },
  change_log: { required: ['at', 'actor', 'collection', 'op'], properties: { at: date, op: { enum: ['insert', 'update', 'delete'] } } },
};

async function setup() {
  await connect();
  const existing = new Set((await db.listCollections().toArray()).map(c => c.name));
  if (!existing.has('meter_readings')) {
    await db.createCollection('meter_readings', { timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' } });
  }
  for (const [name, schema] of Object.entries(VALIDATORS)) {
    const validator = { $jsonSchema: { bsonType: 'object', ...schema } };
    if (existing.has(name)) await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    else await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
  }
  await col('meter_readings').createIndex({ 'meta.meter_code': 1, ts: 1 });
  await col('anomaly_events').createIndex({ key: 1, status: 1 });
  await col('anomaly_events').createIndex({ last_seen: -1 });
  await col('maintenance_logs').createIndex({ ticket_no: 1 }, { unique: true });
  await col('notifications').createIndex({ user_id: 1, created_at: -1 });
  await col('notifications').createIndex({ ref: 1 }, { unique: true, partialFilterExpression: { ref: { $type: 'string' } } });
  await col('device_commands').createIndex({ meter_code: 1, issued_at: -1 });
  await col('demand_events').createIndex({ status: 1, started_at: -1 });
  await col('change_log').createIndex({ at: -1 });
}

async function dropAll() {
  await connect();
  await db.dropDatabase();
}

// ---------- tracked writes ----------
// ctx = { actor, actorId, cityAt }. Bulk meter readings are not logged one by one; ingestion_batches records them.
async function write(ctx, collection, op, filter, change, options = {}) {
  const c = col(collection);
  let result;
  if (op === 'insert') result = await c.insertOne(change);
  else if (op === 'insertMany') result = await c.insertMany(change, { ordered: false });
  else if (op === 'update') result = await c.updateOne(filter, change, options);
  else if (op === 'updateMany') result = await c.updateMany(filter, change, options);
  else if (op === 'delete') result = await c.deleteOne(filter);
  else throw new Error('unknown op ' + op);
  const touched = op.startsWith('insert') ? true : (result.modifiedCount || result.deletedCount || result.upsertedCount);
  if (touched) {
    await col('change_log').insertOne({
      at: new Date(), city_at: ctx.cityAt ? new Date(ctx.cityAt) : null, actor: ctx.actor || 'system', actor_id: ctx.actorId || null,
      collection, op: op.startsWith('insert') ? 'insert' : op.startsWith('update') ? 'update' : 'delete',
      filter: filter || null, change: summarize(change),
    });
  }
  return result;
}
// keep change_log small: arrays of documents become a count
function summarize(change) {
  if (Array.isArray(change)) return { documents: change.length };
  return JSON.parse(JSON.stringify(change, (k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v)));
}

module.exports = { connect, col, setup, dropAll, write, client, VALIDATORS, get db() { return db; } };
