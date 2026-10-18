// Judge page: log in with a code, then score each team of your event.
// The page shows a total preview, but the SERVER calculates and stores the real total.

let token = sessionStorage.getItem('judgeToken');

function $(id) {
  return document.getElementById(id);
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showMessage(text, type = 'ok') {
  const box = $('message');
  box.textContent = text;
  box.className = `message ${type}`;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => box.classList.add('hidden'), 5000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 401) logout();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function safely(action) {
  try {
    await action();
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

// Same formula as services/scoring.js - only used for the live preview.
function previewTotal(rubric, criteria) {
  let sum = 0;
  for (const item of rubric) sum += ((criteria[item.key] || 0) / item.max) * item.weight;
  return Math.round(sum * 10 * 100) / 100;
}

// ---------- login / logout ----------

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const res = await fetch('/api/auth/judge-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('code').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token;
    sessionStorage.setItem('judgeToken', token);
    $('code').value = '';
    await loadDashboard();
  });
});

function logout() {
  token = null;
  sessionStorage.removeItem('judgeToken');
  $('app-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
}
$('logout-btn').addEventListener('click', logout);
$('refresh-btn').addEventListener('click', () => safely(loadDashboard));

// ---------- dashboard ----------

async function loadDashboard() {
  const data = await api('GET', '/api/judge/me');
  const { event, teams, myScores } = data;

  $('login-section').classList.add('hidden');
  $('app-section').classList.remove('hidden');
  $('event-name').textContent = event.name;
  $('event-status').textContent = event.status;
  $('event-status').className = `pill ${event.status}`;
  $('judge-name').textContent = ` Logged in as ${data.judge.name}`;
  $('leaderboard-link').href = `leaderboard.html?event=${event._id}`;
  $('not-live').classList.toggle('hidden', event.status === 'live');

  const cards = $('team-cards');
  cards.replaceChildren();
  if (teams.length === 0) cards.append(el('p', 'No teams in this event yet.', 'muted'));

  for (const team of teams) {
    const existing = myScores.find((s) => s.teamId === team._id);
    cards.append(buildTeamCard(event, team, existing));
  }
}

// One card per team: a number input per rubric criterion, a comment, and a button.
function buildTeamCard(event, team, existing) {
  const card = el('section', null, 'card');
  const title = el('h2', team.name);
  if (existing) title.append(' ', el('span', 'scored', 'pill live'));
  card.append(title, el('p', team.members.join(', '), 'muted'));

  const form = el('form');
  const grid = el('div', null, 'criteria-grid');
  const inputs = {};

  for (const item of event.rubric) {
    const wrap = el('div');
    const label = el('label', `${item.label} (0-${item.max}, weight ${item.weight})`);
    const input = el('input');
    input.type = 'number';
    input.min = 0;
    input.max = item.max;
    input.step = 'any';
    input.required = true;
    input.value = existing ? existing.criteria[item.key] : '';
    input.addEventListener('input', updatePreview);
    inputs[item.key] = input;
    wrap.append(label, input);
    grid.append(wrap);
  }

  const commentLabel = el('label', 'Comment (used for AI feedback when the event closes)');
  const comment = el('textarea');
  comment.maxLength = 1000;
  comment.value = existing ? existing.comment : '';

  const footer = el('div', null, 'row');
  const preview = el('span', '', 'total-preview');
  const button = el('button', existing ? 'Update score' : 'Submit score', 'shrink');
  button.type = 'submit';
  button.disabled = event.status !== 'live';
  footer.append(preview, button);

  form.append(grid, commentLabel, comment, footer);
  card.append(form);

  function readCriteria() {
    const criteria = {};
    for (const [key, input] of Object.entries(inputs)) criteria[key] = Number(input.value);
    return criteria;
  }

  function updatePreview() {
    preview.textContent = `Total preview: ${previewTotal(event.rubric, readCriteria())} / 10`;
  }
  updatePreview();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    safely(async () => {
      const body = { criteria: readCriteria(), comment: comment.value };
      // New score -> POST. Already scored -> PUT to edit (a second POST would hit the unique index).
      const saved = existing
        ? await api('PUT', `/api/scores/${existing._id}`, body)
        : await api('POST', '/api/scores', { teamId: team._id, ...body });
      showMessage(`Saved ${team.name}: total ${saved.total} / 10`);
      await loadDashboard();
    });
  });

  return card;
}

// ---------- start ----------
if (token) safely(loadDashboard);
