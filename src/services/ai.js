// ALL AI-provider details live in this one file, so the provider can be swapped here
// without touching any route. The rest of the app only calls generateTeamFeedback().
//
// Provider: OpenRouter, which uses the OpenAI-compatible "chat completions" API.
// Order of attempts: AI_MODEL (try + 1 retry) -> AI_FALLBACK_MODEL (try + 1 retry).
// The fallback can use a different provider (e.g. Google Gemini's OpenAI-compatible
// endpoint) via AI_FALLBACK_BASE_URL + AI_FALLBACK_API_KEY.
// If there is no API key, or every attempt fails, we return a clearly-labelled
// MOCK result so the app also works offline.

const config = require('../config');

const SYSTEM_PROMPT = `You are an assistant that turns judges' notes into one compiled piece of feedback for a team at a competition.
Judges often write very short, rough notes with typos (e.g. "nice UI", "slow, laggy", "hgih latency").
Interpret what each judge meant, merge points that say the same thing (e.g. "laggy" and "high latency"),
and write clear, complete, encouraging feedback addressed to the team ("you"/"your"). Do not quote notes word for word.
Use the scores, if given, to judge how strong each area was, but do not just repeat the numbers.
Reply with JSON ONLY. No markdown, no code fences, no extra text.
Use exactly this shape:
{"summary": string (2-3 sentences),
 "strengths": [string, ...] (up to 4 short points),
 "improvements": [string, ...] (up to 4 short points),
 "sentiment": {"label": "positive" | "neutral" | "negative", "score": number from -1 to 1}}`;

// Models sometimes wrap JSON in ```json ... ``` even when told not to. Remove that.
function stripCodeFence(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

// Keep only the fields we expect, with the right types, so a slightly-wrong
// AI reply can never break our $jsonSchema validator.
function normalise(parsed) {
  const toStringList = (list) =>
    Array.isArray(list) ? list.filter((s) => typeof s === 'string').map((s) => s.trim()).slice(0, 4) : [];

  if (typeof parsed.summary !== 'string' || !parsed.sentiment) {
    throw new Error('AI reply is missing summary or sentiment');
  }
  const label = ['positive', 'neutral', 'negative'].includes(parsed.sentiment.label)
    ? parsed.sentiment.label
    : 'neutral';
  let score = Number(parsed.sentiment.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(-1, Math.min(1, score)); // clamp into -1..1

  return {
    summary: parsed.summary.trim(),
    strengths: toStringList(parsed.strengths),
    improvements: toStringList(parsed.improvements),
    sentiment: { label, score },
  };
}

// One request to an OpenAI-compatible "chat completions" API.
// provider = { baseUrl, apiKey, model }. Throws on any problem (HTTP error, bad JSON, wrong shape).
async function callModel(provider, teamName, comments, scoreSummary) {
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider.baseUrl.includes('openrouter.ai')) {
    // Optional OpenRouter headers that identify our app on their dashboard.
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'Live Event Judging System';
  }
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.3, // low = more consistent, less "creative" answers
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Team: ${teamName}\n` +
            (scoreSummary ? `Scores: ${scoreSummary}\n` : '') +
            `Judges' comments:\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60000), // give up after 60 seconds
  });

  if (!response.ok) {
    // Include the provider's own explanation (e.g. "model not found", "invalid API key")
    // so the server log says WHY it failed.
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`AI request failed with HTTP ${response.status}: ${detail}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('AI reply had no message content');
  }
  // JSON.parse throws if the model did not return valid JSON -> caught by the caller.
  return normalise(JSON.parse(stripCodeFence(content)));
}

// Offline fallback. Very simple word counting, clearly marked as MOCK.
// Fallback when no AI answers: a simple rule-based reader of the judges' notes.
// Each note is split into phrases ("Ui is nice | laggy the slides could have been better").
// A phrase with a criticism word is an improvement, one with a praise word a strength,
// and the topic words in it (UI, speed, slides, ...) pick a clean sentence to show.
const PRAISE = /\b(nice|good|great|excellent|strong|clear|impressive|creative|well|solid|clean|cool|love[ds]?|innovative|smooth|amazing|awesome|neat|helpful|useful|polished)\b/;
const CRITICISM =
  /\b(slow|lag\w*|latency|bug\w*|crash\w*|weak|poor|unclear|confusing|missing|lacks?|lacking|incomplete|needs?|need(ed)?|requir\w*|should|could|improve\w*|better|not|no|hard|difficult|broken|basic|limited|messy|issues?|problems?)\b/;
const TOPICS = [
  { words: /\b(ui|ux|design|interface|look\w*|layout|visual\w*|frontend|front-end)\b/, good: 'A well-designed, appealing user interface', bad: 'Refine the user interface and overall design' },
  { words: /\b(lag\w*|slow\w*|latency|performance|speed|fast|responsive\w*|load\w*)\b/, good: 'Fast and responsive in use', bad: 'Improve performance - judges found it slow or laggy' },
  { words: /\b(slides?|ppt|deck|presentation|pitch\w*|demo)\b/, good: 'A clear presentation and pitch', bad: 'Strengthen your slides and presentation' },
  { words: /\b(functionality|features?|functions?|scope|requir\w*)\b/, good: 'Useful functionality', bad: 'Add more functionality - judges expected more features' },
  { words: /\b(idea|concept|innovat\w*|original\w*|creative\w*|problem)\b/, good: 'A strong, original idea', bad: 'Sharpen the idea and the problem it solves' },
  { words: /\b(bug\w*|crash\w*|error\w*|stab\w*|broken)\b/, good: 'Stable and reliable', bad: 'Fix bugs and stability issues' },
  { words: /\b(code|backend|architecture|implementation|execution|tech\w*)\b/, good: 'Solid technical execution', bad: 'Improve the technical execution' },
  { words: /\b(docs?|documentation|readme|explain\w*)\b/, good: 'Well documented', bad: 'Document and explain your project better' },
];

function tidy(phrase) {
  const text = phrase.trim().replace(/\s+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function mockFeedback(comments, reason, scoreSummary = '') {
  const strengths = new Set();
  const improvements = new Set();
  for (const comment of comments) {
    const phrases = comment.toLowerCase().split(/[.,;!?\n]+|\b(?:but|however|although|though|and|also)\b/);
    for (const phrase of phrases) {
      if (!phrase.trim()) continue;
      const critical = CRITICISM.test(phrase);
      const praised = PRAISE.test(phrase) && !critical;
      if (!critical && !praised) continue;
      const topics = TOPICS.filter((t) => t.words.test(phrase));
      if (topics.length === 0) (critical ? improvements : strengths).add(tidy(phrase));
      for (const topic of topics) (critical ? improvements : strengths).add(critical ? topic.bad : topic.good);
    }
  }

  const good = strengths.size;
  const bad = improvements.size;
  let score = good + bad === 0 ? 0 : (good - bad) / (good + bad);
  // Weigh in the team's average too: 5/10 is neutral, 10/10 very positive.
  const average = Number((scoreSummary.match(/average ([\d.]+)\/10/) || [])[1]);
  if (Number.isFinite(average)) score = (score + (average - 5) / 5) / 2;
  score = Math.round(Math.max(-1, Math.min(1, score)) * 100) / 100;
  const label = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const parts = [];
  if (good) parts.push(`The judges appreciated ${[...strengths].slice(0, 2).map(lower).join(' and ')}.`);
  if (bad) parts.push(`Their main suggestions: ${[...improvements].slice(0, 2).map(lower).join('; ')}.`);
  if (!parts.length) parts.push(`The judges left ${comments.length} comment(s) for your team.`);

  console.warn(`[ai] using rule-based feedback: ${reason}`);
  return {
    summary: parts.join(' '),
    strengths: [...strengths].slice(0, 4),
    improvements: [...improvements].slice(0, 4),
    sentiment: { label, score },
    source: 'mock',
    // Why the real AI wasn't used - shown to the admin (never to teams).
    aiError: reason,
  };
}

// Main model first, then the fallback model (if one is set in .env).
// The fallback uses its own base URL / key when given, otherwise the main ones.
function getProviders() {
  const providers = [{ name: 'Main', baseUrl: config.aiBaseUrl, apiKey: config.aiApiKey, model: config.aiModel }];
  if (config.aiFallbackModel) {
    providers.push({
      name: 'Fallback',
      baseUrl: config.aiFallbackBaseUrl || config.aiBaseUrl,
      apiKey: config.aiFallbackApiKey || config.aiApiKey,
      model: config.aiFallbackModel,
    });
  }
  return providers;
}

// Main function used by services/feedback.js.
// scoreSummary is optional text like "average 7.4/10, rank 2 of 5; Design 8/10, ...".
// Returns { summary, strengths, improvements, sentiment: {label, score}, source: 'ai'|'mock', aiError? }
async function generateTeamFeedback(teamName, comments, scoreSummary = '') {
  if (comments.length === 0) {
    return mockFeedback(comments, 'no judge comments to summarise');
  }
  if (config.aiForceMock) return mockFeedback(comments, 'AI_FORCE_MOCK is on', scoreSummary);
  if (!config.aiApiKey) return mockFeedback(comments, 'AI_API_KEY is not set on the server', scoreSummary);

  // Each model gets two tries: the first try, plus ONE retry (e.g. if it returned bad JSON).
  // A rate limit (HTTP 429, common on free models) waits a few seconds before the retry.
  const errors = [];
  for (const provider of getProviders()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await callModel(provider, teamName, comments, scoreSummary);
        return { ...result, source: 'ai' };
      } catch (err) {
        console.error(`[ai] ${provider.model} attempt ${attempt} for "${teamName}" failed: ${err.message}`);
        if (attempt === 2) errors.push(`${provider.name} model (${provider.model}): ${err.message}`);
        else if (/HTTP 429/.test(err.message)) await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  return mockFeedback(comments, errors.join(' | ').slice(0, 600), scoreSummary);
}

// Admin "Test AI" button: one tiny request to each configured model.
// Reports whether each answered and the provider's error if not. Never returns keys.
async function checkAi() {
  const settings = {
    AI_API_KEY: Boolean(config.aiApiKey),
    AI_FALLBACK_API_KEY: Boolean(config.aiFallbackApiKey),
    AI_FORCE_MOCK: Boolean(config.aiForceMock),
  };
  const results = [];
  for (const provider of getProviders()) {
    const started = Date.now();
    const row = { name: provider.name, model: provider.model, host: new URL(provider.baseUrl).host, keySet: Boolean(provider.apiKey) };
    try {
      await callModel(provider, 'Test team', ['nice UI but a bit slow'], '');
      row.ok = true;
    } catch (err) {
      row.ok = false;
      row.error = err.name === 'TimeoutError' ? 'No answer within 60 seconds' : err.message;
    }
    row.ms = Date.now() - started;
    results.push(row);
  }
  return { settings, results };
}

// True when real AI calls will be made (used to pause between teams for rate limits).
function usingRealAi() {
  return Boolean(config.aiApiKey) && !config.aiForceMock;
}

module.exports = { generateTeamFeedback, checkAi, usingRealAi, stripCodeFence };
