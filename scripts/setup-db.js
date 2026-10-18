// Creates every collection with a $jsonSchema validator, then creates all indexes.
// Safe to run many times: existing collections get their validator UPDATED (collMod),
// and createIndex does nothing if the same index already exists.
//
// Run: npm run setup-db

const { connectDb, getDb, closeDb } = require('../src/db');

// ---------------------------------------------------------------------------
// $jsonSchema validators
// MongoDB is schemaless by default. A validator makes the DATABASE itself reject
// documents with the wrong shape, even if a bug in our Node code slips through.
// "bsonType" names are MongoDB's types: "objectId", "string", "date", "number"
// ("number" accepts int, long, double and decimal).
// We don't set additionalProperties:false, so _id and future fields are allowed.
// ---------------------------------------------------------------------------
const validators = {
  events: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'status', 'rubric', 'createdAt'],
      properties: {
        name: { bsonType: 'string', minLength: 1 },
        // enum = the only allowed values
        status: { enum: ['draft', 'live', 'closed'] },
        // The rubric is EMBEDDED: it is always read together with its event
        // and is small, so one document is simpler than a separate collection.
        rubric: {
          bsonType: 'array',
          minItems: 1,
          items: {
            bsonType: 'object',
            required: ['key', 'label', 'max', 'weight'],
            properties: {
              key: { bsonType: 'string', minLength: 1 },
              label: { bsonType: 'string', minLength: 1 },
              max: { bsonType: 'number', minimum: 1 },
              weight: { bsonType: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
        // NOTE: "weights must sum to 1" cannot be expressed in $jsonSchema,
        // so the API checks that rule in Node (Phase 2).
        createdAt: { bsonType: 'date' },
        // Optional: true only for the shared demo event (see services/demo.js).
        demo: { bsonType: 'bool' },
      },
    },
  },

  teams: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'name', 'members'],
      properties: {
        eventId: { bsonType: 'objectId' }, // reference to events._id
        name: { bsonType: 'string', minLength: 1 },
        members: { bsonType: 'array', items: { bsonType: 'string' } },
        // Optional: SHA-256 of the team's access code (used for team login).
        codeHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
  },

  judges: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'name', 'codeHash'],
      properties: {
        eventId: { bsonType: 'objectId' },
        name: { bsonType: 'string', minLength: 1 },
        // SHA-256 written as hex is always exactly 64 characters 0-9 a-f.
        // So the plain access code can never be stored here by mistake.
        codeHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
  },

  scores: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'teamId', 'judgeId', 'criteria', 'total', 'submittedAt'],
      properties: {
        // Scores REFERENCE event/team/judge by id instead of being embedded,
        // because they are written often by many judges and queried on their own.
        eventId: { bsonType: 'objectId' },
        teamId: { bsonType: 'objectId' },
        judgeId: { bsonType: 'objectId' },
        // criteria is a free-form object like { idea: 8, design: 7 }.
        // Its keys depend on each event's rubric, so we only say "every value must be a number".
        // (Checking the keys against the rubric is done in Node, Phase 3.)
        criteria: {
          bsonType: 'object',
          additionalProperties: { bsonType: 'number' },
        },
        total: { bsonType: 'number', minimum: 0, maximum: 10 },
        comment: { bsonType: 'string' },
        submittedAt: { bsonType: 'date' },
      },
    },
  },

  leaderboard: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'teamId', 'teamName', 'avgScore', 'judgesCount', 'rank', 'updatedAt'],
      properties: {
        eventId: { bsonType: 'objectId' },
        teamId: { bsonType: 'objectId' },
        teamName: { bsonType: 'string' },
        avgScore: { bsonType: 'number', minimum: 0, maximum: 10 },
        judgesCount: { bsonType: 'number', minimum: 0 },
        rank: { bsonType: 'number', minimum: 1 },
        updatedAt: { bsonType: 'date' },
      },
    },
  },

  feedback: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'teamId', 'summary', 'strengths', 'improvements', 'sentiment', 'generatedAt'],
      properties: {
        eventId: { bsonType: 'objectId' },
        teamId: { bsonType: 'objectId' },
        summary: { bsonType: 'string' },
        strengths: { bsonType: 'array', items: { bsonType: 'string' } },
        improvements: { bsonType: 'array', items: { bsonType: 'string' } },
        sentiment: {
          bsonType: 'object',
          required: ['label', 'score'],
          properties: {
            label: { enum: ['positive', 'neutral', 'negative'] },
            score: { bsonType: 'number', minimum: -1, maximum: 1 },
          },
        },
        // Optional: 'ai' or 'mock', so mock feedback is clearly labelled (Phase 5).
        source: { enum: ['ai', 'mock'] },
        generatedAt: { bsonType: 'date' },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Indexes
// Without an index MongoDB must read EVERY document (COLLSCAN) to answer a query.
// With an index it jumps straight to the matching entries (IXSCAN).
// ---------------------------------------------------------------------------
const indexes = {
  scores: [
    // UNIQUE compound index: the database refuses a second score from the
    // same judge for the same team in the same event (duplicate key error 11000).
    { key: { eventId: 1, teamId: 1, judgeId: 1 }, options: { unique: true, name: 'unique_event_team_judge' } },
    // Fast "all scores of this event" (used by the leaderboard aggregation's $match).
    { key: { eventId: 1 }, options: { name: 'eventId_1' } },
  ],
  teams: [
    { key: { eventId: 1 }, options: { name: 'eventId_1' } },
    // Team login looks a team up by its code hash. "sparse" = teams without a
    // codeHash are left out of the index, so they don't clash with each other.
    { key: { codeHash: 1 }, options: { unique: true, sparse: true, name: 'unique_codeHash' } },
  ],
  judges: [
    { key: { eventId: 1 }, options: { name: 'eventId_1' } },
    // Judge login looks a judge up by the hash of their code, so index it.
    // UNIQUE also guarantees two judges can never share the same code.
    { key: { codeHash: 1 }, options: { unique: true, name: 'unique_codeHash' } },
  ],
  leaderboard: [
    // $merge matches incoming rows to existing ones "on" { eventId, teamId }.
    // MongoDB REQUIRES a unique index on the "on" fields for $merge to work.
    { key: { eventId: 1, teamId: 1 }, options: { unique: true, name: 'unique_event_team' } },
  ],
  feedback: [
    // One feedback document per team per event. Re-generating REPLACES it (upsert).
    { key: { eventId: 1, teamId: 1 }, options: { unique: true, name: 'unique_event_team' } },
  ],
  events: [
    // PARTIAL unique index: only documents with demo: true are indexed, so at most
    // ONE demo event can exist, even if two visitors start the demo at the same moment.
    { key: { demo: 1 }, options: { unique: true, partialFilterExpression: { demo: true }, name: 'unique_demo_event' } },
  ],
};

async function setupCollection(db, name, validator) {
  const exists = await db.listCollections({ name }).toArray();

  if (exists.length === 0) {
    // New collection: create it with the validator attached.
    await db.createCollection(name, {
      validator,
      validationLevel: 'strict', // check every insert AND update
      validationAction: 'error', // reject bad documents (not just log a warning)
    });
    console.log(`  created collection "${name}" with $jsonSchema validator`);
  } else {
    // Already exists: collMod replaces the validator with the latest version.
    await db.command({
      collMod: name,
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    console.log(`  updated $jsonSchema validator on "${name}"`);
  }
}

// Exported so the tests can build a fresh test database the same way.
async function setupDatabase(db) {
  console.log('\nCollections + validators:');
  for (const [name, validator] of Object.entries(validators)) {
    await setupCollection(db, name, validator);
  }

  console.log('\nIndexes:');
  for (const [collectionName, list] of Object.entries(indexes)) {
    for (const { key, options } of list) {
      await db.collection(collectionName).createIndex(key, options);
    }
    // Print what really exists, so you can check it worked.
    const existing = await db.collection(collectionName).indexes();
    const summary = existing
      .map((ix) => `${ix.name}${ix.unique ? ' (UNIQUE)' : ''}`)
      .join(', ');
    console.log(`  ${collectionName}: ${summary}`);
  }

  console.log('\nDatabase setup complete.');
}

async function main() {
  await connectDb();
  await setupDatabase(getDb());
}

// Only run when called as a script ("npm run setup-db"), not when imported by tests.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Setup failed:', err.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}

module.exports = { setupDatabase };
