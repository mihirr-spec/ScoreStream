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
        // Optional: the registered admin who created the event (reference to admins._id).
        // Events made by the .env admin have no owner.
        ownerId: { bsonType: 'objectId' },
      },
    },
  },

  admins: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['username', 'usernameLower', 'passwordHash', 'createdAt'],
      properties: {
        username: { bsonType: 'string', minLength: 3, maxLength: 30 },
        usernameLower: { bsonType: 'string', minLength: 3, maxLength: 30 },
        // scrypt "salt:hash" in hex (16-byte salt, 64-byte hash). Never the plain password.
        passwordHash: { bsonType: 'string', pattern: '^[a-f0-9]{32}:[a-f0-9]{128}$' },
        createdAt: { bsonType: 'date' },
      },
    },
  },

  // A team's place in ONE event. Scores, the leaderboard and feedback all point here.
  // name/members are copied from the team account when the team accepts the invitation.
  teams: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'name', 'members'],
      properties: {
        eventId: { bsonType: 'objectId' }, // reference to events._id
        accountId: { bsonType: 'objectId' }, // reference to teamAccounts._id
        name: { bsonType: 'string', minLength: 1 },
        members: { bsonType: 'array', items: { bsonType: 'string' } },
        joinedAt: { bsonType: 'date' },
        // Old-style teams (before team accounts) had their own access code hash.
        codeHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
  },

  // A team that registered on the platform. Its code never changes and is how an
  // admin invites it; the password (scrypt hash) is what proves it IS that team.
  teamAccounts: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'members', 'code', 'passwordHash', 'createdAt'],
      properties: {
        name: { bsonType: 'string', minLength: 1, maxLength: 100 },
        members: { bsonType: 'array', maxItems: 20, items: { bsonType: 'string' } },
        code: { bsonType: 'string', pattern: '^TM[A-Z0-9]{6}$' },
        passwordHash: { bsonType: 'string', pattern: '^[a-f0-9]{32}:[a-f0-9]{128}$' },
        createdAt: { bsonType: 'date' },
      },
    },
  },

  // A team's repo link and slides for one event. The slides FILE lives in GridFS
  // (slides.files + slides.chunks); slides.fileId points at it.
  submissions: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'teamId', 'updatedAt'],
      properties: {
        eventId: { bsonType: 'objectId' },
        teamId: { bsonType: 'objectId' }, // reference to teams._id
        githubUrl: { bsonType: 'string', pattern: '^https://(www\\.)?github\\.com/' },
        slides: {
          bsonType: 'object',
          required: ['fileId', 'filename', 'size', 'contentType', 'uploadedAt'],
          properties: {
            fileId: { bsonType: 'objectId' },
            filename: { bsonType: 'string' },
            size: { bsonType: 'number', minimum: 1, maximum: 20971520 },
            contentType: { bsonType: 'string' },
            uploadedAt: { bsonType: 'date' },
          },
        },
        updatedAt: { bsonType: 'date' },
      },
    },
  },

  // An admin asking a team to join an event. The team joins only if it accepts.
  invitations: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'accountId', 'invitedBy', 'status', 'createdAt'],
      properties: {
        eventId: { bsonType: 'objectId' },
        accountId: { bsonType: 'objectId' },
        invitedBy: { bsonType: 'string' }, // the admin's username, shown to the team
        status: { enum: ['pending', 'accepted', 'declined'] },
        createdAt: { bsonType: 'date' },
        respondedAt: { bsonType: 'date' },
      },
    },
  },

  // A judge who registered on the platform. Like a team, the code never changes and
  // is how an admin invites them; the password (scrypt hash) proves it IS that judge.
  judgeAccounts: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['name', 'code', 'passwordHash', 'createdAt'],
      properties: {
        name: { bsonType: 'string', minLength: 1, maxLength: 100 },
        code: { bsonType: 'string', pattern: '^JG[A-Z0-9]{6}$' },
        passwordHash: { bsonType: 'string', pattern: '^[a-f0-9]{32}:[a-f0-9]{128}$' },
        createdAt: { bsonType: 'date' },
      },
    },
  },

  // An admin asking a judge to judge an event. The judge joins only if they accept.
  judgeInvitations: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'accountId', 'invitedBy', 'status', 'createdAt'],
      properties: {
        eventId: { bsonType: 'objectId' },
        accountId: { bsonType: 'objectId' }, // reference to judgeAccounts._id
        invitedBy: { bsonType: 'string' },
        status: { enum: ['pending', 'accepted', 'declined'] },
        createdAt: { bsonType: 'date' },
        respondedAt: { bsonType: 'date' },
      },
    },
  },

  // A judge's seat in ONE event. Scores point at this document's _id.
  // name is copied from the judge account when they accept the invitation.
  judges: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['eventId', 'accountId', 'name', 'joinedAt'],
      properties: {
        eventId: { bsonType: 'objectId' },
        accountId: { bsonType: 'objectId' }, // reference to judgeAccounts._id
        name: { bsonType: 'string', minLength: 1 },
        joinedAt: { bsonType: 'date' },
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
    // NO DUPLICATES: a team account can be in each event only once. PARTIAL, because
    // old-style teams have no accountId and must not clash with each other.
    {
      key: { eventId: 1, accountId: 1 },
      options: { unique: true, partialFilterExpression: { accountId: { $exists: true } }, name: 'unique_event_account' },
    },
    // "Which events is this team in?" for the team dashboard.
    { key: { accountId: 1 }, options: { name: 'accountId_1' } },
    // Team login looks a team up by its code hash. "sparse" = teams without a
    // codeHash are left out of the index, so they don't clash with each other.
    { key: { codeHash: 1 }, options: { unique: true, sparse: true, name: 'unique_codeHash' } },
  ],
  judges: [
    { key: { eventId: 1 }, options: { name: 'eventId_1' } },
    // NO DUPLICATES: a judge account can be in each event only once.
    { key: { eventId: 1, accountId: 1 }, options: { unique: true, name: 'unique_event_account' } },
    // "Which events does this judge judge?" for the judge dashboard.
    { key: { accountId: 1 }, options: { name: 'accountId_1' } },
  ],
  judgeAccounts: [
    // The judge code is how admins find a judge, so it must be unique.
    { key: { code: 1 }, options: { unique: true, name: 'unique_code' } },
  ],
  judgeInvitations: [
    // At most ONE pending invitation per judge per event (PARTIAL: answered ones don't count).
    {
      key: { eventId: 1, accountId: 1 },
      options: { unique: true, partialFilterExpression: { status: 'pending' }, name: 'unique_pending_invite' },
    },
    { key: { accountId: 1, status: 1 }, options: { name: 'accountId_1_status_1' } },
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
  teamAccounts: [
    // The team code is how admins find a team, so it must be unique.
    { key: { code: 1 }, options: { unique: true, name: 'unique_code' } },
  ],
  invitations: [
    // At most ONE pending invitation per team per event (PARTIAL: old answered ones don't count).
    {
      key: { eventId: 1, accountId: 1 },
      options: { unique: true, partialFilterExpression: { status: 'pending' }, name: 'unique_pending_invite' },
    },
    // The team dashboard's "pending invitations" query.
    { key: { accountId: 1, status: 1 }, options: { name: 'accountId_1_status_1' } },
  ],
  submissions: [
    // One submission per team per event; also how the judge page finds it ($lookup on teamId).
    { key: { eventId: 1, teamId: 1 }, options: { unique: true, name: 'unique_event_team' } },
    { key: { teamId: 1 }, options: { name: 'teamId_1' } },
  ],
  admins: [
    // UNIQUE: no two organisers can register the same username (in any letter case).
    { key: { usernameLower: 1 }, options: { unique: true, name: 'unique_usernameLower' } },
  ],
  events: [
    // An organiser's event list: find({ ownerId }).sort({ createdAt: -1 }).
    { key: { ownerId: 1, createdAt: -1 }, options: { name: 'ownerId_1_createdAt_-1' } },
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

  // Judges used to sign in with a per-event access code; judge accounts replace that,
  // so the old code index goes.
  if ((await db.listCollections({ name: 'judges' }).toArray()).length) {
    const old = await db.collection('judges').indexes();
    if (old.some((ix) => ix.name === 'unique_codeHash')) await db.collection('judges').dropIndex('unique_codeHash');
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
