"use strict";
/* Admin views: live city map and analytics with CSV export. */

// ---------- live city map ----------
// schematic layout: North District above the river, South District below; two wards per district
const WARD_BOX={4:[20,20,290,170],5:[330,20,290,170],6:[20,230,290,170],7:[330,230,290,170]};
const PIN_SPOTS=[[0.3,0.58],[0.72,0.42],[0.5,0.8],[0.2,0.3]];
function pinXY(p){
  const [x,y,w,h]=WARD_BOX[p.zone_id], i=PG.property.filter(q=>q.zone_id===p.zone_id).indexOf(p), [fx,fy]=PIN_SPOTS[i%PIN_SPOTS.length];
  return [x+w*fx,y+h*fy];
}
const lastDoc=code=>{ const a=byMeter.get(code); return a&&a[a.length-1]; };
const liveRate=code=>{ const d=lastDoc(code); return d&&now-d.ts<TICK*2?d._rate:null; };
function propState(p){
  const ms=metersOf(p.property_id), tk=PG.maintenance_ticket.filter(t=>t.property_id===p.property_id&&ACTIVE.includes(t.status));
  const offline=ms.some(m=>SIM.offline.has(m.meter_code)), valve=ms.some(m=>SIM.mode[m.meter_code]==="SHUTOFF"), off=ms.some(m=>isOff(m.meter_code));
  const overdue=PG.invoice.some(i=>i.property_id===p.property_id&&i.payment_status==="OVERDUE");
  const crit=tk.some(t=>t.severity==="CRITICAL"||t.severity==="HIGH");
  const k=crit?"crit":tk.length?"warn":offline?"off":"ok";
  return {tk,offline,valve,off,overdue,crit,k,label:crit?"Critical fault":tk.length?"Open ticket":offline?"Meter offline":"Normal"};
}

function mapSvg(sel){
  const wards=PG.zone.filter(z=>z.zone_level==="WARD");
  const wardHot=z=>PG.property.filter(p=>p.zone_id===z.zone_id).map(propState);
  return `<svg class="citymap" viewBox="0 0 640 420" role="img" aria-label="Map of the city's wards with a pin for each property">
   <path class="river" d="M0 210 C 90 190, 170 232, 260 210 S 430 188, 520 212 S 610 226, 640 206" />
   <text class="rlab" x="560" y="200">river</text>
   ${wards.map(z=>{ const [x,y,w,h]=WARD_BOX[z.zone_id], st=wardHot(z), cls=st.some(s=>s.crit)?"crit":st.some(s=>s.k!=="ok")?"warn":"";
     return `<g><rect class="ward ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/><text class="wlab" x="${x+12}" y="${y+26}">${esc(z.name)}</text><text class="dlab" x="${x+w-12}" y="${y+26}" text-anchor="end">${esc(zname(z.parent_zone_id))}</text></g>`; }).join("")}
   ${PG.property.map(p=>{ const [x,y]=pinXY(p), s=propState(p), on=p.property_id===sel;
     return `<g class="pin ${s.k}${on?" on":""}" data-act="map-sel" data-id="${p.property_id}" tabindex="0" role="button" aria-label="${p.property_code}, ${s.label}">
      ${s.crit?`<circle class="pulse" cx="${x}" cy="${y}" r="16"/>`:""}
      <circle class="pdot" cx="${x}" cy="${y}" r="${on?17:15}" ${s.valve?'stroke-dasharray="4 3"':""}/>
      <text class="pico" x="${x}" y="${y+5}" text-anchor="middle">${p.property_type==="COMMERCIAL"?"B":"H"}</text>
      <text class="plab" x="${x}" y="${y+34}" text-anchor="middle">${p.property_code}</text></g>`; }).join("")}
  </svg>`;
}

function mapDetail(p){
  const s=propState(p), owner=PG.resident.find(r=>r.resident_id===p.resident_id), er=ecoReport(p.property_id), f=forecast(p.property_id);
  const owed=PG.invoice.filter(i=>i.property_id===p.property_id&&i.payment_status!=="PAID");
  const w=metersOf(p.property_id).find(m=>m.utility_type==="WATER");
  return `<div class="panel-head"><div class="row"><h2>${esc(p.property_code)}</h2><span class="status ${s.k==="crit"?"s-crit":s.k==="warn"?"s-warn":s.k==="off"?"s-mute":"s-ok"}">${s.label}</span></div>${gradeChip(er)}</div>
   <p class="ink2" style="margin:0 0 10px">${esc(p.address_line)} · ${esc(p.property_type.toLowerCase())} · ${esc(zname(p.zone_id))}<br>Owner: ${esc(owner.full_name)} <span class="muted mono">${esc(owner.citizen_ref)}</span></p>
   <div class="tablewrap"><table><tbody>
    ${metersOf(p.property_id).map(m=>{const r=liveRate(m.meter_code);return `<tr><th><span class="dot" style="background:${UT[m.utility_type].color}"></span>${UT[m.utility_type].label}</th><td class="r num">${SIM.mode[m.meter_code]==="SHUTOFF"?`<span class="status s-warn">valve closed</span> `:isOff(m.meter_code)?badge("CLOSED","off")+" ":""}${r==null?`<span class="status s-mute">no signal</span>`:`${n2(r)} ${UT[m.utility_type].rate}`}</td></tr>`;}).join("")}
    <tr><th>${f.c.name} forecast</th><td class="r num">${f.high?`<span class="status s-warn">high</span> `:""}${inr(f.total)}</td></tr>
    <tr><th>Unpaid</th><td class="r num">${s.overdue?badge("OVERDUE")+" ":""}${inr(owed.reduce((a,i)=>a+i.total_amount,0))}</td></tr>
    <tr><th>Eco score</th><td class="r num">${er.score}/100</td></tr>
   </tbody></table></div>
   <h3 style="font-size:14px;margin:14px 0 6px">Open tickets</h3>
   ${s.tk.length?`<div class="stack" style="gap:6px">${s.tk.map(t=>`<div class="row">${sev(t.severity)}<span class="mono">${t.ticket_no}</span><span>${esc(t.issue_type.replace("_"," ").toLowerCase())}</span>${badge(t.status)}<span class="muted">${t.assigned_to?esc(userById(t.assigned_to).display):"unassigned"} · ${slaBadge(t)}</span></div>`).join("")}</div>`:`<p class="muted">None.</p>`}
   <div class="row" style="margin-top:14px">${s.valve?`<button class="btn small" data-act="valve-open" data-code="${w.meter_code}">Reopen water valve</button>`:""}<button class="btn small" data-act="go" data-view="tix">All tickets</button></div>`;
}

V.map=()=>{
  const sel=SESSION.sel.mapProp||PG.property[0].property_id; SESSION.sel.mapProp=sel;
  const st=PG.property.map(propState);
  const n=k=>st.filter(s=>s.k===k).length;
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Live city map</h1>
   <p class="ink2">Every property, coloured by its live state. Pins update with each meter batch; click one for its readings, bills and tickets.</p></div>
  <div class="kpis">
   <div class="kpi"><span class="l">Normal</span><span class="v">${n("ok")}</span><span class="l"><span class="lgd ok"></span>no open issues</span></div>
   <div class="kpi"><span class="l">Open ticket</span><span class="v">${n("warn")}</span><span class="l"><span class="lgd warn"></span>being handled</span></div>
   <div class="kpi"><span class="l">Critical</span><span class="v">${n("crit")}</span><span class="l"><span class="lgd crit"></span>leak, outage or spike</span></div>
   <div class="kpi"><span class="l">Grid load ${src("mg")}</span><span class="v">${Math.round(gridLoad()/GRID_KW*100)}%</span><span class="l">${n1(gridLoad())} of ${GRID_KW} kW</span></div>
  </div>
  <div class="mapgrid">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Synthetic City</h2>${src("mg")}${src("pg")}</div><span class="muted">H home · B business · dashed ring: valve closed</span></div>${mapSvg(sel)}</div>
   <div class="panel">${mapDetail(propById(sel))}</div>
  </div>`;
};
V.map.live=true;

// ---------- analytics ----------
const sumBy=(a,f)=>a.reduce((s,x)=>s+f(x),0);
function analytics(){
  const cycles=PG.billing_cycle.filter(c=>PG.invoice.some(i=>i.cycle_id===c.cycle_id)).sort((a,b)=>a.cycle_id-b.cycle_id);
  const paidOf=i=>sumBy(PG.payment.filter(p=>p.invoice_id===i.invoice_id&&p.status==="SUCCEEDED"),p=>p.amount_paid);
  const money=cycles.map(c=>{ const inv=PG.invoice.filter(i=>i.cycle_id===c.cycle_id);
    return {c,label:MON[c.month],billed:sumBy(inv,i=>i.total_amount),collected:sumBy(inv,paidOf),late:sumBy(PG.invoice_line_item.filter(l=>l.line_kind==="LATE_FEE"&&inv.some(i=>i.invoice_id===l.invoice_id)),l=>l.line_total),n:inv.length,paid:inv.filter(i=>i.payment_status==="PAID").length}; });
  const read=[...new Set(PG.meter_reading.map(r=>r.cycle_id))].sort((a,b)=>a-b);
  const use=read.map(cid=>{ const c=PG.billing_cycle.find(x=>x.cycle_id===cid), o={c,label:MON[c.month]};
    for(const k of Object.keys(UT)) o[k]=sumBy(PG.meter_reading.filter(r=>r.cycle_id===cid&&PG.utility_meter.find(m=>m.meter_id===r.meter_id).utility_type===k),r=>r.total_units_consumed);
    o.kg=sumBy(Object.keys(UT),k=>o[k]*CO2[k]); return o; });
  const last=read[read.length-1];
  const wards=PG.zone.filter(z=>z.zone_level==="WARD").map(z=>{
    const ps=PG.property.filter(p=>p.zone_id===z.zone_id), reps=ps.map(p=>ecoReport(p.property_id));
    const inv=PG.invoice.filter(i=>ps.some(p=>p.property_id===i.property_id));
    const kg=sumBy(ps,p=>kgOf(unitsFor(p.property_id,last)));
    return {z,n:ps.length,kg,kgPer:kg/ps.length,score:Math.round(sumBy(reps,r=>r.score)/reps.length),coll:sumBy(inv,paidOf)/(sumBy(inv,i=>i.total_amount)||1)};
  }).sort((a,b)=>a.kgPer-b.kgPer);
  const tk=PG.maintenance_ticket, done=tk.filter(t=>t.resolved_at);
  const slaMet=done.filter(t=>t.resolved_at<=t.sla_due_at).length;
  return {money,use,wards,tk,done,slaMet,last};
}
const gradeOf=s=>s>=85?"A":s>=70?"B":s>=55?"C":s>=40?"D":"E";

function groupBars(rows,series,fmt){
  const max=Math.max(1,...rows.flatMap(r=>series.map(s=>r[s.k])))*1.12;
  return `<div class="gbars">${rows.map(r=>`<div class="gb"><div class="gcols">${series.map(s=>`<span class="gcol" style="height:${Math.max(1,r[s.k]/max*100)}%;background:${s.c}" title="${s.l}: ${fmt(r[s.k])}"><i>${fmt(r[s.k])}</i></span>`).join("")}</div><span class="lab">${r.label}</span></div>`).join("")}</div>
   <div class="legend">${series.map(s=>`<span><span class="dot" style="background:${s.c}"></span>${s.l}</span>`).join("")}</div>`;
}

V.analytics=()=>{
  const a=analytics(), closed=a.money.filter(m=>Date.parse(m.c.due_date+"T23:59:59+05:30")<now);   // only bills whose due date has passed
  const billed=sumBy(closed,m=>m.billed), coll=sumBy(closed,m=>m.collected), late=sumBy(a.money,m=>m.late);
  const avgRes=a.done.length?sumBy(a.done,t=>t.resolved_at-t.reported_timestamp)/a.done.length:0;
  const k=x=>"₹"+(x/100000).toFixed(1)+"k";
  return `<div class="page-head"><span class="eyebrow">Municipal operations</span><h1>Analytics</h1>
   <p class="ink2">Revenue, consumption and service performance across the city, straight from PostgreSQL. Download any table as CSV for the finance team.</p></div>
  <div class="kpis">
   <div class="kpi"><span class="l">Collection rate ${src("pg")}</span><span class="v">${billed?Math.round(coll/billed*100):0}%</span><span class="l">${inr(coll)} of ${inr(billed)} from bills past their due date</span></div>
   <div class="kpi"><span class="l">Late fees raised ${src("pg")}</span><span class="v">${inr(late)}</span><span class="l">by the nightly overdue job</span></div>
   <div class="kpi"><span class="l">Tickets resolved ${src("pg")}</span><span class="v">${a.done.length}<span class="muted" style="font-size:14px"> / ${a.tk.length}</span></span><span class="l">${a.done.length?`avg ${dur(avgRes)} to fix`:"none resolved yet"}</span></div>
   <div class="kpi"><span class="l">SLA met</span><span class="v">${a.done.length?Math.round(a.slaMet/a.done.length*100)+"%":"–"}</span><span class="l">${a.tk.filter(t=>t.escalated_at).length} escalated</span></div>
  </div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Billed vs collected</h2>${src("pg")}</div><button class="btn small" data-act="csv" data-what="invoices">Invoices CSV</button></div>
    ${groupBars(a.money,[{k:"billed",l:"Billed",c:"var(--pg)"},{k:"collected",l:"Collected",c:"var(--ok)"}],k)}
    <pre class="code" style="margin-top:10px">SELECT c.year, c.month, SUM(i.total_amount) AS billed,
  COALESCE(SUM(p.amount_paid) FILTER (WHERE p.status = 'SUCCEEDED'), 0) AS collected
FROM invoice i JOIN billing_cycle c USING (cycle_id)
LEFT JOIN payment p USING (invoice_id)
GROUP BY ROLLUP ((c.year, c.month)) ORDER BY 1, 2;</pre></div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>City consumption by month</h2>${src("pg")}</div><button class="btn small" data-act="csv" data-what="readings">Readings CSV</button></div>
    <div class="tablewrap"><table><thead><tr><th>Month</th>${Object.keys(UT).map(u=>`<th class="r"><span class="dot" style="background:${UT[u].color}"></span>${UT[u].label}</th>`).join("")}<th class="r">CO₂</th></tr></thead><tbody>
     ${a.use.map(r=>`<tr><td>${r.label}</td>${Object.keys(UT).map(u=>`<td class="r num">${Math.round(r[u]).toLocaleString("en-IN")} ${UT[u].unit}</td>`).join("")}<td class="r num">${(r.kg/1000).toFixed(2)} t</td></tr>`).join("")}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Units come from <code>meter_reading.total_units_consumed</code>, the one row per meter per month written by the aggregation run.</p></div>
  </div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>Greenest wards</h2>${src("pg")}</div><span class="muted">${cycleName(a.last)}</span></div>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Ward</th><th class="r">CO₂ each</th><th>Eco</th><th class="r">Paid</th></tr></thead><tbody>
     ${a.wards.map((w,i)=>`<tr><td>${i+1}</td><td style="white-space:nowrap"><b>${esc(w.z.name)}</b><div class="muted" style="font-size:12px">${esc(zname(w.z.parent_zone_id))}</div></td><td class="r num">${Math.round(w.kgPer)} kg</td><td style="white-space:nowrap">${gradeChip({grade:gradeOf(w.score),score:w.score})} ${w.score}</td><td class="r">${Math.round(w.coll*100)}%</td></tr>`).join("")}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Ranked by CO₂ per property so a ward with more businesses is not punished for its size. Paid = share of the ward's billed amount collected.</p></div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>Tickets by type</h2>${src("pg")}</div><button class="btn small" data-act="csv" data-what="tickets">Tickets CSV</button></div>
    <div class="tablewrap"><table><thead><tr><th>Issue</th><th class="r">Total</th><th class="r">Open</th><th class="r">Resolved</th><th class="r">Avg time to fix</th></tr></thead><tbody>
     ${[...new Set(a.tk.map(t=>t.issue_type))].map(it=>{const ts=a.tk.filter(t=>t.issue_type===it), d=ts.filter(t=>t.resolved_at);return `<tr><td>${esc(it.replace("_"," ").toLowerCase())}</td><td class="r">${ts.length}</td><td class="r">${ts.filter(t=>ACTIVE.includes(t.status)).length}</td><td class="r">${d.length}</td><td class="r">${d.length?dur(sumBy(d,t=>t.resolved_at-t.reported_timestamp)/d.length):"–"}</td></tr>`;}).join("")||`<tr><td colspan="5" class="muted">No tickets yet. Start a scenario in the Disaster simulator.</td></tr>`}</tbody></table></div></div>
  </div>`;
};
V.analytics.live=true;

// ---------- CSV export ----------
const isoIST=t=>t?new Date(t).toLocaleString("sv-SE",IST)+" +05:30":"";
const paidOn=i=>{ const p=PG.payment.find(x=>x.invoice_id===i.invoice_id&&x.status==="SUCCEEDED"); return p?p.payment_date:null; };
const csvCell=v=>v==null?"":/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);
function csvDownload(name,head,rows){
  const text=[head,...rows].map(r=>r.map(csvCell).join(",")).join("\n");
  const url=URL.createObjectURL(new Blob([text],{type:"text/csv"}));
  const a=document.createElement("a"); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  return rows.length;
}
const CSV={
  invoices:()=>csvDownload("invoices.csv",["invoice_no","month","property_code","ward","total_inr","late_fee_inr","status","paid_at"],
    PG.invoice.slice().sort((a,b)=>a.cycle_id-b.cycle_id||a.invoice_no.localeCompare(b.invoice_no)).map(i=>{const p=propById(i.property_id);return [i.invoice_no,cycleName(i.cycle_id),p.property_code,zname(p.zone_id),(i.total_amount/100).toFixed(2),(sumBy(PG.invoice_line_item.filter(l=>l.invoice_id===i.invoice_id&&l.line_kind==="LATE_FEE"),l=>l.line_total)/100).toFixed(2),i.payment_status,isoIST(paidOn(i))];})),
  readings:()=>csvDownload("monthly-readings.csv",["month","meter_code","property_code","utility","opening_register","closing_register","units"],
    PG.meter_reading.slice().sort((a,b)=>a.cycle_id-b.cycle_id).map(r=>{const m=PG.utility_meter.find(x=>x.meter_id===r.meter_id);return [cycleName(r.cycle_id),m.meter_code,propById(m.property_id).property_code,m.utility_type,r.opening_register,r.closing_register,r.total_units_consumed];})),
  tickets:()=>csvDownload("tickets.csv",["ticket_no","property_code","issue","severity","status","source","reported_at","sla_due_at","resolved_at","assigned_to"],
    PG.maintenance_ticket.map(t=>[t.ticket_no,propById(t.property_id).property_code,t.issue_type,t.severity,t.status,t.source,isoIST(t.reported_timestamp),isoIST(t.sla_due_at),isoIST(t.resolved_at),t.assigned_to?userById(t.assigned_to).display:""])),
};
const CSV_SQL={invoices:"COPY (SELECT i.invoice_no, c.month, p.property_code, i.total_amount, i.payment_status, i.paid_at\n      FROM invoice i JOIN billing_cycle c USING (cycle_id) JOIN property p USING (property_id)\n      ORDER BY c.cycle_id, i.invoice_no) TO STDOUT WITH CSV HEADER;",
  readings:"COPY (SELECT cycle_id, meter_id, opening_register, closing_register, total_units_consumed\n      FROM meter_reading ORDER BY cycle_id) TO STDOUT WITH CSV HEADER;",
  tickets:"COPY (SELECT ticket_no, property_id, issue_type, severity, status, reported_timestamp, sla_due_at, resolved_at\n      FROM maintenance_ticket ORDER BY ticket_no) TO STDOUT WITH CSV HEADER;"};

document.addEventListener("click",e=>{
  const b=e.target.closest("[data-act]"); if(!b) return;
  const a=b.dataset.act;
  if(a==="map-sel"){ SESSION.sel.mapProp=b.dataset.id; render(); }
  if(a==="csv"){ const n=CSV[b.dataset.what](); log("pg",`Exported ${b.dataset.what} as CSV (${n} row${n===1?"":"s"})`,CSV_SQL[b.dataset.what]); renderRail(); toast(`Downloaded ${b.dataset.what}.csv (${n} row${n===1?"":"s"})`); }
  if(a==="valve-open"){ const m=meterByCode(b.dataset.code); valve(m,false,"reopened from the city map",SESSION.user.display); render(); }
});
document.addEventListener("keydown",e=>{ if((e.key==="Enter"||e.key===" ")&&e.target.matches?.('.pin[data-act="map-sel"]')){ e.preventDefault(); e.target.dispatchEvent(new MouseEvent("click",{bubbles:true})); } });
