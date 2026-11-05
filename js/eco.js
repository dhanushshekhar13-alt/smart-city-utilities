"use strict";
/* Sustainability insights for residents: carbon footprint, comparison with similar properties, eco score and habit tips.
   Monthly figures come from PostgreSQL meter_reading; habit checks read the last 24 h of MongoDB readings. */

// approximate emission factors, kg CO2e per billing unit (Indian grid average; water = pumping and treatment)
const CO2={ELECTRICITY:0.71,WATER:0.35,GAS:2.0};
const CAR_KG_PER_KM=0.17;            // average petrol car
const TREE_KG_PER_MONTH=1.75;        // one mature tree absorbs about 21 kg CO2 a year

const latestCycleFor=pid=>Math.max(0,...PG.meter_reading.filter(r=>metersOf(pid).some(m=>m.meter_id===r.meter_id)).map(r=>r.cycle_id));
function unitsFor(pid,cyc){
  const o={};
  for(const m of metersOf(pid)){ const r=PG.meter_reading.find(x=>x.meter_id===m.meter_id&&x.cycle_id===cyc); o[m.utility_type]=r?r.total_units_consumed:null; }
  return o;
}
const kgOf=u=>Object.keys(CO2).reduce((s,k)=>s+(u[k]||0)*CO2[k],0);
const median=a=>{ const s=a.slice().sort((x,y)=>x-y), n=s.length; return n?(n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2):0; };
// marginal price: the slab the next unit falls in
const marginal=(ut,units,asOf)=>{ const s=PG.utility_rate.filter(r=>r.utility_type===ut&&r.effective_start_date<=asOf&&(!r.effective_end_date||asOf<r.effective_end_date)).find(r=>units>=r.min_units&&(r.max_units==null||units<r.max_units)); return s?s.price_per_unit*100:0; };   // in paise, like every amount

// similar = same property type in the same district; widen to the whole city if fewer than 3
function peerGroup(p){
  const same=PG.property.filter(q=>q.property_type===p.property_type&&districtOf(q.zone_id)===districtOf(p.zone_id));
  if(same.length>=3) return {list:same,label:`${p.property_type==="COMMERCIAL"?"businesses":"homes"} in ${zname(districtOf(p.zone_id))}`};
  return {list:PG.property.filter(q=>q.property_type===p.property_type),label:`${p.property_type==="COMMERCIAL"?"businesses":"homes"} across the city`};
}

// hour of day in city time
const istHour=t=>Number(new Date(t).toLocaleString("en-GB",{...IST,hour:"2-digit",hour12:false}))%24;
function habits(pid){
  const last=code=>(byMeter.get(code)||[]).filter(d=>!d._opening&&d.ts>now-24*HOUR);
  const e=metersOf(pid).find(m=>m.utility_type==="ELECTRICITY"), w=metersOf(pid).find(m=>m.utility_type==="WATER");
  const ed=last(e.meter_code), wd=last(w.meter_code);
  const base=ed.length?Math.min(...ed.map(d=>d._rate)):0;
  const tot=ed.reduce((s,d)=>s+d._rate,0), peak=ed.filter(d=>{const h=istHour(d.ts);return h>=18&&h<22;}).reduce((s,d)=>s+d._rate,0);
  const night=wd.filter(d=>{const h=istHour(d.ts);return h>=1&&h<5;});
  const nightMin=night.length?Math.min(...night.map(d=>d.flow_lpm)):null;
  const recent=wd.filter(d=>d.ts>now-3*HOUR), recentMin=recent.length>=8?Math.min(...recent.map(d=>d.flow_lpm)):0;
  return {base,peakShare:tot?peak/tot:0,nightMin,recentMin,hours:ed.length/4};
}

function ecoReport(pid){
  const p=propById(pid), cyc=latestCycleFor(pid), asOf=PG.billing_cycle.find(c=>c.cycle_id===cyc).cycle_end_date;
  const mine=unitsFor(pid,cyc), g=peerGroup(p);
  const peers=g.list.map(q=>({p:q,u:unitsFor(q.property_id,cyc)}));
  const cmp=Object.keys(UT).map(ut=>{
    const vals=peers.map(x=>x.u[ut]).filter(v=>v!=null), med=median(vals), you=mine[ut]||0;
    const more=peers.filter(x=>x.p.property_id!==pid&&x.u[ut]>you).length;
    return {ut,you,med,min:Math.min(...vals),max:Math.max(...vals),ratio:med?you/med:1,more,others:peers.length-1,vals};
  });
  const kg=kgOf(mine), peerKg=median(peers.map(x=>kgOf(x.u)));
  const f=forecast(pid), soFarKg=f.rows.reduce((s,r)=>s+r.used*CO2[r.m.utility_type],0), projKg=f.rows.reduce((s,r)=>s+r.proj*CO2[r.m.utility_type],0);
  const h=habits(pid), com=p.property_type==="COMMERCIAL";
  const tips=[];
  if(h.recentMin>2){
    const kl=h.recentMin*60*24*30/1000;
    tips.push({lvl:"crit",title:"Water has not stopped for 3 hours",body:`Flow never fell below ${n2(h.recentMin)} L/min in the last 3 hours. Normal use comes and goes, so this is almost certainly a burst or leak. At this rate it would waste about ${n1(kl)} kL in a month.`,save:kl*marginal("WATER",mine.WATER||0,asOf)});
  } else if(h.nightMin!=null&&h.nightMin>0.5){
    const kl=h.nightMin*60*24*30/1000;
    tips.push({lvl:"crit",title:"Water keeps running at night",body:`Between 1 and 5 am the lowest flow was ${n2(h.nightMin)} L/min. A home with every tap closed drops close to zero, so this looks like a leak or a running toilet. Left alone it wastes about ${n1(kl)} kL a month.`,save:kl*marginal("WATER",mine.WATER||0,asOf)});
  } else if(h.nightMin!=null) tips.push({lvl:"ok",title:"No hidden water leak",body:`Night-time flow fell to ${n2(h.nightMin)} L/min between 1 and 5 am, which is what a sealed system looks like.`,save:0});
  const baseLimit=com?1.0:0.15, baseTarget=com?0.6:0.1;
  if(h.base>baseLimit){
    const kwh=(h.base-baseTarget)*24*30;
    tips.push({lvl:"warn",title:"High always-on electricity",body:`Even at the quietest hour this ${com?"business":"home"} drew ${n2(h.base)} kW. Fridges, routers and devices on standby add up to about ${Math.round(h.base*720)} kWh a month. Switching standby loads off at the wall could save around ${Math.round(kwh)} kWh.`,save:kwh*marginal("ELECTRICITY",mine.ELECTRICITY||0,asOf)});
  } else tips.push({lvl:"ok",title:"Low standby load",body:`The lowest draw in the last day was ${n2(h.base)} kW, so little is left running when nobody needs it.`,save:0});
  if(h.peakShare>0.35){
    tips.push({lvl:"warn",title:"Much of your power is used at peak time",body:`${Math.round(h.peakShare*100)}% of the last day's electricity was used between 6 and 10 pm, when the city grid is busiest. Running the washing machine, geyser or pump earlier in the day eases the load that triggers peak-demand events.`,save:0});
  } else tips.push({lvl:"ok",title:"Peak hours under control",body:`Only ${Math.round(h.peakShare*100)}% of the last day's electricity was used between 6 and 10 pm.`,save:0});
  const worst=cmp.slice().sort((a,b)=>b.ratio-a.ratio)[0];
  if(worst.ratio>1.05){
    const ideas={ELECTRICITY:"LED bulbs, a 5-star fridge and setting the AC to 24 °C are the usual big wins.",WATER:"Tap aerators and a dual-flush toilet cut use by a quarter in most homes.",GAS:"A pressure cooker and lids on pans cut cooking gas by up to a third."};
    const extra=worst.you-worst.med;
    tips.push({lvl:"warn",title:`${UT[worst.ut].label} is above similar ${g.label.split(" ")[0]}`,body:`Last month you used ${n1(worst.you)} ${UT[worst.ut].unit} against a typical ${n1(worst.med)}. ${ideas[worst.ut]}`,save:extra*marginal(worst.ut,worst.you,asOf)});
  }
  // eco score: start at 70, move with each utility against the peer median, then adjust for habits
  let score=70+cmp.reduce((s,c)=>s+Math.max(-15,Math.min(10,(1-c.ratio)*30)),0);
  if(h.recentMin>2||(h.nightMin!=null&&h.nightMin>0.5)) score-=25;
  if(h.base>baseLimit) score-=5;
  if(h.peakShare>0.35) score-=5; else score+=5;
  score=Math.max(0,Math.min(100,Math.round(score)));
  const grade=score>=85?"A":score>=70?"B":score>=55?"C":score>=40?"D":"E";
  return {p,cyc,mine,g,cmp,kg,peerKg,soFarKg,projKg,f,h,tips:tips.sort((a,b)=>({crit:0,warn:1,ok:2}[a.lvl]-{crit:0,warn:1,ok:2}[b.lvl])),score,grade};
}

const gradeChip=(r,big)=>`<span class="grade g-${r.grade}${big?" big":""}" title="Eco score ${r.score}/100">${r.grade}</span>`;

function strip(c){ // range of similar properties with a marker for you and a tick for the median
  const lo=Math.min(c.min,c.you), hi=Math.max(c.max,c.you), span=hi-lo||1, pos=v=>((v-lo)/span*92+4).toFixed(1);
  return `<div class="strip" role="img" aria-label="${UT[c.ut].label}: you ${n1(c.you)}, typical ${n1(c.med)}">
    ${c.vals.map(v=>`<span class="peer" style="left:${pos(v)}%"></span>`).join("")}
    <span class="med" style="left:${pos(c.med)}%"></span>
    <span class="you" style="left:${pos(c.you)}%;background:${UT[c.ut].color}"></span></div>`;
}

V.eco=()=>{
  const props=resProps(); const pid=SESSION.sel.prop||props[0].property_id; SESSION.sel.prop=pid;
  const r=ecoReport(pid), cn=cycleName(r.cyc).split(" ")[0];
  const diff=Math.round((r.kg/r.peerKg-1)*100);
  const saving=r.tips.reduce((s,t)=>s+t.save,0);
  return `<div class="page-head"><span class="eyebrow">Resident portal</span><h1>Footprint &amp; savings</h1>
   <p class="ink2">How your use compares with similar ${esc(r.g.label)}, what it means for the climate, and the habits worth changing.</p></div>
  ${props.length>1?`<div class="tabs" role="group" aria-label="Property">${props.map(x=>`<button aria-pressed="${x.property_id===pid}" data-act="sel-prop" data-id="${x.property_id}">${esc(x.property_code)} · ${esc(x.address_line.split(",")[0])}</button>`).join("")}</div>`:""}
  <div class="kpis k4">
   <div class="kpi"><span class="l">Eco score</span><span class="v row" style="gap:10px">${gradeChip(r,true)}<span>${r.score}<span class="muted" style="font-size:14px">/100</span></span></span><span class="l">Grades A to E against similar ${r.g.label.split(" ")[0]}</span></div>
   <div class="kpi"><span class="l">${cn} footprint ${src("pg")}</span><span class="v">${Math.round(r.kg)} kg CO₂</span><span class="l"><span class="status ${diff>10?"s-warn":"s-ok"}">${diff>=0?"+":""}${diff}%</span> vs a typical ${Math.round(r.peerKg)} kg</span></div>
   <div class="kpi"><span class="l">${r.f.c.name} so far ${src("mg")}</span><span class="v">${Math.round(r.soFarKg)} kg CO₂</span><span class="l">heading for about ${Math.round(r.projKg)} kg</span></div>
   <div class="kpi"><span class="l">Possible saving</span><span class="v">${saving>0.5?inr(Math.round(saving*100)/100):"₹0"}</span><span class="l">${saving>0.5?"a month, if you act on the tips below":"nothing to fix right now"}</span></div>
  </div>
  <div class="grid2">
   <div class="panel"><div class="panel-head"><div class="row"><h2>You and similar ${esc(r.g.label.split(" ")[0])}</h2>${src("pg")}</div><span class="muted">${cn}, ${r.cmp[0].others} others</span></div>
    <div class="stack">${r.cmp.map(c=>`<div class="cmp"><div class="row" style="justify-content:space-between"><b><span class="dot" style="background:${UT[c.ut].color}"></span>${UT[c.ut].label}</b>
      <span class="ink2">You ${n1(c.you)} ${UT[c.ut].unit} · typical ${n1(c.med)} · <span class="status ${c.ratio>1.05?"s-warn":"s-ok"}">${Math.abs(c.ratio-1)<0.03?"about the same":c.ratio>=1?`${Math.round((c.ratio-1)*100)}% more`:`${Math.round((1-c.ratio)*100)}% less`}</span></span></div>
      ${strip(c)}<p class="muted" style="font-size:12px">${c.more} of ${c.others} similar ${r.g.label.split(" ")[0]} used more than you.</p></div>`).join("")}</div>
    <p class="muted" style="font-size:12px;margin-top:8px">Grey dots are ${esc(r.g.label)}, the line is the median and the coloured dot is you. Query:</p>
    <pre class="code">SELECT m.utility_type, r.total_units_consumed,
  PERCENT_RANK() OVER (PARTITION BY p.property_type, w.parent_zone_id, m.utility_type
                       ORDER BY r.total_units_consumed) AS pct_rank
FROM meter_reading r JOIN utility_meter m USING (meter_id)
JOIN property p USING (property_id) JOIN zone w ON w.zone_id = p.zone_id
WHERE r.cycle_id = ${r.cyc};</pre></div>
   <div class="panel"><div class="panel-head"><div class="row"><h2>Where your carbon comes from</h2></div><span class="muted">${cn}</span></div>
    <div class="stack">${Object.keys(UT).map(k=>{const v=(r.mine[k]||0)*CO2[k];return `<div><div class="row" style="justify-content:space-between"><span><span class="dot" style="background:${UT[k].color}"></span>${UT[k].label}</span><span class="num">${Math.round(v)} kg</span></div><div class="meter"><span style="width:${Math.round(v/r.kg*100)}%;background:${UT[k].color}"></span></div></div>`;}).join("")}</div>
    <div class="okbox" style="margin-top:14px">${Math.round(r.kg)} kg CO₂ is about the same as driving a petrol car ${Math.round(r.kg/CAR_KG_PER_KM).toLocaleString("en-IN")} km, or what ${Math.round(r.kg/TREE_KG_PER_MONTH)} trees absorb in a month.</div>
    <p class="muted" style="font-size:12px;margin-top:8px">Approximate factors: ${CO2.ELECTRICITY} kg per kWh (Indian grid average), ${CO2.GAS} kg per m³ of gas, ${CO2.WATER} kg per kL of water pumped and treated.</p></div>
  </div>
  <div class="panel"><div class="panel-head"><div class="row"><h2>Habit check from your smart meters</h2>${src("mg")}</div><span class="muted">last ${Math.round(r.h.hours)} hours of readings</span></div>
   <div class="tips">${r.tips.map(t=>`<div class="tip ${t.lvl}"><b>${esc(t.title)}</b><p class="ink2">${t.body}</p>${t.save>0.5?`<span class="status s-ok">save about ${inr(Math.round(t.save*100)/100)} a month</span>`:""}</div>`).join("")}</div>
   <p class="muted" style="font-size:12px;margin-top:8px">Checks run on <code>db.meter_readings</code>: the lowest water flow between 1 and 5 am (leak test), the lowest electricity draw (always-on load) and the share used between 6 and 10 pm (peak hours). Savings use your current tariff slab.</p></div>`;
};
V.eco.live=true;
