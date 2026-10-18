// Loads settings from the .env file in ONE place.
// Every other file imports values from here instead of reading process.env directly,
// so it's easy to see which settings the app depends on.

const path = require('path');
const dotenv = require('dotenv');

// Use an absolute path so scripts work no matter which folder you run them from.
// quiet: true stops dotenv from printing its own log line on startup.
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// Stop early with a clear message if a required setting is missing.
// We only print the KEY name, never a secret value.
function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required setting "${name}" in .env (see .env.example).`);
    process.exit(1);
  }
  return value;
}

const config = {
  mongodbUri: required('MONGODB_URI'),
  dbName: process.env.DB_NAME || 'judging_system',
  adminPassword: required('ADMIN_PASSWORD'),
  jwtSecret: required('JWT_SECRET'),
  aiApiKey: process.env.AI_API_KEY || '', // empty = use mock AI feedback
  // Tests set AI_FORCE_MOCK=1 so they never call the real AI over the network.
  aiForceMock: process.env.AI_FORCE_MOCK === '1',
  aiBaseUrl: process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1',
  aiModel: process.env.AI_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
  aiFallbackModel: process.env.AI_FALLBACK_MODEL || '', // empty = no fallback model
  port: Number(process.env.PORT) || 3000,
};

module.exports = config;
