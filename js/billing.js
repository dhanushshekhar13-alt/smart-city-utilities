"use strict";
/* Billing: fn_tiered_charge and sp_generate_invoice, mirroring the PostgreSQL function and procedure. */

// tiered charge: fn_tiered_charge(utility, units, as_of)
function tieredCharge(utility,units,asOf){
  const slabs=PG.utility_rate.filter(r=>r.utility_type===utility&&r.effective_start_date<=asOf&&(!r.effective_end_date||asOf<r.effective_end_date)).sort((a,b)=>a.tier_level-b.tier_level);
  if(!slabs.length) throw new PgError(`ERROR:  NO_TARIFF: no ${utility} tariff valid on ${asOf}`);
  const out=[];
  for(const s of slabs){
    const top=s.max_units==null?Infinity:s.max_units;
    const inTier=Math.max(0,Math.min(units,top)-s.min_units);
    if(inTier<=0) continue;
    const q=Math.round(inTier*1000)/1000;
    out.push({rate_id:s.rate_id,tier_level:s.tier_level,units:q,price:s.price_per_unit,amount:Math.round(q*s.price_per_unit*100)});
  }
  return out;
}


let invSeq=0, tktSeq=0, txSeq=1000;
function spGenerateInvoice(propertyId,cycleId,quiet){
  const c=PG.billing_cycle.find(x=>x.cycle_id===cycleId);
  const existing=PG.invoice.find(i=>i.property_id===propertyId&&i.cycle_id===cycleId);
  if(existing) return {existing};
  const meters=metersOf(propertyId).filter(m=>m.is_active);
  const staged=[];
  for(const m of meters){
    const r=PG.meter_reading.find(x=>x.meter_id===m.meter_id&&x.cycle_id===cycleId);
    if(!r) throw new PgError(`ERROR:  MISSING_READING: no meter_reading for ${m.meter_code} in cycle ${cycleId}\nCONTEXT:  PL/pgSQL procedure sp_generate_invoice() — transaction rolled back`);
    for(const t of tieredCharge(m.utility_type,r.total_units_consumed,c.cycle_end_date)) staged.push({m,t});
  }
  invSeq++;
  const inv=insert("invoice",{invoice_id:uid(),invoice_no:`INV-2026-${String(c.month).padStart(2,"0")}-${String(invSeq).padStart(4,"0")}`,property_id:propertyId,cycle_id:cycleId,invoice_date:c.cycle_end_date,total_amount:0,payment_status:"PENDING",paid_at:null});
  for(const {m,t} of staged) insert("invoice_line_item",{line_item_id:uid(),invoice_id:inv.invoice_id,utility_type:m.utility_type,line_kind:"USAGE",rate_id:t.rate_id,tier_level:t.tier_level,units_consumed:t.units,rate_applied:t.price,line_total:t.amount});
  return {created:inv};
}
