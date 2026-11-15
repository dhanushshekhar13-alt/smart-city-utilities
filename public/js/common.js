"use strict";
/* Pages every role has: Inside the databases, My account (password and sessions) and How it works. */

const ROLE_LABEL = u => u.role === "RESIDENT" ? "Resident" : u.role === "STAFF" ? `Staff · ${u.zone_name || "district"}` : "City admin";
const DB_ROLE = { RESIDENT: "resident_role", STAFF: "staff_role", ADMIN: "admin_role" };

// a table cell from PostgreSQL: NULLs, timestamps, UUIDs and JSON get a readable form
function cell(k, v) {
  if (v == null) return `<span class="muted">NULL</span>`;
  if (typeof v === "object") return `<span title="${esc(JSON.stringify(v))}">${esc(JSON.stringify(v).slice(0, 60))}${JSON.stringify(v).length > 60 ? "…" : ""}</span>`;
  if (typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return fmtDT(v);
  if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return `<span title="${esc(v)}">${esc(v.slice(0, 8))}…</span>`;
  const s = String(v); return s.length > 60 ? `<span title="${esc(s)}">${esc(s.slice(0, 60))}…</span>` : esc(s);
}
// a MongoDB document as shell-style JSON, with dates shown as ISODate(...)
const docJson = d => JSON.stringify(d, null, 2).replace(/"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"/g, 'ISODate("$1")');

V.db = async () => {
  const u = APP.user, tbl = APP.sel.tbl || "invoice", col = APP.sel.col || "meter_readings";
  const [t, c] = await Promise.all([api(`/db/table/${tbl}`), api(`/db/collection/${col}`)]);
  return `<div class="page-head"><span class="eyebrow">Under the hood</span><h1>Inside the databases</h1>
   <p class="ink2">You are reading the live databases as <b>${esc(ROLE_LABEL(u))}</b>. Every PostgreSQL query below runs as <code>${DB_ROLE[u.role]}</code> with your user id set, so row-level security and column grants decide what comes back. ${u.role === "ADMIN" ? "Admins see every row." : "Some tables show only your rows, and some none at all."}</p></div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>PostgreSQL tables</h2>${src("pg")}</div><span class="muted">${t.total} visible row${t.total === 1 ? "" : "s"}${t.total > 25 ? ", first 25 shown" : ""}</span></div>
   <div class="tabs" style="margin-bottom:10px" role="group" aria-label="Table">${t.tables.map(k => `<button aria-pressed="${k === tbl}" data-act="sel" data-k="tbl" data-v="${k}">${k}</button>`).join("")}</div>
   <p class="muted" style="font-size:12px;margin-bottom:8px"><code>${esc(t.sql)}</code>${/amount|line_total|rate/.test(t.columns.join(" ")) ? " · money is stored as whole paise (BIGINT)" : ""}</p>
   ${t.error ? `<div class="errbox">${esc(t.error)}</div><p class="muted" style="margin-top:6px">PostgreSQL itself refused: <code>${DB_ROLE[u.role]}</code> has no SELECT grant on this table.</p>`
     : `<div class="tablewrap">${t.rows.length ? `<table><thead><tr>${t.columns.map(k => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${t.rows.map(r => `<tr>${t.columns.map(k => `<td class="mono" style="white-space:nowrap">${cell(k, r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<p class="muted">0 rows visible to ${esc(ROLE_LABEL(u))}.</p>`}</div>`}</div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>MongoDB collections</h2>${src("mg")}</div><span class="muted">${c.hidden ? "not available to your role" : `${c.total} document${c.total === 1 ? "" : "s"}${c.total > 12 ? ", newest 12 shown" : ""}`}</span></div>
   <div class="tabs" style="margin-bottom:10px" role="group" aria-label="Collection">${c.collections.map(k => `<button aria-pressed="${k === col}" data-act="sel" data-k="col" data-v="${k}">${k}</button>`).join("")}</div>
   ${c.options && c.options.timeseries ? `<p class="ink2" style="margin-bottom:8px">Time-series collection (<code>timeField: "${esc(c.options.timeseries.timeField)}", metaField: "${esc(c.options.timeseries.metaField)}", granularity: "${esc(c.options.timeseries.granularity)}"</code>). Electricity, water and gas documents carry different fields.</p>` : ""}
   ${c.options && c.options.validator ? `<p class="ink2" style="margin-bottom:8px">This collection has a <code>$jsonSchema</code> validator; bad documents are rejected by MongoDB.</p>` : ""}
   ${c.filter && Object.keys(c.filter).length ? `<p class="muted" style="font-size:12px;margin-bottom:8px">Filter the API adds for your role: <code>${esc(JSON.stringify(c.filter).slice(0, 160))}</code></p>` : ""}
   <div class="stack">${c.hidden ? `<p class="muted">The API does not query this collection for ${esc(ROLE_LABEL(u))}. MongoDB has no row-level security, so access is enforced in the server.</p>`
     : c.docs.length ? c.docs.map(d => `<pre class="json">${esc(docJson(d))}</pre>`).join("") : `<p class="muted">No documents yet.</p>`}</div></div>`;
};
V.db.live = true;

// ---------- my account: password and sessions ----------
const uaShort = ua => { if (!ua) return "unknown device"; const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /node|curl|undici/i.test(ua) ? "script" : "browser"; const o = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : ""; return o ? `${b} on ${o}` : b; };
const EV_LABEL = { LOGIN_OK: "Signed in", LOGIN_FAILED: "Sign-in refused", LOCKED: "Account locked", LOGOUT: "Signed out", PASSWORD_CHANGED: "Password changed", ACCOUNT_CREATED: "Account created" };
const evTone = k => /FAIL|LOCK/.test(k) ? "s-crit" : /OK|CREATED/.test(k) ? "s-ok" : "s-info";

V.account = async () => {
  const u = APP.user, d = await api("/auth/sessions");
  const live = d.sessions.filter(s => !s.ended_at && ms(s.expires_at) > Date.now());
  return `<div class="page-head"><span class="eyebrow">${esc(ROLE_LABEL(u))}</span><h1>My account</h1>
   <p class="ink2">Signed in as <b>${esc(u.display_name)}</b> (<span class="mono">${esc(u.email)}</span>). Sessions live in PostgreSQL's <code>user_session</code> table; your browser only holds a random token, and the database stores its SHA-256 hash.</p></div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Change password</h2>${src("pg")}</div></div>
    <form class="stack" id="pw-form">
     <label class="f">Current password<input class="in" name="current" type="password" autocomplete="current-password" required></label>
     <label class="f">New password<input class="in" name="next" type="password" autocomplete="new-password" minlength="8" required></label>
     <label class="f">Repeat new password<input class="in" name="again" type="password" autocomplete="new-password" minlength="8" required></label>
     <p class="muted" style="font-size:12px;margin:0">At least 8 characters with a letter and a digit. It is stored as a salted scrypt hash, and your other sessions are signed out.</p>
     <div><button class="btn primary" type="submit">Change password</button></div><div id="pw-out"></div></form></div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>Active sessions</h2>${src("pg")}</div>${live.length > 1 ? `<button class="btn small danger" data-act="end-others">Sign out other sessions</button>` : ""}</div>
    <div class="tablewrap"><table><thead><tr><th>Started</th><th>Device</th><th>Last active</th><th>State</th></tr></thead><tbody>
     ${d.sessions.map(s => `<tr><td>${fmtDT(s.created_at)}</td><td>${esc(uaShort(s.user_agent))}<div class="muted mono" style="font-size:11px">${esc(s.ip || "")}</div></td><td>${fmtDT(s.last_seen_at)}</td>
       <td>${s.session_id === d.current ? `<span class="status s-ok">this browser</span>` : s.ended_at ? `<span class="status s-mute">${esc(String(s.end_reason || "ended").toLowerCase())}</span>` : ms(s.expires_at) <= Date.now() ? `<span class="status s-mute">expired</span>` : `<span class="status s-info">active</span>`}</td></tr>`).join("")}
    </tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Read through the row-level security policy <code>own_session</code>; the <code>token_hash</code> column is not granted to any app role.</p></div></div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>Sign-in activity</h2>${src("pg")}</div><span class="muted">auth_event, newest first</span></div>
   <div class="tablewrap"><table><thead><tr><th>When</th><th>Event</th><th>From</th><th>Detail</th></tr></thead><tbody>
    ${d.events.map(e => `<tr><td>${fmtDT(e.at)}</td><td><span class="status ${evTone(e.kind)}">${esc(EV_LABEL[e.kind] || e.kind)}</span></td><td class="mono">${esc(e.ip || "–")}</td><td class="muted">${esc(e.detail || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Nothing yet.</td></tr>`}
   </tbody></table></div></div>`;
};

FORMS["pw-form"] = async f => {
  const v = Object.fromEntries(new FormData(f)), out = $("#pw-out");
  if (v.next !== v.again) { out.innerHTML = errBox("The two new passwords do not match."); return; }
  try { await post("/auth/password", { current: v.current, next: v.next }); toast("Password changed. Your other sessions were signed out."); await render(); }
  catch (e) { out.innerHTML = errBox(e); refreshRail(); }
};
ACT["end-others"] = async () => { const r = await post("/auth/sessions/end-others"); toast(`Signed out ${r.ended} other session${r.ended === 1 ? "" : "s"}.`); await render(); };

// ---------- how it works ----------
V.how = async () => `<div class="page-head"><span class="eyebrow">How it works</span><h1>One city, two databases, one bridge</h1>
  <p class="ink2">PostgreSQL is the bank: people, properties, tariffs, bills, payments, tickets, accounts and the audit trail, with rules it refuses to break. MongoDB is the sensor diary: every smart-meter reading, anomaly, repair note, alert and device command. A Node.js server sits between them and the browser; the browser never talks to a database directly.</p></div>
  <div class="flow">${[
   ["Smart meters", "24 simulated meters send a reading every 15 city minutes (one tick every 2 seconds).", "mg"],
   ["MongoDB", "Readings land in a time-series collection; anomalies, notes and alerts in normal collections.", "mg"],
   ["Anomaly rules", "Leak, spike and missing-data rules run on every batch and open tickets in PostgreSQL.", "pg"],
   ["Bridge", "At month end, usage = closing register − opening register, upserted into meter_reading.", "pg"],
   ["PostgreSQL", "Procedures apply tariff slabs, create invoices and record payments; RLS hides other people's rows.", "pg"],
   ["Web app", "Residents, staff and admins sign in with real accounts and see different pages.", "pg"]].map((s, i) => `<div class="step"><span class="n">${i + 1}</span><b>${s[0]}</b><span class="ink2" style="font-size:12.5px">${s[1]}</span>${src(s[2])}</div>`).join("")}</div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><h2>What is real here</h2></div><ul class="stack" style="margin:0;padding-left:20px">
    <li>Data lives in a real PostgreSQL 17 database and a real MongoDB 8 database, stored on disk in <code>data/</code>. Restarting the server keeps everything.</li>
    <li>Accounts have salted scrypt password hashes, server-side sessions in <code>user_session</code>, sign-out, lockout after 5 wrong passwords and an <code>auth_event</code> log.</li>
    <li>Every insert, update and delete on a PostgreSQL table is written to <code>audit_log</code> by trigger <code>trg_audit</code>, with who did it and the old and new values. Every MongoDB write is mirrored to <code>change_log</code>. Admins read both under Audit trail.</li>
    <li>Row-level security runs inside PostgreSQL: each request switches to <code>resident_role</code>, <code>staff_role</code> or <code>admin_role</code> and sets <code>app.user_id</code>.</li>
    <li>All names, emails, phone numbers and citizen references are synthetic (<code>SYN-00001</code>, <code>@example.test</code>).</li></ul></div>
   <div class="panel"><div class="panel-head"><h2>Who to sign in as</h2></div><div class="tablewrap"><table><tbody>
    <tr><th>Asha Rao</th><td>Resident, home in Ward N-1 (P-0001)</td></tr><tr><th>Vikram Iyer</th><td>Resident with two properties</td></tr>
    <tr><th>Ravi Kumar, Neha Joshi</th><td>Maintenance staff, North District</td></tr><tr><th>Kavya Shetty</th><td>Maintenance staff, South District</td></tr>
    <tr><th>City Admin</th><td>Everything, including the clock and the simulator</td></tr></tbody></table></div>
    <p class="muted" style="margin-top:8px">Demo accounts use the password <span class="mono">demo123</span>. Meera, Rahul, Fatima and Arjun are on the city register but have no account yet, so they can use <b>Create account</b> on the sign-in page.</p></div></div>
  <div class="panel"><div class="panel-head"><h2>Demo script (about 10 minutes)</h2></div><ol class="stack" style="margin:0;padding-left:20px">
   <li><b>Asha</b>: the dashboard shows her property from PostgreSQL, live meters from MongoDB and the bill forecast. Open <b>Footprint &amp; savings</b> for her carbon footprint, eco score and tips.</li>
   <li><b>Asha → Bills</b>: the slabs on her September bill INV-2026-09-0017 (electricity 100 × ₹5 + 200 × ₹8 + 150 × ₹12, plus water and gas, ₹4,860 in all). <b>Try to open Vikram's invoice</b>: row-level security returns 0 rows.</li>
   <li><b>Admin → Disaster simulator → Pipe burst</b>, then <b>+1 hour</b>. A critical leak ticket opens and goes to <b>Neha</b> (Ravi and Neha are tied on open jobs, and the tie goes by email). The smart valve closes and Asha gets an alert.</li>
   <li><b>Electricity spike</b> and +1 hour: Kavya's district gets a spike ticket, grid load passes 90% and City operations shows a peak demand event.</li>
   <li><b>Asha → Complaints</b>: a new complaint goes to <b>Ravi</b>, who now has fewer open jobs than Neha.</li>
   <li><b>Neha</b>: try the illegal jump to CLOSED (the trigger blocks it), move to in progress, add a field note (MongoDB), resolve with notes. The valve reopens.</li>
   <li><b>Admin → Jump to month end</b>: the meters run to the 1st, the cycle closes and 8 new invoices appear; Asha's unpaid September bill gets a late fee overnight. Asha pays with <b>Send the same request twice</b>: one idempotency key, one payment stored.</li>
   <li><b>Admin → Audit trail</b>: every change above, with who made it. <b>Database rules</b> and <b>SQL lab</b> show PostgreSQL rejecting bad data and running recursive, correlated and window queries.</li></ol></div>`;
