"use strict";
/* Synthetic city (seed 42): zones, residents, properties, meters, cycles, tariffs, history, users. No real personal data. */

// ---------- seed: synthetic city ----------
const Z=(id,name,lvl,parent)=>PG.zone.push({zone_id:id,name,zone_level:lvl,parent_zone_id:parent});
Z(1,"Synthetic City","CITY",null); Z(2,"North District","DISTRICT",1); Z(3,"South District","DISTRICT",1);
Z(4,"Ward N-1","WARD",2); Z(5,"Ward N-2","WARD",2); Z(6,"Ward S-1","WARD",3); Z(7,"Ward S-2","WARD",3);
const zname=id=>PG.zone.find(z=>z.zone_id===id).name;
const districtOf=zid=>{ const z=PG.zone.find(x=>x.zone_id===zid); return z.zone_level==="WARD"?z.parent_zone_id:zid; };

const RES=[["Asha Rao","asha"],["Vikram Iyer","vikram"],["Meera Nair","meera"],["Rahul Desai","rahul"],["Fatima Sheikh","fatima"],["Arjun Menon","arjun"]];
RES.forEach(([n,h],i)=>insert("resident",{resident_id:uid(),citizen_ref:`SYN-${String(i+1).padStart(5,"0")}`,full_name:n,email:`${h}@example.test`,phone:`+9190000000${i+1}`.slice(0,13),registered_date:"2025-04-01",is_active:true}));
const resBy=h=>PG.resident.find(r=>r.email.startsWith(h+"@"));
const PROPS=[["asha",4,"RESIDENTIAL","12 Lake View Road"],["vikram",4,"RESIDENTIAL","7 Temple Street"],["meera",5,"RESIDENTIAL","44 Hill Crest Layout"],
  ["rahul",6,"COMMERCIAL","Desai Bakery, 3 Market Lane"],["fatima",6,"RESIDENTIAL","19 Garden Colony"],["arjun",7,"RESIDENTIAL","5 River Bank Road"],
  ["asha",7,"COMMERCIAL","Rao Print Shop, 88 Station Road"],["vikram",5,"RESIDENTIAL","2 Orchard Avenue"]];
PROPS.forEach(([h,z,t,a],i)=>insert("property",{property_id:uid(),property_code:`P-${String(i+1).padStart(4,"0")}`,resident_id:resBy(h).resident_id,zone_id:z,address_line:a,city:"Synthetic City",pincode:"560001",property_type:t,square_feet:t==="COMMERCIAL"?1800:1200,service_status:"NORMAL"}));
const propByCode=c=>PG.property.find(p=>p.property_code===c);
const propById=id=>PG.property.find(p=>p.property_id===id);
PG.property.forEach((p,i)=>Object.keys(UT).forEach(u=>insert("utility_meter",{meter_id:uid(),meter_code:`MTR-${UT[u].code}-${String(i+1).padStart(4,"0")}`,property_id:p.property_id,utility_type:u,installation_date:"2025-04-10",meter_model:u==="ELECTRICITY"?"SM-3P-200":u==="WATER"?"UFM-25":"GSM-G4",is_active:true})));
const meterByCode=c=>PG.utility_meter.find(m=>m.meter_code===c);
const metersOf=pid=>PG.utility_meter.filter(m=>m.property_id===pid);

[[7,"2026-07-01","2026-07-31","2026-08-30","CLOSED"],[8,"2026-08-01","2026-08-31","2026-09-30","CLOSED"],[9,"2026-09-01","2026-09-30","2026-10-30","CLOSED"],[10,"2026-10-01","2026-10-31","2026-11-30","OPEN"]]
  .forEach(([m,s,e,d,st])=>insert("billing_cycle",{cycle_id:m-6,year:2026,month:m,cycle_start_date:s,cycle_end_date:e,due_date:d,late_penalty_percent:5,status:st}));
const cycleName=id=>{const c=PG.billing_cycle.find(x=>x.cycle_id===id);return new Date(Date.UTC(c.year,c.month-1,1)).toLocaleDateString("en-IN",{month:"long",year:"numeric",timeZone:"UTC"});};

[["ELECTRICITY",1,0,100,5],["ELECTRICITY",2,100,300,8],["ELECTRICITY",3,300,null,12],
 ["WATER",1,0,10,8],["WATER",2,10,25,15],["WATER",3,25,null,25],
 ["GAS",1,0,20,30],["GAS",2,20,null,40]].forEach(([u,t,mn,mx,p],i)=>insert("utility_rate",{rate_id:i+1,utility_type:u,tier_level:t,min_units:mn,max_units:mx,price_per_unit:p,effective_start_date:"2026-04-01",effective_end_date:null}));

// historical monthly usage (PostgreSQL meter_reading) for Jul, Aug, Sep
const BASE={RESIDENTIAL:{ELECTRICITY:[260,420],WATER:[12,22],GAS:[14,26]},COMMERCIAL:{ELECTRICITY:[650,980],WATER:[20,34],GAS:[30,55]}};
const register=new Map(); // running cumulative register per meter (billing units)
PG.utility_meter.forEach(m=>register.set(m.meter_code,m.utility_type==="ELECTRICITY"?Math.round(rand(8000,15000)):m.utility_type==="WATER"?Math.round(rand(400,900)):Math.round(rand(300,700))));
const histRun=uid();
PG.aggregation_run.push({run_id:histRun,cycle_id:3,started_at:Date.parse("2026-10-01T01:00:00+05:30"),finished_at:Date.parse("2026-10-01T01:02:00+05:30"),status:"SUCCEEDED",meters_total:24,meters_written:24,error:null});
for(const cyc of [1,2,3]){
  for(const m of PG.utility_meter){
    const p=propById(m.property_id);
    let [a,b]=BASE[p.property_type][m.utility_type]; let u=Math.round(rand(a,b)*(m.utility_type==="ELECTRICITY"?1:10))/(m.utility_type==="ELECTRICITY"?1:10);
    if(p.property_code==="P-0001"&&cyc===3) u={ELECTRICITY:450,WATER:18,GAS:24}[m.utility_type];
    if(p.property_code==="P-0004"&&m.utility_type==="ELECTRICITY"&&cyc===3) u=1240; // bakery's oven upgrade, for the MoM query
    const open=register.get(m.meter_code), close=Math.round((open+u)*1000)/1000; register.set(m.meter_code,close);
    insert("meter_reading",{reading_id:uid(),meter_id:m.meter_id,cycle_id:cyc,run_id:cyc===3?histRun:null,opening_register:open,closing_register:close,source_doc_count:2880,is_estimated:false,reading_timestamp:Date.parse(`2026-${String(cyc+7).padStart(2,"0")}-01T01:00:00+05:30`)});
  }
}
// history invoices
for(const cyc of [1,2,3]) for(const p of PG.property){
  const {created:inv}=spGenerateInvoice(p.property_id,cyc);
  const unpaid=(p.property_code==="P-0004"&&cyc<3)||(p.property_code==="P-0006"&&cyc===2)||(cyc===3&&["P-0001","P-0002","P-0004","P-0006"].includes(p.property_code));
  if(!unpaid){ const k=`seed-${inv.invoice_no}`; insert("payment",{payment_id:uid(),invoice_id:inv.invoice_id,idempotency_key:k,amount_paid:inv.total_amount,payment_method:["UPI_SIM","NETBANK_SIM","CARD_SIM"][Math.floor(rnd()*3)],status:"SUCCEEDED",transaction_id:`SIMTXN-${++txSeq}`,failure_reason:null,payment_date:Date.parse(PG.billing_cycle.find(x=>x.cycle_id===cyc).due_date+"T10:00:00+05:30")-5*86400e3}); }
  else if(cyc<3) inv.payment_status="OVERDUE";
}

// users (passwords are Argon2id hashes in the real build; here everyone uses "demo123")
const U=(email,role,resident,zone,name)=>insert("app_user",{user_id:uid(),email,password_hash:"$argon2id$v=19$m=19456,t=2,p=1$…",role,resident_id:resident?resBy(resident).resident_id:null,staff_zone_id:zone,failed_logins:0,locked_until:null,display:name});
U("asha@example.test","RESIDENT","asha",null,"Asha Rao"); U("vikram@example.test","RESIDENT","vikram",null,"Vikram Iyer");
U("ravi.staff@city.example.test","STAFF",null,2,"Ravi Kumar"); U("kavya.staff@city.example.test","STAFF",null,3,"Kavya Shetty");
U("admin@city.example.test","ADMIN",null,null,"City Admin");
const userById=id=>PG.app_user.find(u=>u.user_id===id);

