// Builds the Express app: middleware, static pages, API routes, error handling.
// It does NOT connect to MongoDB or start listening - server.js does that.
// Keeping them separate lets the tests import the app and start it on any port.

const path = require('path');
const express = require('express');
const config = require('./config');
const { getDb } = require('./db');
const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Parse JSON request bodies into req.body (max 100kb so nobody can send huge bodies).
app.use(express.json({ limit: '100kb' }));

// Serve the plain HTML/CSS/JS pages from /public.
app.use(express.static(path.join(__dirname, '..', 'public')));

// The site root opens the public leaderboard.
app.get('/', (req, res) => res.redirect('/leaderboard.html'));

// Health check: proves the server is up AND MongoDB answers.
app.get('/api/health', async (req, res) => {
  await getDb().command({ ping: 1 });
  res.json({ status: 'ok', db: config.dbName });
});

// All API routes (see routes/index.js).
app.use('/api', apiRoutes);

// Unknown /api URL -> JSON 404, then the central error handler (must be last).
app.use('/api', notFound);
app.use(errorHandler);

module.exports = app;
