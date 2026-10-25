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
function mockFeedback(comments, reason) {
  const text = comments.join(' ').toLowerCase();
  const goodWords = ['great', 'good', 'excellent', 'strong', 'clear', 'impressive', 'creative', 'well', 'nice', 'solid'];
  const badWords = ['weak', 'poor', 'unclear', 'missing', 'slow', 'confusing', 'lacks', 'bug', 'incomplete', 'needs'];
  const good = goodWords.filter((w) => text.includes(w)).length;
  const bad = badWords.filter((w) => text.includes(w)).length;
  const score = good + bad === 0 ? 0 : Math.round(((good - bad) / (good + bad)) * 100) / 100;
  const label = score > 0.2 ? 'positive' : score < -0.2 ? 'negative' : 'neutral';

  return {
    summary: `[MOCK - ${reason}] Based on ${comments.length} judge comment(s), the overall tone was ${label}.`,
    strengths: good > 0 ? ['[MOCK] Judges used positive words such as "good" or "clear"'] : [],
    improvements: bad > 0 ? ['[MOCK] Judges pointed out some weak or missing areas'] : [],
    sentiment: { label, score },
    source: 'mock',
  };
}

// Main function used by services/feedback.js.
// scoreSummary is optional text like "average 7.4/10, rank 2 of 5; Design 8/10, ...".
// Returns { summary, strengths, improvements, sentiment: {label, score}, source: 'ai'|'mock' }
async function generateTeamFeedback(teamName, comments, scoreSummary = '') {
  if (comments.length === 0) {
    return mockFeedback(comments, 'no judge comments to summarise');
  }
  if (config.aiForceMock || !config.aiApiKey) {
    return mockFeedback(comments, 'no AI_API_KEY set');
  }

  // Main model first, then the fallback model (if one is set in .env).
  // The fallback uses its own base URL / key when given, otherwise the main ones.
  const providers = [{ baseUrl: config.aiBaseUrl, apiKey: config.aiApiKey, model: config.aiModel }];
  if (config.aiFallbackModel) {
    providers.push({
      baseUrl: config.aiFallbackBaseUrl || config.aiBaseUrl,
      apiKey: config.aiFallbackApiKey || config.aiApiKey,
      model: config.aiFallbackModel,
    });
  }

  // Each model gets two tries: the first try, plus ONE retry (e.g. if it returned bad JSON).
  for (const provider of providers) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await callModel(provider, teamName, comments, scoreSummary);
        return { ...result, source: 'ai' };
      } catch (err) {
        console.error(`[ai] ${provider.model} attempt ${attempt} for "${teamName}" failed: ${err.message}`);
      }
    }
  }
  return mockFeedback(comments, 'AI request failed after retries');
}

// True when real AI calls will be made (used to pause between teams for rate limits).
function usingRealAi() {
  return Boolean(config.aiApiKey) && !config.aiForceMock;
}

module.exports = { generateTeamFeedback, usingRealAi, stripCodeFence };
