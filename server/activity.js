// "Under the hood": a short in-memory list of the statements the server just ran, shown in the side rail.
// It is a teaching aid, not the audit trail (that lives in audit_log, auth_event and change_log).
// scope: 'all' (everyone sees it), 'admin' (admins only) or a user_id (that person and admins).
const MAX = 200;
let seq = 0;
const events = [];
let cityNow = () => null;

function log({ db, title, stmt = null, err = null, scope = 'all', collapse = null }) {
  if (collapse) {
    const i = events.slice(0, 30).findIndex(e => e.collapse === collapse);
    if (i >= 0) {
      const [e] = events.splice(i, 1);
      Object.assign(e, { id: ++seq, at: Date.now(), city_at: cityNow(), title, stmt, err, count: e.count + 1 });
      events.unshift(e);
      return e;
    }
  }
  const e = { id: ++seq, at: Date.now(), city_at: cityNow(), db, title, stmt, err, scope, count: 1, collapse };
  events.unshift(e);
  if (events.length > MAX) events.pop();
  return e;
}

function visibleTo(user, limit = 60) {
  return events.filter(e => user.role === 'ADMIN' || e.scope === 'all' || e.scope === user.user_id)
    .slice(0, limit).map(({ collapse, scope, ...e }) => e);
}

module.exports = { log, visibleTo, setClock: f => { cityNow = f; }, get latest() { return seq; } };
