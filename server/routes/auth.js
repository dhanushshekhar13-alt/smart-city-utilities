// /api/auth: sign in, sign out, create an account, change password, my sessions
const express = require('express');
const auth = require('../auth');
const config = require('../config');
const { query, asUser, asOwner } = require('../db/pg');
const { h, need } = require('./util');
const activity = require('../activity');

const r = express.Router();
const ip = req => req.ip || req.socket.remoteAddress;
const publicUser = u => ({ user_id: u.user_id, email: u.email, role: u.role, display_name: u.display_name, resident_id: u.resident_id, staff_zone_id: u.staff_zone_id });

async function withZone(u) {
  const out = publicUser(u);
  if (u.staff_zone_id) out.zone_name = (await query('SELECT name FROM zone WHERE zone_id = $1', [u.staff_zone_id])).rows[0].name;
  return out;
}

r.post('/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  need(email && password, 400, 'Enter your email and password.');
  try {
    const { token, user } = await auth.login(email, password, ip(req), req.get('user-agent'));
    auth.setCookie(res, token);
    res.json({ user: await withZone(user) });
  } catch (e) {
    if (e instanceof auth.AuthError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

r.post('/logout', h(async (req, res) => {
  if (req.user) await auth.logout(req.user, ip(req));
  auth.clearCookie(res);
  res.json({ ok: true });
}));

r.get('/me', h(async (req, res) => {
  if (!req.user) return res.json({ user: null, demo: config.demoMode });
  res.json({ user: await withZone(req.user), demo: config.demoMode });
}));

// demo account cards for the sign-in page (names and roles only; never shown when DEMO_MODE=false)
r.get('/demo-accounts', h(async (req, res) => {
  if (!config.demoMode) return res.json({ accounts: [] });
  const { rows } = await query(`SELECT u.email, u.role, u.display_name, z.name AS zone_name FROM app_user u LEFT JOIN zone z ON z.zone_id = u.staff_zone_id
    WHERE u.is_active AND u.email LIKE '%@%example.test' ORDER BY CASE u.role WHEN 'RESIDENT' THEN 1 WHEN 'STAFF' THEN 2 ELSE 3 END, u.created_at, u.email`);
  res.json({ accounts: rows, password: 'demo123' });
}));

r.post('/register', h(async (req, res) => {
  const { email, display_name, password } = req.body || {};
  need(email && password, 400, 'Enter your email and a password.');
  try {
    const { token, user } = await auth.register(email, display_name, password, ip(req), req.get('user-agent'));
    auth.setCookie(res, token);
    res.json({ user: await withZone(user) });
  } catch (e) {
    if (e instanceof auth.AuthError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

r.post('/password', auth.requireUser, h(async (req, res) => {
  const { current, next } = req.body || {};
  try { await auth.changePassword(req.user, current, next, ip(req)); res.json({ ok: true }); }
  catch (e) { if (e instanceof auth.AuthError) return res.status(e.status).json({ error: e.message }); throw e; }
}));

// my sessions: read through row-level security (policy own_session), token hashes are not even selectable
r.get('/sessions', auth.requireUser, h(async (req, res) => {
  const sessions = await asUser(req.user, async c => (await c.query(`SELECT session_id, created_at, expires_at, last_seen_at, ended_at, end_reason, ip, user_agent
    FROM user_session ORDER BY created_at DESC LIMIT 20`)).rows);
  const { rows: events } = await query('SELECT at, kind, ip, detail FROM auth_event WHERE user_id = $1 ORDER BY at DESC LIMIT 20', [req.user.user_id]);
  res.json({ current: req.user.session_id, sessions, events });
}));

r.post('/sessions/end-others', auth.requireUser, h(async (req, res) => {
  const n = await asOwner(req.user, async c => (await c.query(`UPDATE user_session SET ended_at = now(), end_reason = 'REVOKED'
    WHERE user_id = $1 AND ended_at IS NULL AND session_id <> $2`, [req.user.user_id, req.user.session_id])).rowCount);
  activity.log({ db: 'pg', title: `${req.user.display_name} signed out ${n} other session${n === 1 ? '' : 's'}`, scope: req.user.user_id,
    stmt: "UPDATE user_session SET ended_at = now(), end_reason = 'REVOKED'\nWHERE user_id = $1 AND ended_at IS NULL AND session_id <> <this session>;" });
  res.json({ ended: n });
}));

module.exports = r;
