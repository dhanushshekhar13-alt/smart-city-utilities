"use strict";
/* Shared-data server for the prototype (Node 18+, no packages to install).

   Serves the site and keeps ONE copy of the demo data, so every laptop that
   opens the page sees the same bills, tickets and meter readings. Browsers
   poll GET /api/state about once a second and send PUT /api/state after a
   change (see js/sync.js). Only one browser at a time, the "clock driver",
   runs the meter simulator so the city clock does not tick twice.

   Run:   node server.js            (keeps data in data/state.json)
          node server.js --reset    (starts again from the seed-42 city)
          PORT=3000 node server.js  (another port)
*/
const http=require("http"), fs=require("fs"), path=require("path"), zlib=require("zlib"), os=require("os");

const PORT=Number(process.env.PORT)||8080;
const ROOT=__dirname;
const DATA_DIR=path.join(ROOT,"data"), DATA_FILE=path.join(DATA_DIR,"state.json");
const CLIENT_TIMEOUT=5000;           // a browser that has not polled for 5 s is gone
const MAX_BODY=50*1024*1024;

// ---------- shared state (kept as a JSON string; the server never needs to look inside) ----------
let version=0, state=null, lastUserVersion=0;
if(process.argv.includes("--reset")){ try{ fs.unlinkSync(DATA_FILE); console.log("Reset: deleted data/state.json"); }catch{} }
try{
  const saved=JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));
  version=saved.version; lastUserVersion=saved.version; state=JSON.stringify(saved.state);
  console.log(`Loaded saved data (version ${version}) from data/state.json`);
}catch{}

let saveTimer=null;
function save(){ // write at most once a second, atomically
  if(saveTimer) return;
  saveTimer=setTimeout(()=>{
    saveTimer=null;
    fs.mkdirSync(DATA_DIR,{recursive:true});
    const tmp=DATA_FILE+".tmp";
    fs.writeFileSync(tmp,`{"version":${version},"state":${state}}`);
    fs.renameSync(tmp,DATA_FILE);
  },1000);
}

// ---------- connected browsers and the clock driver ----------
const clients=new Map(); // client id -> last poll time
let driver=null;
function touch(id){
  const t=Date.now(); clients.set(id,t);
  for(const [k,v] of clients) if(t-v>CLIENT_TIMEOUT) clients.delete(k);
  if(!driver||!clients.has(driver)) driver=id;
}

// ---------- helpers ----------
const TYPES={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json",
  ".md":"text/markdown; charset=utf-8",".pdf":"application/pdf",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".mmd":"text/plain; charset=utf-8"};
function send(res,code,body,headers={}){ res.writeHead(code,{"Cache-Control":"no-store",...headers}); res.end(body); }
function sendJSON(req,res,code,json){
  const gz=/\bgzip\b/.test(req.headers["accept-encoding"]||"")&&json.length>1024;
  send(res,code,gz?zlib.gzipSync(json):json,{"Content-Type":"application/json",...(gz?{"Content-Encoding":"gzip"}:{})});
}
function readBody(req){
  return new Promise((ok,fail)=>{
    const parts=[]; let n=0;
    req.on("data",c=>{ n+=c.length; if(n>MAX_BODY){ fail(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end",()=>{ try{ let b=Buffer.concat(parts); if(req.headers["content-encoding"]==="gzip") b=zlib.gunzipSync(b); ok(b.toString("utf8")); }catch(e){ fail(e); } });
    req.on("error",fail);
  });
}

// ---------- API ----------
async function api(req,res,url){
  const id=String(url.searchParams.get("client")||"").slice(0,64);
  if(!id) return sendJSON(req,res,400,`{"error":"client id missing"}`);
  touch(id);
  const meta=()=>`"version":${version},"lastUserVersion":${lastUserVersion},"driver":${driver===id},"clients":${clients.size}`;

  if(req.method==="GET"){
    const since=Number(url.searchParams.get("since"));
    if(since===version||state===null) return sendJSON(req,res,200,`{${meta()},"state":null}`);
    return sendJSON(req,res,200,`{${meta()},"state":${state}}`);
  }
  if(req.method==="PUT"){
    const base=Number(url.searchParams.get("base")), force=url.searchParams.get("force")==="1";
    // a clock tick made on old data is dropped; the driver reloads and ticks again
    if(!force&&state!==null&&base!==version) return sendJSON(req,res,409,`{${meta()}}`);
    let body;
    try{ body=await readBody(req); JSON.parse(body); }catch{ return sendJSON(req,res,400,`{"error":"bad body"}`); }
    state=body; version++; if(force) lastUserVersion=version;
    save();
    return sendJSON(req,res,200,`{${meta()}}`);
  }
  send(res,405,"Method not allowed");
}

// ---------- static files ----------
function serveFile(req,res,url){
  let rel=decodeURIComponent(url.pathname); if(rel.endsWith("/")) rel+="index.html";
  const file=path.normalize(path.join(ROOT,rel));
  const top=path.relative(ROOT,file).split(path.sep)[0];
  if(!file.startsWith(ROOT+path.sep)||top.startsWith(".")||["data","node_modules"].includes(top)||file===__filename) return send(res,404,"Not found");
  fs.readFile(file,(err,buf)=>{
    if(err) return send(res,404,"Not found");
    send(res,200,buf,{"Content-Type":TYPES[path.extname(file).toLowerCase()]||"application/octet-stream"});
  });
}

const server=http.createServer((req,res)=>{
  const url=new URL(req.url,"http://x");
  if(url.pathname==="/api/state") return api(req,res,url).catch(e=>send(res,500,String(e.message)));
  if(req.method!=="GET"&&req.method!=="HEAD") return send(res,405,"Method not allowed");
  serveFile(req,res,url);
});

server.listen(PORT,"0.0.0.0",()=>{
  const ips=Object.values(os.networkInterfaces()).flat().filter(a=>a&&a.family==="IPv4"&&!a.internal).map(a=>a.address);
  console.log(`\nSmart City Utilities is running with shared data.\n`);
  console.log(`  On this laptop:      http://localhost:${PORT}`);
  for(const ip of ips) console.log(`  On another laptop:   http://${ip}:${PORT}   (same Wi-Fi or hotspot)`);
  if(!ips.length) console.log(`  No network address found. Connect to Wi-Fi or a hotspot to share with another laptop.`);
  console.log(`\nEveryone who opens one of these links sees the same data. Press Ctrl+C to stop.\n`);
});
server.on("error",e=>{
  if(e.code==="EADDRINUSE") console.error(`Port ${PORT} is already in use. Close the other server or run: PORT=3000 node server.js`);
  else console.error(e);
  process.exit(1);
});
