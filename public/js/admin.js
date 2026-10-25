// Admin dashboard.
//   #overview                   Dashboard: KPI cards + recent events
//   #events                     every event, with status filters and search
//   #event/<id>/teams           inside one event: teams + invitations
//   #event/<id>/judges          judges, their codes and progress
//   #event/<id>/rankings        live ranking, AI feedback, every score
//   #event/<id>/settings        status, rubric, End Event, Delete
// Every change goes through our JSON API.

requireLogin('admin');

const adminName = tokenPayload('admin').username || 'Admin';
setupUserBar('admin', adminName);
$('avatar').textContent = initials(adminName);

// Shortcut: every admin request sends the admin token.
const adminApi = (method, path, body) => api(method, path, body, 'admin');

const EVENT_TABS = { teams: 'Teams', judges: 'Judges', rankings: 'Rankings & Feedback', settings: 'Event settings' };

let allEvents = [];
let activeFilter = 'all';
let selectedEvent = null;
let eventTeams = [];
let eventJudges = [];
let eventScores = [];
let liveSource = null;
// Judge codes created in this session (shown once, so we keep them until the page closes).
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

const eventUrl = (eventId, tab = 'teams') => `#event/${eventId}/${tab}`;

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

// ---------- Router ----------
// "#event/<id>/judges" -> { view: 'judges', eventId: '<id>' }
function parseRoute() {
  const parts = location.hash.slice(1).split('/');
  if (parts[0] === 'event' && /^[a-f0-9]{24}$/i.test(parts[1] || '')) {
    return { view: EVENT_TABS[parts[2]] ? parts[2] : 'teams', eventId: parts[1] };
  }
  return { view: parts[0] === 'events' ? 'events' : 'overview', eventId: null };
}

function setCrumbs(items) {
  const box = $('crumbs');
  box.replaceChildren();
  items.forEach((item, i) => {
    if (i > 0) box.append(el('span', '/', 'muted'));
    if (i === items.length - 1) box.append(el('strong', item.label));
    else if (item.href) {
      const link = el('a', item.label);
      link.href = item.href;
      box.append(link);
    } else box.append(el('span', item.label, 'muted'));
  });
}

async function route() {
  closeMenus();
  const { view, eventId } = parseRoute();
  const inEvent = Boolean(eventId);

  if (inEvent && (!selectedEvent || selectedEvent._id !== eventId)) {
    try {
      await selectEvent(eventId);
    } catch (err) {
      toast(err.message, 'error');
      location.hash = 'events';
      return;
    }
  }

  for (const section of document.querySelectorAll('[data-view]')) section.classList.toggle('hidden', section.dataset.view !== view);
  $('main-heading').classList.toggle('hidden', inEvent);
  $('event-heading').classList.toggle('hidden', !inEvent);
  $('event-nav').classList.toggle('hidden', !selectedEvent);

  // Sidebar + tabs: which page is active.
  for (const link of document.querySelectorAll('.nav-item[data-nav]')) {
    const active = link.dataset.nav === view;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const tab of document.querySelectorAll('.event-tabs .tab')) tab.classList.toggle('active', tab.dataset.tab === view);

  if (view === 'overview') {
    $('page-title').textContent = 'Administrator Dashboard';
    $('page-desc').textContent = 'Monitor events, teams, judging progress, and feedback in one place.';
    setCrumbs([{ label: 'Workspace' }, { label: 'Dashboard' }]);
  } else if (view === 'events') {
    $('page-title').textContent = 'Events';
    $('page-desc').textContent = 'Create an event, then open it to add judges, invite teams and see results.';
    setCrumbs([{ label: 'Workspace' }, { label: 'Events' }]);
  } else {
    setCrumbs([{ label: 'Events', href: '#events' }, { label: selectedEvent.name, href: eventUrl(selectedEvent._id) }, { label: EVENT_TABS[view] }]);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => safely(route));

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
}

function progressOf(event) {
  const needed = event.teamCount * event.judgeCount;
  return needed ? Math.min(100, Math.round((event.scoreCount / needed) * 100)) : 0;
}

function eventRow(event) {
  const row = el('tr');

  const name = el('td', null, 'event-name');
  const nameLink = el('a', event.name);
  nameLink.href = eventUrl(event._id);
  nameLink.style.textDecoration = 'none';
  name.append(nameLink);

  const status = el('td');
  status.append(pill(event.status));
  const progress = el('td');
  const track = el('span', null, 'progress-track');
  const fill = el('span', null, 'progress-fill');
  fill.style.width = `${progressOf(event)}%`;
  track.append(fill);
  progress.append(track, `${progressOf(event)}%`);

  const actions = el('td');
  const open = el('a', 'Open event', 'row-action');
  open.href = eventUrl(event._id);
  open.style.textDecoration = 'none';

  const wrap = el('span', null, 'overflow-wrap');
  const more = el('button', '⋯', 'icon-button');
  more.type = 'button';
  more.setAttribute('aria-label', `More actions for ${event.name}`);
  more.setAttribute('aria-expanded', 'false');
  const menu = el('span', null, 'overflow-menu hidden');
  for (const [tab, label] of Object.entries(EVENT_TABS)) {
    const link = el('a', label);
    link.href = eventUrl(event._id, tab);
    menu.append(link);
  }
  const view = el('a', 'Public leaderboard ↗');
  view.href = `leaderboard.html?event=${event._id}`;
  view.target = '_blank';
  menu.append(view);
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu(more, menu);
  });
  wrap.append(more, menu);
  actions.append(open, ' ', wrap);

  row.append(name, status, el('td', event.teamCount), el('td', event.judgeCount), progress, actions);
  return row;
}

function renderEventTables() {
  // Dashboard: the 5 newest events.
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

for (const tab of document.querySelectorAll('.filter-tab')) {
  tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    for (const t of document.querySelectorAll('.filter-tab')) {
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
  if (parseRoute().view !== 'events') location.hash = 'events';
});

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

$('create-event').addEventListener('click', () => {
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
      toast(`Event "${event.name}" created - add judges and invite teams`);
      await loadEvents();
      location.hash = eventUrl(event._id, 'judges');
    },
  });
});

// ---------- The selected event ----------
async function selectEvent(eventId) {
  const changed = !selectedEvent || selectedEvent._id !== eventId;
  selectedEvent = await adminApi('GET', `/api/events/${eventId}`);
  const ev = selectedEvent;
  if (changed) recentCodes = [];

  // Heading, sidebar and tab links of this event.
  $('event-title').textContent = ev.name;
  $('event-status').replaceChildren(pill(ev.status));
  $('event-rubric').textContent = ev.rubric.map((r) => `${r.label} ${Math.round(r.weight * 100)}%`).join('  ·  ');
  $('leaderboard-link').href = `leaderboard.html?event=${ev._id}`;
  $('event-nav-name').textContent = ev.name;
  for (const tab of Object.keys(EVENT_TABS)) $(`nav-${tab}`).href = eventUrl(ev._id, tab);
  for (const tab of document.querySelectorAll('.event-tabs .tab')) tab.href = eventUrl(ev._id, tab.dataset.tab);

  // Settings page
  const closed = ev.status === 'closed';
  $('set-draft').classList.toggle('active', ev.status === 'draft');
  $('set-live').classList.toggle('active', ev.status === 'live');
  $('end-event').disabled = closed;
  $('end-event').textContent = closed ? 'Event ended' : 'End Event';
  $('end-text').textContent = closed
    ? 'This event has ended: scoring is closed and every judge code has expired. Setting it live again needs new judge codes (Judges page, "New code").'
    : 'Closes scoring, publishes the final ranking, writes AI feedback for every team and expires every judge code.';
  $('controls-text').textContent = {
    draft: 'Draft: judges cannot score yet. Go live when your teams and judges are ready.',
    live: 'Live: judges are scoring now. Use "End Event" below when judging is over.',
    closed: 'Ended. You can set it live again if judges need to change scores.',
  }[ev.status];
  const rubric = $('rubric-list');
  rubric.replaceChildren();
  for (const r of ev.rubric) {
    const row = el('div', null, 'score-row');
    row.append(el('span', r.label, 'score-label'), el('span', `max ${r.max}  ·  weight ${Math.round(r.weight * 100)}%`, 'score-status'));
    rubric.append(row);
  }
  $('invite-form').querySelector('button').disabled = closed;
  $('judge-form').querySelector('button').disabled = closed;

  // Rankings page
  $('generate-feedback').disabled = !closed;
  $('feedback-note').textContent = closed
    ? 'Written by AI from the judges’ comments. Regenerate if judges changed their comments.'
    : 'Written by AI for every team when you end the event.';

  if (changed) watchLeaderboard(ev._id);
  renderCodes();
  await Promise.all([loadTeams(), loadInvitations(), loadJudges(), loadRankings(), loadFeedback()]);
  await loadScores();
}

async function refreshCounts() {
  await loadEvents();
  await loadScores();
}

async function setStatus(status) {
  await adminApi('PATCH', `/api/events/${selectedEvent._id}`, { status });
  await loadEvents();
  await selectEvent(selectedEvent._id);
  toast(status === 'live' ? 'Event is live - judges can score now' : 'Event moved to draft - judges cannot score');
}
$('set-draft').addEventListener('click', () => safely(() => setStatus('draft')));
$('set-live').addEventListener('click', () => safely(() => setStatus('live')));

$('end-event').addEventListener('click', () =>
  safely(async () => {
    const ok = await confirmModal(
      'End Event?',
      'Scoring closes, the final ranking is published, AI feedback is written for every team, and every judge code of this event expires.',
      'Confirm End Event'
    );
    if (!ok) return;
    await adminApi('PATCH', `/api/events/${selectedEvent._id}`, { status: 'closed' });
    await loadEvents();
    await selectEvent(selectedEvent._id);
    toast('Event ended - judge codes expired, writing AI feedback...');
    location.hash = eventUrl(selectedEvent._id, 'rankings');
    watchFeedback(selectedEvent._id);
  })
);

$('delete-event').addEventListener('click', () =>
  safely(async () => {
    const event = selectedEvent;
    const ok = await confirmModal('Delete event?', `"${event.name}" and all its judges, scores and feedback will be deleted. This cannot be undone.`, 'Delete event');
    if (!ok) return;
    await adminApi('DELETE', `/api/events/${event._id}`);
    toast('Event deleted');
    selectedEvent = null;
    if (liveSource) liveSource.close();
    await loadEvents();
    location.hash = 'events';
  })
);

// One row of a roster: initials, name + subtitle, then any buttons.
function personRow(name, subtitle, ...buttons) {
  const item = el('li');
  const main = el('div', null, 'person-main');
  main.append(name);
  if (subtitle) main.append(subtitle instanceof Node ? subtitle : el('span', subtitle));
  item.append(el('span', initials(name), 'initial'), main, ...buttons);
  return item;
}
function rowButton(label, onClick, danger = false) {
  const btn = el('button', label, `tiny-button${danger ? ' danger' : ''}`);
  btn.type = 'button';
  btn.addEventListener('click', () => safely(onClick));
  return btn;
}

// ---------- Teams + invitations ----------
async function loadTeams() {
  eventTeams = await adminApi('GET', `/api/events/${selectedEvent._id}/teams`);
  $('team-count').textContent = `${eventTeams.length} team${eventTeams.length === 1 ? '' : 's'}`;
  const list = $('team-list');
  list.replaceChildren();
  if (eventTeams.length === 0) list.append(el('li', 'No teams yet. Invite a team with its team code.', 'empty-text'));
  for (const team of eventTeams) {
    const sub = el('span', null);
    sub.append(team.members.join(', ') || 'No members listed');
    if (team.code) sub.append('  ·  ', el('span', team.code, 'code-chip'));
    // What the team shared for judging.
    if (team.githubUrl) {
      const repo = el('a', 'Repo ↗', 'tiny-button');
      repo.href = team.githubUrl;
      repo.target = '_blank';
      repo.rel = 'noopener';
      sub.append('  ·  ', repo);
    }
    if (team.slides) {
      const slides = el('button', 'Slides', 'tiny-button');
      slides.type = 'button';
      slides.title = team.slides.filename;
      slides.addEventListener('click', () => safely(() => downloadFile(`/api/teams/${team._id}/slides`, 'admin')));
      sub.append('  ·  ', slides);
    }
    list.append(
      personRow(
        team.name,
        sub,
        rowButton(
          'Remove',
          async () => {
            const ok = await confirmModal('Remove team?', `"${team.name}" leaves this event and its scores are deleted. The team account itself is kept.`, 'Remove team');
            if (!ok) return;
            await adminApi('DELETE', `/api/teams/${team._id}`);
            toast('Team removed from the event');
            await Promise.all([loadTeams(), loadRankings()]);
            await refreshCounts();
          },
          true
        )
      )
    );
  }
}

async function loadInvitations() {
  const invitations = await adminApi('GET', `/api/events/${selectedEvent._id}/invitations`);
  $('invite-count').textContent = invitations.length;
  const list = $('invite-list');
  list.replaceChildren();
  if (invitations.length === 0) list.append(el('li', 'No invitations waiting.', 'empty-text'));
  for (const inv of invitations) {
    const sub = el('span', null);
    sub.append(el('span', inv.code, 'code-chip'), `  ·  invited ${new Date(inv.createdAt).toLocaleDateString()}`);
    list.append(
      personRow(
        inv.name,
        sub,
        rowButton(
          'Withdraw',
          async () => {
            await adminApi('DELETE', `/api/invitations/${inv._id}`);
            toast('Invitation withdrawn');
            await loadInvitations();
          },
          true
        )
      )
    );
  }
}

$('invite-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const inv = await adminApi('POST', `/api/events/${selectedEvent._id}/invitations`, { code: $('invite-code').value });
    $('invite-code').value = '';
    toast(`Invitation sent to ${inv.name}. They join once they accept.`);
    await loadInvitations();
  });
});

// ---------- Judges ----------
async function loadJudges() {
  eventJudges = await adminApi('GET', `/api/events/${selectedEvent._id}/judges`);
  $('judge-count').textContent = `${eventJudges.length} judge${eventJudges.length === 1 ? '' : 's'}`;
  const list = $('judge-list');
  list.replaceChildren();
  if (eventJudges.length === 0) list.append(el('li', 'No judges yet. Add the first one.', 'empty-text'));
  for (const judge of eventJudges) {
    const sub = el('span', null);
    if (judge.expiredAt) sub.append(pill('code expired'));
    else sub.append('Signs in with this name + code');
    list.append(
      personRow(
        judge.name,
        sub,
        rowButton('New code', async () => {
          const ok = await confirmModal('New code?', `${judge.name}'s old code stops working and a new one is generated.`, 'Generate new code', false);
          if (!ok) return;
          const res = await adminApi('POST', `/api/judges/${judge._id}/reset-code`);
          rememberCode(res.name, res.code);
          await loadJudges();
        }),
        rowButton(
          'Delete',
          async () => {
            const ok = await confirmModal('Delete judge?', `"${judge.name}" and all their scores will be deleted.`, 'Delete judge');
            if (!ok) return;
            await adminApi('DELETE', `/api/judges/${judge._id}`);
            toast('Judge deleted');
            await Promise.all([loadJudges(), loadRankings()]);
            await refreshCounts();
          },
          true
        )
      )
    );
  }
}

$('judge-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const judge = await adminApi('POST', `/api/events/${selectedEvent._id}/judges`, { name: $('judge-name').value });
    $('judge-name').value = '';
    toast(`Judge "${judge.name}" added - copy their code now`);
    rememberCode(judge.name, judge.code);
    await loadJudges();
    await refreshCounts();
  });
});

function rememberCode(name, code) {
  recentCodes.unshift({ name, code });
  renderCodes();
}

function renderCodes() {
  const box = $('code-list');
  box.replaceChildren();
  if (recentCodes.length === 0) {
    box.append(el('p', 'A new code appears here when you add a judge or click New code.', 'empty-text'));
    return;
  }
  for (const item of recentCodes) {
    const row = el('div', null, 'access-row');
    const who = el('div', null, 'access-who');
    who.append(el('span', 'Judge name'), item.name);
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
        recentCodes.map((c) => ({ Judge: c.name, Code: c.code })),
        'Judge codes',
        `${slug(selectedEvent.name)}-judge-codes.xlsx`
      )
    )
  );
  actions.append(download);
  box.append(actions);
}

// ---------- Excel: invite by team codes, export teams ----------
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

$('template-btn').addEventListener('click', () =>
  safely(() =>
    downloadSheet(
      [
        { 'Team code': 'TM7K4Q2X', 'Team name (optional)': 'Byte Bandits' },
        { 'Team code': 'TMQ9R2LP', 'Team name (optional)': 'Null Pointers' },
      ],
      'Teams',
      'scorestream-invite-template.xlsx'
    )
  )
);

// Reads the "Team code" column (or any column whose heading contains "code")
// and sends one invitation per code.
$('import-file').addEventListener('change', (e) =>
  safely(async () => {
    const file = e.target.files[0];
    e.target.value = ''; // so choosing the same file again still fires "change"
    if (!file) return;
    const XLSX = await loadSheetJs();
    const book = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
    const codes = rows
      .map((row) => {
        const key = Object.keys(row).find((h) => h.toLowerCase().includes('code'));
        return key ? String(row[key]).trim() : '';
      })
      .filter(Boolean);
    if (codes.length === 0) throw new Error('No team codes found. The first sheet needs a "Team code" column.');

    const result = await adminApi('POST', `/api/events/${selectedEvent._id}/invitations`, { codes });
    await loadInvitations();
    const list = el('ul', null, 'small muted');
    for (const s of result.skipped) list.append(el('li', `Row ${s.row} (${s.code || 'empty'}${s.name ? `, ${s.name}` : ''}): ${s.reason}`));
    openModal({
      title: `Sent ${result.invited.length} invitation(s)`,
      text: result.skipped.length
        ? `${result.skipped.length} row(s) were skipped. Teams join once they accept.`
        : 'Teams join once they accept the invitation on their dashboard.',
      fields: result.skipped.length ? [list] : [],
      submitLabel: 'OK',
      showCancel: false,
    });
  })
);

// Export: every team with its code, members, rank and average.
$('export-btn').addEventListener('click', () =>
  safely(async () => {
    if (eventTeams.length === 0) throw new Error('No teams to export yet');
    const board = await api('GET', `/api/events/${selectedEvent._id}/leaderboard`).catch(() => ({ rows: [] }));
    const byTeam = new Map(board.rows.map((r) => [r.teamId, r]));
    const rows = eventTeams
      .map((t) => {
        const r = byTeam.get(t._id);
        return { Rank: r ? r.rank : '', 'Team name': t.name, 'Team code': t.code || '', Members: t.members.join(', '), 'Average score': r ? r.avgScore : '', Judges: r ? r.judgesCount : 0 };
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

// ---------- Scores: judging progress (Judges page) + every score (Rankings page) ----------
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
    progress.append(track, `${done} / ${eventTeams.length} teams scored`);
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
      btn.textContent = 'Regenerate feedback';
    }
  })
);

// ---------- Start ----------
safely(async () => {
  await loadEvents();
  await route();
});
