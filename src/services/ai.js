// ALL AI-provider details live in this one file, so the provider can be swapped here
// without touching any route. The rest of the app only calls generateTeamFeedback().
//
// Provider: OpenRouter, which uses the OpenAI-compatible "chat completions" API.
// Order of attempts: AI_MODEL (try + 1 retry) -> AI_FALLBACK_MODEL (try + 1 retry).
// If there is no API key, or every attempt fails, we return a clearly-labelled
// MOCK result so the demo also works offline.

const config = require('../config');

const SYSTEM_PROMPT = `You are an assistant that summarises judges' comments for a team at a competition.
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

// One request to OpenRouter with the given model.
// Throws on any problem (HTTP error, bad JSON, wrong shape).
async function callModel(model, teamName, comments) {
  const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.aiApiKey}`,
      'Content-Type': 'application/json',
      // Optional OpenRouter headers that identify our app on their dashboard.
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Live Event Judging System',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3, // low = more consistent, less "creative" answers
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Team: ${teamName}\nJudges' comments:\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60000), // give up after 60 seconds
  });

  if (!response.ok) {
    throw new Error(`AI request failed with HTTP ${response.status}`);
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

// Main function used by routes/feedback.js.
// Returns { summary, strengths, improvements, sentiment: {label, score}, source: 'ai'|'mock' }
async function generateTeamFeedback(teamName, comments) {
  if (comments.length === 0) {
    return mockFeedback(comments, 'no judge comments to summarise');
  }
  if (config.aiForceMock || !config.aiApiKey) {
    return mockFeedback(comments, 'no AI_API_KEY set');
  }

  // Main model first, then the fallback model (if one is set in .env).
  const models = [config.aiModel];
  if (config.aiFallbackModel) models.push(config.aiFallbackModel);

  // Each model gets two tries: the first try, plus ONE retry (e.g. if it returned bad JSON).
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await callModel(model, teamName, comments);
        return { ...result, source: 'ai' };
      } catch (err) {
        console.error(`[ai] ${model} attempt ${attempt} for "${teamName}" failed: ${err.message}`);
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
