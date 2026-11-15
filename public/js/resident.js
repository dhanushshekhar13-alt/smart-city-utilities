"use strict";
/* Resident portal: dashboard, bills and payments, footprint and savings, complaints, alerts. */

function forecastPanel(f) {
  if (!f) return "";
  const bars = [...f.hist.map(h => ({ ...h, kind: "past" })), { label: f.cycle.short + " (forecast)", amt: f.total, kind: "proj" }];
  const max = Math.max(...bars.map(b => b.amt), f.avg) * 1.1 || 1;
  const pct = Math.round((f.ratio - 1) * 100);
  return `<div class="panel"><div class="panel-head"><div class="row"><h2>${esc(f.cycle.name)} bill forecast</h2>${src("mg")}${src("pg")}</div><span class="muted">Updated every reading</span></div>
   ${f.high ? `<div class="banner warn" style="margin-bottom:12px"><b>Heading for a high bill.</b> ${f.worst.ratio >= 1.5 ? `${esc(f.worst.label)} is on course for ${n1(f.worst.proj)} ${f.worst.unit}, ${n1(f.worst.ratio)}× your usual ${n1(f.worst.avgUnits)}. ` : ""}Forecast ${inr(f.total)} against your usual ${inr(f.avg)}.</div>`
    : `<div class="banner ok" style="margin-bottom:12px"><b>On track.</b> Forecast ${inr(f.total)}, ${pct >= 0 ? `${pct}% above` : `${-pct}% below`} your 3-month average of ${inr(f.avg)}.</div>`}
   <div class="fcgrid"><div class="tablewrap"><table class="fc"><thead><tr><th>Utility</th><th class="r">Used so far</th><th class="r">By ${fmtD(f.cycle.end)}</th><th class="r">Usual</th><th class="r">Forecast</th></tr></thead><tbody>
    ${f.rows.map(r => `<tr><td><span class="dot" style="background:${UT[r.utility].color}"></span>${r.label}</td><td class="r">${n1(r.used)} ${r.unit}</td><td class="r"><b>${n1(r.proj)}</b></td><td class="r">${n1(r.avgUnits)}</td><td class="r">${inr(r.costProj)}</td></tr>`).join("")}
    <tr><td colspan="4"><b>Total</b> <span class="muted">so far ${inr(f.soFar)}</span></td><td class="r"><b>${inr(f.total)}</b></td></tr></tbody></table></div>
   <div class="bars" role="img" aria-label="Bills for the last three months and the forecast">${bars.map(b => `<div class="bar ${b.kind}"><span class="amt">${inr(b.amt).replace(/\.\d\d$/, "")}</span><span class="col" style="height:${Math.round(b.amt / max * 100)}%"></span><span class="lab">${esc(b.label)}</span></div>`).join("")}</div></div>
   <p class="muted" style="font-size:12px;margin-top:6px">Forecast = units used since ${fmtD(f.cycle.start)} (first and last MongoDB register this cycle) + the last 24 hours' rate × ${n1(f.daysLeft)} days left, priced by PostgreSQL's <code>fn_tiered_charge</code>. Past months are the usage lines of your invoices.</p></div>`;
}

const supplyBtn = m => `<button class="btn small" data-act="supply" data-code="${m.meter_code}" data-on="${!m.supply_on}">${m.supply_on ? "Turn off" : "Turn on"}</button>`;

V.home = async () => {
  const d = await api(`/me/home?property=${APP.sel.prop || ""}&ut=${APP.sel.ut || "ELECTRICITY"}`);
  APP.sel.prop = d.property.property_id;
  const p = d.property, f = d.forecast, m = d.meter, last = d.series[d.series.length - 1];
  const fp = f ? Math.round((f.ratio - 1) * 100) : 0;
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Welcome back, ${esc(APP.user.display_name.split(" ")[0])}</h1></div>
  ${propTabs(d.properties, p.property_id)}
  <div class="grid2">
   <div class="panel"><div class="panel-head"><h2>${esc(p.address_line)}</h2>${src("pg")}</div>
     <div class="tablewrap"><table><tbody>
      <tr><th>Property</th><td class="mono">${esc(p.property_code)} · ${esc(p.property_type.toLowerCase())} · ${p.square_feet} sq ft</td></tr>
      <tr><th>Zone</th><td>${esc(p.zone_name)}, ${esc(p.district_name)}</td></tr>
      <tr><th>Service</th><td>${badge(p.service_status)}</td></tr>
      <tr><th>Eco score</th><td>${gradeChip(d.eco)} <span class="num">${d.eco.score}/100</span> · <button class="btn small" data-act="go" data-view="eco">See footprint &amp; savings</button></td></tr>
      <tr><th>Meters</th><td>${d.meters.map(x => `<span class="mono">${x.meter_code}</span>`).join(", ")}</td></tr>
     </tbody></table></div></div>
   <div class="kpis" style="align-content:start">
     <div class="kpi"><span class="l">Unpaid bills ${src("pg")}</span><span class="v">${inr(d.unpaid.reduce((s, i) => s + i.total_amount, 0))}</span><span class="l">${d.unpaid.length ? `${d.unpaid.length} bill${d.unpaid.length > 1 ? "s" : ""}, next due ${fmtD(d.unpaid[0].due_date)}` : "All paid"}</span></div>
     ${f ? `<div class="kpi"><span class="l">${esc(f.cycle.name)} forecast ${src("mg")}</span><span class="v">${inr(f.total)}</span><span class="l">${inr(f.soFar)} so far · <span class="status ${f.high ? "s-crit" : fp > 0 ? "s-warn" : "s-ok"}">${fp >= 0 ? "+" : ""}${fp}% vs usual</span></span></div>` : ""}
     <div class="kpi"><span class="l">Unread alerts ${src("mg")}</span><span class="v">${d.unread}</span><span class="l">${d.unread ? `<button class="btn small" data-act="go" data-view="alerts">Open alerts</button>` : "Nothing unusual"}</span></div>
   </div></div>
  ${forecastPanel(f)}
  <div class="panel"><div class="panel-head"><div class="row"><h2>Live usage, last 24 hours</h2>${src("mg")}</div>${utTabs(d.ut, "ut")}</div>
   <p class="ink2" style="margin-bottom:8px">Right now: <b class="num">${last ? n2(last.v) : "–"} ${UT[d.ut].rate}</b> · meter <span class="mono">${m.meter_code}</span> · last reading ${last ? fmtT(last.t) : "–"}${m.offline ? ` · ${badge("OVERDUE", "offline")}` : ""}${!m.supply_on ? ` · ${badge("CLOSED", "switched off")}` : ""}${!m.valve_open ? ` · <span class="status s-warn">valve closed automatically</span>` : ""} · ${supplyBtn(m)}</p>
   ${chart("c-home", d.series, { color: UT[d.ut].color, unit: UT[d.ut].rate })}
   <p class="muted" style="font-size:12px;margin-top:6px">Query: <code>db.meter_readings.find({ "meta.meter_code": "${m.meter_code}", ts: { $gt: now − 24h } }).sort({ ts: 1 })</code>, served by the index on (meta.meter_code, ts).</p></div>`;
};
V.home.live = true;

function billLine(l) {
  const u = UT[l.utility_type], dot = `<span class="dot" style="background:${u.color}"></span>`;
  if (l.line_kind === "LATE_FEE") return `<tr><td>${dot}${u.label}</td><td><span class="status s-crit">Late fee</span> ${n1(l.rate_applied)}% of usage</td><td class="r">–</td><td class="r">${n1(l.rate_applied)}%</td><td class="r">${inr(l.line_total)}</td></tr>`;
  return `<tr><td>${dot}${u.label}</td><td>Tier ${l.tier_level}: ${n1(l.min_units)}–${l.max_units == null ? "∞" : n1(l.max_units)} ${u.unit}</td><td class="r">${n2(l.units_consumed)}</td><td class="r">₹${n2(l.rate_applied)}</td><td class="r">${inr(l.line_total)}</td></tr>`;
}

V.bills = async () => {
  const { invoices, other } = await api("/me/invoices");
  if (!invoices.length) return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Bills &amp; payments</h1></div><div class="panel"><p class="muted">No bills yet.</p></div>`;
  const pick = invoices.find(i => i.invoice_id === APP.sel.inv) || invoices.find(i => i.payment_status !== "PAID") || invoices[0];
  APP.sel.inv = pick.invoice_id;
  const { invoice: sel, lines, payments } = await api(`/me/invoices/${pick.invoice_id}`);
  APP.data.bill = { sel, lines, payments };
  const newest = Math.max(...invoices.map(i => i.cycle_id));
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Bills &amp; payments</h1></div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><h2>Your invoices</h2>${src("pg")}</div><div class="tablewrap"><table>
     <thead><tr><th>Invoice</th><th>Cycle</th><th>Property</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>
     ${invoices.map(i => `<tr class="click" data-act="sel" data-k="inv" data-v="${i.invoice_id}" tabindex="0" style="${i.invoice_id === sel.invoice_id ? "outline:2px solid var(--accent);outline-offset:-2px;" : ""}${i.cycle_id === newest ? "box-shadow:inset 4px 0 0 var(--accent);font-weight:600" : ""}"><td class="mono">${i.invoice_no}</td><td>${cycleName(i.month, i.year)}</td><td class="mono">${i.property_code}</td><td class="r">${inr(i.total_amount)}</td><td>${badge(i.payment_status)}</td></tr>`).join("")}
     </tbody></table></div>
     <div class="stack" style="margin-top:12px"><p class="ink2">Row-level security means this list is filtered by PostgreSQL itself: the API runs your query as <code>resident_role</code>.</p>
     ${other ? `<div class="row"><button class="btn" data-act="rls-try" data-id="${other.invoice_id}">Try to open ${esc(other.owner)}'s invoice</button></div>` : ""}<div id="rls-out"></div></div></div>
   <div class="panel"><div class="panel-head"><div><span class="eyebrow">${esc(cycleName(sel.month, sel.year))} · ${esc(sel.property_code)}</span><h2 class="mono">${sel.invoice_no}</h2></div>${badge(sel.payment_status)}</div>
     <div class="tablewrap"><table><thead><tr><th>Utility</th><th>Slab</th><th class="r">Units</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
     ${lines.map(billLine).join("")}
     <tr><td colspan="4"><b>Total</b> <span class="muted">(kept equal to the lines by trigger trg_invoice_total)</span></td><td class="r"><b>${inr(sel.total_amount)}</b></td></tr></tbody></table></div>
     <p class="ink2" style="margin:8px 0">Due ${fmtD(sel.due_date)}. Rates are copied onto each line so the bill never changes if the tariff does.${sel.payment_status === "OVERDUE" ? ` <b>Paid late:</b> the nightly job added a ${n1(sel.late_penalty_percent)}% late fee.` : ""}</p>
     <div class="row" style="margin-bottom:8px"><button class="btn small" data-act="print-bill">Print or save as PDF</button></div>
     ${sel.payment_status !== "PAID" ? `<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><h3>Pay this bill <span class="pill">Simulated gateway, no real money</span></h3>
       <div class="row"><label class="f">Method<select class="in" id="pay-method"><option value="UPI_SIM">UPI (simulated)</option><option value="CARD_SIM">Card (simulated)</option><option value="NETBANK_SIM">Net banking (simulated)</option></select></label>
       <label class="f">Gateway outcome<select class="in" id="pay-outcome"><option value="OK">Approve</option><option value="FAIL">Decline</option></select></label></div>
       <div class="row"><button class="btn primary" data-act="pay" data-id="${sel.invoice_id}">Pay ${inr(sel.total_amount)}</button><button class="btn" data-act="pay" data-twice="1" data-id="${sel.invoice_id}">Send the same request twice</button></div><div id="pay-out"></div></div>` : ""}
     ${payments.length ? `<h3 style="margin-top:12px">Payment attempts</h3><div class="tablewrap"><table><thead><tr><th>When</th><th>Method</th><th>Status</th><th>Reference</th></tr></thead><tbody>${payments.map(x => `<tr><td>${fmtDT(x.payment_date)}</td><td>${x.payment_method}</td><td>${badge(x.status)}</td><td class="mono">${esc(x.transaction_id || x.failure_reason)}</td></tr>`).join("")}</tbody></table></div>` : ""}
   </div></div>`;
};

ACT["rls-try"] = async b => {
  const r = await api(`/me/rls-probe/${b.dataset.id}`);
  $("#rls-out").innerHTML = r.rows ? `<div class="errbox">The invoice came back. Row-level security is not working.</div>`
    : `<div class="okbox"><b>0 rows.</b> Invoice ${esc(r.invoice_no)} exists, but PostgreSQL hides it from <code>resident_role</code> because it belongs to ${esc(r.owner)}. The API answers as if it does not exist.</div>`;
  refreshRail();
};
ACT.pay = async b => {
  const twice = !!b.dataset.twice;
  b.disabled = true;
  try {
    const r = await post(`/me/invoices/${b.dataset.id}/pay`, { method: $("#pay-method").value, outcome: $("#pay-outcome").value, twice });
    const first = r.results[0];
    toast(first.status === "SUCCEEDED" ? (twice ? `Paid once. The repeated request returned the same payment; ${r.stored} row stored.` : "Payment approved. Invoice marked paid.") : "Payment declined. The attempt is recorded and the bill stays unpaid.");
    await render();
  } catch (e) { $("#pay-out").innerHTML = errBox(e); b.disabled = false; refreshRail(); }
};
ACT["print-bill"] = () => {
  const { sel: inv, lines, payments } = APP.data.bill;
  const rows = lines.map(l => { const u = UT[l.utility_type];
    if (l.line_kind === "LATE_FEE") return `<tr><td>${u.label}</td><td>Late fee, ${n1(l.rate_applied)}% of usage</td><td></td><td></td><td class="r">${inr(l.line_total)}</td></tr>`;
    return `<tr><td>${u.label}</td><td>Tier ${l.tier_level}: ${n1(l.min_units)}–${l.max_units == null ? "∞" : n1(l.max_units)} ${u.unit}</td><td class="r">${n2(l.units_consumed)}</td><td class="r">₹${n2(l.rate_applied)}</td><td class="r">${inr(l.line_total)}</td></tr>`; }).join("");
  const pay = payments.find(x => x.status === "SUCCEEDED");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${inv.invoice_no}</title><style>
    body{font-family:Helvetica,Arial,sans-serif;color:#13212c;margin:36px;font-size:13px}h1{font-size:22px;margin:0}
    .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0b5d7a;padding-bottom:14px;margin-bottom:18px}
    .brand{color:#0b5d7a;font-weight:700;font-size:15px}.muted{color:#6f8190}.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 30px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #d5dee5}th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#465867}
    .r{text-align:right}.total td{font-weight:700;font-size:15px;border-bottom:none}.st{display:inline-block;padding:3px 10px;border-radius:99px;font-weight:700;font-size:12px;background:${inv.payment_status === "PAID" ? "#e1f3e8;color:#1d7f46" : inv.payment_status === "OVERDUE" ? "#fbe4e4;color:#c22f2f" : "#e1eaf4;color:#2f5f8f"}}
    .foot{margin-top:26px;font-size:11px;color:#6f8190}</style></head><body>
    <div class="top"><div><div class="brand">Smart City Utilities</div><div class="muted">Synthetic City Municipal Corporation · demo data only</div></div>
    <div style="text-align:right"><h1>${inv.invoice_no}</h1><div class="muted">${esc(cycleName(inv.month, inv.year))}</div><div style="margin-top:6px"><span class="st">${inv.payment_status}</span></div></div></div>
    <div class="grid"><div><b>Billed to</b><br>${esc(inv.full_name)} <span class="muted">${esc(inv.citizen_ref)}</span><br>${esc(inv.address_line)}<br>${esc(inv.city)} ${esc(inv.pincode)}</div>
    <div><b>Property</b> ${esc(inv.property_code)} · ${esc(inv.property_type.toLowerCase())}<br><b>Zone</b> ${esc(inv.zone_name)}, ${esc(inv.district_name)}<br><b>Period</b> ${fmtD(inv.cycle_start_date)} – ${fmtD(inv.cycle_end_date)}<br><b>Due</b> ${fmtD(inv.due_date)}</div></div>
    <table><thead><tr><th>Utility</th><th>Slab</th><th class="r">Units</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}
    <tr class="total"><td colspan="4">Total</td><td class="r">${inr(inv.total_amount)}</td></tr></tbody></table>
    ${pay ? `<p><b>Paid</b> ${fmtDT(pay.payment_date)} by ${pay.payment_method.replace("_SIM", "").toLowerCase()} · ref ${esc(pay.transaction_id)}</p>` : inv.payment_status === "OVERDUE" ? `<p><b>Overdue since ${fmtD(inv.due_date)}.</b> Please pay now in the resident portal.</p>` : `<p>Pay online in the resident portal before ${fmtD(inv.due_date)} to avoid a ${n1(inv.late_penalty_percent)}% late fee.</p>`}
    <div class="foot">Units are the closing minus the opening register of each smart meter for the period. Rates are fixed on the bill when it is issued. Printed ${fmtDT(nowCity())} city time.</div></body></html>`;
  const f = document.createElement("iframe"); f.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0"; document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1000); }, 100);
};

V.tickets = async () => {
  const [{ tickets }, { properties }] = await Promise.all([api("/me/tickets"), api("/me/properties")]);
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Complaints</h1></div>
  <div class="grid2"><div class="panel"><div class="panel-head"><h2>Report a problem</h2>${src("pg")}</div>
   <form class="stack" id="complaint"><label class="f">Property<select class="in" name="property_id">${properties.map(p => `<option value="${p.property_id}">${p.property_code} · ${esc(p.address_line)}</option>`).join("")}</select></label>
   <label class="f">Issue<select class="in" name="issue_type"><option value="LOW_PRESSURE">Low water pressure</option><option value="POWER_OUTAGE">Power outage</option><option value="METER_MALFUNCTION">Meter not working</option><option value="BILLING">Billing question</option><option value="OTHER">Something else</option></select></label>
   <label class="f">What's happening?<textarea class="in" name="description" required minlength="5">Water pressure on the first floor has been very low since yesterday evening.</textarea></label>
   <div><button class="btn primary" type="submit">Submit complaint</button></div><div id="c-err"></div></form></div>
  <div class="panel"><div class="panel-head"><h2>Your tickets</h2>${src("pg")}</div>
   ${tickets.length ? `<div class="tablewrap"><table><thead><tr><th>Ticket</th><th>Property</th><th>Issue</th><th>Severity</th><th>Status</th><th>Assigned</th><th>Raised by</th></tr></thead><tbody>${tickets.map(t => `<tr><td class="mono">${t.ticket_no}</td><td class="mono">${t.property_code}</td><td>${issue(t.issue_type)}</td><td>${sev(t.severity)}</td><td>${badge(t.status)}</td><td>${esc(t.assigned_name || "–")}</td><td>${t.source === "ANOMALY" ? "Automatic" : "You"}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="muted">No tickets yet. Complaints you submit and automatic leak or outage tickets for your properties appear here.</p>`}</div></div>`;
};
FORMS.complaint = async f => {
  const body = Object.fromEntries(new FormData(f));
  try {
    const r = await post("/me/tickets", body);
    toast(r.assigned_to ? `Complaint ${r.ticket_no} submitted and assigned to ${r.assigned_to}.` : `Complaint ${r.ticket_no} submitted. Staff for this district can see it now.`);
    await render();
  } catch (e) { $("#c-err").innerHTML = errBox(e); refreshRail(); }
};

V.alerts = async () => {
  const { notifications: ns } = await api("/me/notifications");
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Alerts</h1><p class="ink2">Stored in MongoDB's <code>notifications</code> collection. Marking read is an update; dismissing is a delete. Both are recorded in <code>change_log</code>.</p></div>
  <div class="panel">${ns.some(n => !n.read_at) ? `<div class="row" style="margin-bottom:6px"><button class="btn small" data-act="n-read-all">Mark all as read</button></div>` : ""}
  ${ns.length ? ns.map(n => `<div style="padding:10px 0;border-bottom:1px solid var(--line)" class="stack"><div class="row"><b>${esc(n.title)}</b>${n.read_at ? badge("CLOSED", "read") : badge("OPEN", "new")}<span class="pill">${esc(n.kind.toLowerCase())}</span><span class="muted">${fmtDT(n.created_at)}</span></div><p class="ink2">${esc(n.body)}</p>
    <div class="row">${n.read_at ? "" : `<button class="btn small" data-act="n-read" data-id="${n._id}">Mark as read</button>`}<button class="btn small danger" data-act="n-del" data-id="${n._id}">Dismiss</button></div></div>`).join("")
    : `<p class="muted">No alerts. If the city detects a leak, a spike or an outage at your property, you'll see it here.</p>`}</div>`;
};
V.alerts.live = true;
ACT["n-read"] = async b => { await post(`/me/notifications/${b.dataset.id}/read`); await render(); };
ACT["n-read-all"] = async () => { await post("/me/notifications/read-all"); await render(); };
ACT["n-del"] = async b => { await del(`/me/notifications/${b.dataset.id}`); toast("Alert dismissed"); await render(); };
ACT.supply = async b => {
  const on = b.dataset.on === "true";
  await post(APP.user.role === "ADMIN" ? "/admin/supply" : "/me/supply", { meter_code: b.dataset.code, on });
  toast(on ? "Supply back on. Usage returns on the next reading." : "Supply off. Usage reads 0 from the next reading; the meter keeps reporting.");
  await render();
};

function strip(c) {
  const lo = Math.min(c.min, c.you), hi = Math.max(c.max, c.you), span = hi - lo || 1, pos = v => ((v - lo) / span * 92 + 4).toFixed(1);
  return `<div class="strip" role="img" aria-label="${c.label}: you ${n1(c.you)}, typical ${n1(c.med)}">
    ${c.vals.map(v => `<span class="peer" style="left:${pos(v)}%"></span>`).join("")}
    <span class="med" style="left:${pos(c.med)}%"></span><span class="you" style="left:${pos(c.you)}%;background:${UT[c.ut].color}"></span></div>`;
}
V.eco = async () => {
  const { properties, report: r } = await api(`/me/eco?property=${APP.sel.prop || ""}`);
  APP.sel.prop = r.property.property_id;
  const cn = MONTH[r.cycle.month], diff = r.peerKg ? Math.round((r.kg / r.peerKg - 1) * 100) : 0, f = r.forecast;
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Footprint &amp; savings</h1>
   <p class="ink2">How your use compares with similar ${esc(r.label)}, what it means for the climate, and the habits worth changing.</p></div>
  ${propTabs(properties, r.property.property_id)}
  <div class="kpis k4">
   <div class="kpi"><span class="l">Eco score</span><span class="v row" style="gap:10px">${gradeChip(r, true)}<span>${r.score}<span class="muted" style="font-size:14px">/100</span></span></span><span class="l">Grades A to E against similar ${esc(r.noun)}</span></div>
   <div class="kpi"><span class="l">${cn} footprint ${src("pg")}</span><span class="v">${Math.round(r.kg)} kg CO₂</span><span class="l"><span class="status ${diff > 10 ? "s-warn" : "s-ok"}">${diff >= 0 ? "+" : ""}${diff}%</span> vs a typical ${Math.round(r.peerKg)} kg</span></div>
   <div class="kpi"><span class="l">${f ? esc(f.cycle.name) : "This month"} so far ${src("mg")}</span><span class="v">${Math.round(r.soFarKg)} kg CO₂</span><span class="l">heading for about ${Math.round(r.projKg)} kg</span></div>
   <div class="kpi"><span class="l">Possible saving</span><span class="v">${r.saving > 0.5 ? inr(Math.round(r.saving)) : "₹0"}</span><span class="l">${r.saving > 0.5 ? "a month, if you act on the tips below" : "nothing to fix right now"}</span></div>
  </div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>You and similar ${esc(r.noun)}</h2>${src("pg")}</div><span class="muted">${cn}, ${r.cmp[0].others} others</span></div>
    <div class="stack">${r.cmp.map(c => `<div class="cmp"><div class="row" style="justify-content:space-between"><b><span class="dot" style="background:${UT[c.ut].color}"></span>${c.label}</b>
      <span class="ink2">You ${n1(c.you)} ${c.unit} · typical ${n1(c.med)} · <span class="status ${c.ratio > 1.05 ? "s-warn" : "s-ok"}">${Math.abs(c.ratio - 1) < 0.03 ? "about the same" : c.ratio >= 1 ? `${Math.round((c.ratio - 1) * 100)}% more` : `${Math.round((1 - c.ratio) * 100)}% less`}</span></span></div>
      ${strip(c)}<p class="muted" style="font-size:12px">${c.more} of ${c.others} similar ${esc(r.noun)} used more than you.</p></div>`).join("")}</div>
    <p class="muted" style="font-size:12px;margin-top:8px">Grey dots are ${esc(r.label)}, the line is the median and the coloured dot is you. The numbers come from <code>fn_peer_usage(property, cycle)</code>, a SECURITY DEFINER function that returns usage without saying whose it is, so row-level security still hides other people's rows.</p></div>
   <div class="panel"><div class="panel-head"><h2>Where your carbon comes from</h2><span class="muted">${cn}</span></div>
    <div class="stack">${Object.keys(UT).map(k => { const v = (r.mine[k] || 0) * r.factors[k]; return `<div><div class="row" style="justify-content:space-between"><span><span class="dot" style="background:${UT[k].color}"></span>${UT[k].label}</span><span class="num">${Math.round(v)} kg</span></div><div class="meter"><span style="width:${r.kg ? Math.round(v / r.kg * 100) : 0}%;background:${UT[k].color}"></span></div></div>`; }).join("")}</div>
    <div class="okbox" style="margin-top:14px">${Math.round(r.kg)} kg CO₂ is about the same as driving a petrol car ${Math.round(r.car_km).toLocaleString("en-IN")} km, or what ${Math.round(r.trees)} trees absorb in a month.</div>
    <p class="muted" style="font-size:12px;margin-top:8px">Approximate factors: ${r.factors.ELECTRICITY} kg per kWh (Indian grid average), ${r.factors.GAS} kg per m³ of gas, ${r.factors.WATER} kg per kL of water pumped and treated.</p></div>
  </div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>Habit check from your smart meters</h2>${src("mg")}</div><span class="muted">last ${Math.round(r.habits.hours)} hours of readings</span></div>
   <div class="tips">${r.tips.map(t => `<div class="tip ${t.lvl}"><b>${esc(t.title)}</b><p class="ink2">${esc(t.body)}</p>${t.save > 0.5 ? `<span class="status s-ok">save about ${inr(Math.round(t.save))} a month</span>` : ""}</div>`).join("")}</div>
   <p class="muted" style="font-size:12px;margin-top:8px">Checks run on <code>db.meter_readings</code>: the lowest water flow between 1 and 5 am (leak test), the lowest electricity draw (always-on load) and the share used between 6 and 10 pm (peak hours). Savings use your current tariff slab.</p></div>`;
};
V.eco.live = true;
