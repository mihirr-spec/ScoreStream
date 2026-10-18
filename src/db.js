// One shared MongoDB connection for the whole app.
// MongoClient keeps a connection POOL inside it, so we create it once
// and reuse it everywhere (opening a new connection per request would be slow).

const { MongoClient } = require('mongodb');
const config = require('./config');

let client = null;
let db = null;

// Connect once at startup. Calling it again just returns the same db.
async function connectDb() {
  if (db) return db;

  client = new MongoClient(config.mongodbUri);
  await client.connect();
  db = client.db(config.dbName);

  // "ping" proves the cluster is reachable and our credentials work.
  await db.command({ ping: 1 });
  console.log(`Connected to MongoDB database "${config.dbName}"`);
  return db;
}

// Used by routes/services to get the db after connectDb() has run.
function getDb() {
  if (!db) {
    throw new Error('Database not connected yet. Call connectDb() first.');
  }
  return db;
}

// Close the connection (used by scripts and tests so Node can exit).
async function closeDb() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
}

module.exports = { connectDb, getDb, closeDb };
