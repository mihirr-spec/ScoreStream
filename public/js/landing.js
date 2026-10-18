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

// ---------- Highlight grid (ported from VengeanceUI "highlight-grid") ----------
// One coloured highlight glides behind the hovered cell, changing position,
// size and colour with a CSS transition. The text below explains that feature.
const GRID_COLORS = ['#1d5cf0', '#2b5fd9', '#1e47b0', '#3b74e6', '#14389c', '#2f73ff', '#3566d6', '#1f4fbf', '#4f8df5'];

function setupHighlightGrid() {
  const grid = $('hgrid');
  if (!grid) return;
  const highlight = $('hgrid-highlight');
  const cells = [...grid.querySelectorAll('.hgrid-cell')];
  let active = 0;

  function moveTo(index, animate = true) {
    const cell = cells[index];
    const rect = cell.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    if (rect.width === 0) return;
    highlight.style.transitionDuration = animate ? '' : '0s';
    highlight.style.opacity = '1';
    highlight.style.transform = `translate(${rect.left - gridRect.left - 1}px, ${rect.top - gridRect.top - 1}px)`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.style.backgroundColor = GRID_COLORS[index % GRID_COLORS.length];

    cells.forEach((c, i) => c.classList.toggle('active', i === index));
    $('hgrid-title').textContent = cell.dataset.title;
    $('hgrid-text').textContent = cell.dataset.text;
    active = index;
  }

  cells.forEach((cell, i) => {
    cell.addEventListener('mouseenter', () => moveTo(i));
    cell.addEventListener('focus', () => moveTo(i)); // keyboard users too
    cell.addEventListener('click', () => moveTo(i)); // and touch screens
  });

  // Park on the first cell, and keep the highlight aligned when the layout changes.
  requestAnimationFrame(() => moveTo(0, false));
  new ResizeObserver(() => moveTo(active, false)).observe(grid);
}
setupHighlightGrid();

// ---------- Navbar: highlight the section currently on screen ----------
const navLinks = [...document.querySelectorAll('.nav-link')];
const sectionSpy = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${entry.target.id}`));
    }
  },
  { rootMargin: '-45% 0px -50% 0px' } // "on screen" = crossing the middle of the viewport
);
['how', 'roles', 'ai', 'tech'].forEach((id) => $(id) && sectionSpy.observe($(id)));
