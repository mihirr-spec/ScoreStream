// Team dashboard. A team signs in to its ACCOUNT, which can be in many events.
//   #overview       team code, events joined, best rank, your events
//   #invitations    organisers asking to add your team to their event
//   #event/<id>     your results in one event: rank, judges' scores, AI feedback
// New invitations also pop up as soon as the dashboard opens.

requireLogin('team');

let me = null; // { team, events, invitations } from /api/team/me
let liveSource = null;
let openEventId = null;
const shownPopups = new Set(); // invitations already shown in the pop-up this visit

if (new URLSearchParams(location.search).get('welcome') === '1') $('welcome-banner').classList.remove('hidden');

function pill(status) {
  return el('span', status, `pill ${status}`);
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

// ---------- Router ----------
function parseRoute() {
  const [view, id] = location.hash.slice(1).split('/');
  if (view === 'event' && /^[a-f0-9]{24}$/i.test(id || '')) return { view: 'event', eventId: id };
  return { view: view === 'invitations' ? 'invitations' : 'overview', eventId: null };
}

async function route() {
  const { view, eventId } = parseRoute();
  for (const section of document.querySelectorAll('[data-view]')) section.classList.toggle('hidden', section.dataset.view !== view);
  for (const link of document.querySelectorAll('.nav-item[data-nav]')) {
    const active = link.dataset.nav === (view === 'event' ? `event-${eventId}` : view);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'overview') setCrumbs([{ label: 'My team' }, { label: 'Dashboard' }]);
  if (view === 'invitations') setCrumbs([{ label: 'My team' }, { label: 'Invitations' }]);
  if (view !== 'event') stopLive();
  else await loadEvent(eventId);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => safely(route));

// ---------- Account, events and invitations ----------
async function loadMe() {
  me = await api('GET', '/api/team/me', undefined, 'team');
  const { team, events, invitations } = me;

  setupUserBar('team', team.name);
  setupShell(team.name);
  $('demo-banner').classList.toggle('hidden', !team.demo);
  $('team-name').textContent = team.name;
  $('team-members').textContent = team.members.length ? `Members: ${team.members.join(', ')}` : 'No members listed';
  $('team-code').textContent = team.code;

  const ranks = events.map((e) => e.rank).filter(Boolean);
  $('kpi-events').textContent = events.length;
  $('kpi-best').textContent = ranks.length ? `#${Math.min(...ranks)}` : '-';
  $('kpi-invites').textContent = invitations.length;
  $('invite-badge').textContent = invitations.length;
  $('invite-badge').classList.toggle('hidden', invitations.length === 0);

  // "Your events" table.
  const rows = $('event-rows');
  rows.replaceChildren();
  for (const e of events) {
    const row = el('tr');
    const name = el('td', null, 'event-name');
    const link = el('a', e.name);
    link.href = `#event/${e.eventId}`;
    link.style.textDecoration = 'none';
    name.append(link);
    const status = el('td');
    status.append(pill(e.status));
    const open = el('a', 'View results', 'row-action');
    open.href = `#event/${e.eventId}`;
    const actions = el('td');
    actions.append(open);
    const avg = typeof e.avgScore === 'number' ? e.avgScore.toFixed(2) : '-';
    row.append(name, status, el('td', e.rank ? `#${e.rank}` : '-'), el('td', avg), actions);
    rows.append(row);
  }
  $('no-events').classList.toggle('hidden', events.length > 0);

  // Sidebar: one link per event.
  const nav = $('events-nav-list');
  nav.replaceChildren();
  if (events.length === 0) nav.append(el('p', 'No events yet', 'nav-label'));
  for (const e of events) {
    const link = el('a', null, 'nav-item');
    link.href = `#event/${e.eventId}`;
    link.dataset.nav = `event-${e.eventId}`;
    link.append(el('span', e.name, 'step-name'), pill(e.status));
    nav.append(link);
  }

  renderInvitations();
  // Pop up every invitation we have not shown yet in this visit.
  const fresh = invitations.filter((inv) => !shownPopups.has(inv._id));
  if (fresh.length && $('invite-modal').classList.contains('hidden')) showPopup(fresh[0]);
}

async function answer(inv, accept) {
  const res = await api('POST', `/api/team/invitations/${inv._id}`, { accept }, 'team');
  toast(res.message);
  await loadMe();
  if (accept) location.hash = `#event/${inv.eventId}`;
  else await route();
}

// The Invitations page: one row per pending invitation.
function renderInvitations() {
  const box = $('invite-list');
  box.replaceChildren();
  if (me.invitations.length === 0) {
    box.append(el('p', 'No invitations right now. Give your team code to an organiser and their invitation appears here.', 'empty-text'));
    return;
  }
  for (const inv of me.invitations) {
    const row = el('div', null, 'access-row');
    const who = el('div', null, 'access-who');
    who.append(el('span', `From ${inv.invitedBy}  ·  ${new Date(inv.createdAt).toLocaleDateString()}`), inv.eventName);
    const actions = el('div', null, 'action-row');
    const decline = el('button', 'Decline', 'danger-button');
    decline.type = 'button';
    decline.addEventListener('click', () => safely(() => answer(inv, false)));
    const accept = el('button', 'Accept & join', 'primary');
    accept.type = 'button';
    accept.addEventListener('click', () => safely(() => answer(inv, true)));
    actions.append(decline, accept);
    row.append(who, actions);
    box.append(row);
  }
}

// ---------- Invitation pop-up ----------
let popupInvite = null;
function showPopup(inv) {
  popupInvite = inv;
  shownPopups.add(inv._id);
  const index = me.invitations.findIndex((i) => i._id === inv._id);
  $('invite-step').textContent = me.invitations.length > 1 ? `${index + 1} of ${me.invitations.length}` : '';
  $('invite-title').textContent = `Join "${inv.eventName}"?`;
  $('invite-text').textContent =
    `${inv.invitedBy} wants to add ${me.team.name} to the event "${inv.eventName}". ` +
    'Your team only joins if you accept. The event’s judges will then score your team.';
  $('invite-modal').classList.remove('hidden');
  $('invite-accept').focus();
}
function closePopup() {
  $('invite-modal').classList.add('hidden');
  popupInvite = null;
}
function nextPopup() {
  closePopup();
  const next = me.invitations.find((inv) => !shownPopups.has(inv._id));
  if (next) showPopup(next);
}
$('invite-later').addEventListener('click', nextPopup);
$('invite-accept').addEventListener('click', () =>
  safely(async () => {
    const inv = popupInvite;
    closePopup();
    await answer(inv, true);
  })
);
$('invite-decline').addEventListener('click', () =>
  safely(async () => {
    const inv = popupInvite;
    closePopup();
    await answer(inv, false);
  })
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('invite-modal').classList.contains('hidden')) nextPopup();
});

$('copy-code').addEventListener('click', () =>
  safely(async () => {
    await navigator.clipboard.writeText(me.team.code);
    toast('Team code copied');
  })
);

// ---------- One event ----------
// Fills the rank, average and judges KPI cards.
function showStanding(standing, totalTeams) {
  if (!standing) {
    $('rank').textContent = '-';
    $('rank-note').textContent = 'Waiting for the first judge to score you.';
    $('avg').textContent = '-';
    $('judges').textContent = '0';
    $('team-stars').replaceChildren(stars(0));
    return;
  }
  $('rank').replaceChildren(`#${standing.rank}`, el('small', ` of ${totalTeams}`));
  $('rank-note').textContent = standing.rank === 1 ? 'You are leading the event!' : `${standing.rank - 1} team(s) ahead of you`;
  $('avg').textContent = standing.avgScore.toFixed(2);
  $('judges').textContent = standing.judgesCount;
  $('team-stars').replaceChildren(starsFromScore(standing.avgScore));
}

function showBreakdown(breakdown) {
  const box = $('breakdown');
  box.replaceChildren();
  for (const item of breakdown) {
    const row = el('div', null, 'crit');
    const top = el('div', null, 'crit-top');
    top.append(el('span', `${item.label} (weight ${item.weight})`), el('span', item.avg === null ? 'not scored yet' : `${item.avg} / ${item.max}`));
    const bar = el('div', null, 'bar');
    const fill = el('span');
    fill.style.width = item.avg === null ? '0%' : `${(item.avg / item.max) * 100}%`;
    bar.append(fill);
    row.append(top, bar);
    box.append(row);
  }
}

// One row per judge: their mark for each criterion, total and comment.
function showJudgeScores(rubric, judgeScores) {
  const table = $('judge-scores');
  table.replaceChildren();
  if (judgeScores.length === 0) {
    table.append(el('caption', 'No judge has scored you yet.', 'empty-row'));
    return;
  }
  const head = el('tr');
  for (const title of ['Judge', ...rubric.map((r) => `${r.label} /${r.max}`), 'Total', 'Comment']) head.append(el('th', title));
  table.append(head);
  for (const s of judgeScores) {
    const row = el('tr');
    row.append(el('td', s.judgeName, 'event-name'));
    for (const r of rubric) row.append(el('td', s.criteria[r.key] ?? '-'));
    const total = el('td');
    total.append(el('strong', s.total));
    row.append(total, el('td', s.comment || '-'));
    table.append(row);
  }
}

function showFeedback(event, feedback) {
  const box = $('feedback');
  box.replaceChildren();

  $('feedback-state').textContent = event.status !== 'closed' ? 'Locked' : feedback ? 'Ready' : 'Writing...';
  if (event.status !== 'closed') {
    box.append(el('p', '🔒 Your feedback unlocks when the organiser ends the event. Judges are still scoring.', 'empty-text'));
    return;
  }
  if (!feedback) {
    box.append(el('p', "✨ The event is closed. Your AI feedback is being written from the judges' comments - check back in a minute.", 'empty-text'));
    return;
  }

  const title = el('div', null, 'action-row');
  title.append(el('span', `${feedback.sentiment.label} (${feedback.sentiment.score})`, `pill ${feedback.sentiment.label}`));
  if (feedback.source === 'mock') title.append(el('span', 'mock', 'pill mock'));
  box.append(title, el('p', feedback.summary, 'feedback-summary'));

  const cols = el('div', null, 'feedback-cols');
  for (const [heading, points] of [['💪 Strengths', feedback.strengths], ['🎯 Improvements', feedback.improvements]]) {
    const col = el('div');
    col.append(el('strong', heading));
    const ul = el('ul');
    (points.length ? points : ['Nothing noted']).forEach((p) => ul.append(el('li', p)));
    col.append(ul);
    cols.append(col);
  }
  box.append(cols);
}

function stopLive() {
  if (liveSource) liveSource.close();
  liveSource = null;
  openEventId = null;
  $('live-flag').classList.add('hidden');
}

async function loadEvent(eventId) {
  const data = await api('GET', `/api/team/events/${eventId}`, undefined, 'team');
  setCrumbs([{ label: 'My team', href: '#overview' }, { label: data.event.name }]);
  $('event-name').textContent = data.event.name;
  $('event-status').replaceChildren(pill(data.event.status));
  $('event-team').textContent = `${data.team.name}${data.team.members.length ? `  ·  ${data.team.members.join(', ')}` : ''}`;
  $('leaderboard-link').href = `leaderboard.html?event=${data.event._id}`;

  showStanding(data.standing, data.totalTeams);
  showBreakdown(data.breakdown);
  showJudgeScores(data.event.rubric, data.judgeScores);
  showFeedback(data.event, data.feedback);

  // Listen to the event's public leaderboard stream and pick out our own row.
  if (openEventId !== eventId) {
    stopLive();
    openEventId = eventId;
    liveSource = new EventSource(`/api/events/${eventId}/stream`);
    liveSource.addEventListener('leaderboard', (msg) => {
      const rows = JSON.parse(msg.data);
      const mine = rows.find((r) => r.teamId === data.team._id);
      showStanding(mine || null, data.totalTeams);
    });
    liveSource.addEventListener('open', () => $('live-flag').classList.remove('hidden'));
    liveSource.addEventListener('error', () => $('live-flag').classList.add('hidden'));
  }
}

safely(async () => {
  await loadMe();
  await route();
});
// Every 30s: check for new invitations and refresh the open event (rank also updates live).
setInterval(
  () =>
    safely(async () => {
      await loadMe();
      if (openEventId) await loadEvent(openEventId);
    }),
  30000
);
