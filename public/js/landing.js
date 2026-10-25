// Landing page: scroll animations + the small live leaderboard in the hero.
// If an event is live, the widget shows REAL data pushed over SSE.
// If not, it says so.

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
  const live = events.find((e) => e.status === 'live');
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

// No live event: an empty board with a short explanation.
function showNoLiveEvent() {
  $('bw-rows').replaceChildren(el('p', 'No event is live right now. Rankings appear here as soon as one goes live.', 'bw-empty'));
  $('bw-foot').textContent = 'Waiting for a live event';
  $('chip-text').textContent = 'No live event right now';
}

startLiveWidget()
  .then((isLive) => {
    if (!isLive) showNoLiveEvent();
  })
  .catch(showNoLiveEvent);

// ---------- Highlight grid (ported from VengeanceUI "highlight-grid") ----------
// One coloured highlight glides behind the hovered cell, changing position,
// size and colour with a CSS transition. The text below explains that feature.
// A different accent colour for every cell (like the original component).
const GRID_COLORS = ['#E24E1B', '#2B5FD9', '#F79824', '#C2185B', '#4381C1', '#E8A317', '#818D92', '#1D5CF0', '#D64545'];

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

// ---------- Navbar: a bit more solid once the page is scrolled ----------
function updateNavShadow() {
  document.querySelector('.nav').classList.toggle('scrolled', window.scrollY > 40);
}
window.addEventListener('scroll', updateNavShadow, { passive: true });
updateNavShadow();
