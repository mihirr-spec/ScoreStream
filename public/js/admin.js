// Admin dashboard. Each sidebar link is its own page (admin.html#teams etc.):
//   Overview  - KPI cards + recent events
//   Events    - every event, with status filters and search
//   Teams     - roster, Excel import/export, team access codes
//   Judges    - roster, judge access codes, scoring progress
//   Rankings  - live ranking, AI feedback, every score
//   Settings  - event status, rubric, account, end/delete
// Teams, Judges, Rankings and Settings work on ONE event, chosen in the event bar.
// Every change goes through our JSON API.

requireLogin('admin');

// A demo admin token is limited to the demo event (the server enforces this).
const isDemo = Boolean(tokenPayload('admin').demoEventId);
const adminName = isDemo ? 'Demo admin' : tokenPayload('admin').username || 'Admin';
setupUserBar('admin', adminName);
$('avatar').textContent = initials(adminName);
$('account-name').textContent = adminName;
$('logout-btn-2').addEventListener('click', () => logout('admin'));

// Shortcut: every admin request sends the admin token.
const adminApi = (method, path, body) => api(method, path, body, 'admin');

const VIEWS = {
  overview: { title: 'Administrator Dashboard', crumb: 'Overview', desc: 'Monitor events, teams, judging progress, and feedback in one place.' },
  events: { title: 'Events', desc: 'Create events, filter them by status and open one to manage it.' },
  teams: { title: 'Teams', desc: 'Add teams one by one or import them from Excel, and hand out their access codes.' },
  judges: { title: 'Judges', desc: 'Add judges with the code they sign in with, and track their scoring progress.' },
  rankings: { title: 'Rankings & Feedback', desc: 'Live standings, every submitted score and the AI feedback for each team.' },
  settings: { title: 'Settings', desc: 'Event status, scoring rubric and your account.' },
};

let allEvents = [];
let activeFilter = 'all';
let selectedEvent = null;
let currentView = 'overview';
let eventTeams = [];
let eventJudges = [];
let eventScores = [];
let liveSource = null;
// Codes created in this session (shown once, so we keep them here until the page closes).
let recentCodes = [];

// "Priya Chen" -> "PC"
function initials(name) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join('') || '?'
  );
}

function pill(status) {
  return el('span', status, `pill ${status}`);
}

// ---------- Menus ----------
function closeMenus() {
  for (const menu of document.querySelectorAll('.overflow-menu')) menu.classList.add('hidden');
  for (const btn of document.querySelectorAll('[aria-expanded="true"]')) btn.setAttribute('aria-expanded', 'false');
}
function toggleMenu(button, menu) {
  const opening = menu.classList.contains('hidden');
  closeMenus();
  menu.classList.toggle('hidden', !opening);
  button.setAttribute('aria-expanded', String(opening));
}
$('account').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu($('account'), $('account-menu'));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.overflow-wrap') || e.target.closest('.overflow-menu a')) closeMenus();
});

// ---------- Modal (forms and confirmations) ----------
// fields: elements to show in the form. onSubmit: async; the modal closes when it
// succeeds and stays open (with a red toast) when it throws.
let modalSubmit = null;
let modalCancel = null;
let lastFocus = null;

function openModal({ title, text = '', fields = [], submitLabel = 'Save', danger = false, size = '', showCancel = true, onSubmit }) {
  lastFocus = document.activeElement;
  $('modal-title').textContent = title;
  $('modal-text').textContent = text;
  $('modal-text').classList.toggle('hidden', !text);
  $('modal-body').replaceChildren(...fields);
  $('modal-submit').textContent = submitLabel;
  $('modal-submit').className = danger ? 'danger-button' : 'primary';
  $('modal-box').className = `modal ${size}`;
  $('modal-cancel').classList.toggle('hidden', !showCancel);
  modalSubmit = onSubmit;
  $('modal').classList.remove('hidden');
  const first = $('modal-body').querySelector('input, select, textarea');
  (first || $('modal-submit')).focus();
}

function closeModal() {
  $('modal').classList.add('hidden');
  if (modalCancel) modalCancel();
  modalSubmit = null;
  modalCancel = null;
  if (lastFocus) lastFocus.focus();
}

$('modal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const button = $('modal-submit');
    button.disabled = true;
    try {
      if (modalSubmit) await modalSubmit();
      modalCancel = null; // submitted, so closing is not a "cancel"
      closeModal();
    } finally {
      button.disabled = false;
    }
  });
});
$('modal-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal();
});

// Yes/no question in the modal. Resolves true (confirmed) or false (cancelled).
function confirmModal(title, text, label, danger = true) {
  return new Promise((resolve) => {
    openModal({ title, text, submitLabel: label, danger, onSubmit: async () => resolve(true) });
    modalCancel = () => resolve(false);
  });
}

// A labelled input for modal forms.
function field(label, input, hint) {
  const wrap = el('div', null, 'field');
  const lbl = el('label', label);
  if (hint) lbl.append(' ', el('span', hint, 'hint'));
  if (!input.id) input.id = `f-${Math.random().toString(36).slice(2)}`;
  lbl.htmlFor = input.id;
  wrap.append(lbl, input);
  return wrap;
}
function input(attrs = {}) {
  const node = el('input');
  Object.assign(node, attrs);
  return node;
}

// ---------- Pages ----------
// Shows or hides the event bar / "no event" box for the current page.
function updateEventChrome() {
  const needsEvent = Boolean(document.querySelector(`[data-view="${currentView}"]`).hasAttribute('data-needs-event'));
  const missing = needsEvent && !selectedEvent;
  $('event-bar').classList.toggle('hidden', !needsEvent || !selectedEvent);
  $('no-event').classList.toggle('hidden', !missing);
  $('no-event-create').classList.toggle('hidden', isDemo);
  document.querySelector(`[data-view="${currentView}"]`).classList.toggle('hidden', missing);
  $('create-event').classList.toggle('hidden', isDemo || !['overview', 'events'].includes(currentView));
}

const goTo = setupViews(VIEWS, 'overview', (name) => {
  currentView = name;
  closeMenus();
  updateEventChrome();
});

// ---------- KPIs + event tables ----------
async function loadEvents() {
  allEvents = await adminApi('GET', '/api/events');
  const live = allEvents.filter((e) => e.status === 'live');
  $('kpi-events').textContent = allEvents.length;
  $('kpi-live').textContent = live.length;
  $('kpi-teams').textContent = allEvents.reduce((sum, e) => sum + e.teamCount, 0);
  // Every judge should score every team: the gap is what's still pending.
  $('kpi-pending').textContent = live.reduce((sum, e) => sum + Math.max(e.teamCount * e.judgeCount - e.scoreCount, 0), 0);
  renderEventTables();
  renderPicker();
}

function progressOf(event) {
  const needed = event.teamCount * event.judgeCount;
  return needed ? Math.min(100, Math.round((event.scoreCount / needed) * 100)) : 0;
}

function eventRow(event) {
  const row = el('tr');
  if (selectedEvent && selectedEvent._id === event._id) row.classList.add('selected');

  const status = el('td');
  status.append(pill(event.status));
  const progress = el('td');
  const track = el('span', null, 'progress-track');
  const fill = el('span', null, 'progress-fill');
  fill.style.width = `${progressOf(event)}%`;
  track.append(fill);
  progress.append(track, `${progressOf(event)}%`);

  const actions = el('td');
  const open = el('button', 'Open event', 'row-action');
  open.type = 'button';
  open.addEventListener('click', () =>
    safely(async () => {
      await selectEvent(event._id);
      goTo('teams');
    })
  );

  const wrap = el('span', null, 'overflow-wrap');
  const more = el('button', '⋯', 'icon-button');
  more.type = 'button';
  more.setAttribute('aria-label', `More actions for ${event.name}`);
  more.setAttribute('aria-expanded', 'false');
  const menu = el('span', null, 'overflow-menu hidden');
  const links = [
    ['Teams', 'teams'],
    ['Judges', 'judges'],
    ['Rankings & feedback', 'rankings'],
    ['Settings', 'settings'],
  ];
  for (const [label, view] of links) {
    const btn = el('button', label);
    btn.type = 'button';
    btn.addEventListener('click', () =>
      safely(async () => {
        closeMenus();
        await selectEvent(event._id);
        goTo(view);
      })
    );
    menu.append(btn);
  }
  const view = el('a', 'Public leaderboard ↗');
  view.href = `leaderboard.html?event=${event._id}`;
  view.target = '_blank';
  menu.append(view);
  if (!isDemo) {
    const del = el('button', 'Delete event', 'danger');
    del.type = 'button';
    del.addEventListener('click', () => safely(() => deleteEvent(event)));
    menu.append(del);
  }
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(more, menu);
  });
  wrap.append(more, menu);
  actions.append(open, ' ', wrap);

  row.append(el('td', event.name, 'event-name'), status, el('td', event.teamCount), el('td', event.judgeCount), progress, actions);
  return row;
}

function renderEventTables() {
  // Overview: the 5 newest events.
  $('recent-rows').replaceChildren(...allEvents.slice(0, 5).map(eventRow));
  $('no-recent').classList.toggle('hidden', allEvents.length > 0);

  // Events page: filtered by the status tab and the search box.
  const query = $('event-search').value.trim().toLowerCase();
  const visible = allEvents.filter((e) => (activeFilter === 'all' || e.status === activeFilter) && e.name.toLowerCase().includes(query));
  $('event-rows').replaceChildren(...visible.map(eventRow));
  const none = $('no-events');
  none.classList.toggle('hidden', visible.length > 0);
  none.textContent = allEvents.length === 0 ? 'No events yet. Click "Create Event" to set up your first one.' : 'No events match your search.';
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    }
    renderEventTables();
  });
}
// The top-bar search opens the Events page and stays in sync with its search box.
$('event-search').addEventListener('input', () => {
  $('global-search').value = $('event-search').value;
  renderEventTables();
});
$('global-search').addEventListener('input', () => {
  $('event-search').value = $('global-search').value;
  renderEventTables();
  if (currentView !== 'events') goTo('events');
});

// ---------- Event picker ----------
function renderPicker() {
  const picker = $('event-picker');
  picker.replaceChildren(
    ...allEvents.map((e) => {
      const option = el('option', `${e.name}  (${e.status})`);
      option.value = e._id;
      return option;
    })
  );
  if (selectedEvent) picker.value = selectedEvent._id;
}
$('event-picker').addEventListener('change', () => safely(() => selectEvent($('event-picker').value)));

// ---------- Create event ----------
function rubricRow(values = {}) {
  const row = el('div', null, 'rubric-row');
  const make = (name, placeholder, type, value) => {
    const node = input({ name, placeholder, type, value });
    if (type === 'number') node.step = 'any';
    node.setAttribute('aria-label', placeholder);
    return node;
  };
  row.append(
    make('key', 'key (e.g. design)', 'text', values.key || ''),
    make('label', 'Label', 'text', values.label || ''),
    make('max', 'Max', 'number', values.max || 10),
    make('weight', 'Weight', 'number', values.weight ?? '')
  );
  const remove = el('button', '✕', 'tiny-button danger');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove criterion');
  remove.addEventListener('click', () => {
    const parent = row.parentElement;
    row.remove();
    parent.dispatchEvent(new Event('input'));
  });
  row.append(remove);
  return row;
}

function openCreateEvent() {
  const name = input({ required: true, maxLength: 100, placeholder: 'e.g. Spring Hackathon 2026' });
  const status = el('select');
  for (const [value, label] of [['draft', 'Draft (set up teams and judges first)'], ['live', 'Live (judges can score now)']]) {
    const option = el('option', label);
    option.value = value;
    status.append(option);
  }

  const rows = el('div');
  rows.append(
    rubricRow({ key: 'innovation', label: 'Innovation', max: 10, weight: 0.3 }),
    rubricRow({ key: 'design', label: 'Design', max: 10, weight: 0.4 }),
    rubricRow({ key: 'execution', label: 'Execution', max: 10, weight: 0.3 })
  );
  const readRubric = () =>
    [...rows.querySelectorAll('.rubric-row')].map((row) => ({
      key: row.querySelector('[name=key]').value.trim(),
      label: row.querySelector('[name=label]').value.trim(),
      max: Number(row.querySelector('[name=max]').value),
      weight: Number(row.querySelector('[name=weight]').value),
    }));
  const sum = el('span', '', 'weight-sum');
  const updateSum = () => {
    const total = readRubric().reduce((s, item) => s + (item.weight || 0), 0);
    const ok = Math.abs(total - 1) < 0.001;
    sum.textContent = `Weights total ${total.toFixed(2)} ${ok ? '✓' : '(must be 1)'}`;
    sum.classList.toggle('ok', ok);
  };
  rows.addEventListener('input', updateSum);
  updateSum();

  const add = el('button', '+ Add criterion', 'secondary');
  add.type = 'button';
  add.addEventListener('click', () => {
    rows.append(rubricRow());
    updateSum();
  });
  const head = el('div', null, 'rubric-head');
  for (const h of ['Key', 'Label', 'Max', 'Weight', '']) head.append(el('span', h));
  const footer = el('div', null, 'table-tools');
  footer.style.marginTop = '6px';
  footer.append(add, sum);

  openModal({
    title: 'Create Event',
    text: 'Name the event and set the scoring rubric. Judges score each criterion; weights must add up to 1.',
    size: 'wide',
    fields: [field('Event name', name), field('Start as', status), head, rows, footer],
    submitLabel: 'Create Event',
    onSubmit: async () => {
      // The server validates everything again - this form is just a convenience.
      const event = await adminApi('POST', '/api/events', { name: name.value, status: status.value, rubric: readRubric() });
      toast(`Event "${event.name}" created - now add its teams`);
      await loadEvents();
      await selectEvent(event._id);
      goTo('teams');
    },
  });
}
$('create-event').addEventListener('click', openCreateEvent);
$('no-event-create').addEventListener('click', openCreateEvent);

// ---------- The selected event ----------
async function selectEvent(eventId) {
  const changed = !selectedEvent || selectedEvent._id !== eventId;
  selectedEvent = await adminApi('GET', `/api/events/${eventId}`);
  const ev = selectedEvent;
  try {
    sessionStorage.setItem('adminEvent', ev._id);
  } catch {
    /* storage blocked - the first event is picked next time */
  }
  if (changed) recentCodes = [];

  $('selected-status').replaceWith(Object.assign(pill(ev.status), { id: 'selected-status' }));
  $('selected-rubric').textContent = ev.rubric.map((r) => `${r.label} ${Math.round(r.weight * 100)}%`).join('  ·  ');
  $('leaderboard-link').href = `leaderboard.html?event=${ev._id}`;
  renderPicker();
  renderEventTables();
  updateEventChrome();

  // Settings page
  for (const status of ['draft', 'live', 'closed']) $(`set-${status}`).classList.toggle('active', ev.status === status);
  $('end-event').disabled = ev.status === 'closed';
  $('end-event').textContent = ev.status === 'closed' ? 'Event ended' : 'End Event';
  $('delete-event').classList.toggle('hidden', isDemo);
  $('controls-text').textContent = {
    draft: 'Draft: judges cannot score yet. Go live when your teams and judges are ready.',
    live: 'Live: judges are scoring now.',
    closed: 'Closed: final ranks are published. Set it live again if judges need to change scores.',
  }[ev.status];
  const rubric = $('rubric-list');
  rubric.replaceChildren();
  for (const r of ev.rubric) {
    const row = el('div', null, 'score-row');
    row.append(el('span', r.label, 'score-label'), el('span', `max ${r.max}  ·  weight ${Math.round(r.weight * 100)}%`, 'score-status'));
    rubric.append(row);
  }

  // Rankings page
  $('generate-feedback').disabled = ev.status !== 'closed';
  $('feedback-note').textContent =
    ev.status === 'closed'
      ? 'Written by AI from the judges’ comments. Regenerate if judges changed their comments.'
      : 'Written by AI for every team when you end the event.';

  if (changed) watchLeaderboard(ev._id);
  renderCodes();
  await Promise.all([loadTeams(), loadJudges(), loadRankings(), loadFeedback()]);
  await loadScores();
}

async function refreshCounts() {
  await loadEvents();
  await loadScores();
}

async function setStatus(status) {
  if (status === 'closed') return endEvent();
  await adminApi('PATCH', `/api/events/${selectedEvent._id}`, { status });
  await loadEvents();
  await selectEvent(selectedEvent._id);
  toast(status === 'live' ? 'Event is live - judges can score now' : 'Event moved to draft - judges cannot score');
}
for (const status of ['draft', 'live', 'closed']) {
  $(`set-${status}`).addEventListener('click', () => safely(() => setStatus(status)));
}

async function endEvent() {
  if (selectedEvent.status === 'closed') return;
  const ok = await confirmModal(
    'End Event?',
    'This closes scoring for the selected event, publishes the final ranking and writes AI feedback for every team.',
    'Confirm End Event'
  );
  if (!ok) return;
  await adminApi('PATCH', `/api/events/${selectedEvent._id}`, { status: 'closed' });
  await loadEvents();
  await selectEvent(selectedEvent._id);
  toast('Event ended - writing AI feedback for every team...');
  goTo('rankings');
  watchFeedback(selectedEvent._id);
}
$('end-event').addEventListener('click', () => safely(endEvent));

async function deleteEvent(event) {
  closeMenus();
  const ok = await confirmModal('Delete event?', `"${event.name}" and ALL its teams, judges, scores and feedback will be deleted. This cannot be undone.`, 'Delete event');
  if (!ok) return;
  await adminApi('DELETE', `/api/events/${event._id}`);
  toast('Event deleted');
  if (selectedEvent && selectedEvent._id === event._id) {
    selectedEvent = null;
    if (liveSource) liveSource.close();
  }
  await loadEvents();
  if (!selectedEvent && allEvents.length) await selectEvent(allEvents[0]._id);
  updateEventChrome();
  if (!selectedEvent) goTo('events');
}
$('delete-event').addEventListener('click', () => safely(() => deleteEvent(selectedEvent)));

// ---------- Access codes (shown once) ----------
function rememberCode(kind, name, code, members = []) {
  recentCodes.unshift({ kind, name, code, members });
  renderCodes();
}

// Fills the "Team access codes" (Teams page) and "Judge access codes" (Judges page) cards.
function renderCodes() {
  for (const box of document.querySelectorAll('[data-codes]')) {
    const kind = box.dataset.codes;
    const codes = recentCodes.filter((c) => c.kind === kind);
    box.replaceChildren();
    if (codes.length === 0) {
      box.append(el('p', `New codes appear here when you add a ${kind}${kind === 'team' ? ', import a sheet' : ''} or click New code.`, 'empty-text'));
      continue;
    }
    for (const item of codes) {
      const row = el('div', null, 'access-row');
      const who = el('div', null, 'access-who');
      who.append(item.name);
      if (item.members.length) who.append(el('span', item.members.join(', ')));
      const right = el('div', null, 'action-row');
      right.style.alignItems = 'center';
      const copy = el('button', 'Copy', 'tiny-button');
      copy.type = 'button';
      copy.addEventListener('click', () =>
        safely(async () => {
          await navigator.clipboard.writeText(item.code);
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1800);
        })
      );
      right.append(el('span', item.code, 'code'), copy);
      row.append(who, right);
      box.append(row);
    }
    const actions = el('div', null, 'action-row');
    actions.style.marginTop = '14px';
    const download = el('button', 'Download codes (.xlsx)', 'secondary');
    download.type = 'button';
    download.addEventListener('click', () =>
      safely(() =>
        downloadSheet(
          codes.map((c) => (kind === 'team' ? { 'Team name': c.name, Members: c.members.join(', '), Code: c.code } : { Judge: c.name, Code: c.code })),
          kind === 'team' ? 'Team codes' : 'Judge codes',
          `${slug(selectedEvent.name)}-${kind}-codes.xlsx`
        )
      )
    );
    const clear = el('button', 'Clear', 'secondary');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      recentCodes = recentCodes.filter((c) => c.kind !== kind);
      renderCodes();
    });
    actions.append(download, clear);
    box.append(actions);
  }
}

// One row of the team / judge roster, with "New code" and "Delete".
function personRow(name, subtitle, onReset, onDelete) {
  const item = el('li');
  const main = el('div', null, 'person-main');
  main.append(name);
  if (subtitle) main.append(el('span', subtitle));
  const reset = el('button', 'New code', 'tiny-button');
  reset.type = 'button';
  reset.addEventListener('click', () => safely(onReset));
  const del = el('button', 'Delete', 'tiny-button danger');
  del.type = 'button';
  del.addEventListener('click', () => safely(onDelete));
  item.append(el('span', initials(name), 'initial'), main, reset, del);
  return item;
}

// ---------- Teams ----------
async function loadTeams() {
  eventTeams = await adminApi('GET', `/api/events/${selectedEvent._id}/teams`);
  $('team-count').textContent = `${eventTeams.length} team${eventTeams.length === 1 ? '' : 's'}`;
  const list = $('team-list');
  list.replaceChildren();
  if (eventTeams.length === 0) list.append(el('li', 'No teams yet. Add one or import an Excel sheet.', 'empty-text'));
  for (const team of eventTeams) {
    list.append(
      personRow(
        team.name,
        team.members.join(', '),
        async () => {
          const ok = await confirmModal('New code?', `${team.name}'s old code will stop working.`, 'Create new code', false);
          if (!ok) return;
          const res = await adminApi('POST', `/api/teams/${team._id}/reset-code`);
          rememberCode('team', res.name, res.code, team.members);
        },
        async () => {
          const ok = await confirmModal('Delete team?', `"${team.name}" and its scores will be deleted.`, 'Delete team');
          if (!ok) return;
          await adminApi('DELETE', `/api/teams/${team._id}`);
          toast('Team deleted');
          await Promise.all([loadTeams(), loadRankings()]);
          await refreshCounts();
        }
      )
    );
  }
}

$('add-team').addEventListener('click', () => {
  const name = input({ required: true, maxLength: 100, placeholder: 'e.g. Byte Bandits' });
  const members = input({ placeholder: 'Asha, Rohan' });
  const code = input({ maxLength: 30, placeholder: 'Random if empty' });
  openModal({
    title: 'Add Team',
    text: 'Add a team to this event. The team signs in on the Student tab with its access code.',
    fields: [field('Team name', name), field('Members', members, '(comma separated)'), field('Access code', code, '(optional, 4-30 characters)')],
    submitLabel: 'Add Team',
    onSubmit: async () => {
      const team = await adminApi('POST', `/api/events/${selectedEvent._id}/teams`, {
        name: name.value,
        members: members.value.split(',').map((m) => m.trim()).filter(Boolean),
        code: code.value,
      });
      toast(`Team "${team.name}" added - its code is in Team access codes`);
      rememberCode('team', team.name, team.code, team.members);
      await loadTeams();
      await refreshCounts();
    },
  });
});

// ---------- Judges ----------
async function loadJudges() {
  eventJudges = await adminApi('GET', `/api/events/${selectedEvent._id}/judges`);
  $('judge-count').textContent = `${eventJudges.length} judge${eventJudges.length === 1 ? '' : 's'}`;
  const list = $('judge-list');
  list.replaceChildren();
  if (eventJudges.length === 0) list.append(el('li', 'No judges yet. Add the first one below.', 'empty-text'));
  for (const judge of eventJudges) {
    list.append(
      personRow(
        judge.name,
        'Signs in with this name + code',
        async () => {
          const ok = await confirmModal('New code?', `${judge.name}'s old code will stop working.`, 'Create new code', false);
          if (!ok) return;
          const res = await adminApi('POST', `/api/judges/${judge._id}/reset-code`);
          rememberCode('judge', res.name, res.code);
        },
        async () => {
          const ok = await confirmModal('Delete judge?', `"${judge.name}" and all their scores will be deleted.`, 'Delete judge');
          if (!ok) return;
          await adminApi('DELETE', `/api/judges/${judge._id}`);
          toast('Judge deleted');
          await Promise.all([loadJudges(), loadRankings()]);
          await refreshCounts();
        }
      )
    );
  }
}

$('add-judge').addEventListener('click', () => {
  const name = input({ required: true, maxLength: 100, placeholder: 'e.g. Prof. Rao' });
  const code = input({ maxLength: 30, placeholder: 'e.g. JUDGE01 - random if empty' });
  openModal({
    title: 'Add Judge',
    text: 'The judge signs in on the Judge tab with exactly this name and the access code.',
    fields: [field('Judge name', name), field('Access code', code, '(optional, 4-30 characters)')],
    submitLabel: 'Add Judge',
    onSubmit: async () => {
      const judge = await adminApi('POST', `/api/events/${selectedEvent._id}/judges`, { name: name.value, code: code.value });
      toast(`Judge "${judge.name}" added - their code is in Judge access codes`);
      rememberCode('judge', judge.name, judge.code);
      await loadJudges();
      await refreshCounts();
    },
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
    for (const t of [...result.teams].reverse()) recentCodes.unshift({ kind: 'team', name: t.name, code: t.code, members: t.members });
    renderCodes();
    await loadTeams();
    await refreshCounts();

    if (result.skipped.length) {
      const list = el('ul', null, 'small muted');
      for (const s of result.skipped) list.append(el('li', `${s.row ? `Row ${s.row}` : `"${s.name}"`}: ${s.reason}`));
      openModal({
        title: `Imported ${result.imported} team(s)`,
        text: `${result.skipped.length} row(s) were skipped. The new codes are in Team access codes.`,
        fields: [list],
        submitLabel: 'OK',
        showCancel: false,
      });
    } else {
      toast(`Imported ${result.imported} team(s) - codes are in Team access codes`);
    }
  })
);

// Export: every team with its members, and its rank / average once judges have scored.
$('export-btn').addEventListener('click', () =>
  safely(async () => {
    if (eventTeams.length === 0) throw new Error('No teams to export yet');
    const board = await api('GET', `/api/events/${selectedEvent._id}/leaderboard`).catch(() => ({ rows: [] }));
    const byTeam = new Map(board.rows.map((r) => [r.teamId, r]));
    const rows = eventTeams
      .map((t) => {
        const r = byTeam.get(t._id);
        return { Rank: r ? r.rank : '', 'Team name': t.name, Members: t.members.join(', '), 'Average score': r ? r.avgScore : '', Judges: r ? r.judgesCount : 0 };
      })
      .sort((a, b) => (a.Rank || Infinity) - (b.Rank || Infinity));
    await downloadSheet(rows, 'Teams', `${slug(selectedEvent.name)}-teams.xlsx`);
  })
);

// ---------- Live rankings ----------
function renderRankings(rows) {
  const list = $('rank-list');
  list.replaceChildren();
  if (rows.length === 0) list.append(el('p', 'No scores yet. Rankings appear as soon as judges submit.', 'empty-text'));
  for (const r of rows) {
    const row = el('div', null, 'rank-row');
    row.append(
      el('span', String(r.rank).padStart(2, '0'), 'rank-position'),
      el('span', r.teamName, 'rank-name'),
      el('span', `${r.judgesCount} judge${r.judgesCount === 1 ? '' : 's'}`, 'rank-meta'),
      el('span', r.avgScore.toFixed(2), 'rank-score')
    );
    list.append(row);
  }
}

async function loadRankings() {
  const board = await adminApi('GET', `/api/events/${selectedEvent._id}/leaderboard`);
  renderRankings(board.rows);
}

// The Change Stream pushes a new ranking over SSE every time a score changes.
function watchLeaderboard(eventId) {
  if (liveSource) liveSource.close();
  liveSource = new EventSource(`/api/events/${eventId}/stream`);
  liveSource.addEventListener('leaderboard', (msg) => {
    renderRankings(JSON.parse(msg.data));
    safely(refreshCounts);
  });
  liveSource.addEventListener('open', () => $('live-flag').classList.remove('hidden'));
  liveSource.addEventListener('error', () => $('live-flag').classList.add('hidden'));
}

// ---------- Scores: judge progress (Judges page) + every score (Rankings page) ----------
async function loadScores() {
  if (!selectedEvent) return;
  eventScores = await adminApi('GET', `/api/events/${selectedEvent._id}/scores`);

  const box = $('judge-progress');
  box.replaceChildren();
  if (eventJudges.length === 0) box.append(el('p', 'Add judges to track their progress.', 'empty-text'));
  for (const judge of eventJudges) {
    const done = eventScores.filter((s) => s.judgeName === judge.name).length;
    const row = el('div', null, 'score-row');
    const progress = el('span', null, 'score-status');
    const track = el('span', null, 'progress-track');
    const fill = el('span', null, 'progress-fill');
    fill.style.width = eventTeams.length ? `${Math.round((done / eventTeams.length) * 100)}%` : '0%';
    track.append(fill);
    progress.append(track, `${done} / ${eventTeams.length} complete`);
    row.append(el('span', judge.name, 'score-label'), progress);
    box.append(row);
  }

  const table = $('score-table');
  table.replaceChildren();
  if (eventScores.length === 0) {
    table.append(el('caption', 'No scores yet.', 'empty-row'));
    return;
  }
  const head = el('tr');
  for (const title of ['Team', 'Judge', ...selectedEvent.rubric.map((r) => r.label), 'Total', 'Comment']) head.append(el('th', title));
  table.append(head);
  for (const s of eventScores) {
    const row = el('tr');
    row.append(el('td', s.teamName, 'event-name'), el('td', s.judgeName));
    for (const r of selectedEvent.rubric) row.append(el('td', s.criteria[r.key]));
    const total = el('td');
    total.append(el('strong', s.total));
    row.append(total, el('td', s.comment || '-'));
    table.append(row);
  }
}

// ---------- AI feedback ----------
async function loadFeedback() {
  const items = await adminApi('GET', `/api/events/${selectedEvent._id}/feedback`);
  const list = $('feedback-list');
  list.replaceChildren();
  if (items.length === 0) {
    list.append(el('p', selectedEvent.status === 'closed' ? 'Writing feedback...' : 'Feedback appears here after the event ends.', 'empty-text'));
  }
  for (const f of items) {
    const quote = el('div', null, 'feedback-quote');
    const title = el('strong', f.teamName);
    title.append(pill(f.sentiment.label));
    if (f.source === 'mock') title.append(pill('mock'));
    quote.append(title, f.summary);
    list.append(quote);
  }
  return items;
}

// After ending an event the server writes feedback in the background,
// so check every few seconds until every team has some (max ~2 minutes).
async function watchFeedback(eventId) {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!selectedEvent || selectedEvent._id !== eventId) return;
    const items = await loadFeedback().catch(() => []);
    if (eventTeams.length > 0 && items.length >= eventTeams.length) {
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
      btn.textContent = 'Regenerate Feedback';
    }
  })
);

// ---------- Start ----------
if (isDemo) $('demo-banner').classList.remove('hidden');
safely(async () => {
  await loadEvents();
  // Re-open the event used last time in this tab (or the demo event, or the newest one).
  let saved = null;
  try {
    saved = sessionStorage.getItem('adminEvent');
  } catch {
    /* storage blocked */
  }
  const start = isDemo ? tokenPayload('admin').demoEventId : allEvents.find((e) => e._id === saved)?._id || allEvents[0]?._id;
  if (start) await selectEvent(start);
  updateEventChrome();
});
