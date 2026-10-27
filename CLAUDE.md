# ScoreStream – project guide for Claude

Live event judging + real-time leaderboard on MongoDB, with AI-written team feedback.
Node.js ≥ 20.19, Express 5, **MongoDB native driver (no Mongoose)**, MongoDB Atlas (replica set, needed
for Change Streams), plain HTML/CSS/JS frontend (no framework, no build step), SSE, `node --test`.
CommonJS (`require`) everywhere. README.md has the full API table, data model and feature list – read the
relevant section there instead of scanning the code.

## Commands
- `npm run dev` – server with auto-restart on http://localhost:3000 (`npm start` without watch)
- `npm run setup-db` – collections, `$jsonSchema` validators, indexes (idempotent; run after schema changes)
- `npm test` – `tests/api.test.js` against a separate `<DB_NAME>_test` DB, AI forced to mock
- `npm run explain` – COLLSCAN vs IXSCAN report (`-- --drop-indexes` drops them; re-run setup-db after!)
- Quick AI check without the UI:
  `node -e "require('./src/services/ai').checkAi().then(r=>console.log(JSON.stringify(r,null,1)))"`

## Layout (where to look)
- `src/server.js` connect DB → start Change Stream → listen. `src/app.js` Express app (tests import it).
- `src/config.js` the ONLY place that reads `process.env`. Add new settings here + `.env.example` + README §1.
- `src/db.js` shared client: `connectDb / getDb / closeDb`.
- `src/middleware/` `auth.js` (JWT 12h, `requireAdmin/Judge/Team`, event ownership, scrypt hashes),
  `validate.js` (`httpError`, `parseId`, rubric checks), `errorHandler.js` (JSON 404 + central handler).
- `src/routes/*.js` each router writes full paths (`/events/:id`); all mounted under `/api` in `routes/index.js`.
- `src/services/` `scoring.js` (weighted total), `leaderboard.js` (aggregation ending in `$merge`),
  `changeStream.js` (scores.watch → recompute → SSE), `sse.js`, `feedback.js` (feedback for all teams of a
  closed event), `ai.js` (the ONLY file that knows about the AI provider).
- `scripts/setup-db.js` validators + indexes for all collections. `scripts/explain.js`.
- `public/*.html` + `public/js/<page>.js`; shared helpers in `public/js/common.js` (api, tokens, toasts, stars);
  styles in `public/css/style.css` (design system) and `app.css`.
- `docs/report/`, `report/`, `ScoreStream_ProjectReport_Group19.pdf` – course report; ignore unless asked.

## Conventions
- Errors: `throw httpError(status, msg)`; responses are always `{ error }`; never leak stack traces.
  400 bad input, 401 no/bad token, 403 wrong role / event not live, 404, 409 duplicate / wrong state.
- Duplicates are blocked by unique (often partial) indexes; Mongo error 11000 → 409.
- Rules a `$jsonSchema` can't express (weights sum to 1, criteria keys match rubric) are checked in Node.
- Frontend sets user text with `textContent` only (no `innerHTML` with user data).
- Comments are plain-English and explain *why*; keep the beginner-friendly style of existing files.
- Event status: `draft` → `live` → `closed`. Scoring only while `live`; feedback only when `closed`.
- Score formula: `total = 10 × Σ (mark_i / max_i) × weight_i`.
- Never commit `.env`. Commits go on `dev`.

## AI feedback (src/services/ai.js)
- OpenAI-compatible `POST {baseUrl}/chat/completions`, JSON-only reply, code fences stripped, normalised.
- Order: `AI_MODEL` (try + 1 retry) → `AI_FALLBACK_MODEL` (try + 1 retry) → rule-based MOCK (`source: 'mock'`,
  `aiError` shown only to admin). A 404 (model gone / not free any more) is not retried.
- Fallback can use another provider via `AI_FALLBACK_BASE_URL` + `AI_FALLBACK_API_KEY` (e.g. Gemini).
- Free OpenRouter models change often. If the admin "Test AI connection" shows 404 "unavailable for free",
  the model slug in the server's env is stale: list current free ones with
  `curl -s https://openrouter.ai/api/v1/models` (ids ending in `:free`) and update `AI_MODEL`.
- Env vars on the deployed host are separate from local `.env` – both must be updated.
