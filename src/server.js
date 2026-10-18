// Entry point ("npm start"): connects to MongoDB, starts the Change Stream
// watcher, then starts the HTTP server. The app itself is defined in app.js.

const config = require('./config');
const app = require('./app');
const { connectDb, closeDb } = require('./db');
const { startScoreWatcher, stopScoreWatcher } = require('./services/changeStream');

async function start() {
  await connectDb();
  startScoreWatcher();
  app.listen(config.port, () => {
    console.log(`Server running at http://localhost:${config.port}`);
    console.log(`  Admin:       http://localhost:${config.port}/admin.html`);
    console.log(`  Judge:       http://localhost:${config.port}/judge.html`);
    console.log(`  Leaderboard: http://localhost:${config.port}/leaderboard.html`);
  });
}

// Close the Change Stream and MongoDB connection cleanly when you press Ctrl+C.
process.on('SIGINT', async () => {
  await stopScoreWatcher();
  await closeDb();
  process.exit(0);
});

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
