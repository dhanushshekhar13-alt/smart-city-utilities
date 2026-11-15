"use strict";
/* Shared helpers: API calls, formatting, badges and the line chart. Every number on screen comes from the server. */

const APP = { user: null, view: null, sel: {}, clock: null, demo: false, data: {} };
const V = {};      // views: async () => html
const ACT = {};    // click actions: data-act="name"
const FORMS = {};  // form submit handlers by form id

// ---------- API ----------
class ApiError extends Error { constructor(status, body) { super(body.error || `Request failed (${status})`); this.status = status; this.body = body; } }
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method, credentials: "same-origin",
    headers: { "X-Requested-With": "smart-city", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json() : await res.text();
  if (res.status === 401 && APP.user && !path.startsWith("/auth/")) { APP.user = null; toast("Your session has ended. Please sign in again."); render(); }
  if (!res.ok) throw new ApiError(res.status, typeof data === "string" ? { error: data } : data);
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", body });
const del = path => api(path, { method: "DELETE" });

// ---------- formatting (city time is always shown in IST) ----------
const IST = { timeZone: "Asia/Kolkata" };
const HOUR = 3600e3, TICK = 15 * 60e3;
const ms = t => typeof t === "number" ? t : Date.parse(t);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const fmtT = t => t == null ? "–" : new Date(ms(t)).toLocaleTimeString("en-IN", { ...IST, hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDT = t => t == null ? "–" : new Date(ms(t)).toLocaleString("en-IN", { ...IST, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtD = d => d == null ? "–" : new Date(/^\d{4}-\d\d-\d\d$/.test(d) ? d + "T00:00:00+05:30" : ms(d)).toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short", year: "numeric" });
const inr = paise => "₹" + (Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n1 = v => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 });
const n2 = v => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const cycleName = (m, y) => `${MONTH[m]} ${y}`;
const dur = v => { const m = Math.round(Math.abs(v) / 60e3); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} m` : ""}`.trim() : `${m} m`; };

const UT = {
  ELECTRICITY: { code: "E", unit: "kWh", rate: "kW", label: "Electricity", color: "var(--elec)" },
  WATER: { code: "W", unit: "kL", rate: "L/min", label: "Water", color: "var(--water)" },
  GAS: { code: "G", unit: "m³", rate: "m³/h", label: "Gas", color: "var(--gas)" },
};
const ACTIVE = ["OPEN", "ASSIGNED", "IN_PROGRESS"];
const TRANSITIONS = { OPEN: ["ASSIGNED"], ASSIGNED: ["IN_PROGRESS"], IN_PROGRESS: ["RESOLVED"], RESOLVED: ["CLOSED", "IN_PROGRESS"], CLOSED: [] };
const SLA_H = { CRITICAL: 4, HIGH: 8, MEDIUM: 24, LOW: 72 };

// ---------- small components ----------
const $ = s => document.querySelector(s);
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 3800); }
const src = k => k === "pg" ? `<span class="src pg">PostgreSQL</span>` : `<span class="src mg">MongoDB</span>`;
const sevCls = s => ({ CRITICAL: "s-crit", HIGH: "s-crit", MEDIUM: "s-warn", LOW: "s-mute" })[s] || "s-mute";
const stCls = s => ({ PAID: "s-ok", PENDING: "s-info", OVERDUE: "s-crit", OPEN: "s-crit", ASSIGNED: "s-warn", IN_PROGRESS: "s-warn", RESOLVED: "s-ok", CLOSED: "s-mute", SUCCEEDED: "s-ok", FAILED: "s-crit", INITIATED: "s-info", NORMAL: "s-ok", UNDER_INVESTIGATION: "s-warn", ACK: "s-warn", RUNNING: "s-info" })[s] || "s-mute";
const badge = (s, label) => `<span class="status ${stCls(s)}">${esc(label || String(s).replace(/_/g, " "))}</span>`;
const sev = s => `<span class="status ${sevCls(s)}">${esc(s)}</span>`;
const issue = s => esc(String(s).replace(/_/g, " ").toLowerCase());
const gradeChip = (r, big) => `<span class="grade g-${r.grade}${big ? " big" : ""}" title="Eco score ${r.score}/100">${r.grade}</span>`;
const errBox = e => `<div class="errbox">${esc(e && e.body && e.body.pg ? e.body.pg : e && e.message ? e.message : e)}</div>`;
const nowCity = () => APP.clock ? APP.clock.city_now : Date.now();
function slaBadge(t) {
  if (t.status === "RESOLVED" || t.status === "CLOSED") return ms(t.resolved_at) <= ms(t.sla_due_at) ? `<span class="status s-ok">met</span>` : `<span class="status s-crit">missed</span>`;
  const left = ms(t.sla_due_at) - nowCity();
  if (left < 0) return `<span class="status s-crit">late ${dur(left)}</span>`;
  return `<span class="status ${left < HOUR ? "s-warn" : "s-mute"}">${dur(left)} left</span>`;
}
const propTabs = (props, pid) => props.length > 1 ? `<div class="tabs" role="group" aria-label="Property">${props.map(x => `<button aria-pressed="${x.property_id === pid}" data-act="sel" data-k="prop" data-v="${x.property_id}">${esc(x.property_code)} · ${esc(x.address_line.split(",")[0])}</button>`).join("")}</div>` : "";
const utTabs = (cur, key) => `<div class="tabs" role="group" aria-label="Utility">${Object.keys(UT).map(k => `<button aria-pressed="${k === cur}" data-act="sel" data-k="${key}" data-v="${k}"><span class="dot" style="background:${UT[k].color}"></span>${UT[k].label}</button>`).join("")}</div>`;

// ---------- line chart (SVG) with a hover read-out ----------
const CHARTS = {};
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function chart(id, pts, { color, unit, height = 170 }) {
  CHARTS[id] = { pts, unit };
  const W = 640, H = height, L = 44, R = 12, T = 22, B = 24;
  if (!pts.length) return `<div class="chart" id="${id}"><p class="muted">No readings in this window.</p></div>`;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1; const ymax = niceMax(Math.max(...pts.map(p => p.v)) * 1.1);
  const x = t => L + (W - L - R) * ((t - t0) / Math.max(1, t1 - t0)), y = v => T + (H - T - B) * (1 - v / ymax);
  let grid = "", xl = "";
  for (let i = 0; i <= 4; i++) { const v = ymax * i / 4; grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 10 ? Math.round(v) : n1(v)}</text>`; }
  const step = 6 * HOUR; const first = Math.ceil((t0 + 19800000) / step) * step - 19800000;
  for (let t = first; t <= t1; t += step) xl += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${fmtT(t)}</text>`;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
  const lp = pts[pts.length - 1];
  return `<div class="chart" id="${id}" data-l="${L}" data-r="${R}" data-w="${W}">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart in ${esc(unit)}, latest ${n2(lp.v)} ${esc(unit)}">
    ${grid}${xl}<text x="${L - 6}" y="11" text-anchor="end" style="font-size:10px">${esc(unit)}</text>
    <path d="${area}" fill="${color}" fill-opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(lp.t)}" cy="${y(lp.v)}" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
    <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--ink-3)" stroke-dasharray="3 3" visibility="hidden"/>
    <circle class="xd" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/>
  </svg><div class="tip" hidden></div></div>`;
}
document.addEventListener("pointermove", e => {
  const c = e.target.closest && e.target.closest(".chart");
  document.querySelectorAll(".chart .tip").forEach(t => { if (!c || !c.contains(t)) { t.hidden = true; const s = t.parentNode.querySelector("svg"); if (s) { s.querySelector(".xh")?.setAttribute("visibility", "hidden"); s.querySelector(".xd")?.setAttribute("visibility", "hidden"); } } });
  if (!c || !CHARTS[c.id] || !CHARTS[c.id].pts.length) return;
  const { pts, unit } = CHARTS[c.id]; const svg = c.querySelector("svg"); const r = svg.getBoundingClientRect();
  const W = +c.dataset.w, L = +c.dataset.l, R = +c.dataset.r; const vx = (e.clientX - r.left) / r.width * W; if (vx < L || vx > W - R) return;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t; const tt = t0 + (vx - L) / (W - L - R) * (t1 - t0);
  let best = pts[0]; for (const p of pts) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
  const H = svg.viewBox.baseVal.height; const ymax = niceMax(Math.max(...pts.map(p => p.v)) * 1.1);
  const px = L + (W - L - R) * ((best.t - t0) / Math.max(1, t1 - t0)), py = 22 + (H - 46) * (1 - best.v / ymax);
  const xh = svg.querySelector(".xh"), xd = svg.querySelector(".xd");
  xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.setAttribute("visibility", "visible"); xd.setAttribute("cx", px); xd.setAttribute("cy", py); xd.setAttribute("visibility", "visible");
  const tip = c.querySelector(".tip"); tip.hidden = false; tip.style.left = (px / W * r.width) + "px"; tip.style.top = (py / H * r.height) + "px"; tip.textContent = `${fmtDT(best.t)} · ${n2(best.v)} ${unit}`;
});

// download a file the server generates (CSV export)
async function download(path, name) {
  const res = await fetch("/api" + path, { credentials: "same-origin", headers: { "X-Requested-With": "smart-city" } });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const blob = await res.blob(); const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
