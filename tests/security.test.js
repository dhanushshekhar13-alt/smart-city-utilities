// Row-level security and grants, checked both through the API and straight in PostgreSQL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const T = require('./helpers');

let pg, ids;
before(async () => {
  ({ pg } = await T.fresh());
  const q = async (sql, p) => (await pg.query(sql, p)).rows;
  ids = {
    ashaInv: (await q("SELECT invoice_id FROM invoice WHERE invoice_no = 'INV-2026-09-0017'"))[0].invoice_id,
    vikramInvs: (await q("SELECT i.invoice_id FROM invoice i JOIN property p USING (property_id) JOIN resident r USING (resident_id) WHERE r.email = 'vikram@example.test'")).map(r => r.invoice_id),
    users: Object.fromEntries((await q('SELECT email, user_id FROM app_user')).map(r => [r.email, r.user_id])),
  };
});
after(T.close);

// run SQL as an app role with the user id set, exactly like the API does
async function asRole(email, role, sql, params) {
  const c = await pg.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('app.user_id', $1, true)", [ids.users[email]]);
    return (await c.query(sql, params)).rows;
  } finally { await c.query('ROLLBACK'); c.release(); }
}

test("a resident sees only their own invoices, and another resident's invoice returns 0 rows", async () => {
  const asha = await T.as(T.EMAIL.asha);
  const { body } = await asha.get('/me/invoices');
  assert.ok(body.invoices.length > 0);
  assert.ok(body.invoices.every(i => !ids.vikramInvs.includes(i.invoice_id)));
  const probe = await asha.get(`/me/rls-probe/${ids.vikramInvs[0]}`);
  assert.equal(probe.body.rows, 0);
  assert.equal((await asha.get(`/me/invoices/${ids.vikramInvs[0]}`)).status, 404);
  assert.equal((await asha.post(`/me/invoices/${ids.vikramInvs[0]}/pay`, { method: 'UPI_SIM', outcome: 'OK' })).status, 404);
});

test('row-level security is enforced by PostgreSQL itself, not just the API', async () => {
  const all = (await pg.query('SELECT count(*)::int AS n FROM invoice')).rows[0].n;
  const mine = await asRole(T.EMAIL.asha, 'resident_role', 'SELECT invoice_id FROM invoice');
  assert.ok(mine.length > 0 && mine.length < all);
  const props = await asRole(T.EMAIL.asha, 'resident_role', 'SELECT property_code FROM property ORDER BY 1');
  assert.deepEqual(props.map(p => p.property_code), ['P-0001', 'P-0007']);
  // writing someone else's row silently affects nothing
  const upd = await asRole(T.EMAIL.asha, 'resident_role', "UPDATE invoice SET payment_status = 'PAID' WHERE invoice_id = ANY($1) RETURNING 1", [ids.vikramInvs]).catch(e => e);
  assert.ok(upd instanceof Error || upd.length === 0);
});

test('staff see tickets only in their own district and cannot read billing tables', async () => {
  const admin = await T.as(T.EMAIL.admin);
  await admin.post('/admin/scenarios/burst', { on: true });   // North District (P-0001)
  await admin.post('/admin/scenarios/spike', { on: true });   // South District (P-0004)
  await admin.post('/clock/advance', { hours: 2 });
  const kavya = await T.as(T.EMAIL.kavya), ravi = await T.as(T.EMAIL.ravi);
  const kt = (await kavya.get('/tickets')).body.tickets, rt = (await ravi.get('/tickets')).body.tickets;
  assert.ok(kt.length > 0 && rt.length > 0);
  assert.ok(kt.every(t => t.district_name === 'South District'));
  assert.ok(rt.every(t => t.district_name === 'North District'));
  const inv = await kavya.get('/db/table/invoice');
  assert.match(inv.body.error, /permission denied for table invoice/);
  const denied = await asRole(T.EMAIL.kavya, 'staff_role', 'SELECT * FROM payment').catch(e => e);
  assert.equal(denied.code, '42501');
});

test('secret columns are not granted to any app role', async () => {
  for (const [email, role] of [[T.EMAIL.admin, 'admin_role'], [T.EMAIL.asha, 'resident_role']]) {
    const e = await asRole(email, role, 'SELECT password_hash FROM app_user').catch(x => x);
    assert.equal(e.code, '42501', `${role} must not read password_hash`);
    const s = await asRole(email, role, 'SELECT token_hash FROM user_session').catch(x => x);
    assert.equal(s.code, '42501', `${role} must not read token_hash`);
  }
});

test('the audit log cannot be changed by the app roles', async () => {
  const e = await asRole(T.EMAIL.admin, 'admin_role', 'DELETE FROM audit_log').catch(x => x);
  assert.equal(e.code, '42501');
});

test('a resident only gets their own MongoDB notifications', async () => {
  const asha = await T.as(T.EMAIL.asha), vikram = await T.as(T.EMAIL.vikram);
  const a = (await asha.get('/db/collection/notifications')).body, v = (await vikram.get('/db/collection/notifications')).body;
  assert.ok(a.docs.every(d => d.user_id === ids.users[T.EMAIL.asha]));
  assert.ok(v.docs.every(d => d.user_id === ids.users[T.EMAIL.vikram]));
  assert.equal((await asha.get('/db/collection/change_log')).body.hidden, true);
});
