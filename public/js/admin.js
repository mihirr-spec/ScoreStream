// Admin page logic. Plain JavaScript: fetch() calls our API, then we build the page.
// We always use textContent (never innerHTML with data), so names typed by users
// can't inject HTML/JavaScript into the page.

let token = sessionStorage.getItem('adminToken');
let selectedEvent = null;

// ---------- small helpers ----------

function $(id) {
  return document.getElementById(id);
}

// Creates an element with optional text and CSS class.
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

// Calls our API with the admin token. Throws an Error with the server's message on failure.
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

// Runs an async action and shows any error message on the page.
async function safely(action) {
  try {
    await action();
  } catch (err) {
    showMessage(err.message, 'error');
  }
}

// ---------- login / logout ----------

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const res = await fetch('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    token = data.token;
    sessionStorage.setItem('adminToken', token);
    $('password').value = '';
    showApp();
  });
});

function logout() {
  token = null;
  sessionStorage.removeItem('adminToken');
  $('app-section').classList.add('hidden');
  $('login-section').classList.remove('hidden');
}
$('logout-btn').addEventListener('click', logout);

function showApp() {
  $('login-section').classList.add('hidden');
  $('app-section').classList.remove('hidden');
  safely(loadEvents);
}

// ---------- events list ----------

async function loadEvents() {
  const events = await api('GET', '/api/events');
  const list = $('event-list');
  list.replaceChildren();
  if (events.length === 0) list.append(el('p', 'No events yet. Create one below.', 'muted'));

  for (const event of events) {
    const item = el('div', null, 'list-item');
    const left = el('div');
    left.append(el('strong', event.name), ' ', el('span', event.status, `pill ${event.status}`));
    const btn = el('button', 'Manage', 'small');
    btn.addEventListener('click', () => safely(() => selectEvent(event._id)));
    item.append(left, btn);
    list.append(item);
  }
}

// ---------- create event (rubric editor) ----------

function addRubricRow(values = {}) {
  const row = el('div', null, 'row rubric-row');
  const fields = [
    ['key', 'key (e.g. design)', 'text', values.key || ''],
    ['label', 'Label', 'text', values.label || ''],
    ['max', 'Max mark', 'number', values.max || 10],
    ['weight', 'Weight (0-1)', 'number', values.weight || ''],
  ];
  for (const [name, placeholder, type, value] of fields) {
    const input = el('input');
    input.name = name;
    input.placeholder = placeholder;
    input.type = type;
    input.value = value;
    if (type === 'number') input.step = 'any';
    input.addEventListener('input', updateWeightSum);
    row.append(input);
  }
  const remove = el('button', 'x', 'secondary small shrink');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    row.remove();
    updateWeightSum();
  });
  row.append(remove);
  $('rubric-rows').append(row);
  updateWeightSum();
}

function readRubric() {
  return [...document.querySelectorAll('.rubric-row')].map((row) => ({
    key: row.querySelector('[name=key]').value.trim(),
    label: row.querySelector('[name=label]').value.trim(),
    max: Number(row.querySelector('[name=max]').value),
    weight: Number(row.querySelector('[name=weight]').value),
  }));
}

function updateWeightSum() {
  const sum = readRubric().reduce((total, item) => total + (item.weight || 0), 0);
  $('weight-sum').textContent = `Weights total: ${sum.toFixed(2)} ${Math.abs(sum - 1) < 0.001 ? '(ok)' : '(must be 1)'}`;
}

$('add-rubric-row').addEventListener('click', () => addRubricRow());

$('event-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    // The server validates everything again - this page is just a convenience.
    const event = await api('POST', '/api/events', {
      name: $('event-name').value,
      status: $('event-status').value,
      rubric: readRubric(),
    });
    showMessage(`Event "${event.name}" created`);
    $('event-name').value = '';
    await loadEvents();
    await selectEvent(event._id);
  });
});

// A sensible default rubric to start from.
addRubricRow({ key: 'innovation', label: 'Innovation', max: 10, weight: 0.3 });
addRubricRow({ key: 'design', label: 'Design', max: 10, weight: 0.4 });
addRubricRow({ key: 'execution', label: 'Execution', max: 10, weight: 0.3 });

// ---------- one selected event ----------

async function selectEvent(eventId) {
  selectedEvent = await api('GET', `/api/events/${eventId}`);
  const ev = selectedEvent;
  $('event-detail').classList.remove('hidden');
  $('detail-name').textContent = ev.name;
  $('detail-status').textContent = ev.status;
  $('detail-status').className = `pill ${ev.status}`;
  $('detail-rubric').textContent =
    ' Rubric: ' + ev.rubric.map((r) => `${r.label} (max ${r.max}, weight ${r.weight})`).join(', ');
  $('leaderboard-link').href = `leaderboard.html?event=${ev._id}`;
  $('generate-feedback').disabled = ev.status !== 'closed';
  $('new-judge-code').classList.add('hidden');

  await Promise.all([loadTeams(), loadJudges(), loadScores(), loadFeedback()]);
  $('event-detail').scrollIntoView({ behavior: 'smooth' });
}

// Status buttons: draft / live / closed
for (const btn of document.querySelectorAll('.status-btn')) {
  btn.addEventListener('click', () =>
    safely(async () => {
      await api('PATCH', `/api/events/${selectedEvent._id}`, { status: btn.dataset.status });
      showMessage(`Status changed to ${btn.dataset.status}`);
      await loadEvents();
      await selectEvent(selectedEvent._id);
    })
  );
}

$('delete-event-btn').addEventListener('click', () =>
  safely(async () => {
    if (!confirm(`Delete "${selectedEvent.name}" and ALL its teams, judges and scores?`)) return;
    await api('DELETE', `/api/events/${selectedEvent._id}`);
    showMessage('Event deleted');
    selectedEvent = null;
    $('event-detail').classList.add('hidden');
    await loadEvents();
  })
);

// ---------- teams ----------

async function loadTeams() {
  const teams = await api('GET', `/api/events/${selectedEvent._id}/teams`);
  const list = $('team-list');
  list.replaceChildren();
  if (teams.length === 0) list.append(el('p', 'No teams yet.', 'muted'));
  for (const team of teams) {
    const item = el('div', null, 'list-item');
    const left = el('div');
    left.append(el('strong', team.name), el('span', `  ${team.members.join(', ')}`, 'muted'));
    const del = el('button', 'Delete', 'danger small');
    del.addEventListener('click', () =>
      safely(async () => {
        if (!confirm(`Delete team "${team.name}" and its scores?`)) return;
        await api('DELETE', `/api/teams/${team._id}`);
        await loadTeams();
        await loadScores();
      })
    );
    item.append(left, del);
    list.append(item);
  }
}

$('team-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const members = $('team-members').value.split(',').map((m) => m.trim()).filter(Boolean);
    await api('POST', `/api/events/${selectedEvent._id}/teams`, { name: $('team-name').value, members });
    $('team-name').value = '';
    $('team-members').value = '';
    await loadTeams();
  });
});

// ---------- judges ----------

async function loadJudges() {
  const judges = await api('GET', `/api/events/${selectedEvent._id}/judges`);
  const list = $('judge-list');
  list.replaceChildren();
  if (judges.length === 0) list.append(el('p', 'No judges yet.', 'muted'));
  for (const judge of judges) {
    const item = el('div', null, 'list-item');
    const del = el('button', 'Delete', 'danger small');
    del.addEventListener('click', () =>
      safely(async () => {
        if (!confirm(`Delete judge "${judge.name}" and all their scores?`)) return;
        await api('DELETE', `/api/judges/${judge._id}`);
        await loadJudges();
        await loadScores();
      })
    );
    item.append(el('strong', judge.name), del);
    list.append(item);
  }
}

$('judge-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const judge = await api('POST', `/api/events/${selectedEvent._id}/judges`, { name: $('judge-name').value });
    $('judge-name').value = '';
    // The plain code is only available in this one response - show it clearly.
    const box = $('new-judge-code');
    box.replaceChildren(
      el('div', `Access code for ${judge.name}:`, 'muted'),
      el('div', judge.code, 'code-box'),
      el('div', 'Copy it now. It is stored only as a hash and will NOT be shown again.', 'muted')
    );
    box.classList.remove('hidden');
    await loadJudges();
  });
});

// ---------- scores ----------

async function loadScores() {
  const scores = await api('GET', `/api/events/${selectedEvent._id}/scores`);
  const table = $('score-table');
  table.replaceChildren();
  if (scores.length === 0) {
    table.append(el('caption', 'No scores yet.', 'muted'));
    return;
  }
  const head = el('tr');
  const keys = selectedEvent.rubric.map((r) => r.key);
  for (const title of ['Team', 'Judge', ...selectedEvent.rubric.map((r) => r.label), 'Total', 'Comment']) {
    head.append(el('th', title));
  }
  table.append(head);
  for (const s of scores) {
    const row = el('tr');
    row.append(el('td', s.teamName), el('td', s.judgeName));
    for (const key of keys) row.append(el('td', s.criteria[key]));
    row.append(el('td', s.total, 'score-big'), el('td', s.comment, 'muted'));
    table.append(row);
  }
}

$('refresh-scores').addEventListener('click', () => safely(loadScores));

// ---------- AI feedback ----------

function renderFeedback(items) {
  const list = $('feedback-list');
  list.replaceChildren();
  for (const f of items) {
    const card = el('div', null, 'card feedback-card');
    const title = el('h3', f.teamName);
    title.append(' ', el('span', `${f.sentiment.label} (${f.sentiment.score})`, `pill ${f.sentiment.label}`));
    if (f.source === 'mock') title.append(' ', el('span', 'mock', 'pill mock'));
    card.append(title, el('p', f.summary));
    if (f.strengths.length) {
      const ul = el('ul');
      f.strengths.forEach((s) => ul.append(el('li', s)));
      card.append(el('strong', 'Strengths'), ul);
    }
    if (f.improvements.length) {
      const ul = el('ul');
      f.improvements.forEach((s) => ul.append(el('li', s)));
      card.append(el('strong', 'Improvements'), ul);
    }
    list.append(card);
  }
}

async function loadFeedback() {
  renderFeedback(await api('GET', `/api/events/${selectedEvent._id}/feedback`));
}

$('generate-feedback').addEventListener('click', () =>
  safely(async () => {
    const btn = $('generate-feedback');
    btn.disabled = true;
    btn.textContent = 'Generating... (one team at a time)';
    try {
      const result = await api('POST', `/api/events/${selectedEvent._id}/feedback/generate`);
      showMessage(`Feedback generated for ${result.generated} team(s)`);
      await loadFeedback();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate feedback';
    }
  })
);

// ---------- start ----------
if (token) showApp();
