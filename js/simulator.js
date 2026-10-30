"use strict";
/* IoT simulator (MongoDB time-series readings), anomaly detection and the aggregations the screens use. */

// ---------- IoT simulator: MongoDB time-series readings ----------
const SIM={running:true,mode:{},offline:new Set(),timer:null};
const profile=(m,t)=>{ // hourly-shaped demand, in kW / L/min / m³/h
  const h=Number(new Date(t).toLocaleString("en-GB",{...IST,hour:"2-digit",hour12:false}))%24;
  const p=propById(m.property_id), com=p.property_type==="COMMERCIAL";
  const day=com?(h>=8&&h<20?1:0.25):(h>=6&&h<9?1:h>=18&&h<23?1.25:h>=0&&h<5?0.25:0.55);
  if(m.utility_type==="ELECTRICITY") return (com?2.6:0.75)*day*rand(0.85,1.15);
  if(m.utility_type==="WATER") return Math.max(0.05,(com?0.9:0.5)*day*rand(0.6,1.3)-(h<5?0.3:0));
  return (com?0.12:0.04)*day*rand(0.8,1.2);
};
function makeReading(m,t){
  const p=propById(m.property_id); const mode=SIM.mode[m.meter_code];
  let rate=profile(m,t);
  if(mode==="BURST") rate=rand(13.5,15.5);
  if(mode==="SPIKE") rate=rand(8.5,10.5);
  if(mode==="OFF") rate=0; // supply switched off: the meter keeps reporting, usage stays at zero
  // advance the cumulative register by 15 minutes of use
  const inc=m.utility_type==="ELECTRICITY"?rate*TICK_MIN/60:m.utility_type==="WATER"?rate*TICK_MIN/1000:rate*TICK_MIN/60;
  const reg=Math.round((register.get(m.meter_code)+inc)*1000)/1000; register.set(m.meter_code,reg);
  const meta={meter_code:m.meter_code,property_code:p.property_code,utility:m.utility_type,zone:zname(p.zone_id)};
  const doc={_id:"r"+Math.floor(rnd()*1e12).toString(36),ts:t,meta};
  if(m.utility_type==="ELECTRICITY"){ Object.assign(doc,{kwh_total:reg,voltage:Math.round(rand(226,234)*10)/10,current:Math.round(rate*1000/230*10)/10,power_factor:Math.round(rand(0.9,0.98)*100)/100,_rate:rate}); }
  else if(m.utility_type==="WATER"){ Object.assign(doc,{volume_l_total:Math.round(reg*1000),flow_lpm:Math.round(rate*100)/100,pressure_psi:Math.round((mode==="BURST"?rand(22,28):rand(55,62))*10)/10,_rate:rate}); }
  else { Object.assign(doc,{m3_total:reg,pressure_kpa:Math.round(rand(2.0,2.2)*100)/100,_rate:rate}); }
  return doc;
}
const regOf=d=>d.kwh_total??(d.volume_l_total!=null?d.volume_l_total/1000:d.m3_total);
function mongoInsert(docs){
  for(const d of docs){ MG.meter_readings.push(d); if(!byMeter.has(d.meta.meter_code)) byMeter.set(d.meta.meter_code,[]); byMeter.get(d.meta.meter_code).push(d); }
}
function retention(){ // keep the cycle-opening doc + last 30 h per meter in this prototype
  const cut=now-30*HOUR;
  for(const [k,arr] of byMeter){ let i=1; while(i<arr.length&&arr[i].ts<cut) i++; if(i>1) arr.splice(1,i-1); }
  MG.meter_readings=MG.meter_readings.filter(d=>d.ts>=cut||d._opening);
}
// opening docs at Oct 1 (register = September closing), then 48 h of backfill
PG.utility_meter.forEach(m=>{
  const meta={meter_code:m.meter_code,property_code:propById(m.property_id).property_code,utility:m.utility_type,zone:zname(propById(m.property_id).zone_id)};
  const reg=register.get(m.meter_code);
  const d={_id:"open-"+m.meter_code,ts:OCT1,meta,_opening:true,_rate:0};
  if(m.utility_type==="ELECTRICITY") d.kwh_total=reg; else if(m.utility_type==="WATER") d.volume_l_total=Math.round(reg*1000); else d.m3_total=reg;
  mongoInsert([d]);
  // usage from Oct 1 to the start of the backfill window
  const hrs=(SIM_START-48*HOUR-OCT1)/HOUR; const p=propById(m.property_id);
  const avg={ELECTRICITY:p.property_type==="COMMERCIAL"?1.15:0.5,WATER:(p.property_type==="COMMERCIAL"?0.55:0.35)*60/1000,GAS:p.property_type==="COMMERCIAL"?0.06:0.025}[m.utility_type];
  register.set(m.meter_code,Math.round((reg+avg*hrs*rand(0.9,1.1))*1000)/1000);
});
for(let t=SIM_START-48*HOUR+TICK;t<=SIM_START;t+=TICK) mongoInsert(PG.utility_meter.map(m=>makeReading(m,t)));
MG.ingestion_batches.push({_id:"backfill-seed-42",seed:42,meters:24,count:24*192,from:SIM_START-48*HOUR,to:SIM_START,status:"DONE"});

// ---------- anomaly detection (explainable rules) ----------
const RULES={LEAK:{min_flow:2,window_ticks:4},SPIKE:{factor:3,min_kw:3},MISSING:{ticks:3}};
function lastN(code,n){ const a=byMeter.get(code)||[]; return a.slice(Math.max(1,a.length-n)); }
function baselineKW(code){ const a=(byMeter.get(code)||[]).filter(d=>!d._opening&&d.ts<now-HOUR&&d.ts>=now-25*HOUR); if(!a.length) return 0.6; return Math.max(0.1,a.reduce((s,d)=>s+d._rate,0)/a.length); } // floor: a meter that was switched off has no baseline
function detect(){
  for(const m of PG.utility_meter){
    const arr=byMeter.get(m.meter_code); const last=arr[arr.length-1];
    if(m.utility_type==="WATER"){
      const w=lastN(m.meter_code,RULES.LEAK.window_ticks);
      if(w.length===RULES.LEAK.window_ticks&&w.every(d=>d.flow_lpm>RULES.LEAK.min_flow)){
        raise(m,"LEAK","CRITICAL",`Water kept flowing above ${RULES.LEAK.min_flow} L/min for ${RULES.LEAK.window_ticks*TICK_MIN}+ min (now ${n1(last.flow_lpm)} L/min, pressure ${last.pressure_psi} psi). This home normally uses 0.1–0.7 L/min.`,{flow_lpm:last.flow_lpm,pressure_psi:last.pressure_psi});
      }
    }
    if(m.utility_type==="ELECTRICITY"&&last&&!last._opening){
      const base=baselineKW(m.meter_code);
      if(last._rate>RULES.SPIKE.min_kw&&last._rate>RULES.SPIKE.factor*base){
        raise(m,"VOLTAGE_SPIKE","HIGH",`Demand is ${n1(last._rate)} kW, ${n1(last._rate/base)}× the 24-hour baseline of ${n2(base)} kW (rule: above ${RULES.SPIKE.factor}× and above ${RULES.SPIKE.min_kw} kW).`,{kw:Math.round(last._rate*100)/100,baseline_kw:Math.round(base*100)/100});
      }
    }
  }
  // missing data: one ticket per property, listing every silent meter
  for(const p of PG.property){
    const silent=metersOf(p.property_id).filter(m=>{const a=byMeter.get(m.meter_code);return now-a[a.length-1].ts>=RULES.MISSING.ticks*TICK;});
    if(!silent.length) continue;
    const a=byMeter.get(silent[0].meter_code), ls=a[a.length-1].ts;
    raise(silent[0],"MISSING_DATA","MEDIUM",`${silent.length} meter${silent.length>1?"s":""} silent for ${Math.round((now-ls)/60e3)} min (${silent.map(m=>m.meter_code).join(", ")}; last seen ${fmtT(ls)}). Rule: no reading for ${RULES.MISSING.ticks*TICK_MIN}+ min. Likely a local outage.`,{silent_meters:silent.map(m=>m.meter_code),last_seen:new Date(ls).toISOString()},`MISSING_DATA:${p.property_code}`);
  }
}
function raise(m,type,severity,reason,data,keyOverride){
  const key=keyOverride||`${type}:${m.meter_code}`; const p=propById(m.property_id);
  // 1) MongoDB: upsert the anomaly event (this document is also the outbox)
  let ev=MG.anomaly_events.find(e=>e.key===key&&e.status!=="RESOLVED");
  if(ev){ ev.last_seen=now; ev.hits++; ev.observed=data; ev.reason=reason; }
  else { ev={_id:`${key}:${MG.anomaly_events.length+1}`,key,type,meter_code:m.meter_code,property_code:p.property_code,zone:zname(p.zone_id),severity,detected_at:now,last_seen:now,hits:1,observed:data,reason,status:"OPEN",ticket_no:null,synced_to_sql:false}; MG.anomaly_events.push(ev); }
  log("mg",ev.hits===1?`Anomaly detected: ${type} on ${m.meter_code}`:`Anomaly continues: ${type} on ${m.meter_code} (×${ev.hits})`,
    `db.anomaly_events.updateOne(\n  { key: "${key}", status: { $ne: "RESOLVED" } },\n  { $setOnInsert: { type: "${type}", severity: "${severity}", detected_at: ISODate("${new Date(now).toISOString()}") },\n    $set: { last_seen: ISODate(…), reason: "${reason.slice(0,60)}…" }, $inc: { hits: 1 } },\n  { upsert: true })`,{collapse:ev.hits>1?"ev-"+key:null});
  // 2) PostgreSQL: open or touch the ticket (idempotent through the partial unique index)
  const issue={LEAK:"LEAK",VOLTAGE_SPIKE:"VOLTAGE_SPIKE",MISSING_DATA:"POWER_OUTAGE"}[type];
  let t=PG.maintenance_ticket.find(x=>x.anomaly_key===key&&ACTIVE.includes(x.status));
  const stmt=`SELECT fn_open_anomaly_ticket(\n  '${p.property_code}', '${m.meter_code}', '${key}', '${issue}', '${severity}', $reason);\n-- INSERT … ON CONFLICT (anomaly_key) WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS')\n--   DO UPDATE SET last_seen_at = now(), occurrence_count = occurrence_count + 1`;
  if(t){ t.last_seen_at=now; t.occurrence_count++; log("pg",`Ticket ${t.ticket_no} updated (occurrence ${t.occurrence_count}), no duplicate created`,stmt,{collapse:"tk-"+key}); }
  else {
    t=insert("maintenance_ticket",{ticket_id:uid(),ticket_no:`MT-${String(++tktSeq).padStart(4,"0")}`,property_id:p.property_id,meter_id:m.meter_id,source:"ANOMALY",anomaly_key:key,issue_type:issue,severity,description:reason,status:"OPEN",assigned_to:null,reported_timestamp:now,last_seen_at:now,occurrence_count:1,resolved_at:null,resolution_notes:null});
    const prevStatus=p.service_status; p.service_status="UNDER_INVESTIGATION";
    log("pg",`Ticket ${t.ticket_no} opened automatically (${severity})${prevStatus!==p.service_status?`; ${p.property_code} marked UNDER_INVESTIGATION`:""}`,stmt);
    MG.maintenance_logs.push({_id:"log-"+t.ticket_no,ticket_no:t.ticket_no,entries:[{at:now,by:"anomaly-detector",kind:"SENSOR_SNAPSHOT",text:reason,data}],attachments:[]});
    log("mg",`Ticket log started for ${t.ticket_no}`,`db.maintenance_logs.insertOne({ ticket_no: "${t.ticket_no}",\n  entries: [ { by: "anomaly-detector", kind: "SENSOR_SNAPSHOT", data: ${JSON.stringify(data)} } ] })`);
    const owner=PG.app_user.find(u=>u.resident_id===p.resident_id);
    if(owner){ MG.notifications.push({_id:"n"+(MG.notifications.length+1),user_id:owner.user_id,kind:"ALERT",title:type==="MISSING_DATA"?`Meters offline at ${p.property_code}`:`${UT[m.utility_type].label} alert at ${p.property_code}`,body:reason,created_at:now,read_at:null});
      log("mg",`Alert sent to ${owner.display}`,`db.notifications.insertOne({ user_id: "${owner.user_id.slice(0,8)}…", kind: "ALERT", title: "${UT[m.utility_type].label} alert at ${p.property_code}" })`); }
  }
  // 3) mark the outbox entry as synced
  if(!ev.synced_to_sql){ ev.synced_to_sql=true; ev.ticket_no=t.ticket_no; }
}

// ---------- simulator tick ----------
function tick(){
  now+=TICK;
  const docs=PG.utility_meter.filter(m=>!SIM.offline.has(m.meter_code)).map(m=>makeReading(m,now));
  mongoInsert(docs); retention();
  log("mg",`Smart meters reported ${docs.length} readings`,`db.meter_readings.insertMany([ …${docs.length} docs… ], { ordered: false })\n// e.g. ${JSON.stringify(stripDoc(docs.find(d=>d.meta.utility==="WATER")||docs[0]))}`,{collapse:"ingest"});
  detect();
  if(now>=NOV1&&octoberOpen()) return closeOctober(); // the clock just crossed month end
  render(true);
}
// fast-forward the meters to midnight on 1 November, one 15-minute reading at a time
function fastForwardTo(t){
  const from=now; let n=0;
  while(now<t){
    now+=TICK;
    const docs=PG.utility_meter.filter(m=>!SIM.offline.has(m.meter_code)).map(m=>makeReading(m,now));
    mongoInsert(docs); detect(); n+=docs.length;
  }
  retention();
  log("mg",`Smart meters reported ${n.toLocaleString("en-IN")} readings (${fmtDT(from)} → ${fmtDT(now)})`,`db.meter_readings.insertMany([ …${n} docs, one per meter every 15 min… ], { ordered: false })`);
  return n;
}
function stripDoc(d){ const o={}; for(const k in d){ if(!k.startsWith("_")||k==="_id") o[k]=k==="ts"?`ISODate("${new Date(d.ts).toISOString()}")`:d[k]; } return o; }
function setRunning(on){ SIM.running=on; clearInterval(SIM.timer); if(on) SIM.timer=setInterval(autoTick,2000); renderTop(); }
// with shared data (server.js) only one browser drives the clock; see js/sync.js
function autoTick(){ if(typeof Sync==="undefined"||Sync.drivesClock()){ tick(); if(typeof Sync!=="undefined") Sync.ticked(); } }

// ---------- MongoDB aggregations used by the screens ----------
function seriesFor(code,hours=24){ // 15-min points: kW, L/min or m³/h
  return (byMeter.get(code)||[]).filter(d=>!d._opening&&d.ts>now-hours*HOUR).map(d=>({t:d.ts,v:d.flow_lpm??d._rate}));
}
function citySeries(utility,hours=24){
  const map=new Map();
  for(const m of PG.utility_meter.filter(x=>x.utility_type===utility)) for(const d of (byMeter.get(m.meter_code)||[])){ if(d._opening||d.ts<=now-hours*HOUR) continue; map.set(d.ts,(map.get(d.ts)||0)+(d.flow_lpm??d._rate)); }
  return [...map.entries()].sort((a,b)=>a[0]-b[0]).map(([t,v])=>({t,v}));
}
function cycleTotals(code,from,to){ // pipeline 3: first/last register in window
  const a=(byMeter.get(code)||[]).filter(d=>d.ts>=from&&d.ts<=to);
  if(!a.length) return null;
  return {opening:regOf(a[0]),closing:regOf(a[a.length-1]),count:a.length};
}
const PIPE_CYCLE=`db.meter_readings.aggregate([
  { $match: { ts: { $gte: ISODate("2026-10-01T00:00+05:30"), $lte: <now> } } },
  { $sort:  { "meta.meter_code": 1, ts: 1 } },
  { $group: { _id: "$meta.meter_code",
      opening: { $first: { $ifNull: ["$kwh_total", { $ifNull: ["$m3_total", { $divide: ["$volume_l_total", 1000] }] }] } },
      closing: { $last:  { $ifNull: ["$kwh_total", { $ifNull: ["$m3_total", { $divide: ["$volume_l_total", 1000] }] }] } },
      docs:    { $sum: 1 } } }
])`;

