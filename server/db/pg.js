// PostgreSQL access. Every request from a signed-in person runs in its own transaction as that person's
// database role, so row-level security decides what they can see. Background jobs run as the owner.
const { Pool, types } = require('pg');
const config = require('../config');

types.setTypeParser(1184, v => Date.parse(v));          // timestamptz → milliseconds
types.setTypeParser(1700, v => parseFloat(v));          // numeric → number (units and rupees are small)
types.setTypeParser(20, v => Number(v));                // bigint (paise) → number
types.setTypeParser(1082, v => v);                      // date stays 'YYYY-MM-DD'

const pool = new Pool({ connectionString: config.pgUrl, max: 12 });
const ROLE = { RESIDENT: 'resident_role', STAFF: 'staff_role', ADMIN: 'admin_role' };

async function tx(ctx, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ctx.role) await client.query(`SET LOCAL ROLE ${ctx.role}`);               // role name from the fixed map above
    await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.actor', $2, true)",
      [ctx.userId || '', ctx.actor || 'system']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// as the signed-in person: RLS on
const asUser = (user, fn) => tx({ role: ROLE[user.role], userId: user.user_id, actor: user.display_name }, fn);
// as a background job or the sign-in code: owner rights, RLS bypassed, recorded under the job's name
const asSystem = (actor, fn) => tx({ actor }, fn);
// owner rights but recorded under a person (an admin managing accounts, or someone changing their own password)
const asOwner = (user, fn) => tx({ userId: user.user_id, actor: user.display_name }, fn);
const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, tx, asUser, asSystem, asOwner, ROLE };
