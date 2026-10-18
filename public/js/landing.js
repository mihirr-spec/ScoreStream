// Landing page: scroll animations + the small live leaderboard in the hero.
// If an event is live, the widget shows REAL data pushed over SSE.
// If not, it plays a short demo so the page still shows the idea.

// ---------- Fade sections in as they scroll into view ----------
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.12 }
);
document.querySelectorAll('.reveal').forEach((node) => observer.observe(node));

// ---------- Hero leaderboard widget ----------
let lastScores = {}; // teamName -> avgScore, to flash rows that changed

function renderWidget(rows) {
  const box = $('bw-rows');
  box.replaceChildren();

  for (const row of rows.slice(0, 5)) {
    const line = el('div', null, 'bw-row');
    const middle = el('div');
    const bar = el('div', null, 'bw-bar');
    const fill = el('span');
    fill.style.width = `${(row.avgScore / 10) * 100}%`;
    bar.append(fill);
    middle.append(el('div', row.teamName, 'bw-name'), bar);
    line.append(el('span', `#${row.rank}`, 'bw-rank'), middle, el('span', row.avgScore.toFixed(2), 'bw-score'));

    const before = lastScores[row.teamName];
    if (before !== undefined && before !== row.avgScore) {
      line.classList.add('flash');
      setTimeout(() => line.classList.remove('flash'), 1200);
      $('chip-text').textContent = `${row.teamName} is now #${row.rank}`;
    }
    box.append(line);
  }

  lastScores = {};
  for (const row of rows) lastScores[row.teamName] = row.avgScore;
}

// Real data: first live event -> its leaderboard -> keep listening over SSE.
async function startLiveWidget() {
  const events = await api('GET', '/api/leaderboard/events');
  // Prefer the live demo event (anyone can rate it), otherwise any live event.
  const live = events.find((e) => e.status === 'live' && e.demo) || events.find((e) => e.status === 'live');
  if (!live) return false;

  const data = await api('GET', `/api/events/${live._id}/leaderboard`);
  if (data.rows.length < 2) return false;

  $('bw-title').textContent = live.name;
  $('bw-foot').textContent = 'Real scores from a live event, pushed by the server';
  renderWidget(data.rows);

  const source = new EventSource(`/api/events/${live._id}/stream`);
  source.addEventListener('leaderboard', (msg) => renderWidget(JSON.parse(msg.data)));
  return true;
}

// Demo data: random small score changes every few seconds, re-ranked locally.
function startDemoWidget() {
  const teams = [
    { teamName: 'Query Queens', avgScore: 8.7 },
    { teamName: 'Byte Bandits', avgScore: 7.9 },
    { teamName: 'The Indexers', avgScore: 7.1 },
    { teamName: 'Null Pointers', avgScore: 6.6 },
    { teamName: 'Stack Smashers', avgScore: 5.9 },
  ];

  function rankAndRender() {
    teams.sort((a, b) => b.avgScore - a.avgScore);
    teams.forEach((t, i) => (t.rank = i + 1));
    renderWidget(teams.map((t) => ({ ...t })));
  }

  rankAndRender();
  setInterval(() => {
    const team = teams[Math.floor(Math.random() * teams.length)];
    const change = (Math.random() * 1.6 - 0.6).toFixed(2);
    team.avgScore = Math.min(9.8, Math.max(4, Math.round((team.avgScore + Number(change)) * 100) / 100));
    rankAndRender();
  }, 2800);
}

startLiveWidget()
  .then((isLive) => {
    if (!isLive) startDemoWidget();
  })
  .catch(startDemoWidget);
