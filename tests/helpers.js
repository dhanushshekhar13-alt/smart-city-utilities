// Test helpers. Tests run against real PostgreSQL and MongoDB, but never against your working data:
// they use a separate database named <your database>_test (or TEST_DATABASE_URL / TEST_MONGO_URL),
// which is dropped and loaded with the synthetic city before each test file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');

// read .env the same way server/config.js does, without overriding real environment variables
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) in .env before running the tests.');

const withDb = (url, name) => { const u = new URL(url); u.pathname = '/' + name; return u.toString(); };
const baseName = url => new URL(url).pathname.slice(1) || 'smart_city';
const PG_URL = process.env.TEST_DATABASE_URL || withDb(process.env.DATABASE_URL, baseName(process.env.DATABASE_URL) + '_test');
const MONGO_URL = process.env.TEST_MONGO_URL || withDb(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/smart_city', baseName(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/smart_city') + '_test');
process.env.DATABASE_URL = PG_URL;
process.env.MONGO_URL = MONGO_URL;
process.env.CLOCK_AUTOSTART = 'false';
process.env.DEMO_MODE = 'true';

async function ensureDatabase() {
  const name = baseName(PG_URL);
  const admin = new Client({ connectionString: withDb(PG_URL, 'postgres') });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  await admin.end();
}

let server, base, mods;
// drop and reload both test databases, then start the app on a free port with the city clock stopped
async function fresh() {
  await ensureDatabase();
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'setup.js'), '--reset', '--quiet'], { env: process.env, stdio: 'inherit' });
  mods = {
    pg: require('../server/db/pg'),
    mongo: require('../server/db/mongo'),
    engine: require('../server/sim/engine'),
    S: require('../server/sim/state').S,
  };
  await mods.mongo.connect();
  await mods.engine.start({ timer: false });
  const { createApp } = require('../server/app');
  server = await new Promise(r => { const s = createApp().listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  return mods;
}
async function close() {
  if (mods) mods.engine.stop();
  if (server) await new Promise(r => server.close(r));
  if (mods) await Promise.allSettled([mods.pg.pool.end(), mods.mongo.client.close()]);
}

// a tiny browser: keeps the session cookie and sends the CSRF header
class Browser {
  constructor() { this.cookie = null; }
  async req(method, p, body, { csrf = true } = {}) {
    const headers = {};
    if (csrf) headers['X-Requested-With'] = 'smart-city';
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + '/api' + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; this.cookie = /=$/.test(v) ? null : v; this.lastSetCookie = set; }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  del(p) { return this.req('DELETE', p); }
  async login(email, password = 'demo123') {
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.user;
  }
}
const as = async email => { const b = new Browser(); await b.login(email); return b; };

const EMAIL = {
  asha: 'asha@example.test', vikram: 'vikram@example.test', ravi: 'ravi.staff@city.example.test',
  neha: 'neha.staff@city.example.test', kavya: 'kavya.staff@city.example.test', admin: 'admin@city.example.test',
};

module.exports = { fresh, close, Browser, as, EMAIL, get mods() { return mods; }, PG_URL, MONGO_URL };
