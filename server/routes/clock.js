// /api/clock and /api/activity: the city clock every screen polls, and the "Under the hood" rail
const express = require('express');
const { requireUser, requireRole } = require('../auth');
const engine = require('../sim/engine');
const { S } = require('../sim/state');
const { query } = require('../db/pg');
const activity = require('../activity');
const { h } = require('./util');
const { nextMonthStart } = require('../time');
const { MONTH } = require('../services/billing');

const r = express.Router();

r.get('/clock', h(async (req, res) => {
  const { rows: [c] } = await query("SELECT cycle_id, month, year, cycle_end_date FROM billing_cycle WHERE status = 'OPEN' ORDER BY cycle_id LIMIT 1");
  res.json({ city_now: S.cityNow, running: S.running, version: S.version, activity: activity.latest, tick_minutes: 15,
    open_cycle: c ? { id: c.cycle_id, name: `${MONTH[c.month]} ${c.year}`, month: MONTH[c.month], ends_at: nextMonthStart(c.cycle_end_date) } : null });
}));

r.post('/clock/run', requireRole('ADMIN'), h(async (req, res) => {
  await engine.setRunning(req.user, req.body && req.body.on);
  activity.log({ db: 'pg', title: S.running ? 'City clock resumed' : 'City clock paused', scope: 'all', stmt: `UPDATE sim_clock SET running = ${S.running};   -- audited` });
  res.json({ running: S.running });
}));

r.post('/clock/advance', requireRole('ADMIN'), h(async (req, res) => {
  const hours = Math.min(48, Math.max(1, Number((req.body && req.body.hours) || 1)));
  res.json(await engine.advance(hours));
}));

r.post('/clock/month-end', requireRole('ADMIN'), h(async (req, res) => {
  res.json(await engine.monthEnd());
}));

r.get('/activity', requireUser, (req, res) => res.json({ events: activity.visibleTo(req.user), latest: activity.latest }));

module.exports = r;
