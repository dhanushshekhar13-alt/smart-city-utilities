"use strict";
/* ================================================================
   Smart City Utilities: browser prototype.
   Two in-memory stores stand in for the real databases:
     PG  = PostgreSQL tables (system of record, rules enforced here)
     MG  = MongoDB collections (raw meter readings, logs, alerts)
   Every operation is written to the activity rail with the SQL or
   Mongo statement the real build will run.
   ================================================================ */

// ---------- deterministic randomness (seed 42) ----------
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
let rnd = mulberry32(42);
const rand=(a,b)=>a+(b-a)*rnd();
const uid=()=>{const h=()=>Math.floor(rnd()*65536).toString(16).padStart(4,"0");return `${h()}${h()}-${h()}-4${h().slice(1)}-${h()}-${h()}${h()}${h()}`;};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

// ---------- time ----------
const IST={timeZone:"Asia/Kolkata"};
const HOUR=3600e3, TICK_MIN=15, TICK=TICK_MIN*60e3;
const SIM_START=Date.parse("2026-10-25T08:00:00+05:30");
const OCT1=Date.parse("2026-10-01T00:00:00+05:30");
const NOV1=Date.parse("2026-11-01T00:00:00+05:30"); // October cycle closes here
let now=SIM_START;
const fmtT=t=>new Date(t).toLocaleTimeString("en-IN",{...IST,hour:"2-digit",minute:"2-digit",hour12:false});
const fmtDT=t=>new Date(t).toLocaleString("en-IN",{...IST,day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",hour12:false});
const fmtD=d=>new Date(d+"T00:00:00+05:30").toLocaleDateString("en-IN",{...IST,day:"numeric",month:"short",year:"numeric"});
const inr=paise=>"₹"+(paise/100).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
const n1=v=>Number(v).toLocaleString("en-IN",{maximumFractionDigits:1});
const n2=v=>Number(v).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});

// ---------- schema constants ----------
const UT={ELECTRICITY:{code:"E",unit:"kWh",rate:"kW",label:"Electricity",color:"var(--elec)"},
          WATER:{code:"W",unit:"kL",rate:"L/min",label:"Water",color:"var(--water)"},
          GAS:{code:"G",unit:"m³",rate:"m³/h",label:"Gas",color:"var(--gas)"}};
const ACTIVE=["OPEN","ASSIGNED","IN_PROGRESS"];
const TRANSITIONS={OPEN:["ASSIGNED"],ASSIGNED:["IN_PROGRESS"],IN_PROGRESS:["RESOLVED"],RESOLVED:["CLOSED","IN_PROGRESS"],CLOSED:[]};

// ---------- stores ----------
const PG={zone:[],resident:[],property:[],utility_meter:[],billing_cycle:[],utility_rate:[],aggregation_run:[],meter_reading:[],
          invoice:[],invoice_line_item:[],payment:[],maintenance_ticket:[],ticket_status_history:[],app_user:[],user_session:[]};
const MG={meter_readings:[],anomaly_events:[],maintenance_logs:[],notifications:[],ingestion_batches:[]};
const byMeter=new Map(); // index on meta.meter_code (stands in for { "meta.meter_code": 1, ts: -1 })

// ---------- activity log ----------
const LOG=[];
function log(db,title,stmt,opts={}){
  const last=LOG[0];
  if(opts.collapse){ const i=LOG.slice(0,25).findIndex(e=>e.collapse===opts.collapse);
    if(i>=0){ const e=LOG.splice(i,1)[0]; e.count++; e.at=now; e.title=title; e.stmt=stmt; LOG.unshift(e); renderRail(); return; } }
  LOG.unshift({db,title,stmt,err:opts.err||null,at:now,count:1,collapse:opts.collapse||null});
  if(LOG.length>120) LOG.pop();
  renderRail();
}

// ---------- PostgreSQL rule engine (constraints the real DDL declares) ----------
class PgError extends Error{constructor(msg){super(msg);}}
const UNIQ={
  resident:[{cols:["email"],name:"resident_email_key"},{cols:["citizen_ref"],name:"resident_citizen_ref_key"}],
  billing_cycle:[{cols:["year","month"],name:"billing_cycle_year_month_key"}],
  meter_reading:[{cols:["meter_id","cycle_id"],name:"meter_reading_meter_id_cycle_id_key"}],
  invoice:[{cols:["property_id","cycle_id"],name:"invoice_property_id_cycle_id_key"}],
  invoice_line_item:[{cols:["invoice_id","utility_type","line_kind","tier_level"],name:"invoice_line_item_invoice_id_utility_type_line_kind_tier_level_key"}],
  payment:[{cols:["idempotency_key"],name:"payment_idempotency_key_key"},{cols:["invoice_id"],where:r=>r.status==="SUCCEEDED",name:"uq_one_success_per_invoice"}],
  maintenance_ticket:[{cols:["anomaly_key"],where:r=>r.anomaly_key&&ACTIVE.includes(r.status),name:"uq_active_anomaly_ticket"}],
};
const CHECKS={
  billing_cycle:r=>{ if(!(r.month>=1&&r.month<=12)) return "billing_cycle_month_check";
    if(!(r.cycle_start_date<r.cycle_end_date&&r.cycle_end_date<r.due_date)) return "billing_cycle_check"; },
  resident:r=>{ if(!/^SYN-/.test(r.citizen_ref)) return "resident_citizen_ref_check"; if(r.email!==r.email.toLowerCase()||!r.email.includes("@")) return "resident_email_check"; },
  utility_rate:r=>{ if(!(r.price_per_unit>0)) return "utility_rate_price_per_unit_check"; if(r.max_units!=null&&!(r.max_units>r.min_units)) return "utility_rate_check"; },
  meter_reading:r=>{ if(!(r.closing_register>=r.opening_register)) return "meter_reading_check"; },
  invoice:r=>{ if(!(r.total_amount>=0)) return "invoice_total_amount_check"; },
  payment:r=>{ if(!(r.amount_paid>0)) return "payment_amount_paid_check"; },
  maintenance_ticket:r=>{ if(["RESOLVED","CLOSED"].includes(r.status)&&!(r.resolved_at&&r.resolution_notes)) return "maintenance_ticket_check"; if(!r.description||r.description.length<5) return "maintenance_ticket_description_check"; },
};
const dateOverlap=(a1,a2,b1,b2)=> (a1<(b2??"9999-12-31")) && (b1<(a2??"9999-12-31"));
function checkRow(table,row,selfRef){
  const ck=CHECKS[table]&&CHECKS[table](row);
  if(ck) throw new PgError(`ERROR:  new row for relation "${table}" violates check constraint "${ck}"`);
  for(const u of UNIQ[table]||[]){
    if(u.where&&!u.where(row)) continue;
    const clash=PG[table].find(o=>o!==selfRef&&(!u.where||u.where(o))&&u.cols.every(c=>o[c]===row[c]));
    if(clash) throw new PgError(`ERROR:  duplicate key value violates unique constraint "${u.name}"\nDETAIL:  Key (${u.cols.join(", ")})=(${u.cols.map(c=>short(row[c])).join(", ")}) already exists.`);
  }
  if(table==="utility_rate"){
    const clash=PG.utility_rate.find(o=>o!==selfRef&&o.utility_type===row.utility_type&&o.tier_level===row.tier_level&&dateOverlap(o.effective_start_date,o.effective_end_date,row.effective_start_date,row.effective_end_date));
    if(clash) throw new PgError(`ERROR:  conflicting key value violates exclusion constraint "utility_rate_excl_no_overlap"\nDETAIL:  Key (utility_type, tier_level, daterange(effective_start_date, effective_end_date))=(${row.utility_type}, ${row.tier_level}, [${row.effective_start_date},${row.effective_end_date??""})) conflicts with existing key (${o2s(clash)}).`);
  }
}
const o2s=c=>`${c.utility_type}, ${c.tier_level}, [${c.effective_start_date},${c.effective_end_date??""})`;
const short=v=>typeof v==="string"&&v.length>20?v.slice(0,8)+"…":v;
const computed=(t,r)=>{ if(t==="meter_reading") r.total_units_consumed=Math.round((r.closing_register-r.opening_register)*1000)/1000; };
function insert(table,row){ computed(table,row); checkRow(table,row,null); PG[table].push(row); trgAfter(table,null,row); return row; }
function update(table,row,patch){
  const next={...row,...patch}; computed(table,next);
  trgBefore(table,row,next);
  checkRow(table,next,row);
  const old={...row}; Object.assign(row,next); trgAfter(table,old,row); return row;
}
// triggers
function trgBefore(table,old,next){
  if(table==="maintenance_ticket"&&old.status!==next.status){
    if(!TRANSITIONS[old.status].includes(next.status)) throw new PgError(`ERROR:  ILLEGAL_TRANSITION: ${old.status} -> ${next.status} is not allowed\nCONTEXT:  PL/pgSQL function trg_ticket_transition() line 9 at RAISE`);
    if(next.status==="ASSIGNED"&&!next.assigned_to) throw new PgError(`ERROR:  ASSIGNEE_REQUIRED: a ticket must have assigned_to before ASSIGNED\nCONTEXT:  PL/pgSQL function trg_ticket_transition()`);
    if(next.status==="RESOLVED") next.resolved_at=now;
  }
  if(table==="meter_reading"){
    const m=PG.utility_meter.find(x=>x.meter_id===old.meter_id);
    if(PG.invoice.some(i=>i.property_id===m.property_id&&i.cycle_id===old.cycle_id)) throw new PgError(`ERROR:  READING_LOCKED: meter ${m.meter_code} is already invoiced for cycle ${old.cycle_id}\nCONTEXT:  PL/pgSQL function trg_reading_locked()`);
  }
  if(table==="invoice_line_item"){
    const inv=PG.invoice.find(i=>i.invoice_id===old.invoice_id);
    if(inv.payment_status==="PAID") throw new PgError(`ERROR:  INVOICE_LOCKED: invoice ${inv.invoice_no} is paid and cannot change\nCONTEXT:  PL/pgSQL function trg_invoice_total()`);
  }
}
function trgAfter(table,old,row){
  if(table==="maintenance_ticket"&&(!old||old.status!==row.status)){
    PG.ticket_status_history.push({history_id:PG.ticket_status_history.length+1,ticket_id:row.ticket_id,from_status:old?old.status:null,to_status:row.status,changed_by:(!old&&row.source==="ANOMALY")||!SESSION.user?null:SESSION.user.user_id,changed_at:now});
  }
  if(table==="invoice_line_item"){
    const inv=PG.invoice.find(i=>i.invoice_id===row.invoice_id);
    inv.total_amount=PG.invoice_line_item.filter(l=>l.invoice_id===inv.invoice_id).reduce((s,l)=>s+l.line_total,0);
  }
  if(table==="payment"&&row.status==="SUCCEEDED"&&(!old||old.status!=="SUCCEEDED")){
    const inv=PG.invoice.find(i=>i.invoice_id===row.invoice_id);
    inv.payment_status="PAID"; inv.paid_at=now;
  }
}

// ---------- row-level security (what resident_role / staff_role / admin_role may see) ----------
function zoneSubtree(zid){ const out=[zid]; for(let i=0;i<out.length;i++) PG.zone.filter(z=>z.parent_zone_id===out[i]).forEach(z=>out.push(z.zone_id)); return out; }
function visibleProperties(u){
  if(u.role==="ADMIN") return PG.property;
  if(u.role==="RESIDENT") return PG.property.filter(p=>p.resident_id===u.resident_id);
  const zs=zoneSubtree(u.staff_zone_id); return PG.property.filter(p=>zs.includes(p.zone_id));
}
const visiblePropIds=u=>new Set(visibleProperties(u).map(p=>p.property_id));
function rlsInvoices(u){ if(u.role==="ADMIN") return PG.invoice; if(u.role==="STAFF") return []; const ids=visiblePropIds(u); return PG.invoice.filter(i=>ids.has(i.property_id)); }
function rlsTickets(u){ const ids=visiblePropIds(u); return PG.maintenance_ticket.filter(t=>u.role==="ADMIN"||ids.has(t.property_id)); }
const roleOf=u=>({RESIDENT:"resident_role",STAFF:"staff_role",ADMIN:"admin_role"})[u.role];
const sqlCtx=u=>`BEGIN;\nSET LOCAL ROLE ${roleOf(u)};\nSELECT set_config('app.user_id', '${u.user_id.slice(0,8)}…', true);\n`;
