// Settings come from environment variables or a local .env file (copy .env.example). Credentials are never hard-coded here.
const fs = require('fs');
const path = require('path');

// tiny .env loader so no extra package is needed
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = process.env;
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill in your own database password (see README).');
  process.exit(1);
}
module.exports = {
  port: Number(env.PORT || 8080),
  pgUrl: env.DATABASE_URL,
  mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27017/smart_city',
  sessionHours: Number(env.SESSION_HOURS || 8),
  tickMs: Number(env.TICK_MS || 2000),          // one city tick (15 city minutes) every 2 real seconds
  autoStartClock: env.CLOCK_AUTOSTART !== 'false',
  demoMode: env.DEMO_MODE !== 'false',          // show the demo account cards on the sign-in page
  secureCookies: env.SECURE_COOKIES === 'true', // set to true behind HTTPS
};
