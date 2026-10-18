// Public leaderboard. Uses EventSource (the browser's built-in SSE client):
// the server pushes a new leaderboard every time a score changes - no refreshing,
// no polling. EventSource also reconnects by itself if the connection drops.

const eventId = new URLSearchParams(location.search).get('event');
let previous = {}; // teamId -> { rank, avgScore } from the last update

// ---------- No event chosen: show event cards ----------
async function showEventPicker() {
  $('event-picker').classList.remove('hidden');
  const events = await api('GET', '/api/leaderboard/events');
  const list = $('event-list');
  if (events.length === 0) list.append(el('div', 'No live or closed events yet.', 'card empty'));

  for (const event of events) {
    const card = el('a', null, 'card event-card');
    card.href = `leaderboard.html?event=${event._id}`;
    const head = el('div', null, 'card-head');
    head.append(el('h3', event.name), badge(event.status));
    card.append(head, el('p', event.status === 'live' ? 'Scoring in progress - watch it update live.' : 'Final results and AI feedback.', 'muted'));
    list.append(card);
  }
}

// ---------- Podium (top 3) ----------
function renderPodium(rows) {
  const podium = $('podium');
  podium.replaceChildren();
  if (rows.length === 0) return;

  // Visual order: 2nd, 1st, 3rd (1st in the middle).
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  for (const index of [1, 0, 2]) {
    const row = rows[index];
    if (!row) {
      podium.append(el('div'));
      continue;
    }
    const spot = el('div', null, `podium-spot p${row.rank === 1 ? 1 : ''}`);
    spot.append(
      el('div', medals[row.rank] || `#${row.rank}`, 'medal'),
      el('div', row.teamName, 'pname'),
      el('div', row.avgScore.toFixed(2), 'pscore'),
      starsFromScore(row.avgScore),
      el('div', `${row.judgesCount} judge(s)`, 'muted small')
    );
    podium.append(spot);
  }
}

// ---------- Full table ----------
function renderRows(rows) {
  renderPodium(rows);
  const tbody = $('rows');
  tbody.replaceChildren();
  $('empty').classList.toggle('hidden', rows.length > 0);

  for (const row of rows) {
    const tr = el('tr', null, 'lb-row');
    const before = previous[row.teamId];

    const rankCell = el('td', `#${row.rank}`, 'rank-cell');
    // Arrow showing how the rank moved since the last update.
    if (before && before.rank !== row.rank) {
      const up = row.rank < before.rank;
      rankCell.append(el('span', up ? `▲${before.rank - row.rank}` : `▼${row.rank - before.rank}`, `move ${up ? 'up' : 'down'}`));
    }
    if (before && before.avgScore !== row.avgScore) tr.classList.add('changed');

    const barCell = el('td');
    const bar = el('div', null, 'bar');
    const fill = el('span');
    fill.style.width = `${(row.avgScore / 10) * 100}%`;
    bar.append(fill);
    barCell.append(bar);

    const nameCell = el('td');
    nameCell.append(el('strong', row.teamName), el('br'), starsFromScore(row.avgScore));

    tr.append(rankCell, nameCell, el('td', row.avgScore.toFixed(2), 'rank-cell'), barCell, el('td', row.judgesCount));
    tbody.append(tr);
    if (tr.classList.contains('changed')) setTimeout(() => tr.classList.remove('changed'), 1600);
  }

  previous = {};
  for (const row of rows) previous[row.teamId] = { rank: row.rank, avgScore: row.avgScore };
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function setConnection(isLive) {
  $('conn-dot').className = isLive ? 'pulse' : 'pulse off';
  $('conn-text').textContent = isLive ? 'Live' : 'Reconnecting...';
}

function connectLiveUpdates() {
  const source = new EventSource(`/api/events/${eventId}/stream`);
  // Our server sends messages named "leaderboard" (see services/sse.js).
  source.addEventListener('leaderboard', (msg) => renderRows(JSON.parse(msg.data)));
  source.addEventListener('open', () => setConnection(true));
  source.addEventListener('error', () => setConnection(false));
}

// ---------- AI feedback (closed events only) ----------
async function loadFeedback() {
  const items = await api('GET', `/api/events/${eventId}/feedback`);
  if (items.length === 0) return;
  $('feedback-section').classList.remove('hidden');
  const list = $('feedback-list');

  for (const f of items) {
    const card = el('div', null, 'card feedback-card');
    const title = el('h3', f.teamName);
    title.append(badge(f.sentiment.label));
    if (f.source === 'mock') title.append(badge('mock'));
    card.append(title, el('p', f.summary, 'muted'));
    for (const [heading, points] of [['Strengths', f.strengths], ['Improvements', f.improvements]]) {
      if (points.length === 0) continue;
      const ul = el('ul');
      points.forEach((p) => ul.append(el('li', p)));
      card.append(el('strong', heading), ul);
    }
    list.append(card);
  }
}

// ---------- Start ----------
async function start() {
  if (!eventId) return showEventPicker();

  // First load with a normal request (also checks the event exists).
  const data = await api('GET', `/api/events/${eventId}/leaderboard`);
  $('board').classList.remove('hidden');
  $('event-name').textContent = data.event.name;
  $('event-status').replaceChildren(badge(data.event.status));
  document.title = `${data.event.name} - ScoreStream`;
  renderRows(data.rows);

  connectLiveUpdates();
  if (data.event.status === 'closed') await loadFeedback();
}

safely(start);
