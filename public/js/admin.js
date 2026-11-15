"use strict";
/* Municipal admin: operations, map, analytics, disaster simulator, billing run, tickets, rules, SQL lab, accounts, audit trail. */

V.ops = async () => {
  const d = await api("/admin/ops");
  const cut = APP.sel.cut || "WATER", lastV = a => a.length ? a[a.length - 1].v : 0;
  const pct = Math.round(d.grid.kw / d.grid.capacity * 100), dr = d.grid.demand;
  const crit = d.active.filter(t => t.severity === "CRITICAL").length, late = d.active.filter(t => ms(t.sla_due_at) < d.now).length;
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>City operations</h1></div>
  <div class="kpis">
   <div class="kpi"><span class="l">Water flow now ${src("mg")}</span><span class="v">${n1(lastV(d.city.WATER))} L/min</span><span class="l">${lastV(d.city.WATER) > 8 ? `<span class="status s-crit">Above normal</span>` : "Within normal range"}</span></div>
   <div class="kpi"><span class="l">Electricity grid load ${src("mg")}</span><span class="v">${pct}%</span><span class="l"><span class="meter"><span style="width:${Math.min(100, pct)}%;background:${pct >= 90 ? "var(--crit)" : pct >= 75 ? "var(--warn)" : "var(--ok)"}"></span></span>${n1(d.grid.kw)} of ${d.grid.capacity} kW feeder capacity</span></div>
   <div class="kpi"><span class="l">Active tickets ${src("pg")}</span><span class="v">${d.active.length}</span><span class="l">${crit} critical · ${late} past SLA</span></div>
   <div class="kpi"><span class="l">Outstanding bills ${src("pg")}</span><span class="v">${inr(d.money.outstanding)}</span><span class="l">${inr(d.money.overdue)} overdue</span></div>
  </div>
  ${dr ? `<div class="banner crit"><b>Peak demand event</b> since ${fmtT(dr.started_at)}: ${n1(d.grid.kw)} kW now, peak ${n1(dr.peak_kw)} kW against ${d.grid.capacity} kW capacity. ${dr.notified} residents were asked to delay heavy appliances.</div>` : ""}
  <div class="panel"><div class="panel-head"><div class="row"><h2>Automatic actions</h2>${src("mg")}${src("pg")}</div><span class="muted">What the city did on its own</span></div>
   ${d.auto.length ? `<div class="stack" style="gap:6px">${d.auto.map(a => `<div class="row"><span class="status ${a.k === "valve" ? "s-info" : a.k === "grid" ? "s-warn" : "s-crit"}">${a.k === "sla" ? "SLA" : a.k}</span><span class="muted">${fmtDT(a.t)}</span><span>${esc(a.txt)}</span></div>`).join("")}</div>` : `<p class="muted">Nothing yet. Start the pipe burst or the electricity spike in the Disaster simulator and the city reacts here.</p>`}</div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>City demand, last 24 hours</h2>${src("mg")}</div>${utTabs(cut, "cut")}</div>
    ${chart("c-city", d.city[cut], { color: UT[cut].color, unit: UT[cut].rate, height: 190 })}
    <p class="muted" style="font-size:12px;margin-top:6px">Pipeline: <code>$match ts in the last 24 h → $group by { utility, ts }, $sum of the rate</code>. Gaps from offline meters pull the total down.</p></div>
  <div class="panel"><div class="panel-head"><h2>Wards</h2><div class="row">${src("mg")}${src("pg")}</div></div><div class="tablewrap"><table>
   <thead><tr><th>Ward</th><th>District</th><th class="r">Power now</th><th class="r">Water now</th><th class="r">Active tickets</th><th class="r">Unpaid bills</th><th>Meters</th></tr></thead><tbody>
   ${d.wards.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.district)}</td><td class="r">${n1(r.kw)} kW</td><td class="r">${n1(r.flow)} L/min</td><td class="r">${r.tickets ? `<span class="status ${r.critical ? "s-crit" : "s-warn"}">${r.tickets}</span>` : "0"}</td><td class="r">${inr(r.owed)}</td><td>${r.offline ? `<span class="status s-crit">${r.offline} offline</span>` : `<span class="status s-ok">all online</span>`}</td></tr>`).join("")}
   </tbody></table></div><p class="muted" style="font-size:12px;margin-top:6px">Live demand from the latest MongoDB reading per meter; tickets and bills from PostgreSQL. The API merges both into one response.</p></div>
  <div class="grid2"><div class="panel"><div class="panel-head"><h2>Anomaly feed</h2>${src("mg")}</div>
   ${d.events.length ? d.events.map(e => `<div class="stack" style="padding:8px 0;border-bottom:1px solid var(--line);gap:4px"><div class="row">${sev(e.severity)}<b>${esc(e.type.replace("_", " "))}</b><span class="mono">${esc(e.meter_code)}</span>${badge(e.status, e.status.toLowerCase())}<span class="muted">${e.hits}× · ${fmtT(e.last_seen)}</span></div>
     <p class="ink2" style="font-size:13px">${esc(e.reason)}</p><div class="row"><span class="muted" style="font-size:12px">Ticket ${esc(e.ticket_no || "pending")} · synced_to_sql: ${e.synced_to_sql}${e.ack_by ? ` · acknowledged by ${esc(e.ack_by)}` : ""}</span>${e.status === "OPEN" ? `<button class="btn small" data-act="ack" data-id="${e._id}">Acknowledge</button>` : ""}</div></div>`).join("")
    : `<p class="muted">No anomalies. Use the Disaster simulator to inject a pipe burst, a power spike or an outage.</p>`}</div>
  <div class="panel"><div class="panel-head"><h2>Meter health</h2>${src("mg")}</div><div class="tablewrap"><table><thead><tr><th>Meter</th><th>Property</th><th>Last seen</th><th>State</th></tr></thead><tbody>
   ${d.health.map(h => { const age = d.now - h.last; return `<tr><td class="mono">${h.meter_code}</td><td class="mono">${h.property_code}</td><td>${fmtT(h.last)}</td><td>${age >= TICK * 2 ? `<span class="status s-crit">offline ${Math.round(age / 60e3)} min</span>` : `<span class="status s-ok">online</span>`}</td></tr>`; }).join("")}</tbody></table></div>
   <p class="muted" style="font-size:12px;margin-top:6px">Pipeline: <code>$sort ts → $group by meta.meter_code, last: $last ts</code>, oldest first.</p></div></div>`;
};
V.ops.live = true;
ACT.ack = async b => { await post(`/admin/anomalies/${b.dataset.id}/ack`); await render(); };

// ---------- live city map ----------
const WARD_BOX = { 4: [20, 20, 290, 170], 5: [330, 20, 290, 170], 6: [20, 230, 290, 170], 7: [330, 230, 290, 170] };
const WARD_NAME = { 4: ["Ward N-1", "North District"], 5: ["Ward N-2", "North District"], 6: ["Ward S-1", "South District"], 7: ["Ward S-2", "South District"] };
const PIN_SPOTS = [[0.3, 0.58], [0.72, 0.42], [0.5, 0.8], [0.2, 0.3]];
function mapSvg(props, sel) {
  const pin = p => { const [x, y, w, h] = WARD_BOX[p.zone_id], i = props.filter(q => q.zone_id === p.zone_id).indexOf(p), [fx, fy] = PIN_SPOTS[i % PIN_SPOTS.length]; return [x + w * fx, y + h * fy]; };
  return `<svg class="citymap" viewBox="0 0 640 420" role="img" aria-label="Map of the city's wards with a pin for each property">
   <path class="river" d="M0 210 C 90 190, 170 232, 260 210 S 430 188, 520 212 S 610 226, 640 206" /><text class="rlab" x="560" y="200">river</text>
   ${Object.keys(WARD_BOX).map(Number).map(z => { const [x, y, w, h] = WARD_BOX[z], st = props.filter(p => p.zone_id === z), cls = st.some(s => s.crit) ? "crit" : st.some(s => s.k !== "ok") ? "warn" : "";
     return `<g><rect class="ward ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/><text class="wlab" x="${x + 12}" y="${y + 26}">${WARD_NAME[z][0]}</text><text class="dlab" x="${x + w - 12}" y="${y + 26}" text-anchor="end">${WARD_NAME[z][1]}</text></g>`; }).join("")}
   ${props.map(p => { const [x, y] = pin(p), on = p.property_id === sel;
     return `<g class="pin ${p.k}${on ? " on" : ""}" data-act="sel" data-k="mapProp" data-v="${p.property_id}" tabindex="0" role="button" aria-label="${p.property_code}, ${p.label}">
      ${p.crit ? `<circle class="pulse" cx="${x}" cy="${y}" r="16"/>` : ""}<circle class="pdot" cx="${x}" cy="${y}" r="${on ? 17 : 15}" ${p.valve ? 'stroke-dasharray="4 3"' : ""}/>
      <text class="pico" x="${x}" y="${y + 5}" text-anchor="middle">${p.property_type === "COMMERCIAL" ? "B" : "H"}</text><text class="plab" x="${x}" y="${y + 34}" text-anchor="middle">${p.property_code}</text></g>`; }).join("")}
  </svg>`;
}
V.map = async () => {
  const { properties: ps, grid } = await api("/admin/map");
  const sel = (ps.find(p => p.property_id === APP.sel.mapProp) || ps[0]).property_id; APP.sel.mapProp = sel;
  const d = await api(`/admin/map/${sel}`), s = d.state, p = d.property, n = k => ps.filter(x => x.k === k).length;
  const w = d.meters.find(m => m.utility_type === "WATER");
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Live city map</h1>
   <p class="ink2">Every property, coloured by its live state. Pins update with each meter batch; click one for its readings, bills and tickets.</p></div>
  <div class="kpis">
   <div class="kpi"><span class="l">Normal</span><span class="v">${n("ok")}</span><span class="l"><span class="lgd ok"></span>no open issues</span></div>
   <div class="kpi"><span class="l">Open ticket</span><span class="v">${n("warn")}</span><span class="l"><span class="lgd warn"></span>being handled</span></div>
   <div class="kpi"><span class="l">Critical</span><span class="v">${n("crit")}</span><span class="l"><span class="lgd crit"></span>leak, outage or spike</span></div>
   <div class="kpi"><span class="l">Grid load ${src("mg")}</span><span class="v">${Math.round(grid.kw / grid.capacity * 100)}%</span><span class="l">${n1(grid.kw)} of ${grid.capacity} kW</span></div>
  </div>
  <div class="mapgrid">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Synthetic City</h2>${src("mg")}${src("pg")}</div><span class="muted">H home · B business · dashed ring: valve closed</span></div>${mapSvg(ps, sel)}</div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>${esc(p.property_code)}</h2><span class="status ${s.k === "crit" ? "s-crit" : s.k === "warn" ? "s-warn" : s.k === "off" ? "s-mute" : "s-ok"}">${s.label}</span></div>${gradeChip(d.eco)}</div>
   <p class="ink2" style="margin:0 0 10px">${esc(p.address_line)} · ${esc(p.property_type.toLowerCase())} · ${esc(p.zone_name)}<br>Owner: ${esc(p.full_name)} <span class="muted mono">${esc(p.citizen_ref)}</span></p>
   <div class="tablewrap"><table><tbody>
    ${d.meters.map(m => `<tr><th><span class="dot" style="background:${UT[m.utility_type].color}"></span>${UT[m.utility_type].label}</th><td class="r num">${!m.valve_open ? `<span class="status s-warn">valve closed</span> ` : !m.supply_on ? badge("CLOSED", "off") + " " : ""}${m.rate == null ? `<span class="status s-mute">no signal</span>` : `${n2(m.rate)} ${UT[m.utility_type].rate}`}</td></tr>`).join("")}
    ${d.forecast ? `<tr><th>${esc(d.forecast.name)} forecast</th><td class="r num">${d.forecast.high ? `<span class="status s-warn">high</span> ` : ""}${inr(d.forecast.total)}</td></tr>` : ""}
    <tr><th>Unpaid</th><td class="r num">${s.overdue ? badge("OVERDUE") + " " : ""}${inr(s.owed)}</td></tr>
    <tr><th>Eco score</th><td class="r num">${d.eco.score}/100</td></tr></tbody></table></div>
   <h3 style="font-size:14px;margin:14px 0 6px">Open tickets</h3>
   ${s.tickets.length ? `<div class="stack" style="gap:6px">${s.tickets.map(t => `<div class="row">${sev(t.severity)}<span class="mono">${t.ticket_no}</span><span>${issue(t.issue_type)}</span>${badge(t.status)}<span class="muted">${esc(t.assigned_name || "unassigned")} · ${slaBadge(t)}</span></div>`).join("")}</div>` : `<p class="muted">None.</p>`}
   <div class="row" style="margin-top:14px">${w && !w.valve_open ? `<button class="btn small" data-act="valve-open" data-code="${w.meter_code}">Reopen water valve</button>` : ""}<button class="btn small" data-act="go" data-view="tix">All tickets</button></div></div>
  </div>`;
};
V.map.live = true;
ACT["valve-open"] = async b => { await post("/admin/valve", { meter_code: b.dataset.code, open: true }); toast("Valve opened."); await render(); };

// ---------- analytics ----------
function groupBars(rows, series, fmt) {
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => r[s.k]))) * 1.12;
  return `<div class="gbars">${rows.map(r => `<div class="gb"><div class="gcols">${series.map(s => `<span class="gcol" style="height:${Math.max(1, r[s.k] / max * 100)}%;background:${s.c}" title="${s.l}: ${fmt(r[s.k])}"><i>${fmt(r[s.k])}</i></span>`).join("")}</div><span class="lab">${r.label}</span></div>`).join("")}</div>
   <div class="legend">${series.map(s => `<span><span class="dot" style="background:${s.c}"></span>${s.l}</span>`).join("")}</div>`;
}
V.analytics = async () => {
  const a = await api("/admin/analytics"), k = a.kpi, kk = x => "₹" + (x / 100000).toFixed(1) + "k";
  const months = [...new Set(a.use.map(u => u.cycle_id))].map(c => { const rows = a.use.filter(u => u.cycle_id === c), o = { label: MON[rows[0].month] };
    for (const u of Object.keys(UT)) o[u] = (rows.find(r => r.utility_type === u) || { units: 0 }).units; return o; });
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Analytics</h1>
   <p class="ink2">Revenue, consumption and service performance across the city, straight from PostgreSQL. Download any table as CSV for the finance team.</p></div>
  <div class="kpis">
   <div class="kpi"><span class="l">Collection rate ${src("pg")}</span><span class="v">${k.billed ? Math.round(k.collected / k.billed * 100) : 0}%</span><span class="l">${inr(k.collected)} of ${inr(k.billed)} from bills past their due date</span></div>
   <div class="kpi"><span class="l">Late fees raised ${src("pg")}</span><span class="v">${inr(k.late)}</span><span class="l">by the nightly overdue job</span></div>
   <div class="kpi"><span class="l">Tickets resolved ${src("pg")}</span><span class="v">${k.resolved}<span class="muted" style="font-size:14px"> / ${k.total}</span></span><span class="l">${k.resolved ? `avg ${dur(k.avg_fix_ms)} to fix` : "none resolved yet"}</span></div>
   <div class="kpi"><span class="l">SLA met</span><span class="v">${k.resolved ? Math.round(k.sla_met / k.resolved * 100) + "%" : "–"}</span><span class="l">${k.escalated} escalated</span></div>
  </div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Billed vs collected</h2>${src("pg")}</div><button class="btn small" data-act="csv" data-what="invoices">Invoices CSV</button></div>
    ${groupBars(a.money.map(m => ({ label: MON[m.month], billed: m.billed, collected: m.collected })), [{ k: "billed", l: "Billed", c: "var(--pg)" }, { k: "collected", l: "Collected", c: "var(--ok)" }], kk)}
    <pre class="code" style="margin-top:10px">SELECT cycle_id, year, month, billed, collected, late_fees
FROM v_cycle_revenue ORDER BY cycle_id;
-- view: invoice ⟕ payment (SUCCEEDED) ⟕ LATERAL late-fee lines, GROUP BY cycle</pre></div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>City consumption by month</h2>${src("pg")}</div><button class="btn small" data-act="csv" data-what="readings">Readings CSV</button></div>
    <div class="tablewrap"><table><thead><tr><th>Month</th>${Object.keys(UT).map(u => `<th class="r"><span class="dot" style="background:${UT[u].color}"></span>${UT[u].label}</th>`).join("")}<th class="r">CO₂</th></tr></thead><tbody>
     ${months.map(r => `<tr><td>${r.label}</td>${Object.keys(UT).map(u => `<td class="r num">${Math.round(r[u]).toLocaleString("en-IN")} ${UT[u].unit}</td>`).join("")}<td class="r num">${((r.ELECTRICITY * 0.71 + r.WATER * 0.35 + r.GAS * 2) / 1000).toFixed(2)} t</td></tr>`).join("")}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Units come from <code>meter_reading.total_units_consumed</code>, the one row per meter per month written by the aggregation run.</p></div>
  </div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Greenest wards</h2>${src("pg")}</div><span class="muted">${a.last ? cycleName(a.last.month, a.last.year) : ""}</span></div>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Ward</th><th class="r">CO₂ each</th><th>Eco</th><th class="r">Paid</th></tr></thead><tbody>
     ${a.wards.map((w, i) => `<tr><td>${i + 1}</td><td style="white-space:nowrap"><b>${esc(w.name)}</b><div class="muted" style="font-size:12px">${esc(w.district)}</div></td><td class="r num">${Math.round(w.kg_per)} kg</td><td style="white-space:nowrap">${gradeChip(w)} ${w.score}</td><td class="r">${Math.round(w.paid_share * 100)}%</td></tr>`).join("")}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Ranked by CO₂ per property so a ward with more businesses is not punished for its size. Paid = share of the ward's billed amount collected.</p></div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>Tickets by type</h2>${src("pg")}</div><button class="btn small" data-act="csv" data-what="tickets">Tickets CSV</button></div>
    <div class="tablewrap"><table><thead><tr><th>Issue</th><th class="r">Total</th><th class="r">Open</th><th class="r">Resolved</th><th class="r">Avg time to fix</th></tr></thead><tbody>
     ${a.tickets.map(t => `<tr><td>${issue(t.issue_type)}</td><td class="r">${t.total}</td><td class="r">${t.open}</td><td class="r">${t.resolved}</td><td class="r">${t.resolved ? dur(t.avg_fix_ms) : "–"}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No tickets yet. Start a scenario in the Disaster simulator.</td></tr>`}</tbody></table></div></div>
  </div>`;
};
V.analytics.live = true;
ACT.csv = async b => { const w = b.dataset.what; await download(`/admin/csv/${w}`, w === "readings" ? "monthly-readings.csv" : `${w}.csv`); toast(`Downloaded ${w}.csv`); refreshRail(); };

// ---------- disaster simulator ----------
const SCEN = [
  { id: "burst", title: "Pipe burst", where: "P-0001 · 12 Lake View Road · Ward N-1", what: "Water flow jumps to about 14 L/min and pressure drops. After 1 city-hour the leak rule fires and opens a CRITICAL ticket for North District staff." },
  { id: "spike", title: "Electricity spike", where: "P-0004 · Desai Bakery · Ward S-1", what: "Demand jumps to about 9–10 kW, over 3× the bakery's baseline. The spike rule opens a HIGH ticket for South District staff." },
  { id: "outage", title: "Local outage", where: "Ward S-2 · P-0006 and P-0007", what: "Six meters stop reporting. After 45 city-minutes the missing-data rule opens one ticket per property; the ward shows its meters offline." },
];
const POLICIES = [
  ["autoValve", "Automatic valve shut-off", "When the leak rule opens a critical ticket, the city closes that home's smart water valve straight away and tells the resident. The valve opens again when the repair ticket is resolved."],
  ["demandResponse", "Peak demand response", "When city electricity demand passes 90% of the feeder's capacity, every resident gets a request to delay heavy appliances. The event ends when demand drops below 80%."],
  ["autoDispatch", "Smart dispatch", "New tickets go straight to an engineer whose district covers the property, picking whoever has the fewest open jobs (ties go by email). Each ticket gets an SLA deadline by severity and is escalated if it runs late."],
];
V.scen = async () => {
  const d = await api("/admin/sim");
  const st = Object.fromEntries(d.scenarios.map(s => [s.id, s]));
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Disaster simulator</h1>
   <p class="ink2">Each scenario changes what the simulated meters send to MongoDB. Detection, tickets and alerts then happen on their own, the same way they would with real meters. Press <b>+1 hour</b> in the top bar to skip ahead.</p></div>
  <div class="grid3">${SCEN.map(s => { const x = st[s.id]; return `<div class="panel stack"><div class="row" style="justify-content:space-between"><h2>${s.title}</h2>${x.contained ? `<span class="status s-warn">valve closed</span>` : x.on ? `<span class="status s-crit">running</span>` : `<span class="status s-mute">idle</span>`}</div>
    <p class="mono" style="font-size:12px">${s.where}</p><p class="ink2">${s.what}</p>
    <div class="row">${x.on ? `<button class="btn" data-act="scen" data-id="${s.id}" data-on="false">Restore normal</button>` : `<button class="btn primary" data-act="scen" data-id="${s.id}" data-on="true">Start ${s.title.toLowerCase()}</button>`}</div></div>`; }).join("")}</div>
  <div class="panel"><div class="panel-head"><h2>Smart automation</h2><span class="muted">Stored in <code>sim_clock.policies</code>; every switch is audited</span></div>
   <div class="policies">${POLICIES.map(([k, t, desc]) => `<div class="policy"><div><b>${t}</b><p class="ink2">${desc}</p></div><button class="switch" role="switch" aria-checked="${!!d.policies[k]}" data-act="policy" data-k="${k}" data-on="${!d.policies[k]}"><span></span>${d.policies[k] ? "On" : "Off"}</button></div>`).join("")}</div></div>
  <div class="panel"><div class="panel-head"><h2>Switch a home's supply on or off</h2>${src("pg")}</div>
   <p class="ink2" style="margin-bottom:8px">For a home that is empty or disconnected. The meter keeps reporting every 15 city-minutes, but its usage reads 0, so the bill only counts what was used while it was on. This is different from an outage, where meters stop reporting.</p>
   <div class="tablewrap"><table><thead><tr><th>Property</th><th>Zone</th>${Object.keys(UT).map(k => `<th>${UT[k].label}</th>`).join("")}</tr></thead><tbody>
   ${d.supply.map(p => `<tr><td><span class="mono">${esc(p.property_code)}</span> ${esc(p.address_line.split(",")[0])}</td><td>${esc(p.zone_name)}</td>${Object.keys(UT).map(k => { const m = p.meters.find(x => x.utility_type === k); return `<td>${m.supply_on ? badge("PAID", "on") : badge("CLOSED", "off")} ${supplyBtn(m)}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div></div>
  <div class="panel"><div class="panel-head"><h2>Detection rules</h2><span class="muted">Thresholds are configuration, shown so the reason for every ticket can be explained</span></div><div class="tablewrap"><table>
   <thead><tr><th>Rule</th><th>Fires when</th><th>Severity</th><th>Duplicate handling</th></tr></thead><tbody>
   <tr><td><b>Leak</b></td><td>Water flow above ${d.rules.LEAK.min_flow} L/min for ${d.rules.LEAK.window_ticks} readings in a row (${d.rules.LEAK.window_ticks * 15} min)</td><td>${sev("CRITICAL")}</td><td rowspan="3">One active ticket per <code>anomaly_key</code> (e.g. LEAK:MTR-W-0001), enforced by the partial unique index <code>uq_active_anomaly_ticket</code>; repeats raise <code>occurrence_count</code></td></tr>
   <tr><td><b>Spike</b></td><td>Electricity above ${d.rules.SPIKE.factor}× its 24-hour average and above ${d.rules.SPIKE.min_kw} kW</td><td>${sev("HIGH")}</td></tr>
   <tr><td><b>Missing data</b></td><td>No reading from a property's meters for ${d.rules.MISSING.ticks * 15}+ min (one ticket per property)</td><td>${sev("MEDIUM")}</td></tr>
   </tbody></table></div></div>`;
};
ACT.scen = async b => { const on = b.dataset.on === "true"; await post(`/admin/scenarios/${b.dataset.id}`, { on }); toast(on ? "Scenario running. Press +1 hour to let the detector see it." : "Back to normal readings."); await render(); };
ACT.policy = async b => { await post(`/admin/policies/${b.dataset.k}`, { on: b.dataset.on === "true" }); await render(); };

// ---------- billing run ----------
V.billing = async () => {
  const d = await api(`/admin/billing?cycle=${APP.sel.cycle || ""}`), c = d.pick, name = cycleName(c.month, c.year), open = c.status === "OPEN";
  APP.sel.cycle = c.cycle_id;
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Billing run: ${esc(name)} ${badge(open ? "PENDING" : "CLOSED", open ? "open" : "closed")}</h1>
   <p class="ink2">Two steps. First the bridge reads each meter's opening and closing register from MongoDB and writes one row per meter to PostgreSQL. Then a stored procedure turns those rows into invoices using the tariff slabs. ${open ? "You can run both steps now (bills then cover usage up to the current city time), or press <b>Jump to month end</b> to let the meters run to the end of the month and have the nightly job do it." : "This cycle is closed; run either step again to show nothing is duplicated."}</p>
   <div class="row" style="margin-top:8px"><div class="tabs" role="group" aria-label="Cycle">${d.cycles.map(x => `<button aria-pressed="${x.cycle_id === c.cycle_id}" data-act="sel" data-k="cycle" data-v="${x.cycle_id}">${MON[x.month]} ${x.year}</button>`).join("")}</div>
   ${open ? `<button class="btn primary" data-act="month-end">Jump to month end</button><span class="muted">Fast-forwards ${Math.max(0, Math.round((d.ends_at - d.now) / HOUR))} simulated hours of meter readings, then closes ${MONTH[c.month]}</span>` : ""}</div></div>
  <div class="grid2"><div class="panel stack"><div class="row" style="justify-content:space-between"><h2>1 · Aggregate usage</h2><div class="row">${src("mg")}→${src("pg")}</div></div>
    <pre class="code">${esc(d.pipeline)}</pre>
    <div class="row"><button class="btn primary" data-act="agg">Run aggregation</button><span class="muted">${d.runs.length} run${d.runs.length === 1 ? "" : "s"} · ${d.readings.length}/${d.meters} meter readings</span></div></div>
   <div class="panel stack"><div class="row" style="justify-content:space-between"><h2>2 · Generate invoices</h2>${src("pg")}</div>
    <pre class="code">-- for each property, one transaction:
CALL sp_generate_invoice(property_id, ${c.cycle_id});
--  1. pg_advisory_xact_lock(hash(property), cycle)
--  2. if an invoice exists → return it (no duplicate)
--  3. every meter needs a meter_reading, else MISSING_READING
--  4. fn_tiered_charge() per utility → line items
--  5. trigger keeps invoice.total_amount = SUM(lines)</pre>
    <div class="row"><button class="btn primary" data-act="gen">Generate invoices</button><span class="muted">${d.invoices}/${d.properties} invoices for ${MONTH[c.month]}</span></div></div></div>
  ${APP.data.billRes ? `<div class="panel">${APP.data.billRes}</div>` : ""}
  ${d.runs.length ? `<div class="panel"><div class="panel-head"><h2>aggregation_run</h2>${src("pg")}</div><div class="tablewrap"><table><thead><tr><th>Started</th><th>Status</th><th class="r">Written</th><th>Note</th></tr></thead><tbody>
   ${d.runs.map(r => `<tr><td>${fmtDT(r.started_at)}</td><td>${badge(r.status)}</td><td class="r">${r.meters_written}/${r.meters_total}</td><td class="muted">${esc(r.error || "")}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
  ${d.readings.length ? `<div class="panel"><div class="panel-head"><h2>meter_reading, ${esc(name)}</h2>${src("pg")}</div><div class="tablewrap"><table><thead><tr><th>Meter</th><th>Property</th><th class="r">Opening</th><th class="r">Closing</th><th class="r">Units</th><th class="r">Docs</th><th>Invoice</th></tr></thead><tbody>
   ${d.readings.map(r => `<tr><td class="mono">${r.meter_code}</td><td class="mono">${r.property_code}</td><td class="r">${n2(r.opening_register)}</td><td class="r">${n2(r.closing_register)}</td><td class="r"><b>${n2(r.total_units_consumed)}</b> ${UT[r.utility_type].unit}</td><td class="r">${r.source_doc_count}</td><td>${r.invoice_no ? `<span class="mono">${r.invoice_no}</span> ${inr(r.total_amount)}` : "–"}</td></tr>`).join("")}</tbody></table></div>
   <p class="muted" style="font-size:12px;margin-top:6px">Units = closing − opening of the cumulative register, so a duplicated or late reading cannot change the bill. A pipe burst shows up here as extra water. Once a property is invoiced, trigger <code>trg_reading_locked</code> freezes its rows.</p></div>` : ""}`;
};
ACT.agg = async () => {
  const r = await post("/admin/billing/aggregate", { cycle: APP.sel.cycle });
  APP.data.billRes = r.errors.length || r.locked ? `<div class="errbox">${esc(`${r.written} readings written, ${r.locked} rejected by trg_reading_locked (already invoiced).${r.errors[0] ? "\n" + r.errors[0] : ""}`)}</div>`
    : `<div class="okbox">Aggregation run finished: ${r.written} meter readings written or refreshed. Running it again only refreshes the same rows (UNIQUE (meter_id, cycle_id) with ON CONFLICT DO UPDATE).</div>`;
  await render();
};
ACT.gen = async () => {
  const r = await post("/admin/billing/invoices", { cycle: APP.sel.cycle });
  APP.data.billRes = r.errors.length ? `<div class="errbox">${esc(r.errors[0])}\n\nRun the aggregation first so every meter has a reading for this cycle.</div>`
    : `<div class="okbox">${r.created} invoices created, ${r.existed} already existed and were returned unchanged.${r.existed && !r.created ? " Nothing was duplicated: UNIQUE (property_id, cycle_id) plus the procedure's existence check." : ""}</div>`;
  await render();
};

// ---------- all tickets ----------
V.tix = async () => {
  const { tickets } = await api("/tickets");
  const ts = tickets.slice().sort((a, b) => ms(b.reported_timestamp) - ms(a.reported_timestamp));
  const sel = ts.find(t => t.ticket_id === APP.sel.tk) || ts[0]; if (sel) APP.sel.tk = sel.ticket_id;
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>All tickets</h1></div>
  <div class="panel"><div class="panel-head"><h2>Every ticket in the city</h2>${src("pg")}</div>${ts.length ? ticketTable(ts, { district: true }) : `<p class="muted">No tickets yet.</p>`}</div>
  ${sel ? await ticketDetail(sel.ticket_id, false) : ""}`;
};
V.tix.live = true;

// ---------- database rules ----------
V.rules = async () => {
  const { rules } = await api("/db/rules");
  return `<div class="page-head"><span class="eyebrow">Database rules</span><h1>Watch the databases refuse bad data</h1><p class="ink2">Each button sends a statement that must be rejected. It runs for real as <code>admin_role</code> inside a transaction that is always rolled back, and the error below is the database's own message.</p></div>
  <div class="grid2">${rules.map((t, i) => `<div class="panel stack"><div class="row" style="justify-content:space-between"><h3>${esc(t.title)}</h3>${src(t.db)}</div><pre class="code">${esc(t.sql)}</pre><p class="muted" style="font-size:12px">Guarded by ${esc(t.why)}</p><div><button class="btn" data-act="rule" data-i="${i}">Run statement</button></div><div id="rule-${i}"></div></div>`).join("")}</div>`;
};
ACT.rule = async b => {
  const i = b.dataset.i, r = await post(`/db/rules/${i}`);
  $("#rule-" + i).innerHTML = r.rejected ? `<div class="errbox">${esc(r.error)}</div>` : `<div class="okbox">${esc(r.error)}</div>`;
  refreshRail();
};

// ---------- SQL lab ----------
V.sql = async () => {
  const { queries, zones } = await api("/db/sql"), q = APP.sel.q || "q1", meta = queries.find(x => x.id === q);
  const qs = meta.param === "zone" ? `?zone=${APP.sel.zone || 2}` : meta.param === "th" ? `?th=${APP.sel.th || 2}` : "";
  const r = await api(`/db/sql/${q}${qs}`);
  const param = meta.param === "zone" ? `<label class="f">Zone ($1)<select class="in" data-change="zone">${zones.map(z => `<option value="${z.zone_id}" ${z.zone_id === Number(APP.sel.zone || 2) ? "selected" : ""}>${esc(z.name)}</option>`).join("")}</select></label>`
    : meta.param === "th" ? `<label class="f">Minimum overdue bills ($1)<select class="in" data-change="th">${[1, 2, 3].map(v => `<option ${v === Number(APP.sel.th || 2) ? "selected" : ""}>${v}</option>`).join("")}</select></label>`
    : meta.param === "today" ? `<p class="ink2">$1 = <b>${esc(r.params[0])}</b>, today on the city clock.</p>` : "";
  return `<div class="page-head"><span class="eyebrow">Database showcase</span><h1>SQL lab</h1><p class="ink2">The query catalogue. Each statement runs in PostgreSQL as <code>admin_role</code> and the rows below are exactly what it returned.</p></div>
  <div class="tabs" role="group" aria-label="Query">${queries.map(x => `<button aria-pressed="${x.id === q}" data-act="sel" data-k="q" data-v="${x.id}">${esc(x.title.split(":")[0])}</button>`).join("")}</div>
  <div class="panel stack"><div class="row" style="justify-content:space-between"><h2>${esc(r.title)}</h2>${src("pg")}</div>
   <pre class="code">${esc(r.sql)}</pre>${param ? `<div class="row">${param}</div>` : ""}
   <div class="tablewrap"><table><thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${r.rows.length ? r.rows.map(row => `<tr>${row.map(v => `<td class="${typeof v === "number" ? "r num" : ""}">${v == null ? '<span class="muted">NULL</span>' : esc(typeof v === "number" ? (Number.isInteger(v) ? v : n2(v)) : v)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${r.columns.length}" class="muted">0 rows</td></tr>`}</tbody></table></div>
   <p class="muted" style="font-size:12px">${r.rows.length} row${r.rows.length === 1 ? "" : "s"} in ${r.ms.toFixed(1)} ms.</p></div>`;
};

// ---------- accounts ----------
V.users = async () => {
  const d = await api("/admin/users");
  return `<div class="page-head"><span class="eyebrow">Accounts</span><h1>Users and sign-in</h1><p class="ink2">Accounts live in <code>app_user</code> with scrypt password hashes; no role can even select the hash column. Every change here is written to <code>audit_log</code> and sign-ins to <code>auth_event</code>.</p></div>
  <div class="panel"><div class="panel-head"><h2>Accounts</h2>${src("pg")}</div><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th class="r">Live sessions</th><th>State</th><th></th></tr></thead><tbody>
  ${d.users.map(u => { const locked = u.locked_until && ms(u.locked_until) > Date.now(); return `<tr><td><b>${esc(u.display_name)}</b></td><td class="mono">${esc(u.email)}</td><td>${esc(u.role.toLowerCase())}${u.zone_name ? ` · ${esc(u.zone_name)}` : ""}</td><td>${u.last_login_at ? new Date(ms(u.last_login_at)).toLocaleString("en-IN") : "never"}</td><td class="r">${u.live_sessions}</td>
    <td>${!u.is_active ? badge("CLOSED", "deactivated") : locked ? badge("OVERDUE", "locked") : u.failed_logins ? badge("ASSIGNED", `${u.failed_logins} failed`) : badge("PAID", "active")}</td>
    <td style="white-space:nowrap">${locked || u.failed_logins ? `<button class="btn small" data-act="u-unlock" data-id="${u.user_id}">Unlock</button> ` : ""}${u.live_sessions && u.user_id !== APP.user.user_id ? `<button class="btn small" data-act="u-revoke" data-id="${u.user_id}">Sign out</button> ` : ""}<button class="btn small" data-act="u-reset" data-id="${u.user_id}" data-name="${esc(u.display_name)}">Reset password</button> ${u.user_id !== APP.user.user_id ? `<button class="btn small ${u.is_active ? "danger" : ""}" data-act="u-active" data-id="${u.user_id}" data-on="${!u.is_active}">${u.is_active ? "Deactivate" : "Reactivate"}</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div><div id="u-out"></div></div>
  <div class="panel"><div class="panel-head"><h2>Create an account</h2>${src("pg")}</div>
   <form id="new-user" class="stack"><div class="formgrid">
    <label class="f">Role<select class="in" name="role" data-change="newrole">${["STAFF", "ADMIN", "RESIDENT"].map(r => `<option ${APP.sel.newrole === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>
    ${(APP.sel.newrole || "STAFF") === "RESIDENT" ? `<label class="f">Resident on the city register<select class="in" name="resident_id">${d.unclaimed.map(r => `<option value="${r.resident_id}">${esc(r.full_name)} · ${esc(r.email)}</option>`).join("") || "<option value=''>Everyone already has an account</option>"}</select></label>`
      : `<label class="f">Name<input class="in" name="display_name" required placeholder="Priya Kulkarni"></label><label class="f">Email<input class="in" name="email" type="email" required placeholder="priya.staff@city.example.test"></label>`}
    ${(APP.sel.newrole || "STAFF") === "STAFF" ? `<label class="f">Works in<select class="in" name="staff_zone_id">${d.zones.map(z => `<option value="${z.zone_id}">${esc(z.name)}</option>`).join("")}</select></label>` : ""}
    <label class="f">First password<input class="in" name="password" type="text" required minlength="8" placeholder="at least 8 characters, a letter and a number"></label></div>
    <div><button class="btn primary" type="submit">Create account</button></div><div id="nu-out"></div></form>
   <p class="muted" style="font-size:12px;margin-top:8px">Residents can also create their own account from the sign-in page with the email on their utility record (${d.unclaimed.map(r => esc(r.full_name.split(" ")[0])).join(", ") || "none left"}).</p></div>`;
};
FORMS["new-user"] = async f => {
  try { const r = await post("/admin/users", Object.fromEntries(new FormData(f))); toast(`Account created for ${r.user.display_name}.`); await render(); }
  catch (e) { $("#nu-out").innerHTML = errBox(e); refreshRail(); }
};
const userAct = (path, body, msg) => async b => { try { await post(`/admin/users/${b.dataset.id}/${path}`, body ? body(b) : {}); toast(msg(b)); await render(); } catch (e) { $("#u-out").innerHTML = errBox(e); } };
ACT["u-unlock"] = userAct("unlock", null, () => "Account unlocked.");
ACT["u-revoke"] = userAct("revoke", null, () => "Their sessions were signed out.");
ACT["u-active"] = userAct("active", b => ({ on: b.dataset.on === "true" }), b => b.dataset.on === "true" ? "Account reactivated." : "Account deactivated and signed out.");
ACT["u-reset"] = async b => {
  const box = $("#u-out");
  box.innerHTML = `<form id="reset-pw" class="row" data-id="${b.dataset.id}" style="margin-top:10px"><label class="f">New password for ${esc(b.dataset.name)}<input class="in" name="password" required minlength="8"></label><button class="btn primary" type="submit">Set password</button></form>`;
  box.querySelector("input").focus();
};
FORMS["reset-pw"] = async f => {
  try { await post(`/admin/users/${f.dataset.id}/password`, { password: new FormData(f).get("password") }); toast("Password reset; their sessions were signed out."); await render(); }
  catch (e) { f.insertAdjacentHTML("afterend", errBox(e)); }
};

// ---------- audit trail ----------
V.audit = async () => {
  const s = APP.sel.asrc || "pg", t = APP.sel.atable || "";
  const d = await api(`/admin/audit?source=${s}&table=${encodeURIComponent(t)}`);
  const tabs = [["pg", "PostgreSQL changes"], ["auth", "Sign-ins"], ["sessions", "Sessions"], ["mongo", "MongoDB changes"]];
  const json = o => o ? esc(JSON.stringify(o, null, 1)) : "";
  const diffOf = r => r.operation === "UPDATE" && r.changed ? r.changed.map(k => `<div><b>${esc(k)}</b>: ${esc(JSON.stringify(r.old_row ? r.old_row[k] : null))} → ${esc(JSON.stringify(r.new_row ? r.new_row[k] : null))}</div>`).join("") : "";
  let body = "";
  if (s === "pg") body = `<table><thead><tr><th>#</th><th>Real time</th><th>City time</th><th>Who</th><th>DB role</th><th>Table</th><th>Op</th><th>Row</th><th>Change</th></tr></thead><tbody>${d.rows.map(r => `<tr class="audit-row"><td class="mono">${r.audit_id}</td><td style="white-space:nowrap" title="${esc(new Date(ms(r.at)).toLocaleString("en-IN"))}">${new Date(ms(r.at)).toLocaleTimeString("en-IN", { hour12: false })}</td><td style="white-space:nowrap">${fmtDT(r.city_at)}</td><td>${esc(r.actor)}</td><td class="mono" style="font-size:11px">${esc(r.db_role)}</td><td class="mono">${esc(r.table_name)}</td><td>${badge(r.operation === "DELETE" ? "OVERDUE" : r.operation === "INSERT" ? "PAID" : "ASSIGNED", r.operation)}</td><td class="mono">${esc(r.row_key)}</td><td class="diff">${r.operation === "UPDATE" ? `<pre>${diffOf(r)}</pre>` : `<pre>${json(r.new_row || r.old_row)}</pre>`}</td></tr>`).join("")}</tbody></table>`;
  if (s === "auth") body = `<table><thead><tr><th>#</th><th>When</th><th>Event</th><th>Email</th><th>IP</th><th>Detail</th></tr></thead><tbody>${d.rows.map(r => `<tr><td class="mono">${r.event_id}</td><td>${new Date(ms(r.at)).toLocaleString("en-IN")}</td><td>${badge(r.kind === "LOGIN_OK" || r.kind === "ACCOUNT_CREATED" ? "PAID" : r.kind === "LOGOUT" || r.kind === "PASSWORD_CHANGED" ? "PENDING" : "OVERDUE", r.kind)}</td><td class="mono">${esc(r.email)}</td><td class="mono">${esc(r.ip || "")}</td><td class="muted">${esc(r.detail || "")}</td></tr>`).join("")}</tbody></table>`;
  if (s === "sessions") body = `<table><thead><tr><th>Who</th><th>Started</th><th>Last seen</th><th>Expires</th><th>Ended</th><th>IP</th><th>Browser</th></tr></thead><tbody>${d.rows.map(r => `<tr><td>${esc(r.display_name)}<div class="muted mono" style="font-size:11px">${esc(r.email)}</div></td><td>${new Date(ms(r.created_at)).toLocaleString("en-IN")}</td><td>${new Date(ms(r.last_seen_at)).toLocaleTimeString("en-IN")}</td><td>${new Date(ms(r.expires_at)).toLocaleString("en-IN")}</td><td>${r.ended_at ? `${badge("CLOSED", r.end_reason)} ${new Date(ms(r.ended_at)).toLocaleTimeString("en-IN")}` : badge("PAID", "live")}</td><td class="mono">${esc(r.ip || "")}</td><td class="muted" style="font-size:11px">${esc((r.user_agent || "").slice(0, 60))}</td></tr>`).join("")}</tbody></table>`;
  if (s === "mongo") body = `<table><thead><tr><th>When (real)</th><th>City time</th><th>Who</th><th>Collection</th><th>Op</th><th>Filter</th><th>Change</th></tr></thead><tbody>${d.rows.map(r => `<tr class="audit-row"><td style="white-space:nowrap">${new Date(ms(r.at)).toLocaleString("en-IN")}</td><td style="white-space:nowrap">${fmtDT(r.city_at)}</td><td>${esc(r.actor)}</td><td class="mono">${esc(r.collection)}</td><td>${badge(r.op === "delete" ? "OVERDUE" : r.op === "insert" ? "PAID" : "ASSIGNED", r.op)}</td><td><pre>${json(r.filter)}</pre></td><td><pre>${json(r.change)}</pre></td></tr>`).join("")}</tbody></table>`;
  return `<div class="page-head"><span class="eyebrow">Accounts</span><h1>Audit trail</h1><p class="ink2">Every change is kept. PostgreSQL writes <code>audit_log</code> from trigger <code>trg_audit</code> on every main table (who, which database role, real and city time, the row before and after, never a password hash). MongoDB writes go through one function that records them in <code>change_log</code>. Sign-ins and sign-outs are in <code>auth_event</code>, and sessions are kept after sign-out.</p></div>
  <div class="tabs" role="group" aria-label="Source">${tabs.map(([k, l]) => `<button aria-pressed="${k === s}" data-act="sel" data-k="asrc" data-v="${k}" data-reset="atable">${l}</button>`).join("")}</div>
  ${d.counts.length ? `<div class="tabs" role="group" aria-label="Filter" style="margin-top:8px"><button aria-pressed="${!t}" data-act="sel" data-k="atable" data-v="">all</button>${s === "auth" ? d.counts.map(c => `<span class="pill">${esc(c.name)} ${c.n}</span>`).join("") : d.counts.map(c => `<button aria-pressed="${c.name === t}" data-act="sel" data-k="atable" data-v="${esc(c.name)}">${esc(c.name)} · ${c.n}</button>`).join("")}</div>` : ""}
  <div class="panel"><div class="panel-head"><h2>Latest ${d.rows.length}</h2>${src(s === "mongo" ? "mg" : "pg")}</div><div class="tablewrap">${d.rows.length ? body : `<p class="muted">Nothing recorded yet.</p>`}</div></div>`;
};
V.audit.live = true;
