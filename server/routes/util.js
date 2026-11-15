// Helpers shared by the route files.
const activity = require('../activity');

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; Object.assign(this, extra); } }

// PostgreSQL errors as psql would print them, so the screen shows the database's own words
function pgErrorText(e) {
  if (!e || !e.code || !/^[0-9A-Z]{5}$/.test(e.code)) return e && e.message;
  let s = `ERROR:  ${e.message}`;
  if (e.detail) s += `\nDETAIL:  ${e.detail}`;
  if (e.hint) s += `\nHINT:  ${e.hint}`;
  if (e.constraint) s += `\nCONSTRAINT:  ${e.constraint}`;
  if (e.table) s += `\nTABLE:  ${e.table}`;
  return `${s}\nSQLSTATE:  ${e.code}`;
}
// application errors raised in PL/pgSQL start with an upper-case code, e.g. "ILLEGAL_TRANSITION: …"
const shortPg = e => String(e.message || '').replace(/^[A-Z_]+: /, '');

// async handler: errors become JSON with the right status
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, next) {   // eslint-disable-line no-unused-vars
  const isPg = err && err.code && /^[0-9A-Z]{5}$/.test(err.code);
  const status = err.status || (isPg ? (err.code === '42501' ? 403 : err.code === 'P0002' ? 404 : 400) : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: isPg ? shortPg(err) : (status >= 500 ? 'Something went wrong on the server.' : err.message), pg: isPg ? pgErrorText(err) : undefined, code: isPg ? err.code : undefined });
}

// the prefix every request transaction runs with, shown in the "Under the hood" rail
const ROLE_NAME = { RESIDENT: 'resident_role', STAFF: 'staff_role', ADMIN: 'admin_role' };
const sqlCtx = u => `BEGIN;\nSET LOCAL ROLE ${ROLE_NAME[u.role]};\nSELECT set_config('app.user_id', '${u.user_id.slice(0, 8)}…', true);\n`;
const logPg = (u, title, body, err) => activity.log({ db: 'pg', title, scope: u.user_id, stmt: `${sqlCtx(u)}${body}\n${err ? 'ROLLBACK;' : 'COMMIT;'}`, err: err ? pgErrorText(err) : null });
const logMg = (u, title, stmt, err) => activity.log({ db: 'mg', title, scope: u.user_id, stmt, err: err || null });

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

module.exports = { HttpError, pgErrorText, shortPg, h, errorHandler, sqlCtx, logPg, logMg, isUuid, need, ROLE_NAME };
