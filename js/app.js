"use strict";
/* Sessions, rendering, the resident / staff / admin views, event handling and boot. */

// ---------- session / navigation ----------
const SESSION={user:null,view:null,sel:{}};
const NAV={
  RESIDENT:[["home","My dashboard"],["bills","Bills & payments"],["tickets","Complaints"],["alerts","Alerts"],["db","Inside the databases"],["how","How it works"]],
  STAFF:[["queue","Ticket queue"],["db","Inside the databases"],["how","How it works"]],
  ADMIN:[["ops","City operations"],["scen","Disaster simulator"],["billing","Billing run"],["tix","All tickets"],["rules","Database rules"],["sql","SQL lab"],["db","Inside the databases"],["how","How it works"]],
};
function login(user){
  const raw=Array.from({length:4},()=>Math.floor(rnd()*2**32).toString(16).padStart(8,"0")).join("");
  insert("user_session",{token_hash:"sha256:"+raw.slice(0,16)+"…",user_id:user.user_id,created_at:now,expires_at:now+8*HOUR});
  SESSION.user=user; SESSION.view=NAV[user.role][0][0]; SESSION.sel={};
  log("pg",`${user.display} signed in as ${user.role}`,`SELECT user_id, password_hash, role FROM app_user WHERE email = $1;  -- $1 = '${user.email}'\n-- verify Argon2id hash, then:\nINSERT INTO user_session (token_hash, user_id, expires_at)\nVALUES (sha256($token), '${user.user_id.slice(0,8)}…', now() + interval '8 hours');\n-- cookie sc_session: HttpOnly; Secure; SameSite=Lax`);
  render();
}
function logout(){ const u=SESSION.user; PG.user_session=PG.user_session.filter(s=>s.user_id!==u.user_id); log("pg",`${u.display} signed out`,`DELETE FROM user_session WHERE token_hash = sha256($token);`); SESSION.user=null; render(); }

// ---------- rendering helpers ----------
const $=s=>document.querySelector(s);
const app=$("#app");
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast.h); toast.h=setTimeout(()=>t.hidden=true,3400); }
const src=k=>k==="pg"?`<span class="src pg">PostgreSQL</span>`:`<span class="src mg">MongoDB</span>`;
const sevCls=s=>({CRITICAL:"s-crit",HIGH:"s-crit",MEDIUM:"s-warn",LOW:"s-mute"})[s]||"s-mute";
const stCls=s=>({PAID:"s-ok",PENDING:"s-info",OVERDUE:"s-crit",OPEN:"s-crit",ASSIGNED:"s-warn",IN_PROGRESS:"s-warn",RESOLVED:"s-ok",CLOSED:"s-mute",SUCCEEDED:"s-ok",FAILED:"s-crit",NORMAL:"s-ok",UNDER_INVESTIGATION:"s-warn",ACK:"s-warn"})[s]||"s-mute";
const badge=(s,label)=>`<span class="status ${stCls(s)}">${esc(label||s.replace("_"," "))}</span>`;
const sev=s=>`<span class="status ${sevCls(s)}">${esc(s)}</span>`;

const CHARTS={};
function niceMax(v){ if(v<=0) return 1; const p=Math.pow(10,Math.floor(Math.log10(v))); const n=v/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
function chart(id,pts,{color,unit,height=170}){
  CHARTS[id]={pts,unit};
  const W=640,H=height,L=44,R=12,T=22,B=24;
  if(!pts.length) return `<div class="chart" id="${id}"><p class="muted">No readings in this window.</p></div>`;
  const t0=pts[0].t,t1=pts[pts.length-1].t||t0+1; const ymax=niceMax(Math.max(...pts.map(p=>p.v))*1.1);
  const x=t=>L+(W-L-R)*((t-t0)/Math.max(1,t1-t0)), y=v=>T+(H-T-B)*(1-v/ymax);
  let grid="",xl="";
  for(let i=0;i<=4;i++){ const v=ymax*i/4; grid+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${v>=10?Math.round(v):n1(v)}</text>`; }
  const step=6*HOUR; let first=Math.ceil(t0/step)*step;
  for(let t=first;t<=t1;t+=step) xl+=`<text x="${x(t)}" y="${H-6}" text-anchor="middle">${fmtT(t)}</text>`;
  const line=pts.map((p,i)=>`${i?"L":"M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area=`${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
  const lp=pts[pts.length-1];
  return `<div class="chart" id="${id}" data-l="${L}" data-r="${R}" data-w="${W}">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart in ${esc(unit)}, latest ${n2(lp.v)} ${esc(unit)}">
    ${grid}${xl}<text x="${L-6}" y="11" text-anchor="end" style="font-size:10px">${esc(unit)}</text>
    <path d="${area}" fill="${color}" fill-opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(lp.t)}" cy="${y(lp.v)}" r="4.5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
    <line class="xh" x1="0" x2="0" y1="${T}" y2="${H-B}" stroke="var(--ink-3)" stroke-dasharray="3 3" visibility="hidden"/>
    <circle class="xd" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" fill="transparent" class="hit"/>
  </svg><div class="tip" hidden></div></div>`;
}
document.addEventListener("pointermove",e=>{
  const c=e.target.closest&&e.target.closest(".chart"); document.querySelectorAll(".chart .tip").forEach(t=>{ if(!c||!c.contains(t)){ t.hidden=true; const s=t.parentNode.querySelector("svg"); if(s){s.querySelector(".xh")?.setAttribute("visibility","hidden");s.querySelector(".xd")?.setAttribute("visibility","hidden");} } });
  if(!c||!CHARTS[c.id]) return;
  const {pts,unit}=CHARTS[c.id]; const svg=c.querySelector("svg"); const r=svg.getBoundingClientRect();
  const W=+c.dataset.w,L=+c.dataset.l,R=+c.dataset.r; const vx=(e.clientX-r.left)/r.width*W; if(vx<L||vx>W-R) return;
  const t0=pts[0].t,t1=pts[pts.length-1].t; const tt=t0+(vx-L)/(W-L-R)*(t1-t0);
  let best=pts[0]; for(const p of pts) if(Math.abs(p.t-tt)<Math.abs(best.t-tt)) best=p;
  const H=svg.viewBox.baseVal.height; const ymax=niceMax(Math.max(...pts.map(p=>p.v))*1.1);
  const px=L+(W-L-R)*((best.t-t0)/Math.max(1,t1-t0)), py=22+(H-46)*(1-best.v/ymax);
  const xh=svg.querySelector(".xh"),xd=svg.querySelector(".xd");
  xh.setAttribute("x1",px);xh.setAttribute("x2",px);xh.setAttribute("visibility","visible");xd.setAttribute("cx",px);xd.setAttribute("cy",py);xd.setAttribute("visibility","visible");
  const tip=c.querySelector(".tip"); tip.hidden=false; tip.style.left=(px/W*r.width)+"px"; tip.style.top=(py/H*r.height)+"px"; tip.textContent=`${fmtDT(best.t)} · ${n2(best.v)} ${unit}`;
});

// ---------- top bar & rail ----------
function renderTop(){
  const u=SESSION.user;
  $("#top").innerHTML=`<div class="brand"><div class="brand-mark" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M9 1 3 9h4l-1 6 6-8H8z" fill="var(--accent-ink)"/></svg></div>
    <div><div class="brand-name">Smart City Utilities</div></div><span class="pill">Prototype · synthetic data</span>${typeof Sync!=="undefined"?Sync.badge():""}</div>
    <div class="spacer"></div>
    <div class="clock"><span class="time" title="Simulated city clock (1 tick = 15 min)">City time ${fmtDT(now)}</span>
      <button class="btn small" data-act="sim-toggle">${SIM.running?"Pause clock":"Resume clock"}</button>
      <button class="btn small" data-act="ff" title="Advance one simulated hour">+1 hour</button>
      ${now<NOV1?`<button class="btn small" data-act="month-end" title="Run the meters to midnight on 1 November, then close October and send the bills">Jump to month end</button>`:""}</div>
    ${u?`<div class="row"><span class="ink2">${esc(u.display)}</span><button class="btn small" data-act="logout">Switch user</button></div>`:""}`;
}
function renderRail(){
  const el=$("#feed"); if(!el) return;
  el.innerHTML=LOG.slice(0,60).map(e=>`<div class="ev ${e.err?"err":e.db}"><div class="meta">${src(e.db)}<span>${fmtT(e.at)}</span>${e.count>1?`<span>×${e.count}</span>`:""}</div>
    <div class="t">${esc(e.title)}</div>${e.stmt?`<pre>${esc(e.stmt)}</pre>`:""}${e.err?`<div class="res-err">${esc(e.err)}</div>`:""}</div>`).join("")||`<p class="muted">Actions you take will appear here with the exact SQL or MongoDB statement behind them.</p>`;
}

// ---------- views ----------
const V={};

V.how=()=>`<div class="page-head"><span class="eyebrow">How it works</span><h1>One city, two databases, one bridge</h1>
  <p class="ink2">PostgreSQL is the bank: people, properties, tariffs, bills and payments, with rules it refuses to break. MongoDB is the sensor diary: every smart-meter reading and every repair note. The bridge turns a month of readings into one clean row per meter that PostgreSQL bills from.</p></div>
  <div class="flow">${[
   ["Smart meters","24 simulated meters (electricity, water, gas) send a reading every 15 city-minutes.","mg"],
   ["MongoDB","Readings land in a time-series collection; each meter type has its own fields.","mg"],
   ["Anomaly rules","Leak, spike and missing-data rules run on every batch and explain why they fired.","mg"],
   ["Bridge","Monthly usage = closing register − opening register, written to meter_reading.","pg"],
   ["PostgreSQL","Procedures apply tariff slabs, create invoices, record payments; RLS hides other people's rows.","pg"],
   ["Portals","Residents, staff and admins each see a different app built on both databases.","pg"]].map((s,i)=>`<div class="step"><span class="n">${i+1}</span><b>${s[0]}</b><span class="ink2" style="font-size:12.5px">${s[1]}</span>${src(s[2])}</div>`).join("")}</div>
  <div class="panel"><div class="panel-head"><h2>Demo script (about 8 minutes)</h2></div><ol class="stack" style="margin:0;padding-left:20px">
   <li><b>Asha (resident)</b>: dashboard shows her property from PostgreSQL next to live meter charts from MongoDB. Open "Bills" and her September bill: 100 × ₹5 + 200 × ₹8 + 150 × ₹12 = ₹3,900 for electricity.</li>
   <li>Still as Asha: press <b>Try to open Vikram's invoice</b>. Row-level security returns 0 rows.</li>
   <li>Pay the September bill with <b>Send the same request twice</b>: one payment row, invoice becomes PAID. Try a failed payment on another bill: the attempt is stored, the bill stays unpaid.</li>
   <li><b>Admin</b> → Disaster simulator → <b>Pipe burst</b> at Asha's home, then press +1 hour. A CRITICAL leak ticket appears with a reason; more readings bump its count instead of making duplicates.</li>
   <li><b>Ravi (staff, North District)</b>: take the ticket, try the illegal jump to CLOSED (trigger blocks it), add a note (MongoDB), resolve it. The leak stops.</li>
   <li><b>Admin</b> → Billing run: aggregate October from MongoDB, generate invoices, run it again to show nothing is duplicated.</li>
   <li><b>Admin</b> → Database rules and SQL lab: watch PostgreSQL reject bad data and run the recursive, correlated and window queries.</li></ol>
   <p class="muted" style="margin-top:10px">This prototype runs entirely in the browser: the two databases are simulated in memory with the same tables, collections and rules as the real design. The real build uses PostgreSQL 17, MongoDB 8 and Next.js.</p></div>`;

// ----- resident -----
function resProps(){ return visibleProperties(SESSION.user); }
V.home=()=>{
  const u=SESSION.user, props=resProps(); const pid=SESSION.sel.prop||props[0].property_id; SESSION.sel.prop=pid; const p=propById(pid);
  const ut=SESSION.sel.ut||"ELECTRICITY"; const m=metersOf(pid).find(x=>x.utility_type===ut);
  const pts=seriesFor(m.meter_code); const last=pts[pts.length-1];
  const due=rlsInvoices(u).filter(i=>i.property_id===pid&&i.payment_status!=="PAID");
  const nov=now>=NOV1, from=nov?NOV1:OCT1;
  const oct=metersOf(pid).map(mm=>{const c=cycleTotals(mm.meter_code,from,now);return {mm,units:c?c.closing-c.opening:0};});
  const est=oct.reduce((s,o)=>s+tieredCharge(o.mm.utility_type,o.units,nov?"2026-11-30":"2026-10-31").reduce((a,t)=>a+t.amount,0),0);
  const notif=MG.notifications.filter(n=>n.user_id===u.user_id&&!n.read_at).length;
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Welcome back, ${esc(u.display.split(" ")[0])}</h1></div>
  ${props.length>1?`<div class="tabs" role="group" aria-label="Property">${props.map(x=>`<button aria-pressed="${x.property_id===pid}" data-act="sel-prop" data-id="${x.property_id}">${esc(x.property_code)} · ${esc(x.address_line.split(",")[0])}</button>`).join("")}</div>`:""}
  <div class="grid2">
   <div class="panel"><div class="panel-head"><h2>${esc(p.address_line)}</h2>${src("pg")}</div>
     <div class="tablewrap"><table><tbody>
      <tr><th>Property</th><td class="mono">${esc(p.property_code)} · ${esc(p.property_type.toLowerCase())} · ${p.square_feet} sq ft</td></tr>
      <tr><th>Zone</th><td>${esc(zname(p.zone_id))}, ${esc(zname(districtOf(p.zone_id)))}</td></tr>
      <tr><th>Service</th><td>${badge(p.service_status)}</td></tr>
      <tr><th>Meters</th><td>${metersOf(pid).map(x=>`<span class="mono">${x.meter_code}</span>`).join(", ")}</td></tr>
     </tbody></table></div></div>
   <div class="kpis" style="align-content:start">
     <div class="kpi"><span class="l">Unpaid bills ${src("pg")}</span><span class="v">${due.length?inr(due.reduce((s,i)=>s+i.total_amount,0)):"₹0.00"}</span><span class="l">${due.length?`${due.length} bill${due.length>1?"s":""}, next due ${fmtD(PG.billing_cycle.find(c=>c.cycle_id===due[0].cycle_id).due_date)}`:"All paid"}</span></div>
     <div class="kpi"><span class="l">${nov?"November":"October"} so far ${src("mg")}</span><span class="v">${inr(est)}</span><span class="l">Estimated from live readings with current slabs</span></div>
     <div class="kpi"><span class="l">Unread alerts ${src("mg")}</span><span class="v">${notif}</span><span class="l">${notif?`<button class="btn small" data-act="go" data-view="alerts">Open alerts</button>`:"Nothing unusual"}</span></div>
   </div></div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>Live usage, last 24 hours</h2>${src("mg")}</div>
     <div class="tabs" role="group" aria-label="Utility">${Object.keys(UT).map(k=>`<button aria-pressed="${k===ut}" data-act="sel-ut" data-ut="${k}"><span class="dot" style="background:${UT[k].color}"></span>${UT[k].label}</button>`).join("")}</div></div>
   <p class="ink2" style="margin-bottom:8px">Right now: <b class="num">${last?n2(last.v):"–"} ${UT[ut].rate}</b> · meter <span class="mono">${m.meter_code}</span> · last reading ${last?fmtT(last.t):"–"}${SIM.offline.has(m.meter_code)?` · ${badge("OVERDUE","offline")}`:""}${isOff(m.meter_code)?` · ${badge("CLOSED","switched off")}`:""} · ${supplyBtn(m.meter_code,true)}</p>
   ${chart("c-home",pts,{color:UT[ut].color,unit:UT[ut].rate})}
   <p class="muted" style="font-size:12px;margin-top:6px">Query: <code>db.meter_readings.find({ "meta.meter_code": "${m.meter_code}", ts: { $gte: now − 24h } }).sort({ ts: 1 })</code>, served by the index on (meta.meter_code, ts).</p></div>`;
};
V.home.live=true;

V.bills=()=>{
  const u=SESSION.user; const invs=rlsInvoices(u).slice().sort((a,b)=>b.cycle_id-a.cycle_id||a.invoice_no.localeCompare(b.invoice_no));
  const sel=SESSION.sel.inv&&invs.find(i=>i.invoice_id===SESSION.sel.inv)||invs.find(i=>i.payment_status!=="PAID")||invs[0];
  SESSION.sel.inv=sel.invoice_id;
  const lines=PG.invoice_line_item.filter(l=>l.invoice_id===sel.invoice_id).sort((a,b)=>a.utility_type.localeCompare(b.utility_type)||a.tier_level-b.tier_level);
  const pays=PG.payment.filter(x=>x.invoice_id===sel.invoice_id);
  const c=PG.billing_cycle.find(x=>x.cycle_id===sel.cycle_id); const p=propById(sel.property_id);
  const vik=resBy("vikram"); const other=u.resident_id===vik.resident_id?PG.invoice.find(i=>propById(i.property_id).resident_id===resBy("asha").resident_id&&i.cycle_id===3):PG.invoice.find(i=>propById(i.property_id).resident_id===vik.resident_id&&i.cycle_id===3); const otherName=u.resident_id===vik.resident_id?"Asha":"Vikram";
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Bills &amp; payments</h1></div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><h2>Your invoices</h2>${src("pg")}</div><div class="tablewrap"><table>
     <thead><tr><th>Invoice</th><th>Cycle</th><th>Property</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>
     ${invs.map(i=>`<tr class="click" data-act="sel-inv" data-id="${i.invoice_id}" tabindex="0" style="${i===sel?"outline:2px solid var(--accent);outline-offset:-2px;":""}${i.cycle_id===4?"box-shadow:inset 4px 0 0 var(--accent);font-weight:600":""}" ${i.cycle_id===4?'title="New bill"':""}><td class="mono">${i.invoice_no}</td><td>${cycleName(i.cycle_id)}</td><td class="mono">${propById(i.property_id).property_code}</td><td class="r">${inr(i.total_amount)}</td><td>${badge(i.payment_status)}</td></tr>`).join("")}
     </tbody></table></div>
     <div class="stack" style="margin-top:12px"><p class="ink2">Row-level security means this list is filtered by PostgreSQL itself, not just by the app.</p>
     <div class="row"><button class="btn" data-act="rls-try" data-id="${other?other.invoice_id:""}">Try to open ${otherName}'s invoice</button></div><div id="rls-out"></div></div></div>
   <div class="panel"><div class="panel-head"><div><span class="eyebrow">${esc(cycleName(sel.cycle_id))} · ${esc(p.property_code)}</span><h2 class="mono">${sel.invoice_no}</h2></div>${badge(sel.payment_status)}</div>
     <div class="tablewrap"><table><thead><tr><th>Utility</th><th>Slab</th><th class="r">Units</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>
     ${lines.map(l=>{const r=PG.utility_rate.find(x=>x.rate_id===l.rate_id);return `<tr><td><span class="dot" style="background:${UT[l.utility_type].color}"></span>${UT[l.utility_type].label}</td><td>Tier ${l.tier_level}: ${n1(r.min_units)}–${r.max_units==null?"∞":n1(r.max_units)} ${UT[l.utility_type].unit}</td><td class="r">${n2(l.units_consumed)}</td><td class="r">₹${n2(l.rate_applied)}</td><td class="r">${inr(l.line_total)}</td></tr>`;}).join("")}
     <tr><td colspan="4"><b>Total</b> <span class="muted">(kept equal to the lines by trigger trg_invoice_total)</span></td><td class="r"><b>${inr(sel.total_amount)}</b></td></tr></tbody></table></div>
     <p class="ink2" style="margin:8px 0">Due ${fmtD(c.due_date)}. Rates are copied onto each line so the bill never changes if the tariff does.</p>
     ${sel.payment_status!=="PAID"?`<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><h3>Pay this bill <span class="pill">Simulated gateway, no real money</span></h3>
       <div class="row"><label class="f">Method<select class="in" id="pay-method"><option value="UPI_SIM">UPI (simulated)</option><option value="CARD_SIM">Card (simulated)</option><option value="NETBANK_SIM">Net banking (simulated)</option></select></label>
       <label class="f">Gateway outcome<select class="in" id="pay-outcome"><option value="OK">Approve</option><option value="FAIL">Decline</option></select></label></div>
       <div class="row"><button class="btn primary" data-act="pay" data-id="${sel.invoice_id}">Pay ${inr(sel.total_amount)}</button><button class="btn" data-act="pay-twice" data-id="${sel.invoice_id}">Send the same request twice</button></div></div>`:""}
     ${pays.length?`<h3 style="margin-top:12px">Payment attempts</h3><div class="tablewrap"><table><thead><tr><th>When</th><th>Method</th><th>Status</th><th>Reference</th></tr></thead><tbody>${pays.map(x=>`<tr><td>${fmtDT(x.payment_date)}</td><td>${x.payment_method}</td><td>${badge(x.status)}</td><td class="mono">${esc(x.transaction_id||x.failure_reason)}</td></tr>`).join("")}</tbody></table></div>`:""}
   </div></div>`;
};
function spRecordPayment(invoiceId,method,key,outcome){
  const u=SESSION.user; const inv=rlsInvoices(u).find(i=>i.invoice_id===invoiceId);
  const stmt=`${sqlCtx(u)}CALL sp_record_payment('${inv.invoice_no}', ${n2(inv.total_amount/100)}, '${method}', '${key}', '${outcome}');\nCOMMIT;`;
  const prev=PG.payment.find(x=>x.idempotency_key===key);
  if(prev){ log("pg","Same request received again: original result returned, nothing new written",stmt+`\n-- idempotency_key '${key}' already exists → returns payment ${prev.payment_id.slice(0,8)}…`); return prev; }
  try{
    if(inv.payment_status==="PAID") throw new PgError(`ERROR:  ALREADY_PAID: invoice ${inv.invoice_no} is already paid`);
    const pay=insert("payment",{payment_id:uid(),invoice_id:inv.invoice_id,idempotency_key:key,amount_paid:inv.total_amount,payment_method:method,status:"INITIATED",transaction_id:null,failure_reason:null,payment_date:now});
    if(outcome==="FAIL"){ update("payment",pay,{status:"FAILED",failure_reason:"Declined by simulated gateway"}); log("pg",`Payment declined: attempt stored as FAILED, ${inv.invoice_no} stays ${inv.payment_status}`,stmt+`\n-- SAVEPOINT before_settle; gateway declined → ROLLBACK TO SAVEPOINT; attempt kept as FAILED`); return pay; }
    update("payment",pay,{status:"SUCCEEDED",transaction_id:`SIMTXN-${++txSeq}`});
    log("pg",`Payment succeeded: ${inv.invoice_no} is now PAID (trigger trg_payment_settles_invoice)`,stmt);
    return pay;
  }catch(e){ log("pg","Payment rejected",stmt,{err:e.message}); toast(e.message.split("\n")[0].replace("ERROR:  ","")); return null; }
}

V.tickets=()=>{
  const u=SESSION.user; const ts=rlsTickets(u).slice().sort((a,b)=>b.reported_timestamp-a.reported_timestamp);
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Complaints</h1></div>
  <div class="grid2"><div class="panel"><div class="panel-head"><h2>Report a problem</h2>${src("pg")}</div>
   <form class="stack" id="complaint"><label class="f">Property<select class="in" id="c-prop">${resProps().map(p=>`<option value="${p.property_id}">${p.property_code} · ${esc(p.address_line)}</option>`).join("")}</select></label>
   <label class="f">Issue<select class="in" id="c-type"><option value="LOW_PRESSURE">Low water pressure</option><option value="POWER_OUTAGE">Power outage</option><option value="METER_MALFUNCTION">Meter not working</option><option value="BILLING">Billing question</option><option value="OTHER">Something else</option></select></label>
   <label class="f">What's happening?<textarea class="in" id="c-desc">Water pressure on the first floor has been very low since yesterday evening.</textarea></label>
   <div><button class="btn primary" type="submit">Submit complaint</button></div></form></div>
  <div class="panel"><div class="panel-head"><h2>Your tickets</h2>${src("pg")}</div>
   ${ts.length?`<div class="tablewrap"><table><thead><tr><th>Ticket</th><th>Issue</th><th>Severity</th><th>Status</th><th>Raised by</th></tr></thead><tbody>${ts.map(t=>`<tr><td class="mono">${t.ticket_no}</td><td>${t.issue_type.replace("_"," ").toLowerCase()}</td><td>${sev(t.severity)}</td><td>${badge(t.status)}</td><td>${t.source==="ANOMALY"?"Automatic":"You"}</td></tr>`).join("")}</tbody></table></div>`:`<p class="muted">No tickets yet. Complaints you submit and automatic leak or outage tickets for your properties appear here.</p>`}</div></div>`;
};
V.alerts=()=>{
  const u=SESSION.user; const ns=MG.notifications.filter(n=>n.user_id===u.user_id).sort((a,b)=>b.created_at-a.created_at);
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Alerts</h1><p class="ink2">Stored in MongoDB's <code>notifications</code> collection. Marking read is an update; dismissing is a delete.</p></div>
  <div class="panel">${ns.length?ns.map(n=>`<div style="padding:10px 0;border-bottom:1px solid var(--line)" class="stack"><div class="row"><b>${esc(n.title)}</b>${n.read_at?badge("CLOSED","read"):badge("OPEN","new")}<span class="muted">${fmtDT(n.created_at)}</span></div><p class="ink2">${esc(n.body)}</p>
    <div class="row">${n.read_at?"":`<button class="btn small" data-act="n-read" data-id="${n._id}">Mark as read</button>`}<button class="btn small danger" data-act="n-del" data-id="${n._id}">Dismiss</button></div></div>`).join(""):`<p class="muted">No alerts. If the city detects a leak, a spike or an outage at your property, you'll see it here.</p>`}</div>`;
};
V.alerts.live=true;

// ----- staff -----
function ticketDetail(t,canAct){
  const p=propById(t.property_id); const lg=MG.maintenance_logs.find(l=>l.ticket_no===t.ticket_no);
  const hist=PG.ticket_status_history.filter(h=>h.ticket_id===t.ticket_id);
  const u=SESSION.user; const nexts=TRANSITIONS[t.status];
  return `<div class="panel"><div class="panel-head"><div><span class="eyebrow">${esc(p.property_code)} · ${esc(p.address_line)} · ${esc(zname(p.zone_id))}</span><h2 class="mono">${t.ticket_no}</h2></div><div class="row">${sev(t.severity)}${badge(t.status)}</div></div>
   <p style="margin-bottom:8px">${esc(t.description)}</p>
   <p class="muted" style="margin-bottom:10px">Source ${t.source.toLowerCase()} · opened ${fmtDT(t.reported_timestamp)} · seen ${t.occurrence_count}× · last ${fmtT(t.last_seen_at)}${t.assigned_to?` · assigned to ${esc(userById(t.assigned_to).display)}`:""}</p>
   ${canAct?`<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><div class="row"><h3>Update status</h3>${src("pg")}</div>
     <div class="row">${t.status==="OPEN"?`<button class="btn primary" data-act="t-take" data-id="${t.ticket_id}">Take this ticket</button>`:""}
     ${nexts.filter(s=>s!=="ASSIGNED").map(s=>`<button class="btn ${s==="RESOLVED"?"primary":""}" data-act="t-move" data-to="${s}" data-id="${t.ticket_id}">Move to ${s.replace("_"," ").toLowerCase()}</button>`).join("")}
     ${t.status!=="CLOSED"&&!nexts.includes("CLOSED")?`<button class="btn danger" data-act="t-move" data-to="CLOSED" data-id="${t.ticket_id}" title="Shows the trigger rejecting an illegal transition">Try to close directly</button>`:""}</div>
     ${nexts.includes("RESOLVED")?`<label class="f">Resolution notes (required to resolve)<input class="in" id="t-res" value="Replaced burst joint on main inlet; flow back to normal."></label>`:""}
     <div id="t-err"></div></div>`:""}
   <div class="grid2" style="margin-top:12px"><div><div class="row" style="margin-bottom:6px"><h3>Status history</h3>${src("pg")}</div>
     <div class="tablewrap"><table><tbody>${hist.map(h=>`<tr><td>${fmtDT(h.changed_at)}</td><td>${h.from_status?esc(h.from_status)+" → ":""}<b>${esc(h.to_status)}</b></td><td class="muted">${h.changed_by?esc(userById(h.changed_by).display):"system"}</td></tr>`).join("")}</tbody></table></div>
     <p class="muted" style="font-size:12px;margin-top:4px">Written by trigger trg_ticket_history.</p></div>
    <div><div class="row" style="margin-bottom:6px"><h3>Field notes</h3>${src("mg")}</div>
     <div class="stack">${(lg?lg.entries:[]).map((e,i)=>`<div style="border-left:2px solid var(--line);padding-left:8px"><div class="muted" style="font-size:12px">${fmtDT(e.at)} · ${esc(e.by)} · ${esc(e.kind)}</div><div>${esc(e.text)}</div>${e.data?`<pre class="json">${esc(JSON.stringify(e.data))}</pre>`:""}${canAct&&e.kind==="NOTE"&&e.by===u.display?`<button class="btn small danger" data-act="note-del" data-tk="${t.ticket_no}" data-i="${i}">Delete note</button>`:""}</div>`).join("")}
     ${canAct?`<form class="stack" id="note-form" data-tk="${t.ticket_no}"><textarea class="in" id="note-text">Crew on site. Main valve isolated; water supply to 12 Lake View Road paused for repair.</textarea><div><button class="btn" type="submit">Add note</button></div></form>`:""}</div></div></div></div>`;
}
V.queue=()=>{
  const u=SESSION.user; const ts=rlsTickets(u).slice().sort((a,b)=>ACTIVE.includes(b.status)-ACTIVE.includes(a.status)||b.reported_timestamp-a.reported_timestamp);
  const sel=ts.find(t=>t.ticket_id===SESSION.sel.tk)||ts[0];
  return `<div class="page-head"><span class="eyebrow">Maintenance console · ${esc(zname(u.staff_zone_id))}</span><h1>Ticket queue</h1>
   <p class="ink2">Row-level security shows staff only tickets for properties in their district. Kavya (South District) sees a different list.</p></div>
  <div class="panel"><div class="panel-head"><h2>Tickets in ${esc(zname(u.staff_zone_id))}</h2>${src("pg")}</div>
   ${ts.length?`<div class="tablewrap"><table><thead><tr><th>Ticket</th><th>Property</th><th>Issue</th><th>Severity</th><th>Status</th><th class="r">Seen</th><th>Assigned</th></tr></thead><tbody>
   ${ts.map(t=>`<tr class="click" data-act="sel-tk" data-id="${t.ticket_id}" tabindex="0"><td class="mono">${t.ticket_no}</td><td class="mono">${propById(t.property_id).property_code}</td><td>${t.issue_type.replace("_"," ").toLowerCase()}</td><td>${sev(t.severity)}</td><td>${badge(t.status)}</td><td class="r">${t.occurrence_count}×</td><td>${t.assigned_to?esc(userById(t.assigned_to).display):"–"}</td></tr>`).join("")}</tbody></table></div>`
   :`<p class="muted">No tickets in your district yet. Ask the admin to run the pipe-burst scenario at Asha's home (Ward N-1), or a resident to submit a complaint.</p>`}</div>
  ${sel?ticketDetail(sel,true):""}`;
};
V.queue.live=false;

// ----- admin -----
V.ops=()=>{
  const cut=SESSION.sel.cut||"WATER";
  const city={E:citySeries("ELECTRICITY"),W:citySeries("WATER"),G:citySeries("GAS")};
  const lastV=a=>a.length?a[a.length-1].v:0;
  const outstanding=PG.invoice.filter(i=>i.payment_status!=="PAID").reduce((s,i)=>s+i.total_amount,0);
  const overdue=PG.invoice.filter(i=>i.payment_status==="OVERDUE").reduce((s,i)=>s+i.total_amount,0);
  const active=PG.maintenance_ticket.filter(t=>ACTIVE.includes(t.status));
  const events=MG.anomaly_events.slice().sort((a,b)=>b.last_seen-a.last_seen).slice(0,6);
  const zoneRows=PG.zone.filter(z=>z.zone_level==="WARD").map(z=>{
    const props=PG.property.filter(p=>p.zone_id===z.zone_id); const codes=new Set(props.map(p=>p.property_code));
    const kw=PG.utility_meter.filter(m=>m.utility_type==="ELECTRICITY"&&codes.has(propById(m.property_id).property_code)).reduce((s,m)=>{const a=byMeter.get(m.meter_code);const d=a[a.length-1];return s+(d&&now-d.ts<TICK*2?d._rate:0);},0);
    const flow=PG.utility_meter.filter(m=>m.utility_type==="WATER"&&codes.has(propById(m.property_id).property_code)).reduce((s,m)=>{const a=byMeter.get(m.meter_code);const d=a[a.length-1];return s+(d&&now-d.ts<TICK*2?d.flow_lpm:0);},0);
    const tk=active.filter(t=>codes.has(propById(t.property_id).property_code));
    const owed=PG.invoice.filter(i=>codes.has(propById(i.property_id).property_code)&&i.payment_status!=="PAID").reduce((s,i)=>s+i.total_amount,0);
    const off=PG.utility_meter.filter(m=>codes.has(propById(m.property_id).property_code)&&SIM.offline.has(m.meter_code)).length;
    return {z,kw,flow,tk,owed,off};
  });
  const health=PG.utility_meter.map(m=>{const a=byMeter.get(m.meter_code);const d=a[a.length-1];return {m,d,age:now-d.ts};}).sort((a,b)=>b.age-a.age).slice(0,6);
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>City operations</h1></div>
  <div class="kpis">
   <div class="kpi"><span class="l">Electricity demand now ${src("mg")}</span><span class="v">${n1(lastV(city.E))} kW</span><span class="l">8 properties, 15-min average</span></div>
   <div class="kpi"><span class="l">Water flow now ${src("mg")}</span><span class="v">${n1(lastV(city.W))} L/min</span><span class="l">${lastV(city.W)>8?`<span class="status s-crit">Above normal</span>`:"Within normal range"}</span></div>
   <div class="kpi"><span class="l">Active tickets ${src("pg")}</span><span class="v">${active.length}</span><span class="l">${active.filter(t=>t.severity==="CRITICAL").length} critical</span></div>
   <div class="kpi"><span class="l">Outstanding bills ${src("pg")}</span><span class="v">${inr(outstanding)}</span><span class="l">${inr(overdue)} overdue</span></div>
  </div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>City demand, last 24 hours</h2>${src("mg")}</div>
    <div class="tabs" role="group" aria-label="Utility">${Object.keys(UT).map(k=>`<button aria-pressed="${k===cut}" data-act="sel-cut" data-ut="${k}"><span class="dot" style="background:${UT[k].color}"></span>${UT[k].label}</button>`).join("")}</div></div>
    ${chart("c-city",citySeries(cut),{color:UT[cut].color,unit:UT[cut].rate,height:190})}
    <p class="muted" style="font-size:12px;margin-top:6px">Pipeline: <code>$match ts ≥ now − 24h → $group by ts, sum of rate</code> across all ${cut.toLowerCase()} meters. Gaps from offline meters pull the total down.</p></div>
  <div class="panel"><div class="panel-head"><h2>Wards</h2><div class="row">${src("mg")}${src("pg")}</div></div><div class="tablewrap"><table>
   <thead><tr><th>Ward</th><th>District</th><th class="r">Power now</th><th class="r">Water now</th><th class="r">Active tickets</th><th class="r">Unpaid bills</th><th>Meters</th></tr></thead><tbody>
   ${zoneRows.map(r=>`<tr><td><b>${esc(r.z.name)}</b></td><td>${esc(zname(r.z.parent_zone_id))}</td><td class="r">${n1(r.kw)} kW</td><td class="r">${n1(r.flow)} L/min</td><td class="r">${r.tk.length?`<span class="status ${r.tk.some(t=>t.severity==="CRITICAL")?"s-crit":"s-warn"}">${r.tk.length}</span>`:"0"}</td><td class="r">${inr(r.owed)}</td><td>${r.off?`<span class="status s-crit">${r.off} offline</span>`:`<span class="status s-ok">all online</span>`}</td></tr>`).join("")}
   </tbody></table></div><p class="muted" style="font-size:12px;margin-top:6px">Live demand from the latest MongoDB reading per meter; tickets and bills from PostgreSQL. The API merges both into one response.</p></div>
  <div class="grid2"><div class="panel"><div class="panel-head"><h2>Anomaly feed</h2>${src("mg")}</div>
   ${events.length?events.map(e=>`<div class="stack" style="padding:8px 0;border-bottom:1px solid var(--line);gap:4px"><div class="row">${sev(e.severity)}<b>${esc(e.type.replace("_"," "))}</b><span class="mono">${esc(e.meter_code)}</span>${badge(e.status==="OPEN"?"OPEN":e.status==="ACK"?"ACK":"RESOLVED",e.status.toLowerCase())}<span class="muted">${e.hits}× · ${fmtT(e.last_seen)}</span></div>
     <p class="ink2" style="font-size:13px">${esc(e.reason)}</p><div class="row"><span class="muted" style="font-size:12px">Ticket ${esc(e.ticket_no||"pending")} · synced_to_sql: ${e.synced_to_sql}</span>${e.status==="OPEN"?`<button class="btn small" data-act="ack" data-id="${e._id}">Acknowledge</button>`:""}</div></div>`).join("")
   :`<p class="muted">No anomalies. Use the Disaster simulator to inject a pipe burst, a power spike or an outage.</p>`}</div>
  <div class="panel"><div class="panel-head"><h2>Meter health</h2>${src("mg")}</div><div class="tablewrap"><table><thead><tr><th>Meter</th><th>Property</th><th>Last seen</th><th>State</th></tr></thead><tbody>
   ${health.map(h=>`<tr><td class="mono">${h.m.meter_code}</td><td class="mono">${propById(h.m.property_id).property_code}</td><td>${fmtT(h.d.ts)}</td><td>${h.age>=TICK*2?`<span class="status s-crit">offline ${Math.round(h.age/60e3)} min</span>`:`<span class="status s-ok">online</span>`}</td></tr>`).join("")}</tbody></table></div>
   <p class="muted" style="font-size:12px;margin-top:6px">Pipeline: <code>$sort ts → $group by meta.meter_code, last: $last ts</code>, oldest first.</p></div></div>`;
};
V.ops.live=true;

V.scen=()=>{
  const sc=[
    {id:"burst",title:"Pipe burst",where:"P-0001 · 12 Lake View Road · Ward N-1",what:"Water flow jumps to about 14 L/min and pressure drops. After 1 city-hour the leak rule fires and opens a CRITICAL ticket for North District staff.",meter:"MTR-W-0001",mode:"BURST"},
    {id:"spike",title:"Electricity spike",where:"P-0004 · Desai Bakery · Ward S-1",what:"Demand jumps to about 9–10 kW, over 3× the bakery's baseline. The spike rule opens a HIGH ticket for South District staff.",meter:"MTR-E-0004",mode:"SPIKE"},
    {id:"outage",title:"Local outage",where:"Ward S-2 · P-0006 and P-0007",what:"Six meters stop reporting. After 45 city-minutes the missing-data rule opens one ticket per property; the ward shows its meters offline.",ward:7}];
  const on=s=>s.ward?PG.property.filter(p=>p.zone_id===s.ward).some(p=>metersOf(p.property_id).some(m=>SIM.offline.has(m.meter_code))):SIM.mode[s.meter]===s.mode;
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Disaster simulator</h1>
   <p class="ink2">Each scenario changes what the simulated meters send to MongoDB. Detection, tickets and alerts then happen on their own, the same way they would with real meters. Press <b>+1 hour</b> in the top bar to skip ahead.</p></div>
  <div class="grid3">${sc.map(s=>`<div class="panel stack"><div class="row" style="justify-content:space-between"><h2>${s.title}</h2>${on(s)?`<span class="status s-crit">running</span>`:`<span class="status s-mute">idle</span>`}</div>
    <p class="mono" style="font-size:12px">${s.where}</p><p class="ink2">${s.what}</p>
    <div class="row">${on(s)?`<button class="btn" data-act="scen-stop" data-id="${s.id}">Restore normal</button>`:`<button class="btn primary" data-act="scen-start" data-id="${s.id}">Start ${s.title.toLowerCase()}</button>`}</div></div>`).join("")}</div>
  <div class="panel"><div class="panel-head"><h2>Switch a home's supply on or off</h2>${src("mg")}</div>
   <p class="ink2" style="margin-bottom:8px">For a home that is empty or disconnected. The meter keeps reporting every 15 city-minutes, but its usage reads 0, so the bill only counts what was used while it was on. The city clock keeps running. This is different from an outage, where meters stop reporting.</p>
   <div class="tablewrap"><table><thead><tr><th>Property</th><th>Zone</th>${Object.keys(UT).map(k=>`<th>${UT[k].label}</th>`).join("")}</tr></thead><tbody>
   ${PG.property.map(p=>`<tr><td><span class="mono">${esc(p.property_code)}</span> ${esc(p.address_line.split(",")[0])}</td><td>${esc(zname(p.zone_id))}</td>${Object.keys(UT).map(k=>{const mm=metersOf(p.property_id).find(x=>x.utility_type===k);return `<td>${isOff(mm.meter_code)?badge("CLOSED","off"):badge("PAID","on")} ${supplyBtn(mm.meter_code,true)}</td>`;}).join("")}</tr>`).join("")}</tbody></table></div></div>
  <div class="panel"><div class="panel-head"><h2>Detection rules</h2><span class="muted">Thresholds are configuration, shown so the reason for every ticket can be explained</span></div><div class="tablewrap"><table>
   <thead><tr><th>Rule</th><th>Fires when</th><th>Severity</th><th>Duplicate handling</th></tr></thead><tbody>
   <tr><td><b>Leak</b></td><td>Water flow above ${RULES.LEAK.min_flow} L/min for ${RULES.LEAK.window_ticks} readings in a row (${RULES.LEAK.window_ticks*TICK_MIN} min)</td><td>${sev("CRITICAL")}</td><td rowspan="3">One active ticket per <code>anomaly_key</code> (e.g. LEAK:MTR-W-0001), enforced by a partial unique index; repeats raise <code>occurrence_count</code></td></tr>
   <tr><td><b>Spike</b></td><td>Electricity above ${RULES.SPIKE.factor}× its 24-hour average and above ${RULES.SPIKE.min_kw} kW</td><td>${sev("HIGH")}</td></tr>
   <tr><td><b>Missing data</b></td><td>No reading from a property&#39;s meters for ${RULES.MISSING.ticks*TICK_MIN}+ min (one ticket per property)</td><td>${sev("MEDIUM")}</td></tr>
   </tbody></table></div></div>`;
};
const isOff=code=>SIM.mode[code]==="OFF";
function setSupply(code,on){
  const m=meterByCode(code), p=propById(m.property_id), label=UT[m.utility_type].label.toLowerCase();
  if(on) delete SIM.mode[code]; else SIM.mode[code]="OFF";
  log("mg",`${p.property_code} ${label} ${on?"switched back on":"switched off (usage 0, meter still reporting)"}`,`// simulator config\nsim.mode["${code}"] = ${on?"null":'"OFF"'}\n// readings keep arriving every 15 min with ${m.utility_type==="ELECTRICITY"?"current: 0":m.utility_type==="WATER"?"flow_lpm: 0":"flow 0 m³/h"}`);
  render();
}
const supplyBtn=(code,small)=>`<button class="btn${small?" small":""}" data-act="supply" data-code="${code}" data-on="${isOff(code)}" aria-pressed="${!isOff(code)}">${isOff(code)?"Turn on":"Turn off"}</button>`;
function scenario(id,start){
  const set=(code,mode)=>{ if(mode) SIM.mode[code]=mode; else delete SIM.mode[code]; };
  if(id==="burst"){ set("MTR-W-0001",start?"BURST":null); log("mg",start?"Scenario started: pipe burst at P-0001":"Scenario ended: P-0001 water back to normal",`// simulator config\nsim.mode["MTR-W-0001"] = ${start?'"BURST"':"null"}`); }
  if(id==="spike"){ set("MTR-E-0004",start?"SPIKE":null); log("mg",start?"Scenario started: electricity spike at P-0004":"Scenario ended: P-0004 back to normal",`sim.mode["MTR-E-0004"] = ${start?'"SPIKE"':"null"}`); }
  if(id==="outage"){ PG.property.filter(p=>p.zone_id===7).forEach(p=>metersOf(p.property_id).forEach(m=>start?SIM.offline.add(m.meter_code):SIM.offline.delete(m.meter_code))); log("mg",start?"Scenario started: Ward S-2 meters stop reporting":"Scenario ended: Ward S-2 meters online",`sim.offline = ${start?'["MTR-*-0006","MTR-*-0007"]':"[]"}`); }
  render();
}

V.billing=()=>{
  const runs=PG.aggregation_run.filter(r=>r.cycle_id===4);
  const readings=PG.meter_reading.filter(r=>r.cycle_id===4);
  const invs=PG.invoice.filter(i=>i.cycle_id===4);
  const lastRes=SESSION.sel.billRes;
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Billing run: October 2026 ${badge(now>=NOV1?"CLOSED":"PENDING",now>=NOV1?"closed":"open")}</h1>
   <p class="ink2">Two steps. First the bridge reads each meter's opening and closing register from MongoDB and writes one row per meter to PostgreSQL. Then a stored procedure turns those rows into invoices using the tariff slabs. ${now>=NOV1?"October closed at midnight on 1 November and the nightly job billed it; run either step again to show nothing is duplicated.":"You can run both steps now (the cycle then closes at the current city time), or press <b>Jump to month end</b> to let the meters run to 1 November and have the nightly job do it."}</p>
   ${now<NOV1?`<div class="row"><button class="btn primary" data-act="month-end">Jump to month end</button><span class="muted">Fast-forwards ${Math.round((NOV1-now)/HOUR)} simulated hours of meter readings, then closes October</span></div>`:""}</div>
  <div class="grid2"><div class="panel stack"><div class="row" style="justify-content:space-between"><h2>1 · Aggregate usage</h2><div class="row">${src("mg")}→${src("pg")}</div></div>
    <pre class="code">${esc(PIPE_CYCLE)}</pre>
    <div class="row"><button class="btn primary" data-act="agg">Run aggregation</button><span class="muted">${runs.length} run${runs.length===1?"":"s"} · ${readings.length}/24 meter readings</span></div></div>
   <div class="panel stack"><div class="row" style="justify-content:space-between"><h2>2 · Generate invoices</h2>${src("pg")}</div>
    <pre class="code">-- for each property, one transaction:
CALL sp_generate_invoice(property_id, 4);
--  1. pg_advisory_xact_lock(hash(property, cycle))
--  2. if an invoice exists → return it (no duplicate)
--  3. every meter needs a meter_reading, else ROLLBACK
--  4. fn_tiered_charge() per utility → line items
--  5. trigger keeps invoice.total_amount = SUM(lines)</pre>
    <div class="row"><button class="btn primary" data-act="gen">Generate invoices</button><span class="muted">${invs.length}/8 invoices for October</span></div></div></div>
  ${lastRes?`<div class="panel">${lastRes}</div>`:""}
  ${readings.length?`<div class="panel"><div class="panel-head"><h2>meter_reading, October</h2>${src("pg")}</div><div class="tablewrap"><table><thead><tr><th>Meter</th><th>Property</th><th class="r">Opening</th><th class="r">Closing</th><th class="r">Units</th><th class="r">Docs</th><th>Invoice</th></tr></thead><tbody>
   ${readings.map(r=>{const m=PG.utility_meter.find(x=>x.meter_id===r.meter_id);const p=propById(m.property_id);const i=invs.find(x=>x.property_id===p.property_id);return `<tr><td class="mono">${m.meter_code}</td><td class="mono">${p.property_code}</td><td class="r">${n2(r.opening_register)}</td><td class="r">${n2(r.closing_register)}</td><td class="r"><b>${n2(r.total_units_consumed)}</b> ${UT[m.utility_type].unit}</td><td class="r">${r.source_doc_count}</td><td>${i?`<span class="mono">${i.invoice_no}</span> ${inr(i.total_amount)}`:"–"}</td></tr>`;}).join("")}</tbody></table></div>
   <p class="muted" style="font-size:12px;margin-top:6px">Units = closing − opening of the cumulative register, so a duplicated or late reading cannot change the bill. A pipe burst shows up here as extra water.</p></div>`:""}`;
};
function aggregateOctober(){
  const to=Math.min(now,NOV1); // the cycle never takes readings from after midnight on 1 November
  const run={run_id:uid(),cycle_id:4,started_at:now,finished_at:null,status:"RUNNING",meters_total:24,meters_written:0,error:null};
  PG.aggregation_run.push(run);
  let written=0,locked=0,errs=[];
  for(const m of PG.utility_meter){
    const c=cycleTotals(m.meter_code,OCT1,to); if(!c) continue;
    const ex=PG.meter_reading.find(r=>r.meter_id===m.meter_id&&r.cycle_id===4);
    try{
      if(ex){ update("meter_reading",ex,{closing_register:Math.round(c.closing*1000)/1000,source_doc_count:c.count,run_id:run.run_id,reading_timestamp:now}); }
      else insert("meter_reading",{reading_id:uid(),meter_id:m.meter_id,cycle_id:4,run_id:run.run_id,opening_register:Math.round(c.opening*1000)/1000,closing_register:Math.round(c.closing*1000)/1000,source_doc_count:c.count,is_estimated:false,reading_timestamp:now});
      written++;
    }catch(e){ locked++; errs.push(e.message); }
  }
  run.status="SUCCEEDED"; run.finished_at=now; run.meters_written=written;
  log("mg","Aggregated October usage for 24 meters",PIPE_CYCLE.replace("<now>",`ISODate("${new Date(to).toISOString()}")`));
  log("pg",`Bridge wrote ${written} meter readings${locked?`, ${locked} locked because already invoiced`:""}`,`INSERT INTO meter_reading (meter_id, cycle_id, run_id, opening_register, closing_register, source_doc_count)\nVALUES ($1, 4, '${run.run_id.slice(0,8)}…', $2, $3, $4)\nON CONFLICT (meter_id, cycle_id) DO UPDATE\n  SET closing_register = EXCLUDED.closing_register, run_id = EXCLUDED.run_id;\n-- trigger trg_reading_locked blocks the update once a cycle is invoiced`,{err:locked?errs[0]:null});
  return {written,locked,errs};
}
function runAggregation(){
  const {written,locked,errs}=aggregateOctober();
  SESSION.sel.billRes=`<div class="${locked?"errbox":"okbox"}">${locked?esc(`${written} readings written, ${locked} rejected.\n${errs[0]}`):`Aggregation run finished: ${written} meter readings written or refreshed. Running it again only refreshes the same rows (UNIQUE (meter_id, cycle_id)).`}</div>`;
  render();
}
function invoiceOctober(){
  let created=[],existed=0,errs=[];
  for(const p of PG.property){
    try{ const r=spGenerateInvoice(p.property_id,4); r.created?created.push(r.created):existed++; }catch(e){ errs.push(e.message); }
  }
  log("pg",`sp_generate_invoice: ${created.length} created, ${existed} already existed${errs.length?`, ${errs.length} rolled back`:""}`,`CALL sp_generate_invoice(property_id, 4);  -- × 8 properties`,{err:errs[0]||null});
  return {created,existed,errs};
}
function generateInvoices(){
  const {created,existed,errs}=invoiceOctober();
  SESSION.sel.billRes=errs.length?`<div class="errbox">${esc(errs[0])}\n\nRun the aggregation first so every meter has an October reading.</div>`:`<div class="okbox">${created.length} invoices created, ${existed} already existed and were returned unchanged.${existed&&!created.length?" Nothing was duplicated: UNIQUE (property_id, cycle_id) plus the procedure's existence check.":""}</div>`;
  render();
}
// "Jump to month end": meters run to midnight on 1 November, then the nightly billing job closes October
function monthEnd(){
  if(now>=NOV1) return;
  fastForwardTo(NOV1);
  closeOctober();
}
const octoberOpen=()=>PG.billing_cycle.find(c=>c.cycle_id===4).status!=="CLOSED";
// nightly billing job; also runs on its own when the clock passes midnight on 1 November (+1 hour or the live clock)
function closeOctober(){
  const agg=aggregateOctober(), inv=invoiceOctober();
  const oct=PG.billing_cycle.find(c=>c.cycle_id===4);
  if(oct.status!=="CLOSED"){ update("billing_cycle",oct,{status:"CLOSED"});
    log("pg","October cycle closed",`UPDATE billing_cycle SET status = 'CLOSED' WHERE cycle_id = 4;`); }
  if(!PG.billing_cycle.some(c=>c.cycle_id===5)){
    insert("billing_cycle",{cycle_id:5,year:2026,month:11,cycle_start_date:"2026-11-01",cycle_end_date:"2026-11-30",due_date:"2026-12-30",late_penalty_percent:5,status:"OPEN"});
    log("pg","November cycle opened",`INSERT INTO billing_cycle (year, month, cycle_start_date, cycle_end_date, due_date)\nVALUES (2026, 11, '2026-11-01', '2026-11-30', '2026-12-30');`); }
  for(const i of inv.created){
    const p=propById(i.property_id), owner=PG.app_user.find(u=>u.resident_id===p.resident_id); if(!owner) continue;
    MG.notifications.push({_id:"n"+(MG.notifications.length+1),user_id:owner.user_id,kind:"BILL",title:`October bill ready for ${p.property_code}`,body:`${i.invoice_no}: ${inr(i.total_amount)}, due ${fmtD(oct.due_date)}. Open Bills & payments to see the slabs and pay.`,created_at:now,read_at:null});
  }
  if(inv.created.length) log("mg",`Bill alerts sent for ${inv.created.length} invoices`,`db.notifications.insertMany([ { kind: "BILL", title: "October bill ready for P-…" }, … ])`);
  SESSION.sel.billRes=`<div class="${inv.errs.length||agg.locked?"errbox":"okbox"}">${inv.created.length?`Nightly job at ${fmtDT(now)}: ${agg.written} meter readings written, ${inv.created.length} October invoices created${inv.existed?`, ${inv.existed} already existed`:""}. Residents have a bill alert.`:esc(`October was already invoiced earlier, so no new bills were made.${agg.locked?`\n${agg.errs[0]}`:""}`)}</div>`;
  if(typeof Sync!=="undefined") Sync.changed();
  toast(inv.created.length?`October closed: ${inv.created.length} new bills issued`:"October was already billed; nothing new");
  render();
}
V.tix=()=>{
  const ts=PG.maintenance_ticket.slice().sort((a,b)=>b.reported_timestamp-a.reported_timestamp);
  const sel=ts.find(t=>t.ticket_id===SESSION.sel.tk)||ts[0];
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>All tickets</h1></div>
  <div class="panel"><div class="panel-head"><h2>Every ticket in the city</h2>${src("pg")}</div>${ts.length?`<div class="tablewrap"><table><thead><tr><th>Ticket</th><th>Property</th><th>District</th><th>Issue</th><th>Severity</th><th>Status</th><th class="r">Seen</th><th>Assigned</th></tr></thead><tbody>
  ${ts.map(t=>{const p=propById(t.property_id);return `<tr class="click" data-act="sel-tk" data-id="${t.ticket_id}" tabindex="0"><td class="mono">${t.ticket_no}</td><td class="mono">${p.property_code}</td><td>${esc(zname(districtOf(p.zone_id)))}</td><td>${t.issue_type.replace("_"," ").toLowerCase()}</td><td>${sev(t.severity)}</td><td>${badge(t.status)}</td><td class="r">${t.occurrence_count}×</td><td>${t.assigned_to?esc(userById(t.assigned_to).display):"–"}</td></tr>`;}).join("")}</tbody></table></div>`:`<p class="muted">No tickets yet.</p>`}</div>
  ${sel?ticketDetail(sel,false):""}`;
};
V.tix.live=true;

V.rules=()=>{
  const tries=[
    ["Billing cycle with month 13","INSERT INTO billing_cycle (year, month, cycle_start_date, cycle_end_date, due_date)\nVALUES (2026, 13, '2026-12-01', '2026-12-31', '2027-01-30');",()=>insert("billing_cycle",{cycle_id:99,year:2026,month:13,cycle_start_date:"2026-12-01",cycle_end_date:"2026-12-31",due_date:"2027-01-30",status:"OPEN"})],
    ["Second invoice for the same property and month",`INSERT INTO invoice (invoice_no, property_id, cycle_id, total_amount)\nVALUES ('INV-DUP-1', (SELECT property_id FROM property WHERE property_code = 'P-0001'), 3, 100);`,()=>insert("invoice",{invoice_id:uid(),invoice_no:"INV-DUP-1",property_id:propByCode("P-0001").property_id,cycle_id:3,total_amount:10000,payment_status:"PENDING"})],
    ["Overlapping electricity tariff","INSERT INTO utility_rate (utility_type, tier_level, min_units, max_units, price_per_unit, effective_start_date)\nVALUES ('ELECTRICITY', 1, 0, 100, 4.50, '2026-10-01');",()=>insert("utility_rate",{rate_id:99,utility_type:"ELECTRICITY",tier_level:1,min_units:0,max_units:100,price_per_unit:4.5,effective_start_date:"2026-10-01",effective_end_date:null})],
    ["Resident with a real-looking ID number","INSERT INTO resident (citizen_ref, full_name, email, phone)\nVALUES ('1234-5678-9012', 'Test Person', 'test@example.test', '+919000000099');",()=>insert("resident",{resident_id:uid(),citizen_ref:"1234-5678-9012",full_name:"Test Person",email:"test@example.test",phone:"+919000000099"})],
    ["Change a meter reading that's already billed",`UPDATE meter_reading SET closing_register = closing_register - 50\nWHERE meter_id = (SELECT meter_id FROM utility_meter WHERE meter_code = 'MTR-E-0001') AND cycle_id = 3;`,()=>{const m=meterByCode("MTR-E-0001");const r=PG.meter_reading.find(x=>x.meter_id===m.meter_id&&x.cycle_id===3);update("meter_reading",r,{closing_register:r.closing_register-50});}],
    ["Second successful payment for a paid invoice",`INSERT INTO payment (invoice_id, idempotency_key, amount_paid, payment_method, status)\nSELECT invoice_id, 'manual-retry-77', total_amount, 'CASH', 'SUCCEEDED'\nFROM invoice WHERE invoice_no = '${PG.invoice.find(i=>i.payment_status==="PAID").invoice_no}';`,()=>{const i=PG.invoice.find(x=>x.payment_status==="PAID");insert("payment",{payment_id:uid(),invoice_id:i.invoice_id,idempotency_key:"manual-retry-"+Math.floor(rnd()*1e6),amount_paid:i.total_amount,payment_method:"CASH",status:"SUCCEEDED",transaction_id:null});}],
  ];
  tries.push(["Malformed meter reading (MongoDB validator)",`db.meter_readings.insertOne({\n  ts: ISODate("2026-10-25T09:00:00Z"),\n  meta: { utility: "WATER" },          // meter_code missing\n  flow_lpm: -4.2                        // negative flow\n})`,()=>{ throw new PgError(`MongoServerError: Document failed validation\n  details: { operatorName: "$jsonSchema", schemaRulesNotSatisfied: [\n    { operatorName: "required", missingProperties: [ "meta.meter_code", "meta.property_code" ] },\n    { operatorName: "properties", propertyName: "flow_lpm", details: [ { operatorName: "minimum", specifiedAs: { minimum: 0 }, reason: "comparison failed", consideredValue: -4.2 } ] } ] }\n(also rejected earlier by the API's Zod schema with 400 Bad Request)`); },"mg"]);
  V.rules.tries=tries;
  return `<div class="page-head"><span class="eyebrow">Database rules</span><h1>Watch PostgreSQL refuse bad data</h1><p class="ink2">Each button sends a statement the database must reject. The errors follow the real PostgreSQL and MongoDB message formats for that constraint, trigger or validator.</p></div>
  <div class="grid2">${tries.map((t,i)=>`<div class="panel stack"><div class="row" style="justify-content:space-between"><h3>${esc(t[0])}</h3>${src(t[3]||"pg")}</div><pre class="code">${esc(t[1])}</pre><div><button class="btn" data-act="rule" data-i="${i}">Run statement</button></div><div id="rule-${i}"></div></div>`).join("")}</div>`;
};

V.sql=()=>{
  const q=SESSION.sel.q||"q1";
  const Q={
   q1:{t:"Recursive CTE: zone roll-up",sql:`WITH RECURSIVE subtree AS (
  SELECT zone_id FROM zone WHERE zone_id = $1          -- anchor
  UNION ALL
  SELECT z.zone_id FROM zone z
  JOIN subtree s ON z.parent_zone_id = s.zone_id     -- walk down
)
SELECT um.utility_type, SUM(mr.total_units_consumed) AS units
FROM subtree s
JOIN property p        ON p.zone_id = s.zone_id
JOIN utility_meter um  ON um.property_id = p.property_id
JOIN meter_reading mr  ON mr.meter_id = um.meter_id AND mr.cycle_id = 3
GROUP BY um.utility_type;`,run:()=>{const zid=Number(SESSION.sel.zone||2);const zs=zoneSubtree(zid);const props=PG.property.filter(p=>zs.includes(p.zone_id));
     return {param:`<label class="f">Zone ($1)<select class="in" id="q-zone">${PG.zone.map(z=>`<option value="${z.zone_id}" ${z.zone_id===zid?"selected":""}>${esc(z.name)}</option>`).join("")}</select></label>`,
     note:`Subtree of ${zname(zid)}: ${zs.map(zname).join(", ")} → ${props.length} properties.`,
     cols:["utility_type","units (September)"],rows:Object.keys(UT).map(k=>[k,n2(PG.meter_reading.filter(r=>r.cycle_id===3&&props.some(p=>metersOf(p.property_id).some(m=>m.meter_id===r.meter_id&&m.utility_type===k))).reduce((s,r)=>s+r.total_units_consumed,0))+" "+UT[k].unit])};}},
   q3:{t:"Nested + JOIN + HAVING: residents with overdue bills",sql:`SELECT z.name AS zone, r.full_name, r.email, COUNT(*) AS overdue_bills,
       SUM(i.total_amount) AS overdue_amount
FROM resident r
JOIN property p ON p.resident_id = r.resident_id
JOIN zone z     ON z.zone_id = p.zone_id
JOIN invoice i  ON i.property_id = p.property_id
WHERE i.payment_status = 'OVERDUE'
  AND r.resident_id IN (SELECT resident_id FROM resident WHERE is_active)
GROUP BY z.name, r.full_name, r.email
HAVING COUNT(*) >= $1          -- the source design used 3; small demo data
ORDER BY overdue_amount DESC;`,run:()=>{const th=Number(SESSION.sel.th||2);const g=new Map();
     PG.invoice.filter(i=>i.payment_status==="OVERDUE").forEach(i=>{const p=propById(i.property_id);const r=PG.resident.find(x=>x.resident_id===p.resident_id);const k=zname(p.zone_id)+"|"+r.full_name;const o=g.get(k)||{z:zname(p.zone_id),n:r.full_name,e:r.email,c:0,a:0};o.c++;o.a+=i.total_amount;g.set(k,o);});
     return {param:`<label class="f">Minimum overdue bills ($1)<select class="in" id="q-th">${[1,2,3].map(v=>`<option ${v===th?"selected":""}>${v}</option>`).join("")}</select></label>`,cols:["zone","full_name","email","overdue_bills","overdue_amount"],rows:[...g.values()].filter(o=>o.c>=th).sort((a,b)=>b.a-a.a).map(o=>[o.z,o.n,o.e,o.c,inr(o.a)])};}},
   q2:{t:"Correlated subquery: above the district average",sql:`SELECT p.property_code, p.property_type, mr.total_units_consumed AS kwh
FROM property p
JOIN utility_meter um ON um.property_id = p.property_id AND um.utility_type = 'ELECTRICITY'
JOIN meter_reading mr ON mr.meter_id = um.meter_id AND mr.cycle_id = 3
WHERE mr.total_units_consumed > 1.3 * (
  SELECT AVG(mr2.total_units_consumed)          -- re-evaluated per outer row
  FROM property p2
  JOIN zone z2           ON z2.zone_id = p2.zone_id
  JOIN utility_meter um2 ON um2.property_id = p2.property_id AND um2.utility_type = 'ELECTRICITY'
  JOIN meter_reading mr2 ON mr2.meter_id = um2.meter_id AND mr2.cycle_id = 3
  WHERE z2.parent_zone_id = (SELECT parent_zone_id FROM zone WHERE zone_id = p.zone_id)
    AND p2.property_id <> p.property_id
);`,run:()=>{const kwh=p=>{const m=metersOf(p.property_id).find(x=>x.utility_type==="ELECTRICITY");return PG.meter_reading.find(r=>r.meter_id===m.meter_id&&r.cycle_id===3).total_units_consumed;};
     const rows=PG.property.map(p=>{const others=PG.property.filter(o=>o!==p&&districtOf(o.zone_id)===districtOf(p.zone_id));const avg=others.reduce((s,o)=>s+kwh(o),0)/others.length;return {p,k:kwh(p),avg};}).filter(o=>o.k>1.3*o.avg);
     return {cols:["property_code","property_type","kwh","district avg of others"],rows:rows.map(o=>[o.p.property_code,o.p.property_type,n2(o.k),n2(o.avg)])};}},
   c1:{t:"CTE + window function: month-over-month change",sql:`WITH monthly AS (
  SELECT p.property_code, mr.cycle_id, mr.total_units_consumed AS kwh
  FROM meter_reading mr
  JOIN utility_meter um ON um.meter_id = mr.meter_id AND um.utility_type = 'ELECTRICITY'
  JOIN property p       ON p.property_id = um.property_id
), changes AS (
  SELECT property_code, cycle_id, kwh,
         LAG(kwh) OVER (PARTITION BY property_code ORDER BY cycle_id) AS prev_kwh
  FROM monthly
)
SELECT property_code, prev_kwh AS august, kwh AS september,
       ROUND(100.0 * (kwh - prev_kwh) / prev_kwh, 1) AS change_pct
FROM changes WHERE cycle_id = 3
ORDER BY change_pct DESC;`,run:()=>{const rows=PG.property.map(p=>{const m=metersOf(p.property_id).find(x=>x.utility_type==="ELECTRICITY");const g=c=>PG.meter_reading.find(r=>r.meter_id===m.meter_id&&r.cycle_id===c).total_units_consumed;return [p.property_code,g(2),g(3)];}).map(([c,a,s])=>[c,a,s,Math.round(1000*(s-a)/a)/10]).sort((x,y)=>y[3]-x[3]);
     return {cols:["property_code","august","september","change_pct"],rows:rows.map(r=>[r[0],n2(r[1]),n2(r[2]),(r[3]>0?"+":"")+r[3]+"%"])};}},
   c2:{t:"CTE: receivables ageing",sql:`WITH open_bills AS (
  SELECT i.invoice_no, i.total_amount, bc.due_date,
         DATE '2026-10-25' - bc.due_date AS days_late
  FROM invoice i JOIN billing_cycle bc USING (cycle_id)
  WHERE i.payment_status IN ('PENDING','OVERDUE')
)
SELECT CASE WHEN days_late <= 0  THEN 'not yet due'
            WHEN days_late <= 30 THEN '1–30 days'
            WHEN days_late <= 60 THEN '31–60 days'
            ELSE '60+ days' END AS bucket,
       COUNT(*) AS bills, SUM(total_amount) AS amount
FROM open_bills GROUP BY 1 ORDER BY MIN(days_late);`,run:()=>{const today=new Date(now).toLocaleDateString("en-CA",IST);const b=new Map();
     PG.invoice.filter(i=>i.payment_status!=="PAID").forEach(i=>{const d=PG.billing_cycle.find(c=>c.cycle_id===i.cycle_id).due_date;const late=Math.round((Date.parse(today)-Date.parse(d))/86400e3);const k=late<=0?"not yet due":late<=30?"1–30 days":late<=60?"31–60 days":"60+ days";const o=b.get(k)||{c:0,a:0,min:late};o.c++;o.a+=i.total_amount;o.min=Math.min(o.min,late);b.set(k,o);});
     return {cols:["bucket","bills","amount"],rows:[...b.entries()].sort((x,y)=>x[1].min-y[1].min).map(([k,o])=>[k,o.c,inr(o.a)])};}},
  };
  const cur=Q[q]; const res=cur.run();
  return `<div class="page-head"><span class="eyebrow">Database showcase</span><h1>SQL lab</h1><p class="ink2">The query catalogue for rubric rows 7 and 8. In this prototype the results are computed in the browser from the same rows; in the real build these exact statements run in PostgreSQL.</p></div>
  <div class="tabs" role="group" aria-label="Query">${Object.entries(Q).map(([k,v])=>`<button aria-pressed="${k===q}" data-act="sel-q" data-q="${k}">${esc(v.t.split(":")[0])}</button>`).join("")}</div>
  <div class="panel stack"><div class="row" style="justify-content:space-between"><h2>${esc(cur.t)}</h2>${src("pg")}</div>
   <pre class="code">${esc(cur.sql)}</pre>${res.param?`<div class="row">${res.param}</div>`:""}${res.note?`<p class="ink2">${esc(res.note)}</p>`:""}
   <div class="tablewrap"><table><thead><tr>${res.cols.map(c=>`<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${res.rows.length?res.rows.map(r=>`<tr>${r.map(v=>`<td class="${typeof v==="number"||/^[₹+\-\d]/.test(String(v))?"r num":""}">${esc(v)}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${res.cols.length}" class="muted">0 rows</td></tr>`}</tbody></table></div></div>`;
};

V.db=()=>{
  const u=SESSION.user; const tbl=SESSION.sel.tbl||"invoice"; const col=SESSION.sel.col||"meter_readings";
  let rows=PG[tbl];
  if(u.role==="RESIDENT"){ const ids=visiblePropIds(u); const meterIds=new Set(PG.utility_meter.filter(m=>ids.has(m.property_id)).map(m=>m.meter_id)); const invIds=new Set(rlsInvoices(u).map(i=>i.invoice_id));
    const f={property:r=>ids.has(r.property_id),utility_meter:r=>ids.has(r.property_id),meter_reading:r=>meterIds.has(r.meter_id),invoice:r=>invIds.has(r.invoice_id),invoice_line_item:r=>invIds.has(r.invoice_id),payment:r=>invIds.has(r.invoice_id),maintenance_ticket:r=>ids.has(r.property_id),resident:r=>r.resident_id===u.resident_id,app_user:r=>r.user_id===u.user_id,user_session:r=>r.user_id===u.user_id,ticket_status_history:r=>rlsTickets(u).some(t=>t.ticket_id===r.ticket_id),aggregation_run:()=>false};
    if(f[tbl]) rows=rows.filter(f[tbl]); }
  if(u.role==="STAFF"){ const ids=visiblePropIds(u); const f={property:r=>ids.has(r.property_id),maintenance_ticket:r=>ids.has(r.property_id),invoice:()=>false,invoice_line_item:()=>false,payment:()=>false,resident:()=>false,app_user:r=>r.user_id===u.user_id,user_session:r=>r.user_id===u.user_id}; if(f[tbl]) rows=rows.filter(f[tbl]); }
  const show=rows.slice(-25).reverse(); const cols=show.length?Object.keys(show[0]).filter(k=>k!=="display"):[];
  const fmtCell=(k,v)=>{ if(v==null) return `<span class="muted">NULL</span>`; if(/(_at|timestamp|payment_date|started_at|finished_at|last_seen_at|expires_at)$/.test(k)&&typeof v==="number") return fmtDT(v); if(/amount|line_total/.test(k)&&typeof v==="number") return n2(v/100); if(typeof v==="string"&&/^[0-9a-f]{8}-/.test(v)) return `<span title="${v}">${v.slice(0,8)}…</span>`; return esc(v); };
  let docs=MG[col].slice(-12).reverse();
  if(u.role==="RESIDENT"&&col==="notifications") docs=docs.filter(d=>d.user_id===u.user_id);
  const docJson=d=>{const o={};for(const k in d){ if(k.startsWith("_")&&k!=="_id") continue; o[k]=typeof d[k]==="number"&&/ts|_at|detected_at|last_seen/.test(k)?`ISODate("${new Date(d[k]).toISOString()}")`:d[k]; } return JSON.stringify(o,(k,v)=>Array.isArray(v)&&k==="entries"?v.map(e=>({...e,at:typeof e.at==="number"?new Date(e.at).toISOString():e.at})):v,2);};
  return `<div class="page-head"><span class="eyebrow">Under the hood</span><h1>Inside the databases</h1><p class="ink2">You are viewing as <b>${esc(roleOf(u))}</b>. ${u.role==="ADMIN"?"Admins see every row.":"Row-level security filters what this role can read, so some tables show only your rows or none."}</p></div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>PostgreSQL tables</h2>${src("pg")}</div><span class="muted">${rows.length} visible row${rows.length===1?"":"s"}${rows.length>25?", newest 25 shown":""}</span></div>
   <div class="tabs" style="margin-bottom:10px" role="group" aria-label="Table">${Object.keys(PG).map(k=>`<button aria-pressed="${k===tbl}" data-act="sel-tbl" data-t="${k}">${k}</button>`).join("")}</div>
   <div class="tablewrap">${show.length?`<table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead><tbody>${show.map(r=>`<tr>${cols.map(c=>`<td class="mono" style="white-space:nowrap">${fmtCell(c,r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>`:`<p class="muted">0 rows visible to ${esc(roleOf(u))}.</p>`}</div></div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>MongoDB collections</h2>${src("mg")}</div><span class="muted">${MG[col].length} documents</span></div>
   <div class="tabs" style="margin-bottom:10px" role="group" aria-label="Collection">${Object.keys(MG).map(k=>`<button aria-pressed="${k===col}" data-act="sel-col" data-c="${k}">${k}</button>`).join("")}</div>
   ${col==="meter_readings"?`<p class="ink2" style="margin-bottom:8px">Time-series collection (<code>timeField: "ts", metaField: "meta"</code>). Electricity, water and gas documents carry different fields.</p>`:""}
   <div class="stack">${docs.length?docs.map(d=>`<pre class="json">${esc(docJson(d))}</pre>`).join(""):`<p class="muted">No documents yet.</p>`}</div></div>`;
};

// ---------- main render ----------
function render(fromTick){
  if(!SESSION.user){ if(fromTick) return renderTop(); return renderLogin(); }
  const view=V[SESSION.view];
  if(fromTick){ renderTop(); if(view.live){ const y=window.scrollY; $("#main").innerHTML=view(); window.scrollTo(0,y); } else updateBadges(); return; }
  if(!$("#main")){ app.innerHTML=`<header class="topbar" id="top"></header><div class="shell"><nav class="side" id="nav" aria-label="Sections"></nav><main id="main"></main><aside class="rail"><div class="panel"><div class="panel-head" style="margin-bottom:8px"><h2>Under the hood</h2><span class="muted" style="font-size:12px">live statement log</span></div><div class="feed" id="feed"></div></div></aside></div>`; }
  renderTop(); renderNav(); $("#main").innerHTML=view(); renderRail();
}
function updateBadges(){ renderNav(); }
function renderNav(){
  const u=SESSION.user; const unread=MG.notifications.filter(n=>n.user_id===u.user_id&&!n.read_at).length;
  const myOpen=rlsTickets(u).filter(t=>ACTIVE.includes(t.status)).length;
  $("#nav").innerHTML=`<div class="who"><div class="role-tag">${u.role==="RESIDENT"?"Resident":u.role==="STAFF"?"Maintenance staff":"Municipal admin"}</div><b>${esc(u.display)}</b><div class="muted mono" style="font-size:11px">${esc(roleOf(u))}</div></div>`+
    NAV[u.role].map(([k,l])=>`<button class="nav" data-act="go" data-view="${k}" ${SESSION.view===k?'aria-current="page"':""}>${l}${k==="alerts"&&unread?` <span class="status s-crit">${unread}</span>`:""}${k==="queue"&&myOpen?` <span class="status s-warn">${myOpen}</span>`:""}</button>`).join("");
}
function renderLogin(){
  const pick=SESSION.pick||PG.app_user[0].email;
  const ini=n=>n.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const roleOf=u=>u.role==="RESIDENT"?"Resident":u.role==="STAFF"?"Staff · "+zname(u.staff_zone_id):"City admin";
  app.innerHTML=`<header class="topbar" id="top"></header><div class="login">
   <section class="login-hero">
    <span class="eyebrow">DBMS mini-project · Dhanush &amp; Gagan</span>
    <h1>Smart City Utilities &amp; Infrastructure Management</h1>
    <p>Electricity, water and gas for a whole city on one platform. Smart meters report every 15 minutes, faults raise repair tickets on their own, and every bill is worked out from real readings.</p>
    <ul class="login-feats">
     <li><span class="feat-ic" style="--c:var(--elec)">⚡</span><div><b>Live smart meters</b><span>Readings stream into MongoDB as time series</span></div></li>
     <li><span class="feat-ic" style="--c:var(--crit)">!</span><div><b>Automatic fault detection</b><span>Leaks, spikes and outages become tickets and alerts</span></div></li>
     <li><span class="feat-ic" style="--c:var(--water)">₹</span><div><b>Fair tiered billing</b><span>PostgreSQL turns a month of usage into one exact bill</span></div></li>
    </ul>
    <div class="login-dbs"><span class="src pg">PostgreSQL</span><span class="src mg">MongoDB</span><span class="muted">Synthetic data only</span></div>
   </section>
   <section class="login-card" aria-labelledby="lg-title">
    <h2 id="lg-title">Sign in</h2><p class="muted">Welcome back. Use your city account.</p>
    <form id="login-form" class="stack">
     <label class="f">Email<input class="in" id="lg-email" type="email" value="${esc(pick)}" autocomplete="username"></label>
     <label class="f">Password<input class="in" id="lg-pass" type="password" value="demo123" autocomplete="current-password"></label>
     <button class="btn primary lg" type="submit">Sign in</button>
    </form>
    <div id="lg-err"></div>
    <div class="login-sep"><span>or pick a demo account</span></div>
    <div class="users" role="group" aria-label="Demo accounts">${PG.app_user.map(u=>`<button class="ucard" aria-pressed="${u.email===pick}" data-act="pick" data-email="${u.email}"><span class="avatar r-${u.role.toLowerCase()}">${esc(ini(u.display))}</span><span class="ucard-t"><b>${esc(u.display)}</b><span class="muted">${esc(roleOf(u))}</span></span></button>`).join("")}</div>
    <p class="muted" style="font-size:12px;margin:0">Every demo account uses the password <span class="mono">demo123</span>.</p>
   </section></div>`;
  renderTop();
}

// ---------- events ----------
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-act]"); if(!b) return;
  const a=b.dataset.act, u=SESSION.user;
  if(a==="pick"){ SESSION.pick=b.dataset.email; renderLogin(); return; }
  if(a==="sim-toggle"){ setRunning(!SIM.running); log("mg",SIM.running?"City clock resumed":"City clock paused",null); return; }
  if(a==="ff"){ for(let i=0;i<4;i++) tick(); render(); return; }
  if(a==="month-end"){ toast("Running the meters to midnight on 1 November…"); setTimeout(monthEnd,30); return; }
  if(a==="logout"){ logout(); return; }
  if(a==="go"){ SESSION.view=b.dataset.view; SESSION.sel.billRes=null; render(); window.scrollTo(0,0); return; }
  if(a==="sel-prop"){ SESSION.sel.prop=b.dataset.id; render(); return; }
  if(a==="sel-ut"){ SESSION.sel.ut=b.dataset.ut; render(); return; }
  if(a==="sel-cut"){ SESSION.sel.cut=b.dataset.ut; render(); return; }
  if(a==="sel-inv"){ SESSION.sel.inv=b.dataset.id; render(); return; }
  if(a==="sel-tk"){ SESSION.sel.tk=b.dataset.id; render(); return; }
  if(a==="sel-q"){ SESSION.sel.q=b.dataset.q; render(); return; }
  if(a==="sel-tbl"){ SESSION.sel.tbl=b.dataset.t; render(); return; }
  if(a==="sel-col"){ SESSION.sel.col=b.dataset.c; render(); return; }
  if(a==="rls-try"){
    const id=b.dataset.id; const found=rlsInvoices(u).find(i=>i.invoice_id===id); const real=PG.invoice.find(i=>i.invoice_id===id);
    const stmt=`${sqlCtx(u)}SELECT * FROM invoice WHERE invoice_id = '${id.slice(0,8)}…';\n-- policy invoice_resident_read: property must belong to the signed-in resident\nCOMMIT;`;
    log("pg",found?"Invoice returned":`Row-level security returned 0 rows for ${real.invoice_no}`,stmt);
    $("#rls-out").innerHTML=`<div class="okbox"><b>0 rows.</b> Invoice ${esc(real.invoice_no)} exists, but PostgreSQL hides it from <code>resident_role</code> because it belongs to ${esc(propById(real.property_id)&&PG.resident.find(r=>r.resident_id===propById(real.property_id).resident_id).full_name)}. The API answers 404, so nobody can even tell it exists.</div>`; return; }
  if(a==="pay"||a==="pay-twice"){
    const id=b.dataset.id; const method=$("#pay-method").value, outcome=$("#pay-outcome").value; const key="idem-"+Math.floor(rnd()*1e9).toString(36);
    const p1=spRecordPayment(id,method,key,outcome); if(a==="pay-twice"&&p1) spRecordPayment(id,method,key,outcome);
    if(p1) toast(p1.status==="SUCCEEDED"?(a==="pay-twice"?"Paid once. The repeated request returned the same payment.":"Payment approved. Invoice marked paid."):"Payment declined. The attempt is recorded and the bill stays unpaid.");
    render(); return; }
  if(a==="n-read"){ const n=MG.notifications.find(x=>x._id===b.dataset.id); n.read_at=now; log("mg","Alert marked as read",`db.notifications.updateOne({ _id: "${n._id}" }, { $set: { read_at: ISODate("${new Date(now).toISOString()}") } })`); render(); return; }
  if(a==="n-del"){ const id=b.dataset.id; MG.notifications=MG.notifications.filter(x=>x._id!==id); log("mg","Alert dismissed",`db.notifications.deleteOne({ _id: "${id}", user_id: <signed-in user> })`); toast("Alert dismissed"); render(); return; }
  if(a==="ack"){ const ev=MG.anomaly_events.find(x=>x._id===b.dataset.id); ev.status="ACK"; ev.ack_by=u.display; log("mg",`Anomaly ${ev.key} acknowledged`,`db.anomaly_events.updateOne({ _id: "${ev._id}" }, { $set: { status: "ACK", ack_by: "${u.display}", ack_at: ISODate(…) } })`); render(); return; }
  if(a==="t-take"||a==="t-move"){
    const t=PG.maintenance_ticket.find(x=>x.ticket_id===b.dataset.id); const to=a==="t-take"?"ASSIGNED":b.dataset.to;
    const patch={status:to}; if(a==="t-take") patch.assigned_to=u.user_id;
    if(to==="RESOLVED"||to==="CLOSED"){ const v=$("#t-res")?.value?.trim(); if(to==="RESOLVED") patch.resolution_notes=v||null; }
    const stmt=`${sqlCtx(u)}UPDATE maintenance_ticket SET status = '${to}'${patch.assigned_to?`, assigned_to = '${u.user_id.slice(0,8)}…'`:""}${patch.resolution_notes?`, resolution_notes = $notes`:""}\nWHERE ticket_no = '${t.ticket_no}'\nRETURNING status, resolved_at;\nCOMMIT;`;
    try{ update("maintenance_ticket",t,patch);
      log("pg",`${t.ticket_no}: ${to.replace("_"," ").toLowerCase()} (history row written by trigger)`,stmt);
      const lg=MG.maintenance_logs.find(l=>l.ticket_no===t.ticket_no)||(MG.maintenance_logs.push({_id:"log-"+t.ticket_no,ticket_no:t.ticket_no,entries:[],attachments:[]}),MG.maintenance_logs[MG.maintenance_logs.length-1]);
      lg.entries.push({at:now,by:u.display,kind:"STATUS",text:`Status changed to ${to}`});
      log("mg","Status mirrored to the ticket log",`db.maintenance_logs.updateOne({ ticket_no: "${t.ticket_no}" },\n  { $push: { entries: { by: "${u.display}", kind: "STATUS", text: "Status changed to ${to}" } } })`);
      if(to==="RESOLVED"){ const m=PG.utility_meter.find(x=>x.meter_id===t.meter_id); if(m) delete SIM.mode[m.meter_code];
        const p=propById(t.property_id); if(!PG.maintenance_ticket.some(x=>x!==t&&x.property_id===p.property_id&&ACTIVE.includes(x.status))) p.service_status="NORMAL";
        MG.anomaly_events.filter(ev=>ev.key===t.anomaly_key&&ev.status!=="RESOLVED").forEach(ev=>ev.status="RESOLVED");
        toast(`${t.ticket_no} resolved. The meter is back to normal readings.`); }
      render();
    }catch(err){ log("pg",`Rejected: ${t.ticket_no} → ${to}`,stmt,{err:err.message}); render(); const box=$("#t-err"); if(box) box.innerHTML=`<div class="errbox">${esc(err.message)}</div>`; }
    return; }
  if(a==="note-del"){ const lg=MG.maintenance_logs.find(l=>l.ticket_no===b.dataset.tk); const i=+b.dataset.i; const e1=lg.entries[i]; lg.entries.splice(i,1);
    log("mg","Field note deleted",`db.maintenance_logs.updateOne({ ticket_no: "${lg.ticket_no}" },\n  { $pull: { entries: { by: "${e1.by}", at: ISODate("${new Date(e1.at).toISOString()}") } } })`); render(); return; }
  if(a==="supply"){ setSupply(b.dataset.code,b.dataset.on==="true"); toast(b.dataset.on==="true"?"Supply back on. Usage returns on the next reading.":"Supply off. Usage reads 0 from the next reading; the city clock keeps running."); return; }
  if(a==="scen-start"||a==="scen-stop"){ scenario(b.dataset.id,a==="scen-start"); toast(a==="scen-start"?"Scenario running. Press +1 hour to let the detector see it.":"Back to normal readings."); return; }
  if(a==="agg"){ runAggregation(); return; }
  if(a==="gen"){ generateInvoices(); return; }
  if(a==="rule"){ const i=+b.dataset.i; const t=V.rules.tries[i]; const box=$("#rule-"+i);
    try{ t[2](); log(t[3]||"pg",`Accepted: ${t[0]}`,t[1]); box.innerHTML=`<div class="okbox">Accepted (unexpected).</div>`; }
    catch(err){ log(t[3]||"pg",`Rejected: ${t[0]}`,t[1],{err:err.message}); box.innerHTML=`<div class="errbox">${esc(err.message)}</div>`; } return; }
});
document.addEventListener("keydown",e=>{ if(e.key==="Enter"){ const r=e.target.closest&&e.target.closest("tr[data-act]"); if(r){ r.click(); } } });
document.addEventListener("change",e=>{
  if(e.target.id==="q-zone"){ SESSION.sel.zone=e.target.value; render(); }
  if(e.target.id==="q-th"){ SESSION.sel.th=e.target.value; render(); }
});
document.addEventListener("submit",e=>{
  e.preventDefault(); const f=e.target;
  if(f.id==="login-form"){ const email=$("#lg-email").value.trim().toLowerCase(); const pass=$("#lg-pass").value; const user=PG.app_user.find(u=>u.email===email);
    if(!user||pass!=="demo123"){ log("pg","Sign-in failed","SELECT user_id, password_hash, role FROM app_user WHERE email = $1;\n-- Argon2id verify failed → failed_logins = failed_logins + 1",{err:"401 Invalid email or password"}); $("#lg-err").innerHTML=`<div class="errbox">Email or password is wrong. Every demo account uses the password demo123.</div>`; return; }
    login(user); return; }
  if(f.id==="complaint"){ const u=SESSION.user; const pid=$("#c-prop").value; const type=$("#c-type").value; const desc=$("#c-desc").value.trim();
    const stmt=`${sqlCtx(u)}INSERT INTO maintenance_ticket (ticket_no, property_id, source, issue_type, severity, description)\nVALUES (next_ticket_no(), '${pid.slice(0,8)}…', 'RESIDENT', '${type}', 'MEDIUM', $desc)\nRETURNING ticket_no;\nCOMMIT;`;
    try{ const t=insert("maintenance_ticket",{ticket_id:uid(),ticket_no:`MT-${String(tktSeq+1).padStart(4,"0")}`,property_id:pid,meter_id:null,source:"RESIDENT",anomaly_key:null,issue_type:type,severity:"MEDIUM",description:desc,status:"OPEN",assigned_to:null,reported_timestamp:now,last_seen_at:now,occurrence_count:1,resolved_at:null,resolution_notes:null}); tktSeq++;
      log("pg",`Complaint ${t.ticket_no} created`,stmt);
      MG.maintenance_logs.push({_id:"log-"+t.ticket_no,ticket_no:t.ticket_no,entries:[{at:now,by:u.display,kind:"NOTE",text:desc}],attachments:[]});
      log("mg",`Ticket log started for ${t.ticket_no}`,`db.maintenance_logs.insertOne({ ticket_no: "${t.ticket_no}", entries: [ { by: "${u.display}", kind: "NOTE", text: $desc } ] })`);
      toast(`Complaint ${t.ticket_no} submitted. Staff for this district can see it now.`); render();
    }catch(err){ log("pg","Complaint rejected",stmt,{err:err.message}); toast(err.message.split("\n")[0].replace("ERROR:  ","")); } return; }
  if(f.id==="note-form"){ const u=SESSION.user; const tk=f.dataset.tk; const text=$("#note-text").value.trim(); if(!text) return;
    let lg=MG.maintenance_logs.find(l=>l.ticket_no===tk); if(!lg){ lg={_id:"log-"+tk,ticket_no:tk,entries:[],attachments:[]}; MG.maintenance_logs.push(lg); }
    lg.entries.push({at:now,by:u.display,kind:"NOTE",text});
    log("mg",`Note added to ${tk}`,`db.maintenance_logs.updateOne({ ticket_no: "${tk}" },\n  { $push: { entries: { at: ISODate(…), by: "${u.display}", kind: "NOTE", text: $text } } })`); render(); return; }
});

// ---------- boot ----------
log("mg","Seeded 48 hours of readings for 24 meters (seed 42)","db.meter_readings.insertMany([ …4,608 docs… ], { ordered: false })\n// time-series collection: { timeField: \"ts\", metaField: \"meta\", granularity: \"minutes\" }");
log("pg","Seeded the synthetic city","-- 7 zones, 6 residents, 8 properties, 24 meters, 4 billing cycles,\n-- 8 tariff slabs, 72 meter readings, 24 invoices, 5 users\n-- (all names, emails and IDs are synthetic)");
render();
setRunning(true);
