// Billing rules: tariff slabs, invoice totals, locked readings, payments and the month-end run.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers');

let pg, mongo;
const one = async (sql, p) => (await pg.query(sql, p)).rows[0];
before(async () => { ({ pg, mongo } = await T.fresh()); });
after(T.close);

test("Asha's September bill is ₹4,860 and its lines follow the tariff slabs", async () => {
  const inv = await one("SELECT invoice_id, total_amount::int AS total, payment_status FROM invoice WHERE invoice_no = 'INV-2026-09-0017'");
  assert.equal(inv.total, 486000);   // paise
  const { rows } = await pg.query("SELECT tier_level, units_consumed AS units, line_total::int AS amt FROM invoice_line_item WHERE invoice_id = $1 AND utility_type = 'ELECTRICITY' ORDER BY tier_level", [inv.invoice_id]);
  assert.deepEqual(rows.map(r => [r.tier_level, Number(r.units), r.amt]), [[1, 100, 50000], [2, 200, 160000], [3, 150, 180000]]);
  const sum = await one('SELECT sum(line_total)::int AS s FROM invoice_line_item WHERE invoice_id = $1', [inv.invoice_id]);
  assert.equal(sum.s, inv.total, 'trg_invoice_total keeps the header equal to the lines');
});

test('fn_tiered_charge splits usage across slabs', async () => {
  const { rows } = await pg.query("SELECT tier_level, units, amount::int AS amount FROM fn_tiered_charge('ELECTRICITY', 450, '2026-09-30')");
  assert.deepEqual(rows.map(r => r.amount), [50000, 160000, 180000]);
});

test('an invoiced meter reading is locked against changes', async () => {
  const e = await pg.query('UPDATE meter_reading SET closing_register = closing_register + 1 WHERE cycle_id = 3').catch(x => x);
  assert.match(e.message, /READING_LOCKED/);
});

test('a ticket cannot jump to CLOSED; the trigger enforces the state machine', async () => {
  const p = await one("SELECT property_id FROM property WHERE property_code = 'P-0002'");
  const t = await one("INSERT INTO maintenance_ticket (property_id, source, issue_type, severity, description, reported_timestamp, last_seen_at) VALUES ($1, 'RESIDENT', 'OTHER', 'LOW', 'test ticket', fn_city_now(), fn_city_now()) RETURNING ticket_id", [p.property_id]);
  const e = await pg.query("UPDATE maintenance_ticket SET status = 'CLOSED' WHERE ticket_id = $1", [t.ticket_id]).catch(x => x);
  assert.match(e.message, /ILLEGAL_TRANSITION/);
  const { rows } = await pg.query('SELECT to_status FROM ticket_status_history WHERE ticket_id = $1', [t.ticket_id]);
  assert.deepEqual(rows.map(r => r.to_status), ['OPEN']);
});

test('the same payment request sent twice stores one payment', async () => {
  const asha = await T.as(T.EMAIL.asha);
  const inv = await one("SELECT invoice_id FROM invoice WHERE invoice_no = 'INV-2026-09-0017'");
  const declined = await asha.post(`/me/invoices/${inv.invoice_id}/pay`, { method: 'CARD_SIM', outcome: 'FAIL' });
  assert.equal(declined.body.results[0].status, 'FAILED');
  assert.equal((await one('SELECT payment_status FROM invoice WHERE invoice_id = $1', [inv.invoice_id])).payment_status, 'PENDING');
  const r = await asha.post(`/me/invoices/${inv.invoice_id}/pay`, { method: 'UPI_SIM', outcome: 'OK', twice: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.stored, 1);
  assert.equal(r.body.results[0].payment_id, r.body.results[1].payment_id);
  assert.equal(r.body.results[1].repeat, true);
  assert.equal((await one('SELECT payment_status FROM invoice WHERE invoice_id = $1', [inv.invoice_id])).payment_status, 'PAID');
  const again = await asha.post(`/me/invoices/${inv.invoice_id}/pay`, { method: 'UPI_SIM', outcome: 'OK' });
  assert.equal(again.status, 400, 'a paid invoice cannot be paid again with a new key');
  const n = await one("SELECT count(*)::int AS n FROM payment WHERE invoice_id = $1 AND status = 'SUCCEEDED'", [inv.invoice_id]);
  assert.equal(n.n, 1);
});

test('month end closes October, bills every property and opens November', async () => {
  const admin = await T.as(T.EMAIL.admin);
  const before = await one("SELECT count(*)::int AS n FROM invoice WHERE cycle_id = 4");
  assert.equal(before.n, 0);
  const r = await admin.post('/clock/month-end');
  assert.equal(r.status, 200);
  assert.ok(r.body.ticks > 0 && r.body.readings > 0);
  const cycles = (await pg.query('SELECT cycle_id, status FROM billing_cycle ORDER BY cycle_id')).rows;
  assert.deepEqual(cycles.slice(-2), [{ cycle_id: 4, status: 'CLOSED' }, { cycle_id: 5, status: 'OPEN' }]);
  const inv = (await pg.query('SELECT invoice_id, total_amount::bigint AS t FROM invoice WHERE cycle_id = 4')).rows;
  assert.equal(inv.length, 8);
  for (const i of inv) {
    const s = await one('SELECT sum(line_total)::bigint AS s FROM invoice_line_item WHERE invoice_id = $1', [i.invoice_id]);
    assert.equal(s.s, i.t);
  }
  // usage comes from MongoDB: closing register minus opening register for every meter
  const reading = await one("SELECT mr.opening_register::float AS o, mr.closing_register::float AS c, mr.source_doc_count AS n FROM meter_reading mr JOIN utility_meter m USING (meter_id) WHERE m.meter_code = 'MTR-E-0001' AND mr.cycle_id = 4");
  assert.ok(reading.c > reading.o && reading.n > 2000);
  const bills = await mongo.col('notifications').countDocuments({ kind: 'BILL' });
  assert.equal(bills, 4, 'one bill alert per property whose owner has an account (Asha and Vikram, two each)');
});

test('the nightly job marks unpaid bills overdue and adds the late fee', async () => {
  // Vikram's September bill for P-0002 was due on 30 October and is still unpaid after month end
  const r = await one(`SELECT i.payment_status, i.total_amount::int AS t,
      (SELECT sum(line_total)::int FROM invoice_line_item l WHERE l.invoice_id = i.invoice_id AND l.line_kind = 'LATE_FEE') AS fee
    FROM invoice i JOIN property p USING (property_id) WHERE p.property_code = 'P-0002' AND i.cycle_id = 3`);
  assert.equal(r.payment_status, 'OVERDUE');
  assert.ok(r.fee > 0);
});
