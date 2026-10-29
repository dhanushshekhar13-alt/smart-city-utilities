"use strict";
/* Live sharing between laptops. When the page is served by server.js, every
   browser keeps the same copy of the data: changes are sent to the server and
   the other browsers pick them up within about a second. Only one browser (the
   "clock driver", chosen by the server) runs the meter simulator.
   Opened as a plain file or from another server, this does nothing and the
   prototype runs on its own as before. */

const Sync=(()=>{
  const id=Math.random().toString(36).slice(2)+Date.now().toString(36);
  let mode="probe";           // probe → on (server.js found) | off (static) ; on ⇄ lost
  let version=-1, driver=false, clients=0;
  let last="";                // the snapshot the server has, as far as we know
  let dirty=null;             // "user" or "tick" when the local data has changed since `last`
  let chain=Promise.resolve();
  const run=f=>{ chain=chain.then(f).catch(()=>{}); return chain; };

  const snapshot=()=>JSON.stringify({PG,MG,register:[...register],now,invSeq,tktSeq,txSeq,
    sim:{running:SIM.running,mode:SIM.mode,offline:[...SIM.offline]},LOG});

  function apply(s){
    for(const k in PG) PG[k]=s.PG[k]||[];
    for(const k in MG) MG[k]=s.MG[k]||[];
    byMeter.clear();
    for(const d of MG.meter_readings){ if(!byMeter.has(d.meta.meter_code)) byMeter.set(d.meta.meter_code,[]); byMeter.get(d.meta.meter_code).push(d); }
    for(const a of byMeter.values()) a.sort((x,y)=>x.ts-y.ts);
    register.clear(); for(const [k,v] of s.register) register.set(k,v);
    now=s.now; invSeq=s.invSeq; tktSeq=s.tktSeq; txSeq=s.txSeq;
    SIM.mode=s.sim.mode; SIM.offline=new Set(s.sim.offline);
    LOG.length=0; LOG.push(...s.LOG);
    if(SESSION.user) SESSION.user=PG.app_user.find(u=>u.user_id===SESSION.user.user_id)||null;
    if(SIM.running!==s.sim.running) setRunning(s.sim.running);
  }

  // redraw after someone else's change, without wiping a form the user is typing in
  function redraw(full){
    const typing=document.activeElement&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if(full&&!typing){ const y=window.scrollY; render(); renderRail(); window.scrollTo(0,y); }
    else { render(true); renderRail(); }
  }

  async function push(kind){
    const s=snapshot(); if(s===last){ dirty=null; return; }
    let body=s, headers={"Content-Type":"application/json"};
    if(typeof CompressionStream!=="undefined"){
      body=await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
      headers["Content-Encoding"]="gzip";
    }
    // a person's change always wins; a clock tick made on old data is dropped
    const r=await fetch(`api/state?client=${id}&base=${version}${kind==="user"?"&force=1":""}`,{method:"PUT",headers,body});
    const j=await r.json(); driver=j.driver; clients=j.clients;
    if(r.ok){ version=j.version; last=s; dirty=null; }
    else if(r.status===409){ dirty=null; await poll(); }
  }

  async function poll(){
    if(dirty) return push(dirty);                       // send our change before taking anyone else's
    let r;
    try{ r=await fetch(`api/state?client=${id}&since=${version}`,{cache:"no-store"}); }
    catch{ if(mode==="probe") return stop(); if(mode==="on"){ mode="lost"; renderTop(); } return; }
    if(!r.ok||!(r.headers.get("content-type")||"").includes("json")){ if(mode==="probe") stop(); return; }
    const j=await r.json();
    const wasDriver=driver, first=mode==="probe";
    driver=j.driver; clients=j.clients;
    if(mode!=="on"){ mode="on"; rnd=mulberry32((Math.random()*2**32)>>>0); } // own random stream, so ids never clash between laptops
    if(j.state){
      if(dirty) return push(dirty);                     // a change happened while we were waiting
      const behind=j.lastUserVersion>version;
      apply(j.state); version=j.version; last=snapshot();
      redraw(first||behind);
    } else if(j.version===0&&version<0){
      dirty="user"; await push("user");                  // first laptop: the server has no data yet, so share ours
    }
    if(first||wasDriver!==driver) renderTop();
  }

  let timer=null;
  function stop(){ mode="off"; clearInterval(timer); renderTop(); }
  function start(){
    if(location.protocol==="file:"){ mode="off"; return; }
    // any click, form or choice may change data: send it right after the app has handled it
    for(const ev of ["click","submit","change"]) document.addEventListener(ev,()=>setTimeout(()=>{ if(mode==="on"&&snapshot()!==last){ dirty="user"; run(poll); } },0));
    timer=setInterval(()=>run(poll),1000);
    run(poll);
  }

  return {
    start,
    // simulator asks before each automatic tick
    drivesClock:()=>mode==="off"||(mode==="on"&&driver),
    ticked(){ if(mode==="on"){ dirty=dirty||"tick"; run(poll); } },
    badge(){
      if(mode==="on") return `<span class="pill" style="color:var(--ok)" title="Data is shared through server.js. ${driver?"This laptop runs the meter clock.":"Another laptop runs the meter clock."}">Live · ${clients} ${clients===1?"browser":"browsers"}</span>`;
      if(mode==="lost") return `<span class="pill" style="color:var(--crit)" title="Cannot reach server.js. Changes here are not shared until it is back.">Offline · reconnecting</span>`;
      return "";
    },
  };
})();
Sync.start();
