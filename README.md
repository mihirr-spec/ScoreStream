# ScoreStream

**A live event judging and leaderboard system built on MongoDB.**

Judges score teams at a live event, and the leaderboard updates in real time for everyone
watching. When an event closes, an LLM reads each team's judge comments and writes short
feedback for that team.

**Stack:** Node.js + Express 5, the MongoDB **native driver** (no Mongoose), MongoDB Atlas,
plain HTML/CSS/JS, Server-Sent Events, `node --test`.

---

## 1. Setup

```bash
git clone git@github.com:mihirr-spec/ScoreStream.git
cd ScoreStream
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `.env`:

| Key | What to put |
|---|---|
| `MONGODB_URI` | Atlas connection string (Atlas → Connect → Drivers). Also allow your IP under **Network Access**. |
| `DB_NAME` | e.g. `judging_system` |
| `ADMIN_USERNAME` | Admin login name (optional, defaults to `admin`) |
| `ADMIN_PASSWORD` | Any password you choose for the admin page |
| `JWT_SECRET` | A long random string (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `AI_API_KEY` | Your OpenRouter key. Leave it empty to use the offline **MOCK** feedback. |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` |
| `AI_MODEL` | Main free OpenRouter model, e.g. `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `AI_FALLBACK_MODEL` | Used if the main model fails twice, e.g. `gemini-3.5-flash-lite` (optional) |
| `AI_FALLBACK_BASE_URL` | Optional different provider for the fallback, e.g. `https://generativelanguage.googleapis.com/v1beta/openai` (Google Gemini) |
| `AI_FALLBACK_API_KEY` | Key for that provider (free Gemini key from aistudio.google.com). Empty = use `AI_API_KEY` |
| `PORT` | `3000` |

Then:

```bash
npm run setup-db   # collections + $jsonSchema validators + indexes (safe to re-run)
npm run dev        # start the server (auto-restarts when you edit files)
```

Open http://localhost:3000 for the landing page, then **Log in** (one screen, three roles):

| Role | How to log in | What they get |
|---|---|---|
| Admin | **Create an account** on the Administrator tab, or use `ADMIN_USERNAME` + `ADMIN_PASSWORD` from `.env` (sees every event) | Dashboard and Events list. Inside each event: invite judges by their judge code and teams by their team code, watch judging progress live, rankings, AI feedback, and End Event. Registered admins only see their own events |
| Judge | **Register** on the Judge tab (name, password) to get a permanent judge code. Sign in with **judge code + password**. | Accept or decline invitations, then per event rate the teams one at a time (stars + feedback, repo and slides at hand), then "Submit & next". Scoring locks when the admin ends the event |
| Team | **Register** on the Team tab (team name, members, password) to get a permanent team code. Sign in with **team code + password**. | Accept or decline invitations, then per event: share a GitHub repo and slides, live rank, average, every judge's marks and comments, and AI feedback once the event ends |

**How teams and judges join an event:** the admin enters their code, which creates a *pending invitation*. They
see a pop-up on their dashboard ("*admin* wants to add you to *event*") and accept or decline. Only
accepting adds them, and the admin's event page updates live when they do. Duplicates are impossible: one account per team, and unique indexes allow each team
in an event only once and only one open invitation per team per event.

**Ending an event** closes scoring, recomputes the final ranking and
writes AI feedback for every team: the model merges the judges' short notes (e.g. "nice UI, laggy",
"hgih latency") into one written review.

**Excel:** "Invite from Excel" reads a `Team code` column and sends one invitation per row. "Export to Excel"
downloads the event's teams with codes, ranks and averages.

**Submissions:** in each event a team can share its **GitHub repo** link and upload its **slides**
(PDF, PowerPoint, Word, Excel, CSV or image, up to 20 MB) until the event ends. Judges preview both inside the scoring card, and the
admin sees them in the event's team list. Slide files are stored in MongoDB with **GridFS**
(`slides.files` + `slides.chunks`), so no separate file server is needed and files survive redeploys.

The public leaderboard is at http://localhost:3000/leaderboard.html.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run setup-db` | Creates/updates all collections, validators and indexes |
| `npm run dev` / `npm start` | Runs the server (with / without auto-restart) |
| `npm run explain` | Prints COLLSCAN vs IXSCAN for the main queries |
| `npm test` | Runs the API tests: the 6 required cases plus team accounts, invitations and duplicates, submissions, judge invitations and admin accounts (separate `<DB_NAME>_test` database) |

### explain() screenshots (COLLSCAN vs IXSCAN)

```bash
npm run explain -- --drop-indexes   # BEFORE: drops scores indexes -> COLLSCAN, examines ALL scores
npm run setup-db                    # put the indexes back (important!)
npm run explain                     # AFTER: IXSCAN using eventId_1, examines only this event's scores
```

## 3. Folder structure

```
ScoreStream/
├── src/                        Backend (Node.js + Express)
│   ├── server.js               Entry point: connect DB, start Change Stream, listen
│   ├── app.js                  Express app: middleware, static files, routes, errors
│   ├── config.js               Reads .env in one place
│   ├── db.js                   One shared MongoClient (connectDb / getDb / closeDb)
│   ├── middleware/
│   │   ├── auth.js             JWT tokens, requireAdmin/Judge/Team, event ownership, sha256, scrypt passwords
│   │   ├── validate.js         httpError, parseId, rubric and members validation
│   │   └── errorHandler.js     JSON 404 and the central error handler
│   ├── routes/
│   │   ├── index.js            Registers every router under /api
│   │   └── auth, events, teams, judges, scores, leaderboard, feedback
│   └── services/
│       ├── scoring.js          Validate marks + weighted total
│       ├── leaderboard.js      Aggregation pipeline ending in $merge
│       ├── changeStream.js     Watches scores -> recompute -> SSE push
│       ├── sse.js              Connected browsers per event
│       ├── feedback.js         Writes AI feedback for every team of a closed event
│       └── ai.js               OpenRouter call + fallback model + mock (only AI-specific file)
├── public/                     Frontend (plain HTML, CSS, JS)
│   ├── index.html              Landing page
│   ├── login.html              One login screen for Admin / Judge / Team (+ team and admin sign-up)
│   ├── admin.html  judge.html  team.html  leaderboard.html
│   ├── css/style.css           Shared design system
│   ├── img/                    Hero image and free-licensed Pexels photos
│   └── js/common.js            Shared helpers (api, auth tokens, toasts, stars)
│       js/landing.js  login.js  admin.js  judge.js  team.js  leaderboard.js
├── scripts/                    One-off database scripts
│   ├── setup-db.js             Collections, $jsonSchema validators, indexes
│   └── explain.js              COLLSCAN vs IXSCAN report
├── tests/
│   └── api.test.js             The 6 required API tests (node --test)
├── docs/
│   ├── ScoreStream_Project_Report.pdf
│   └── report/                 Report source (HTML) and screenshots
├── .env.example                Config keys with no secret values
├── .editorconfig  .gitattributes  .gitignore  .nvmrc
└── package.json
```

## 4. Data model

| Collection | Fields | Notes |
|---|---|---|
| `events` | name, status (`draft`/`live`/`closed`), rubric `[{key,label,max,weight}]`, createdAt | Rubric is **embedded**: it is small and always read together with its event |
| `teams` | eventId, name, members[] | References its event |
| `judgeAccounts` | name, code (`JG…`), passwordHash, createdAt | A registered judge; the code never changes |
| `judgeInvitations` | eventId, accountId, invitedBy, status, createdAt | Pending until the judge accepts or declines |
| `judges` | eventId, accountId, name, joinedAt | A judge's seat in one event; scores reference it |
| `scores` | eventId, teamId, judgeId, criteria{}, total, comment, submittedAt | **References**, not embedded: written often by many judges and queried on its own |
| `leaderboard` | eventId, teamId, teamName, avgScore, judgesCount, rank, updatedAt | Written only by `$merge` |
| `feedback` | eventId, teamId, summary, strengths[], improvements[], sentiment{label,score}, source, generatedAt | `source` is `ai` or `mock` |

**Scoring formula:** `total = 10 × Σ (mark_i / max_i) × weight_i` (out of 10).
For example, marks 8, 7, 9 with weights 0.3, 0.4, 0.3 → **7.9**. `avgScore` is the average of `total` across judges.

## 5. MongoDB features (viva checklist)

- **$jsonSchema validators on all 12 collections** (`scripts/setup-db.js`), set with `validationLevel: strict` and `validationAction: error`. `criteria` uses `additionalProperties: { bsonType: 'number' }`, which allows any keys but only numbers as values. Password hashes must match the scrypt `salt:hash` pattern, so a plain password can never be stored by mistake. Rules a schema can't express (weights add up to 1, criteria keys match the rubric) are checked in Node.
- **Indexes:**
  - `scores` UNIQUE `{eventId, teamId, judgeId}`: the database itself blocks a second score from a judge for the same team (error 11000 → HTTP 409).
  - `scores {eventId}`, `teams {eventId}` and `judges {eventId}` make the per-event queries fast.
  - `leaderboard` UNIQUE `{eventId, teamId}` is required by `$merge`.
  - Extras:
    - `judgeAccounts` UNIQUE `{code}`; `judges` UNIQUE `{eventId, accountId}` and `judgeInvitations` **partial** unique `{eventId, accountId}` where `status: 'pending'` stop duplicate judges and invitations.
    - `feedback` UNIQUE `{eventId, teamId}` keeps one feedback document per team (used by an upsert).
    - `teams` **partial** unique `{eventId, accountId}` stops the same team account joining an event twice.
    - `invitations` **partial** unique `{eventId, accountId}` where `status: 'pending'` allows one open invitation per team per event.
    - `teamAccounts` UNIQUE `{code}`, `admins` UNIQUE `{usernameLower}`, `submissions` UNIQUE `{eventId, teamId}`.
- **Per-criterion averages** for the team page use `$objectToArray` -> `$unwind` -> `$group` on the free-form `criteria` object.
- **Aggregation pipeline** (`services/leaderboard.js`): `$match` → `$group` (`$avg`, `$sum`) → `$set` (`$round`) → `$lookup` teams → `$unwind` → `$setWindowFields` with `$rank` → `$project` → `$merge` into `leaderboard`.
- **Change Stream** (`services/changeStream.js`): `scores.watch()` filtered to insert, update, replace and delete, with `fullDocument: 'updateLookup'`.
  - On any change, the server recomputes that event's leaderboard and pushes it over SSE.
  - A delete has no document, so the server recomputes every `live` event.
  - The handler never writes to `scores`, which avoids an infinite loop.
  - Changes are processed one at a time, in order.
- **explain('executionStats')** (`scripts/explain.js`): shows COLLSCAN vs IXSCAN, keys examined and documents examined.

## 6. API

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/admin-register`, `/api/auth/admin-login` `{username, password}` | public |
| POST | `/api/auth/judge-register` `{name, password}`, `/api/auth/judge-login` `{code, password}` | public |
| POST | `/api/auth/team-register` `{name, members, password}`, `/api/auth/team-login` `{code, password}` | public |
| GET, POST | `/api/events` | admin |
| GET, PATCH, DELETE | `/api/events/:id` (PATCH: status and/or rubric) | admin |
| GET | `/api/events/:eventId/teams` (with team code, repo link and slides info) | admin |
| DELETE | `/api/teams/:id` (removes the team from the event) | admin |
| GET, POST | `/api/events/:eventId/invitations` `{code}` or `{codes: [...]}` | admin |
| DELETE | `/api/invitations/:id` (withdraw a pending invitation) | admin |
| GET, POST | `/api/events/:eventId/judges` (GET: judges with code and progress; POST `{code}`: invite) | admin |
| GET | `/api/events/:eventId/judge-invitations`; DELETE `/api/judge-invitations/:id` | admin |
| DELETE | `/api/judges/:id` (removes the judge from the event, with their scores) | admin |
| GET | `/api/teams/:id/slides` (download) | admin |
| GET | `/api/team/me` (account, events, pending invitations) | team |
| POST | `/api/team/invitations/:id` `{accept}` | team |
| GET | `/api/team/events/:eventId` (rank, per-criterion averages, judges' scores, submission, feedback once closed) | team |
| PUT | `/api/team/events/:eventId/submission` `{githubUrl}` | team |
| PUT, GET, DELETE | `/api/team/events/:eventId/slides?name=deck.pptx` (PUT body = the raw file) | team |
| GET | `/api/judge/me` (account, events with progress, pending invitations) | judge |
| POST | `/api/judge/invitations/:id` `{accept}` | judge |
| GET | `/api/judge/events/:eventId` (rubric, teams with submissions, own scores) | judge |
| GET | `/api/judge/teams/:teamId/slides` (download) | judge |
| POST | `/api/scores` `{teamId, criteria, comment}` | judge |
| PUT | `/api/scores/:id` `{criteria, comment}` | judge (own scores only) |
| GET | `/api/events/:eventId/scores` | admin |
| GET | `/api/leaderboard/events` (live and closed events) | public |
| GET | `/api/events/:eventId/leaderboard` | public |
| GET | `/api/events/:eventId/stream` (SSE) | public |
| POST | `/api/events/:eventId/feedback/generate` (event must be `closed`) | admin |
| GET | `/api/events/:eventId/feedback` | public |

Errors are always `{ "error": "message" }` with a proper status code:
- 400: bad input
- 401: not logged in or bad token
- 403: wrong role, or the event is not live
- 404: not found
- 409: duplicate, or the wrong event state

Stack traces are never sent to the client.

## 7. Security notes

- Admin password check uses `crypto.timingSafeEqual` on SHA-256 digests (equal length).
- Admin, judge and team passwords are stored only as scrypt hashes with a random salt.
- Tokens are JWTs signed with `JWT_SECRET` and expire after 12 hours. A judge or team token also stops working if the account is deleted.
- A judge can only score teams of events they accepted, and only while the event is `live`.
- Marks must be numbers from 0 to the criterion's max. Unknown or missing criteria are rejected.
- The frontend uses `textContent` only, so user-entered names can't inject HTML.
- `.env` is git-ignored. Only `.env.example` (keys, no secrets) is tracked.

## 8. AI feedback

`services/ai.js` is the only file that knows about OpenRouter:
- It sends **all** of a team's comments in one request and asks for JSON only.
- It strips any ```json code fences from the reply and parses it inside try/catch.
- On bad JSON or any failure it **retries once**. If the main model still fails, it tries `AI_FALLBACK_MODEL` (also with one retry), then falls back to a **MOCK** result. Mock results have `source: 'mock'` and a summary starting with `[MOCK - reason]`.
- The route generates feedback team by team, with a 3.5 s pause between real AI calls, to stay under the free tier's limit of about 20 requests per minute.

## 9. Tests

`npm test` covers:
1. Valid marks are saved, with total 7.9.
2. A mark above the max → 400.
3. The same judge scoring the same team twice → 409. The test also checks that a direct insert is rejected by the unique index.
4. A judge edits a score → the total is recalculated and the Change Stream re-ranks the leaderboard.
5. No token, a judge token or a bad token on an admin route → 401/403.
6. Feedback generation (mock) saves a summary and sentiment.

The tests use the `MONGODB_URI` from `.env`, but work in a separate `<DB_NAME>_test` database that they drop afterwards.
