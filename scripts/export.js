#!/usr/bin/env node
// Exports both databases to files you can open or hand in:
//   data/export/<time>/postgres/<table>.csv   one CSV per table (password and token hashes left out)
//   data/export/<time>/mongo/<collection>.ndjson   one JSON document per line, dates as ISO strings
// Usage: npm run export
const fs = require('fs');
const path = require('path');
const { pool } = require('../server/db/pg');
const mongo = require('../server/db/mongo');

const SECRET = { app_user: ['password_hash'], user_session: ['token_hash'] };
const csvCell = v => {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(__dirname, '..', 'data', 'export', stamp);
  fs.mkdirSync(path.join(out, 'postgres'), { recursive: true });
  fs.mkdirSync(path.join(out, 'mongo'), { recursive: true });

  const { rows: tables } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  for (const { tablename: t } of tables) {
    const { rows: cols } = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t]);
    const names = cols.map(c => c.column_name).filter(c => !(SECRET[t] || []).includes(c));
    const isTime = new Set(cols.filter(c => c.data_type.startsWith('timestamp')).map(c => c.column_name));
    const { rows } = await pool.query(`SELECT ${names.map(n => `"${n}"`).join(', ')} FROM "${t}"`);
    const lines = [names.join(','), ...rows.map(r => names.map(n => csvCell(isTime.has(n) && r[n] != null ? new Date(r[n]) : r[n])).join(','))];
    fs.writeFileSync(path.join(out, 'postgres', `${t}.csv`), lines.join('\n') + '\n');
    console.log(`PostgreSQL ${t}: ${rows.length} rows`);
  }

  await mongo.connect();
  for (const { name } of await mongo.db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const file = fs.createWriteStream(path.join(out, 'mongo', `${name}.ndjson`));
    let n = 0;
    for await (const d of mongo.col(name).find({})) { file.write(JSON.stringify(d) + '\n'); n++; }
    await new Promise(r => file.end(r));
    console.log(`MongoDB ${name}: ${n} documents`);
  }
  console.log(`\nExported to ${path.relative(process.cwd(), out)}`);
}

main()
  .catch(e => { console.error(e.message); process.exitCode = 1; })
  .finally(async () => { await pool.end(); await mongo.client.close(); });
