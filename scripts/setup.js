#!/usr/bin/env node
// Creates the PostgreSQL schema (tables, functions, triggers, roles, row-level security), the MongoDB
// collections and validators, then loads the synthetic city.
//   npm run setup         first-time setup (does nothing if the database already has the tables)
//   npm run reset         drops everything in both databases and starts again
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../server/config');
const mongo = require('../server/db/mongo');
const { seed } = require('./seed');

const reset = process.argv.includes('--reset');
const quiet = process.argv.includes('--quiet');
const log = quiet ? () => {} : (...a) => console.log(...a);

async function main() {
  const pg = new Client({ connectionString: config.pgUrl });
  await pg.connect();
  const { rows: [{ exists }] } = await pg.query("SELECT to_regclass('public.app_user') IS NOT NULL AS exists");
  if (exists && !reset) {
    log('The database is already set up. Run "npm run reset" to drop everything and load the demo city again.');
    await pg.end();
    return;
  }
  if (reset) {
    log('Dropping the public schema and the MongoDB database…');
    await pg.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pg.query('CREATE SCHEMA public');
    await mongo.dropAll();
  }
  const dir = path.join(__dirname, '..', 'db', 'postgres');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    log(`PostgreSQL: applying ${f}`);
    await pg.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  log('MongoDB: creating collections, validators and indexes');
  await mongo.setup();
  log('Loading the synthetic city (seed 42)…');
  const t0 = Date.now();
  await pg.query('BEGIN');
  try {
    const r = await seed(pg, mongo, log);
    await pg.query('COMMIT');
    log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s. Start the app with "npm start" and open http://localhost:${config.port}`);
    return r;
  } catch (e) {
    await pg.query('ROLLBACK');
    throw e;
  } finally {
    await pg.end();
  }
}

if (require.main === module) {
  main().then(() => mongo.client.close()).catch(async e => {
    console.error('\nSetup failed:', e.message);
    if (/ECONNREFUSED|ENOTFOUND|connect/i.test(e.message)) console.error('Is the database running? Try "npm run db:up" (Docker) or start PostgreSQL and MongoDB yourself, and check .env.');
    await mongo.client.close().catch(() => {});
    process.exit(1);
  });
}
module.exports = { main };
