// Starts the server: connects to PostgreSQL and MongoDB, starts the city clock, serves the app.
const config = require('./config');
const { pool } = require('./db/pg');
const mongo = require('./db/mongo');
const engine = require('./sim/engine');
const { createApp } = require('./app');

async function main() {
  await pool.query('SELECT 1');
  await mongo.connect();
  const { rows: [{ ready }] } = await pool.query("SELECT to_regclass('public.sim_clock') IS NOT NULL AS ready");
  if (!ready) throw new Error('The database has no tables yet. Run "npm run setup" first.');
  await engine.start();
  const server = createApp().listen(config.port, () => {
    console.log(`Smart City Utilities running at http://localhost:${config.port}`);
    console.log(`PostgreSQL ${config.pgUrl.replace(/:[^:@/]*@/, ':****@')}  ·  MongoDB ${config.mongoUrl.replace(/:[^:@/]*@/, ':****@')}`);
  });
  const shutdown = async () => {
    engine.stop();
    server.close();
    await Promise.allSettled([pool.end(), mongo.client.close()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  console.error('Could not start:', e.message);
  if (/ECONNREFUSED|connect/i.test(e.message)) console.error('Is the database running? Try "npm run db:up", then "npm run setup".');
  process.exit(1);
});
