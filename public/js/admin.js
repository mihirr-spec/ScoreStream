// Admin dashboard: events list, create event, and one event's teams, judges,
// scores and AI feedback. Every change goes through our JSON API.

requireLogin('admin');

// A demo admin token is limited to the demo event (the server enforces this).
const isDemo = Boolean(tokenPayload('admin').demoEventId);
const adminName = isDemo ? 'Demo admin' : tokenPayload('admin').username || 'Admin';
setupUserBar('admin', adminName);
$('welcome-name').textContent = adminName;

let selectedEvent = null;

// Shortcut: every admin request sends the admin token.
const adminApi = (method, path, body) => api(method, path, body, 'admin');

function showPanel(name) {
  $('create-panel').classList.toggle('hidden', name !== 'create');
  $('welcome-panel').classList.toggle('hidden', name !== 'welcome');
  $('event-panel').classList.toggle('hidden', name !== 'event');
}

// ---------- Events list (left column) ----------
async function loadEvents() {
  const events = await adminApi('GET', '/api/events');
  const list = $('event-list');
  list.replaceChildren();
  if (events.length === 0) list.append(el('p', 'No events yet.', 'muted small'));

  for (const event of events) {
    const item = el('button', null, 'event-item');
    item.type = 'button';
    if (selectedEvent && selectedEvent._id === event._id) item.classList.add('active');
    item.append(el('strong', event.name), badge(event.status));
    item.addEventListener('click', () => safely(() => selectEvent(event._id)));
    list.append(item);
  }
}

// ---------- Create event (rubric editor) ----------
function addRubricRow(values = {}) {
  const row = el('div', null, 'rubric-row');
  const fields = [
    ['key', 'key (e.g. design)', 'text', values.key || ''],
    ['label', 'Label', 'text', values.label || ''],
    ['max', 'Max', 'number', values.max || 10],
    ['weight', 'Weight', 'number', values.weight || ''],
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
  const remove = el('button', '✕', 'btn btn-ghost btn-sm');
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
  const ok = Math.abs(sum - 1) < 0.001;
  $('weight-sum').textContent = `Weights total ${sum.toFixed(2)} ${ok ? '✓' : '(must be 1)'}`;
}

$('add-rubric-row').addEventListener('click', () => addRubricRow());
function openCreatePanel() {
  selectedEvent = null;
  showPanel('create');
  $('event-name').focus();
  safely(loadEvents);
}
$('new-event-btn').addEventListener('click', openCreatePanel);
$('welcome-create-btn').addEventListener('click', openCreatePanel);

$('event-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    // The server validates everything again - this form is just a convenience.
    const event = await adminApi('POST', '/api/events', {
      name: $('event-name').value,
      status: $('event-status').value,
      rubric: readRubric(),
    });
    toast(`Event "${event.name}" created`);
    $('event-name').value = '';
    await selectEvent(event._id);
  });
});

// A sensible default rubric to start from.
addRubricRow({ key: 'innovation', label: 'Innovation', max: 10, weight: 0.3 });
addRubricRow({ key: 'design', label: 'Design', max: 10, weight: 0.4 });
addRubricRow({ key: 'execution', label: 'Execution', max: 10, weight: 0.3 });

// ---------- One selected event ----------
async function selectEvent(eventId) {
  selectedEvent = await adminApi('GET', `/api/events/${eventId}`);
  const ev = selectedEvent;
  showPanel('event');
  $('code-box').classList.add('hidden');
  $('import-result').classList.add('hidden');

  $('detail-name').textContent = ev.name;
  $('detail-status').replaceChildren(badge(ev.status));
  $('detail-rubric').textContent = ev.rubric.map((r) => `${r.label} ${Math.round(r.weight * 100)}%`).join('  ·  ');
  $('leaderboard-link').href = `leaderboard.html?event=${ev._id}`;
  for (const btn of $('status-seg').children) btn.classList.toggle('active', btn.dataset.status === ev.status);
  $('generate-feedback').disabled = ev.status !== 'closed';
  $('feedback-note').textContent =
    ev.status === 'closed'
      ? 'The event is closed. Feedback was written automatically - regenerate it if judges changed their comments.'
      : 'Written automatically for every team when you close the event.';

  await Promise.all([loadEvents(), loadTeams(), loadJudges(), loadScores(), loadFeedback()]);
}

// Status switch: draft / live / closed
for (const btn of $('status-seg').children) {
  btn.addEventListener('click', () =>
    safely(async () => {
      const status = btn.dataset.status;
      const closing = status === 'closed' && selectedEvent.status !== 'closed';
      if (closing && !confirm('Close the event? Judges can no longer score, final ranks are published and AI feedback is written for every team.')) return;
      await adminApi('PATCH', `/api/events/${selectedEvent._id}`, { status });
      await selectEvent(selectedEvent._id);
      if (closing) {
        toast('Event closed - writing AI feedback for every team...');
        watchFeedback(selectedEvent._id);
      } else {
        toast(`Event is now ${status}`);
      }
    })
  );
}

$('delete-event-btn').addEventListener('click', () =>
  safely(async () => {
    if (!confirm(`Delete "${selectedEvent.name}" and ALL its teams, judges and scores?`)) return;
    await adminApi('DELETE', `/api/events/${selectedEvent._id}`);
    toast('Event deleted');
    selectedEvent = null;
    showPanel('welcome');
    await loadEvents();
  })
);

// Tabs
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll('[data-panel]')) panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.tab);
  });
}

// ---------- Access code box (judges + teams) ----------
function showCode(forWhat, code) {
  $('code-for').textContent = `Access code for ${forWhat}`;
  $('code-value').textContent = code;
  $('code-box').classList.remove('hidden');
  $('code-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('copy-code').addEventListener('click', () =>
  safely(async () => {
    await navigator.clipboard.writeText($('code-value').textContent);
    toast('Code copied');
  })
);

// One row in the teams / judges list, with "New code" and "Delete" buttons.
function listRow(title, subtitle, onReset, onDelete) {
  const item = el('div', null, 'list-item');
  const left = el('div');
  left.append(el('strong', title));
  if (subtitle) left.append(el('div', subtitle, 'muted small'));
  const actions = el('div', null, 'list-actions');
  const reset = el('button', 'New code', 'btn btn-ghost btn-sm');
  reset.addEventListener('click', () => safely(onReset));
  const del = el('button', 'Delete', 'btn btn-danger btn-sm');
  del.addEventListener('click', () => safely(onDelete));
  actions.append(reset, del);
  item.append(left, actions);
  return item;
}

// ---------- Teams ----------
async function loadTeams() {
  const teams = await adminApi('GET', `/api/events/${selectedEvent._id}/teams`);
  $('stat-teams').textContent = teams.length;
  const list = $('team-list');
  list.replaceChildren();
  if (teams.length === 0) list.append(el('div', 'No teams yet. Add the first one above.', 'empty'));

  for (const team of teams) {
    list.append(
      listRow(
        team.name,
        team.members.join(', '),
        async () => {
          const res = await adminApi('POST', `/api/teams/${team._id}/reset-code`);
          showCode(`team ${res.name}`, res.code);
        },
        async () => {
          if (!confirm(`Delete team "${team.name}" and its scores?`)) return;
          await adminApi('DELETE', `/api/teams/${team._id}`);
          await Promise.all([loadTeams(), loadScores()]);
        }
      )
    );
  }
}

$('team-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const members = $('team-members').value.split(',').map((m) => m.trim()).filter(Boolean);
    const team = await adminApi('POST', `/api/events/${selectedEvent._id}/teams`, {
      name: $('team-name').value,
      members,
      code: $('team-code').value,
    });
    $('team-name').value = '';
    $('team-members').value = '';
    $('team-code').value = '';
    showCode(`team ${team.name}`, team.code);
    await loadTeams();
  });
});

// ---------- Excel import / export ----------
// SheetJS reads and writes .xlsx/.xls/.csv in the browser. It is only downloaded
// the first time the admin imports or exports.
let sheetJs = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJs) {
    sheetJs = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => {
        sheetJs = null;
        reject(new Error('Could not load the Excel library. Check your internet connection.'));
      };
      document.head.append(script);
    });
  }
  return sheetJs;
}

// Saves rows (array of objects) as an .xlsx file.
async function downloadSheet(rows, sheetName, fileName) {
  const XLSX = await loadSheetJs();
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), sheetName);
  XLSX.writeFile(book, fileName);
}

// "Spring Hackathon 2026" -> "spring-hackathon-2026"
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';

// Turns sheet rows into { name, members, code } using the column headings:
// a heading containing "team" or "name" = team name, any heading containing
// "member" = members (several member columns are fine), "code" = access code.
function rowsToTeams(rows) {
  return rows.map((row) => {
    const team = { name: '', members: [], code: '' };
    for (const [heading, value] of Object.entries(row)) {
      const h = heading.toLowerCase();
      const text = String(value ?? '').trim();
      if (!text) continue;
      if (h.includes('member')) team.members.push(...text.split(/[,;\n]/).map((m) => m.trim()).filter(Boolean));
      else if (h.includes('code')) team.code = text;
      else if (!team.name && (h.includes('team') || h.includes('name'))) team.name = text;
    }
    return team;
  });
}

$('template-btn').addEventListener('click', () =>
  safely(() =>
    downloadSheet(
      [
        { 'Team name': 'Byte Bandits', Members: 'Asha, Rohan', Code: '' },
        { 'Team name': 'Null Pointers', Members: 'Kabir, Meera, Dev', Code: 'NULLPTR1' },
      ],
      'Teams',
      'scorestream-teams-template.xlsx'
    )
  )
);

let lastImport = [];
$('import-file').addEventListener('change', (e) =>
  safely(async () => {
    const file = e.target.files[0];
    e.target.value = ''; // so choosing the same file again still fires "change"
    if (!file) return;
    const XLSX = await loadSheetJs();
    const book = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
    const teams = rowsToTeams(rows).filter((t) => t.name || t.members.length || t.code);
    if (teams.length === 0) throw new Error('No teams found. The first sheet needs a "Team name" column.');

    // The server saves every valid row with one insertMany into MongoDB.
    const result = await adminApi('POST', `/api/events/${selectedEvent._id}/teams/import`, { teams });
    lastImport = result.teams;
    showImportResult(result);
    const skippedNote = result.skipped.length ? `, skipped ${result.skipped.length}` : '';
    toast(`Imported ${result.imported} team(s)${skippedNote}`);
    await loadTeams();
  })
);

function showImportResult(result) {
  $('import-title').textContent = `Imported ${result.imported} team(s)`;
  const table = $('import-table');
  table.replaceChildren();
  if (result.teams.length) {
    const head = el('tr');
    for (const title of ['Team', 'Members', 'Code']) head.append(el('th', title));
    table.append(head);
    for (const t of result.teams) {
      const row = el('tr');
      const code = el('td');
      code.append(el('code', t.code));
      row.append(el('td', t.name), el('td', t.members.join(', '), 'muted small'), code);
      table.append(row);
    }
  }
  const skipped = $('import-skipped');
  skipped.replaceChildren();
  for (const s of result.skipped) {
    const where = s.row ? `row ${s.row}` : `"${s.name}"`;
    skipped.append(el('li', `Skipped ${where}: ${s.reason}`));
  }
  $('download-codes').classList.toggle('hidden', result.teams.length === 0);
  $('import-result').classList.remove('hidden');
}

$('download-codes').addEventListener('click', () =>
  safely(() =>
    downloadSheet(
      lastImport.map((t) => ({ 'Team name': t.name, Members: t.members.join(', '), Code: t.code })),
      'Team codes',
      `${slug(selectedEvent.name)}-team-codes.xlsx`
    )
  )
);
$('close-import').addEventListener('click', () => $('import-result').classList.add('hidden'));

// Export: every team with its members, and its rank / average once judges have scored.
$('export-btn').addEventListener('click', () =>
  safely(async () => {
    const teams = await adminApi('GET', `/api/events/${selectedEvent._id}/teams`);
    if (teams.length === 0) throw new Error('No teams to export yet');
    const board = await api('GET', `/api/events/${selectedEvent._id}/leaderboard`).catch(() => ({ rows: [] }));
    const byTeam = new Map(board.rows.map((r) => [r.teamId, r]));
    const rows = teams
      .map((t) => {
        const r = byTeam.get(t._id);
        return {
          Rank: r ? r.rank : '',
          'Team name': t.name,
          Members: t.members.join(', '),
          'Average score': r ? r.avgScore : '',
          Judges: r ? r.judgesCount : 0,
        };
      })
      .sort((a, b) => (a.Rank || Infinity) - (b.Rank || Infinity));
    await downloadSheet(rows, 'Teams', `${slug(selectedEvent.name)}-teams.xlsx`);
  })
);

// ---------- Judges ----------
async function loadJudges() {
  const judges = await adminApi('GET', `/api/events/${selectedEvent._id}/judges`);
  $('stat-judges').textContent = judges.length;
  const list = $('judge-list');
  list.replaceChildren();
  if (judges.length === 0) list.append(el('div', 'No judges yet. Add the first one above.', 'empty'));

  for (const judge of judges) {
    list.append(
      listRow(
        judge.name,
        '',
        async () => {
          const res = await adminApi('POST', `/api/judges/${judge._id}/reset-code`);
          showCode(`judge ${res.name}`, res.code);
        },
        async () => {
          if (!confirm(`Delete judge "${judge.name}" and all their scores?`)) return;
          await adminApi('DELETE', `/api/judges/${judge._id}`);
          await Promise.all([loadJudges(), loadScores()]);
        }
      )
    );
  }
}

$('judge-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const judge = await adminApi('POST', `/api/events/${selectedEvent._id}/judges`, {
      name: $('judge-name').value,
      code: $('judge-code').value,
    });
    $('judge-name').value = '';
    $('judge-code').value = '';
    showCode(`judge ${judge.name} (they sign in with this name + code)`, judge.code);
    await loadJudges();
  });
});

// ---------- Scores ----------
async function loadScores() {
  const scores = await adminApi('GET', `/api/events/${selectedEvent._id}/scores`);
  $('stat-scores').textContent = scores.length;
  $('stat-avg').textContent = scores.length ? (scores.reduce((s, x) => s + x.total, 0) / scores.length).toFixed(2) : '-';

  const table = $('score-table');
  table.replaceChildren();
  if (scores.length === 0) {
    table.append(el('caption', 'No scores yet.', 'empty'));
    return;
  }
  const head = el('tr');
  for (const title of ['Team', 'Judge', ...selectedEvent.rubric.map((r) => r.label), 'Total', 'Comment']) head.append(el('th', title));
  table.append(head);
  for (const s of scores) {
    const row = el('tr');
    row.append(el('td', s.teamName), el('td', s.judgeName));
    for (const r of selectedEvent.rubric) row.append(el('td', s.criteria[r.key]));
    const total = el('td');
    total.append(el('strong', s.total));
    row.append(total, el('td', s.comment, 'muted small'));
    table.append(row);
  }
}
$('refresh-scores').addEventListener('click', () => safely(loadScores));

// ---------- AI feedback ----------
async function loadFeedback() {
  const items = await adminApi('GET', `/api/events/${selectedEvent._id}/feedback`);
  const list = $('feedback-list');
  list.replaceChildren();
  for (const f of items) {
    const card = el('div', null, 'card feedback-card');
    const title = el('h3', f.teamName);
    title.append(badge(`${f.sentiment.label} ${f.sentiment.score}`, f.sentiment.label));
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

// After closing an event the server writes feedback in the background,
// so check every few seconds until every team has some (max ~2 minutes).
async function watchFeedback(eventId) {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!selectedEvent || selectedEvent._id !== eventId) return;
    const [items, teams] = await Promise.all([
      adminApi('GET', `/api/events/${eventId}/feedback`),
      adminApi('GET', `/api/events/${eventId}/teams`),
    ]).catch(() => [[], []]);
    await loadFeedback();
    if (teams.length > 0 && items.length >= teams.length) {
      toast(`AI feedback ready for ${items.length} team(s)`);
      return;
    }
  }
}

$('generate-feedback').addEventListener('click', () =>
  safely(async () => {
    const btn = $('generate-feedback');
    btn.disabled = true;
    btn.textContent = 'Generating... (one team at a time)';
    try {
      const result = await adminApi('POST', `/api/events/${selectedEvent._id}/feedback/generate`);
      toast(`Feedback generated for ${result.generated} team(s)`);
      await loadFeedback();
    } finally {
      btn.disabled = selectedEvent.status !== 'closed';
      btn.textContent = '✨ Regenerate feedback';
    }
  })
);

// ---------- Start ----------
if (isDemo) {
  // Hide what the demo admin is not allowed to do, and open the demo event straight away.
  $('demo-banner').classList.remove('hidden');
  $('new-event-btn').classList.add('hidden');
  $('delete-event-btn').classList.add('hidden');
  safely(() => selectEvent(tokenPayload('admin').demoEventId));
} else {
  showPanel('welcome');
  safely(loadEvents);
}
