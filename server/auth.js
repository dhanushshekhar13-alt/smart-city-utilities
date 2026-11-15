// Accounts and sessions. Passwords are stored as scrypt hashes; the browser gets a random session token in an
// HttpOnly cookie and PostgreSQL keeps only its SHA-256. Every sign-in, failure, lockout and sign-out is written
// to auth_event, and sessions are kept (with ended_at and end_reason) after sign-out as history.
const crypto = require('crypto');
const { promisify } = require('util');
const { query, asSystem, asOwner } = require('./db/pg');
const config = require('./config');
const activity = require('./activity');

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 32;
const COOKIE = 'sc_session';
const MAX_FAILS = 5, LOCK_MIN = 15;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

class AuthError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const USER_COLS = 'user_id, email, role, resident_id, staff_zone_id, display_name, is_active';

async function authEvent(c, kind, email, userId, ip, detail) {
  await c.query('INSERT INTO auth_event (kind, email, user_id, ip, detail) VALUES ($1, $2, $3, $4, $5)', [kind, email, userId, ip, detail || null]);
}

async function createSession(c, user, ip, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  await c.query(`INSERT INTO user_session (token_hash, user_id, expires_at, ip, user_agent)
    VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`, [sha256(token), user.user_id, config.sessionHours, ip, (ua || '').slice(0, 200)]);
  return token;
}

async function login(email, password, ip, ua) {
  email = String(email || '').trim().toLowerCase();
  return asSystem('sign-in', async c => {
    const { rows: [u] } = await c.query(`SELECT ${USER_COLS}, password_hash, failed_logins, locked_until FROM app_user WHERE email = $1 FOR UPDATE`, [email]);
    if (!u) {
      await authEvent(c, 'LOGIN_FAILED', email, null, ip, 'no such account');
      activity.log({ db: 'pg', title: 'Sign-in failed', scope: 'admin', err: '401 Invalid email or password',
        stmt: `SELECT user_id, password_hash, role FROM app_user WHERE email = '${email}';  -- 0 rows\nINSERT INTO auth_event (kind, email) VALUES ('LOGIN_FAILED', '${email}');` });
      throw new AuthError(401, 'Email or password is wrong.');
    }
    if (!u.is_active) {
      await authEvent(c, 'LOGIN_FAILED', email, u.user_id, ip, 'account deactivated');
      throw new AuthError(403, 'This account has been deactivated. Ask the city admin.');
    }
    if (u.locked_until && u.locked_until > Date.now()) {
      await authEvent(c, 'LOGIN_FAILED', email, u.user_id, ip, 'account locked');
      throw new AuthError(423, `Too many wrong passwords. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}.`);
    }
    if (!(await verifyPassword(password || '', u.password_hash))) {
      const fails = u.failed_logins + 1, lock = fails >= MAX_FAILS;
      await c.query(`UPDATE app_user SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => ${LOCK_MIN}) END WHERE user_id = $1`, [u.user_id, lock ? 0 : fails, lock]);
      await authEvent(c, lock ? 'LOCKED' : 'LOGIN_FAILED', email, u.user_id, ip, lock ? `locked for ${LOCK_MIN} minutes after ${MAX_FAILS} wrong passwords` : `wrong password (${fails} of ${MAX_FAILS})`);
      activity.log({ db: 'pg', title: lock ? `Account ${email} locked for ${LOCK_MIN} minutes` : 'Sign-in failed: wrong password', scope: 'admin', err: lock ? '423 Locked' : '401 Invalid email or password',
        stmt: `UPDATE app_user SET failed_logins = ${lock ? 0 : fails}${lock ? `, locked_until = now() + interval '${LOCK_MIN} minutes'` : ''} WHERE email = '${email}';\nINSERT INTO auth_event (kind, email) VALUES ('${lock ? 'LOCKED' : 'LOGIN_FAILED'}', '${email}');` });
      // the counter has to survive the error, so commit it and answer afterwards
      return { error: new AuthError(lock ? 423 : 401, lock ? `Too many wrong passwords. The account is locked for ${LOCK_MIN} minutes.` : 'Email or password is wrong.') };
    }
    await c.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE user_id = $1', [u.user_id]);
    const token = await createSession(c, u, ip, ua);
    await authEvent(c, 'LOGIN_OK', email, u.user_id, ip, ua ? ua.slice(0, 120) : null);
    activity.log({ db: 'pg', title: `${u.display_name} signed in as ${u.role}`, scope: u.user_id,
      stmt: `SELECT user_id, password_hash, role FROM app_user WHERE email = $1;   -- scrypt verify\nINSERT INTO user_session (token_hash, user_id, expires_at)\nVALUES (sha256(<token>), '${u.user_id.slice(0, 8)}…', now() + interval '${config.sessionHours} hours');\nINSERT INTO auth_event (kind, email) VALUES ('LOGIN_OK', '${email}');\n-- cookie ${COOKIE}: HttpOnly; SameSite=Lax` });
    delete u.password_hash; delete u.failed_logins; delete u.locked_until;
    return { token, user: u };
  }).then(r => { if (r.error) throw r.error; return r; });
}

// session lookup for every request; expired sessions are closed on the spot
async function userFromToken(token) {
  if (!token) return null;
  const { rows: [s] } = await query(`SELECT s.session_id, s.expires_at, s.ended_at, s.last_seen_at, ${USER_COLS.split(', ').map(c => 'u.' + c).join(', ')}
    FROM user_session s JOIN app_user u USING (user_id) WHERE s.token_hash = $1`, [sha256(token)]);
  if (!s || s.ended_at || !s.is_active) return null;
  if (s.expires_at <= Date.now()) {
    await asSystem('session-expiry', c => c.query("UPDATE user_session SET ended_at = now(), end_reason = 'EXPIRED' WHERE session_id = $1 AND ended_at IS NULL", [s.session_id]));
    return null;
  }
  if (Date.now() - s.last_seen_at > 60e3) query('UPDATE user_session SET last_seen_at = now() WHERE session_id = $1', [s.session_id]).catch(() => {});
  return s;
}

async function logout(user, ip) {
  await asOwner(user, async c => {
    await c.query("UPDATE user_session SET ended_at = now(), end_reason = 'LOGOUT' WHERE session_id = $1 AND ended_at IS NULL", [user.session_id]);
    await authEvent(c, 'LOGOUT', user.email, user.user_id, ip);
  });
  activity.log({ db: 'pg', title: `${user.display_name} signed out`, scope: user.user_id,
    stmt: `UPDATE user_session SET ended_at = now(), end_reason = 'LOGOUT'\nWHERE token_hash = sha256(<token>);   -- the row stays as history\nINSERT INTO auth_event (kind, email) VALUES ('LOGOUT', '${user.email}');` });
}

// A resident whose email is on file (resident table) but who has no account yet can create one.
async function register(email, displayName, password, ip, ua) {
  email = String(email || '').trim().toLowerCase();
  const bad = passwordProblem(password);
  if (bad) throw new AuthError(400, bad);
  const hash = await hashPassword(password);
  return asSystem('registration', async c => {
    const { rows: [r] } = await c.query('SELECT resident_id, full_name FROM resident WHERE email = $1 AND is_active', [email]);
    if (!r) throw new AuthError(404, 'That email is not on the city register. Use the email on your utility account.');
    const { rows: [taken] } = await c.query('SELECT 1 FROM app_user WHERE email = $1 OR resident_id = $2', [email, r.resident_id]);
    if (taken) throw new AuthError(409, 'An account already exists for this email. Sign in instead.');
    const { rows: [u] } = await c.query(`INSERT INTO app_user (email, password_hash, role, resident_id, display_name)
      VALUES ($1, $2, 'RESIDENT', $3, $4) RETURNING ${USER_COLS}`, [email, hash, r.resident_id, String(displayName || r.full_name).trim().slice(0, 80) || r.full_name]);
    await authEvent(c, 'ACCOUNT_CREATED', email, u.user_id, ip, 'self-registration');
    await c.query('UPDATE app_user SET last_login_at = now() WHERE user_id = $1', [u.user_id]);
    const token = await createSession(c, u, ip, ua);
    await authEvent(c, 'LOGIN_OK', email, u.user_id, ip, 'after registration');
    activity.log({ db: 'pg', title: `New account created for ${u.display_name}`, scope: u.user_id,
      stmt: `SELECT resident_id FROM resident WHERE email = '${email}';\nINSERT INTO app_user (email, password_hash, role, resident_id, display_name)\nVALUES ('${email}', 'scrypt$16384$8$1$…', 'RESIDENT', '${r.resident_id.slice(0, 8)}…', '${u.display_name}');\nINSERT INTO auth_event (kind, email) VALUES ('ACCOUNT_CREATED', '${email}');` });
    return { token, user: u };
  });
}

async function changePassword(user, current, next, ip) {
  const bad = passwordProblem(next);
  if (bad) throw new AuthError(400, bad);
  const { rows: [u] } = await query('SELECT password_hash FROM app_user WHERE user_id = $1', [user.user_id]);
  if (!(await verifyPassword(current || '', u.password_hash))) throw new AuthError(400, 'Your current password is not right.');
  const hash = await hashPassword(next);
  await asOwner(user, async c => {
    await c.query('UPDATE app_user SET password_hash = $2 WHERE user_id = $1', [user.user_id, hash]);
    // every other session of this person is signed out
    await c.query("UPDATE user_session SET ended_at = now(), end_reason = 'PASSWORD_CHANGED' WHERE user_id = $1 AND ended_at IS NULL AND session_id <> $2", [user.user_id, user.session_id]);
    await authEvent(c, 'PASSWORD_CHANGED', user.email, user.user_id, ip);
  });
  activity.log({ db: 'pg', title: `${user.display_name} changed their password`, scope: user.user_id,
    stmt: `UPDATE app_user SET password_hash = 'scrypt$…' WHERE user_id = $1;   -- audit_log records that it changed, never the hash\nUPDATE user_session SET ended_at = now(), end_reason = 'PASSWORD_CHANGED'\nWHERE user_id = $1 AND session_id <> <this session>;` });
}

// ---------- Express middleware ----------
function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setCookie(res, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${config.sessionHours * 3600}`];
  if (config.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }

async function attachUser(req, res, next) {
  try { req.user = await userFromToken(readCookie(req, COOKIE)); next(); } catch (e) { next(e); }
}
const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in.' });
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your account cannot do this.' });
  next();
};
// mutating requests must carry this header; a form on another site cannot add it (CSRF guard)
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'smart-city') return res.status(403).json({ error: 'Missing request header.' });
  next();
}

module.exports = { hashPassword, verifyPassword, passwordProblem, sha256, login, logout, register, changePassword, userFromToken,
  attachUser, requireUser, requireRole, csrfGuard, setCookie, clearCookie, AuthError, COOKIE, authEvent, USER_COLS };
