// Express app: JSON API under /api, the single-page frontend from public/.
const path = require('path');
const express = require('express');
const auth = require('./auth');
const { errorHandler } = require('./routes/util');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'");
    next();
  });
  app.use('/api', auth.csrfGuard, auth.attachUser, (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api', require('./routes/clock'));
  app.use('/api/me', require('./routes/resident').router);
  app.use('/api/tickets', require('./routes/tickets'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/db', require('./routes/db'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
