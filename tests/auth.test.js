// Accounts and sessions: sign-in, sign-out, lockout, registration, password change and the CSRF header.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers');

let pg;
before(async () => { ({ pg } = await T.fresh()); });
after(T.close);

test('sign-in sets an HttpOnly session cookie and stores only a hash of the token', async () => {
  const b = new T.Browser();
  const user = await b.login(T.EMAIL.asha);
  assert.equal(user.role, 'RESIDENT');
  assert.equal(user.password_hash, undefined);
  assert.match(b.lastSetCookie, /HttpOnly/);
  assert.match(b.lastSetCookie, /SameSite=Lax/);
  const token = b.cookie.split('=')[1];
  const { rows } = await pg.query('SELECT token_hash FROM user_session WHERE user_id = $1 AND ended_at IS NULL', [user.user_id]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.length, 64);
  const me = await b.get('/auth/me');
  assert.equal(me.body.user.email, T.EMAIL.asha);
});

test('passwords are stored as salted scrypt hashes', async () => {
  const { rows } = await pg.query('SELECT password_hash FROM app_user WHERE email IN ($1, $2)', [T.EMAIL.asha, T.EMAIL.vikram]);
  for (const r of rows) assert.match(r.password_hash, /^scrypt\$/);
  assert.notEqual(rows[0].password_hash, rows[1].password_hash, 'same password, different salt');
});

test('sign-out ends the session in the database and the cookie stops working', async () => {
  const b = new T.Browser();
  const user = await b.login(T.EMAIL.vikram);
  const cookie = b.cookie;
  assert.equal((await b.post('/auth/logout')).status, 200);
  const { rows: [s] } = await pg.query('SELECT ended_at, end_reason FROM user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [user.user_id]);
  assert.ok(s.ended_at);
  assert.equal(s.end_reason, 'LOGOUT');
  const replay = new T.Browser(); replay.cookie = cookie;
  assert.equal((await replay.get('/auth/me')).body.user, null);
  assert.equal((await replay.get('/me/home')).status, 401);
  const { rows: ev } = await pg.query("SELECT kind FROM auth_event WHERE user_id = $1 ORDER BY event_id", [user.user_id]);
  assert.deepEqual(ev.map(e => e.kind), ['LOGIN_OK', 'LOGOUT']);
});

test('five wrong passwords lock the account, even against the right password', async () => {
  const b = new T.Browser();
  for (let i = 1; i <= 4; i++) assert.equal((await b.post('/auth/login', { email: T.EMAIL.kavya, password: 'wrong-' + i })).status, 401);
  assert.equal((await b.post('/auth/login', { email: T.EMAIL.kavya, password: 'wrong-5' })).status, 423);
  const right = await b.post('/auth/login', { email: T.EMAIL.kavya, password: 'demo123' });
  assert.equal(right.status, 423);
  const { rows: [u] } = await pg.query('SELECT failed_logins, locked_until > now() AS locked FROM app_user WHERE email = $1', [T.EMAIL.kavya]);
  assert.equal(u.locked, true);
  const { rows: ev } = await pg.query("SELECT kind, count(*)::int AS n FROM auth_event WHERE email = $1 GROUP BY kind", [T.EMAIL.kavya]);
  assert.ok(ev.find(e => e.kind === 'LOCKED'));

  // an admin can unlock the account
  const admin = await T.as(T.EMAIL.admin);
  const { rows: [k] } = await pg.query('SELECT user_id FROM app_user WHERE email = $1', [T.EMAIL.kavya]);
  assert.equal((await admin.post(`/admin/users/${k.user_id}/unlock`)).status, 200);
  await new T.Browser().login(T.EMAIL.kavya);
});

test('a resident on the register can create an account; others cannot', async () => {
  const b = new T.Browser();
  assert.equal((await b.post('/auth/register', { email: 'nobody@example.test', password: 'Secret2026' })).status, 404);
  assert.equal((await b.post('/auth/register', { email: 'meera@example.test', password: 'short' })).status, 400);
  assert.equal((await b.post('/auth/register', { email: T.EMAIL.asha, password: 'Secret2026' })).status, 409);
  const r = await b.post('/auth/register', { email: 'meera@example.test', password: 'Secret2026', display_name: 'Meera N' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'RESIDENT');
  const home = await b.get('/me/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.property.property_code.startsWith('P-'), true);
});

test('changing a password ends the other sessions', async () => {
  const one = await T.as(T.EMAIL.ravi), two = await T.as(T.EMAIL.ravi);
  assert.equal((await one.post('/auth/password', { current: 'nope', next: 'NewPass2026' })).status, 400);
  assert.equal((await one.post('/auth/password', { current: 'demo123', next: 'NewPass2026' })).status, 200);
  assert.equal((await two.get('/auth/me')).body.user, null);
  assert.equal((await one.get('/auth/me')).body.user.email, T.EMAIL.ravi);
  await new T.Browser().login(T.EMAIL.ravi, 'NewPass2026');
  assert.equal((await new T.Browser().post('/auth/login', { email: T.EMAIL.ravi, password: 'demo123' })).status, 401);
});

test('state-changing requests without the CSRF header are refused', async () => {
  const b = await T.as(T.EMAIL.asha);
  const r = await b.req('POST', '/me/notifications/read-all', {}, { csrf: false });
  assert.equal(r.status, 403);
});

test('roles cannot reach each other’s endpoints', async () => {
  const asha = await T.as(T.EMAIL.asha), neha = await T.as(T.EMAIL.neha);
  assert.equal((await asha.get('/admin/ops')).status, 403);
  assert.equal((await neha.get('/admin/users')).status, 403);
  assert.equal((await neha.get('/me/home')).status, 403);
  assert.equal((await new T.Browser().get('/tickets')).status, 401);
});
