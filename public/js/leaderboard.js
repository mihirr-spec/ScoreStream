// Public leaderboard. Uses EventSource (the browser's built-in SSE client):
// the server pushes a new leaderboard every time a score changes - no refreshing,
// no polling. EventSource also reconnects by itself if the connection drops.

const eventId = new URLSearchParams(location.search).get('event');
let previousScores = {}; // teamId -> avgScore, to highlight rows that changed

function $(id) {
  return document.getElementById(id);
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(text) {
  $('message').textContent = text;
  $('message').className = 'message error';
}

async function getJson(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- no event chosen: show a list ----------

async function showEventPicker() {
  $('event-picker').classList.remove('hidden');
  const events = await getJson('/api/leaderboard/events');
  const list = $('event-list');
  if (events.length === 0) list.append(el('p', 'No live or closed events yet.', 'muted'));
  for (const event of events) {
    const item = el('div', null, 'list-item');
    const link = el('a', event.name);
    link.href = `leaderboard.html?event=${event._id}`;
    item.append(link, el('span', event.status, `pill ${event.status}`));
    list.append(item);
  }
}

// ---------- the leaderboard table ----------

function renderRows(rows) {
  const tbody = $('rows');
  tbody.replaceChildren();
  $('empty').classList.toggle('hidden', rows.length > 0);

  for (const row of rows) {
    const tr = el('tr');
    if (row.rank === 1) tr.className = 'top1';
    // Flash the row if this team's average changed since the last update.
    const before = previousScores[row.teamId];
    if (before !== undefined && before !== row.avgScore) tr.classList.add('changed');

    tr.append(
      el('td', `#${row.rank}`, 'rank'),
      el('td', row.teamName),
      el('td', row.avgScore.toFixed(2), 'score-big'),
      el('td', row.judgesCount)
    );
    tbody.append(tr);
  }

  previousScores = {};
  for (const row of rows) previousScores[row.teamId] = row.avgScore;
  $('updated').textContent = `Last update: ${new Date().toLocaleTimeString()}`;
}

function connectLiveUpdates() {
  const source = new EventSource(`/api/events/${eventId}/stream`);

  // Our server sends messages named "leaderboard" (see services/sse.js).
  source.addEventListener('leaderboard', (msg) => {
    renderRows(JSON.parse(msg.data));
  });
  source.addEventListener('open', () => {
    $('connection').textContent = '● Live';
    $('connection').className = 'connection on shrink';
  });
  source.addEventListener('error', () => {
    $('connection').textContent = '● Reconnecting...';
    $('connection').className = 'connection off shrink';
  });
}

// ---------- AI feedback (closed events only) ----------

async function loadFeedback() {
  const items = await getJson(`/api/events/${eventId}/feedback`);
  if (items.length === 0) return;
  $('feedback-section').classList.remove('hidden');
  const list = $('feedback-list');
  for (const f of items) {
    const card = el('div', null, 'card feedback-card');
    const title = el('h3', f.teamName);
    title.append(' ', el('span', f.sentiment.label, `pill ${f.sentiment.label}`));
    if (f.source === 'mock') title.append(' ', el('span', 'mock', 'pill mock'));
    card.append(title, el('p', f.summary));
    for (const [heading, points] of [['Strengths', f.strengths], ['Improvements', f.improvements]]) {
      if (points.length === 0) continue;
      const ul = el('ul');
      points.forEach((p) => ul.append(el('li', p)));
      card.append(el('strong', heading), ul);
    }
    list.append(card);
  }
}

// ---------- start ----------

async function start() {
  if (!eventId) return showEventPicker();

  // First load with a normal request (also checks the event exists).
  const data = await getJson(`/api/events/${eventId}/leaderboard`);
  $('board').classList.remove('hidden');
  $('event-name').textContent = data.event.name;
  $('event-status').textContent = data.event.status;
  $('event-status').className = `pill ${data.event.status}`;
  document.title = `${data.event.name} - Leaderboard`;
  renderRows(data.rows);

  connectLiveUpdates();
  if (data.event.status === 'closed') await loadFeedback();
}

start().catch((err) => showError(err.message));
