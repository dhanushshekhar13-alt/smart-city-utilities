"use strict";
/* App shell: sign-in and account creation, navigation, the city clock, the activity rail, event wiring and boot. */

const NAV = {
  RESIDENT: [["home", "My dashboard"], ["bills", "Bills & payments"], ["eco", "Footprint & savings"], ["tickets", "Complaints"], ["alerts", "Alerts"], ["db", "Inside the databases"], ["account", "My account"], ["how", "How it works"]],
  STAFF: [["queue", "Ticket queue"], ["db", "Inside the databases"], ["account", "My account"], ["how", "How it works"]],
  ADMIN: [["ops", "City operations"], ["map", "City map"], ["analytics", "Analytics"], ["scen", "Disaster simulator"], ["billing", "Billing run"], ["tix", "All tickets"], ["rules", "Database rules"], ["sql", "SQL lab"], ["users", "Accounts"], ["audit", "Audit trail"], ["db", "Inside the databases"], ["account", "My account"], ["how", "How it works"]],
};
const app = () => $("#app");
let lastActivity = -1, offline = false, busy = false;

// ---------- top bar ----------
function renderTop() {
  const u = APP.user, c = APP.clock, admin = u && u.role === "ADMIN";
  $("#top").innerHTML = `<div class="brand"><div class="brand-mark" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M9 1 3 9h4l-1 6 6-8H8z" fill="var(--accent-ink)"/></svg></div>
    <div class="brand-name">Smart City Utilities</div><span class="pill">PostgreSQL + MongoDB · synthetic data</span></div>
    <div class="spacer"></div>
    <div class="clock">${c ? `<span class="time badge-live${c.running ? "" : " paused"}" id="clock-time" title="Simulated city clock: one tick is ${c.tick_minutes} city minutes, every 2 seconds">City time ${fmtDT(c.city_now)}${c.running ? "" : " · paused"}</span>` : ""}
     ${admin && c ? `<button class="btn small" data-act="clock-run">${c.running ? "Pause clock" : "Resume clock"}</button>
      <button class="btn small" data-act="clock-hour" title="Run one simulated hour of meter readings now">+1 hour</button>
      ${c.open_cycle ? `<button class="btn small" data-act="month-end" title="Run the meters to the 1st, then close ${esc(c.open_cycle.name)} and send the bills">Jump to month end</button>` : ""}` : ""}</div>
    ${u ? `<div class="row"><span class="ink2">${esc(u.display_name)}</span><button class="btn small" data-act="logout">Sign out</button></div>` : ""}`;
}
function updateClockText() {
  const el = $("#clock-time"), c = APP.clock; if (!el || !c) return renderTop();
  el.textContent = `City time ${fmtDT(c.city_now)}${c.running ? "" : " · paused"}`;
}

// ---------- side nav ----------
function renderNav() {
  const u = APP.user;
  $("#nav").innerHTML = `<div class="who"><div class="role-tag">${u.role === "RESIDENT" ? "Resident" : u.role === "STAFF" ? "Maintenance staff" : "Municipal admin"}</div><b>${esc(u.display_name)}</b><div class="muted" style="font-size:11.5px">${esc(ROLE_LABEL(u))}</div></div>` +
    NAV[u.role].map(([k, l]) => `<button class="nav" data-act="go" data-view="${k}" ${APP.view === k ? 'aria-current="page"' : ""}>${l}</button>`).join("");
}

// ---------- activity rail ("under the hood") ----------
async function refreshRail() {
  const el = $("#feed"); if (!el || !APP.user) return;
  try {
    const { events, latest } = await api("/activity"); lastActivity = latest;
    el.innerHTML = events.map(e => `<div class="ev ${e.err ? "err" : e.db}"><div class="meta">${src(e.db)}<span>${fmtT(e.city_at || e.at)}</span>${e.count > 1 ? `<span>×${e.count}</span>` : ""}</div>
      <div class="t">${esc(e.title)}</div>${e.stmt ? `<pre>${esc(e.stmt)}</pre>` : ""}${e.err ? `<div class="res-err">${esc(e.err)}</div>` : ""}</div>`).join("")
      || `<p class="muted">Actions you take appear here with the SQL or MongoDB statement the server ran.</p>`;
  } catch { /* the clock poll shows the offline bar */ }
}

// ---------- sign-in / create account ----------
const initials = n => String(n).split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
async function renderLogin() {
  APP.view = null;
  if (APP.demo && !APP.data.accounts) { try { APP.data.accounts = (await api("/auth/demo-accounts")).accounts; } catch { APP.data.accounts = []; } }
  const accts = APP.data.accounts || [], reg = APP.sel.reg, pick = APP.sel.pick || (accts[0] && accts[0].email) || "";
  const roleOf = a => a.role === "RESIDENT" ? "Resident" : a.role === "STAFF" ? `Staff · ${a.zone_name || ""}` : "City admin";
  app().innerHTML = `<header class="topbar" id="top"></header>${offline ? `<div class="offline-bar">The server is not answering. Retrying…</div>` : ""}<div class="login">
   <section class="login-hero">
    <span class="eyebrow">DBMS mini-project · Dhanush &amp; Gagan</span>
    <h1>Smart City Utilities &amp; Infrastructure Management</h1>
    <p>Electricity, water and gas for a whole city on one platform. Smart meters report every 15 minutes into MongoDB, faults raise repair tickets on their own, and PostgreSQL works out every bill from real readings.</p>
    <ul class="login-feats">
     <li><span class="feat-ic" style="--c:var(--elec)">⚡</span><div><b>Live smart meters</b><span>Readings stream into a MongoDB time-series collection</span></div></li>
     <li><span class="feat-ic" style="--c:var(--crit)">!</span><div><b>Automatic fault detection</b><span>Leaks, spikes and outages become tickets and alerts</span></div></li>
     <li><span class="feat-ic" style="--c:var(--water)">₹</span><div><b>Fair tiered billing</b><span>Stored procedures turn a month of usage into one exact bill</span></div></li>
     <li><span class="feat-ic" style="--c:var(--gas)">↻</span><div><b>Every change is recorded</b><span>Real accounts, sessions and a full audit trail</span></div></li>
    </ul>
    <div class="login-dbs"><span class="src pg">PostgreSQL</span><span class="src mg">MongoDB</span><span class="muted">Synthetic data only</span></div>
   </section>
   <section class="login-card" aria-labelledby="lg-title">
    ${reg ? `<h2 id="lg-title">Create your account</h2><p class="muted">For residents whose email is on the city's utility register.</p>
     <form id="register-form" class="stack">
      <label class="f">Email on your utility account<input class="in" name="email" type="email" autocomplete="username" required placeholder="meera@example.test"></label>
      <label class="f">Your name<input class="in" name="display_name" autocomplete="name" placeholder="As you want it shown"></label>
      <label class="f">Password<input class="in" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="muted" style="font-size:12px;margin:0">At least 8 characters with a letter and a digit.</p>
      <button class="btn primary lg" type="submit">Create account</button></form>
     <div id="lg-err"></div>
     <div class="login-switch">Already have an account? <button class="linkbtn" data-act="reg" data-v="">Sign in</button></div>`
    : `<h2 id="lg-title">Sign in</h2><p class="muted">Use your city account.</p>
     <form id="login-form" class="stack">
      <label class="f">Email<input class="in" name="email" type="email" value="${esc(pick)}" autocomplete="username" required></label>
      <label class="f">Password<input class="in" name="password" type="password" value="${APP.demo && pick ? "demo123" : ""}" autocomplete="current-password" required></label>
      <button class="btn primary lg" type="submit">Sign in</button></form>
     <div id="lg-err"></div>
     <div class="login-switch">New resident? <button class="linkbtn" data-act="reg" data-v="1">Create an account</button></div>
     ${accts.length ? `<div class="login-sep"><span>or pick a demo account</span></div>
      <div class="users" role="group" aria-label="Demo accounts">${accts.map(a => `<button class="ucard" aria-pressed="${a.email === pick}" data-act="pick" data-email="${esc(a.email)}"><span class="avatar r-${a.role.toLowerCase()}">${esc(initials(a.display_name))}</span><span class="ucard-t"><b>${esc(a.display_name)}</b><span class="muted">${esc(roleOf(a))}</span></span></button>`).join("")}</div>
      <p class="muted" style="font-size:12px;margin:0">Demo accounts use the password <span class="mono">demo123</span>. Five wrong passwords lock an account for 15 minutes.</p>` : ""}`}
   </section></div>`;
  renderTop();
}
function signedIn(user) {
  APP.user = user; APP.view = NAV[user.role][0][0]; APP.sel = {}; APP.data = {}; lastActivity = -1;
  return render();
}
FORMS["login-form"] = async f => {
  const v = Object.fromEntries(new FormData(f));
  try { const { user } = await post("/auth/login", { email: v.email, password: v.password }); await signedIn(user); }
  catch (e) { $("#lg-err").innerHTML = errBox(e); }
};
FORMS["register-form"] = async f => {
  const v = Object.fromEntries(new FormData(f));
  try { const { user } = await post("/auth/register", v); toast("Account created. You are signed in."); await signedIn(user); }
  catch (e) { $("#lg-err").innerHTML = errBox(e); }
};
ACT.pick = b => { APP.sel.pick = b.dataset.email; renderLogin(); };
ACT.reg = b => { APP.sel.reg = b.dataset.v; renderLogin(); };
ACT.logout = async () => {
  try { await post("/auth/logout"); } catch { /* the cookie is cleared either way */ }
  APP.user = null; APP.sel = {}; APP.data = {}; toast("Signed out."); render();
};

// ---------- clock controls (admin) ----------
ACT["clock-run"] = async () => { const r = await post("/clock/run", { on: !APP.clock.running }); APP.clock.running = r.running; renderTop(); refreshRail(); };
ACT["clock-hour"] = async () => { const r = await post("/clock/advance", { hours: 1 }); toast(`Ran ${r.ticks} ticks: ${r.readings} meter readings.`); await pollClock(true); await render(); };
ACT["month-end"] = async () => {
  toast(`Running the meters to the end of ${APP.clock.open_cycle ? APP.clock.open_cycle.name : "the month"}…`);
  const before = APP.clock.open_cycle && APP.clock.open_cycle.name;
  const r = await post("/clock/month-end");
  await pollClock(true);
  toast(`${n1(r.ticks / 4)} city hours run (${r.readings.toLocaleString("en-IN")} readings). ${before ? `${before} is closed and its bills are out.` : ""}`);
  await render();
};

// ---------- built-in actions ----------
ACT.go = b => { APP.view = b.dataset.view; APP.data = {}; window.scrollTo(0, 0); return render(); };
ACT.sel = b => {
  APP.sel[b.dataset.k] = b.dataset.v;
  if (b.dataset.reset) b.dataset.reset.split(",").forEach(k => delete APP.sel[k]);
  return render();
};

// ---------- rendering ----------
function ensureShell() {
  if ($("#main")) return;
  app().innerHTML = `<header class="topbar" id="top"></header><div class="offline-bar" id="offline" hidden>The server is not answering. Retrying…</div>
   <div class="shell"><nav class="side" id="nav" aria-label="Sections"></nav><main id="main" tabindex="-1"></main>
   <aside class="rail" aria-label="Under the hood"><div class="panel"><div class="panel-head" style="margin-bottom:8px"><h2>Under the hood</h2><span class="muted" style="font-size:12px">statements the server ran</span></div><div class="feed" id="feed"></div></div></aside></div>`;
  lastActivity = -1;
}
render.n = 0;
async function render({ live = false } = {}) {
  const my = ++render.n;
  if (!APP.user) return renderLogin();
  if (!NAV[APP.user.role].some(([k]) => k === APP.view)) APP.view = NAV[APP.user.role][0][0];
  const first = !$("#main"); ensureShell();
  if (!live) { renderTop(); renderNav(); }
  const main = $("#main"), view = V[APP.view];
  if (!live && (first || main.dataset.view !== APP.view)) main.innerHTML = `<p class="loading">Loading…</p>`;
  try {
    const html = await view();
    if (my !== render.n || !APP.user) return;
    const y = window.scrollY; main.innerHTML = html; main.dataset.view = APP.view;
    if (live) window.scrollTo(0, y);
  } catch (e) {
    if (my !== render.n || !APP.user) return;
    main.innerHTML = `<div class="page-head"><h1>Something went wrong</h1></div>${errBox(e)}`;
  }
  if (!live || lastActivity !== (APP.clock && APP.clock.activity)) refreshRail();
}

// A live view re-renders when the city clock moves, unless someone is typing in it.
let dirty = false;
const typing = () => { const a = document.activeElement; return dirty || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $("#main") && $("#main").contains(a)); };
async function pollClock(skipLive) {
  try {
    const c = await api("/clock"), prev = APP.clock;
    if (offline) { offline = false; const ob = $("#offline"); if (ob) ob.hidden = true; }
    APP.clock = c;
    if (!prev || prev.running !== c.running || !!prev.open_cycle !== !!c.open_cycle || (prev.open_cycle && c.open_cycle && prev.open_cycle.id !== c.open_cycle.id)) renderTop(); else updateClockText();
    if (!APP.user || skipLive || busy) return;
    const view = V[APP.view];
    if (prev && prev.version !== c.version && view && view.live && !typing()) await render({ live: true });
    else if (c.activity !== lastActivity) refreshRail();
  } catch (e) {
    if (e instanceof ApiError) return;
    offline = true; const ob = $("#offline"); if (ob) ob.hidden = false;
  }
}

// ---------- events ----------
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const f = ACT[b.dataset.act]; if (!f) return;
  e.preventDefault(); dirty = false;
  if (b.tagName === "BUTTON") { if (b.disabled) return; b.disabled = true; }
  busy = true;
  try { await f(b, e); }
  catch (err) { toast(err.message || String(err)); refreshRail(); }
  finally { busy = false; if (b.isConnected && b.tagName === "BUTTON") b.disabled = false; }
});
document.addEventListener("submit", async e => {
  const f = e.target; const h = FORMS[f.id]; if (!h) return;
  e.preventDefault(); dirty = false;
  const btn = f.querySelector("[type=submit]"); if (btn) btn.disabled = true;
  busy = true;
  try { await h(f); }
  catch (err) { toast(err.message || String(err)); refreshRail(); }
  finally { busy = false; if (btn && btn.isConnected) btn.disabled = false; }
});
document.addEventListener("change", e => {
  const k = e.target.dataset && e.target.dataset.change; if (!k) return;
  APP.sel[k] = e.target.value; dirty = false; render();
});
document.addEventListener("input", e => { if (e.target.closest && e.target.closest("#main form")) dirty = true; });
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const r = e.target.closest && e.target.closest("tr[data-act], g[data-act]");
  if (r) { e.preventDefault(); r.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
});

// ---------- boot ----------
(async function boot() {
  try {
    const me = await api("/auth/me"); APP.demo = me.demo; APP.user = me.user;
    if (APP.user) APP.view = NAV[APP.user.role][0][0];
  } catch { offline = true; }
  await pollClock(true);
  await render();
  setInterval(pollClock, 2000);
})();
