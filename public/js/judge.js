// Judge dashboard. A judge signs in to their ACCOUNT, which can judge many events.
//   #overview       judge code, events you judge, your progress
//   #invitations    organisers asking you to judge their event
//   #event/<id>     score that event's teams ONE at a time: stars (or slider) per
//                   criterion, feedback, then "Submit & next" moves to the next team.
// New invitations pop up as soon as the dashboard opens.
// 5 stars = the criterion's max mark, so 1 star = max / 5 (e.g. 2 marks out of 10).
// The page shows a total preview, but the SERVER calculates and stores the real total.

requireLogin('judge');

let me = null; // { judge, events, invitations } from /api/judge/me
let data = null; // { judge, event, teams, myScores } from /api/judge/events/<id>
let openEventId = null;
let currentTeamId = null; // the team on the scoring card (by id, so new teams don't shift it)
let liveSource = null;
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
  $('search-wrap').classList.toggle('hidden', view !== 'event');
  if (view === 'overview') setCrumbs([{ label: 'Judging' }, { label: 'Dashboard' }]);
  if (view === 'invitations') setCrumbs([{ label: 'Judging' }, { label: 'Invitations' }]);
  if (view !== 'event') stopLive();
  else await openEvent(eventId);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => safely(route));

// ---------- Account, events and invitations ----------
async function loadMe() {
  me = await api('GET', '/api/judge/me', undefined, 'judge');
  const { judge, events, invitations } = me;

  setupUserBar('judge', judge.name);
  setupShell(judge.name);
  $('judge-name').textContent = judge.name;
  $('judge-code').textContent = judge.code;
  $('kpi-events').textContent = events.length;
  $('kpi-left').textContent = events.filter((e) => e.status === 'live').reduce((sum, e) => sum + Math.max(e.teamCount - e.scoredCount, 0), 0);
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
    const progress = el('td');
    const track = el('span', null, 'progress-track');
    const fill = el('span', null, 'progress-fill');
    fill.style.width = e.teamCount ? `${Math.round((e.scoredCount / e.teamCount) * 100)}%` : '0%';
    track.append(fill);
    progress.append(track, ` ${e.scoredCount} / ${e.teamCount} teams`);
    const open = el('a', e.status === 'live' ? 'Score teams' : 'View', 'row-action');
    open.href = `#event/${e.eventId}`;
    const actions = el('td');
    actions.append(open);
    row.append(name, status, progress, actions);
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
  const { view, eventId } = parseRoute();
  for (const link of nav.querySelectorAll('.nav-item')) link.classList.toggle('active', view === 'event' && link.dataset.nav === `event-${eventId}`);

  renderInvitations();
  // Pop up every invitation we have not shown yet in this visit.
  const fresh = invitations.filter((inv) => !shownPopups.has(inv._id));
  if (fresh.length && $('invite-modal').classList.contains('hidden')) showPopup(fresh[0]);
}

async function answer(inv, accept) {
  const res = await api('POST', `/api/judge/invitations/${inv._id}`, { accept }, 'judge');
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
    box.append(el('p', 'No invitations right now. Give your judge code to an organiser and their invitation appears here.', 'empty-text'));
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
    const accept = el('button', 'Accept & judge', 'primary');
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
  $('invite-title').textContent = `Judge "${inv.eventName}"?`;
  $('invite-text').textContent =
    `${inv.invitedBy} wants you to judge the event "${inv.eventName}". ` +
    'You are only added if you accept. You can then see its teams and score them.';
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
for (const [id, accept] of [['invite-accept', true], ['invite-decline', false]]) {
  $(id).addEventListener('click', () =>
    safely(async () => {
      const inv = popupInvite;
      closePopup();
      await answer(inv, accept);
    })
  );
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('invite-modal').classList.contains('hidden')) nextPopup();
});

$('copy-code').addEventListener('click', () =>
  safely(async () => {
    await navigator.clipboard.writeText(me.judge.code);
    toast('Judge code copied');
  })
);

// ---------- One event: scoring ----------
// Same formula as services/scoring.js - only used for the live preview.
function previewTotal(rubric, criteria) {
  let sum = 0;
  for (const item of rubric) sum += ((criteria[item.key] || 0) / item.max) * item.weight;
  return Math.round(sum * 10 * 100) / 100;
}

const scoreFor = (team) => data.myScores.find((s) => s.teamId === team._id);
const currentIndex = () => Math.max(data.teams.findIndex((t) => t._id === currentTeamId), 0);

async function loadEvent(eventId) {
  data = await api('GET', `/api/judge/events/${eventId}`, undefined, 'judge');
  const { event, teams } = data;
  setCrumbs([{ label: 'Judging', href: '#overview' }, { label: event.name }]);
  $('event-name').textContent = event.name;
  $('event-status').replaceChildren(pill(event.status));
  $('leaderboard-link').href = `leaderboard.html?event=${event._id}`;
  $('steps-note').textContent = `${data.myScores.length} of ${teams.length} teams scored by you`;
  const banner = $('not-live');
  banner.classList.toggle('hidden', event.status === 'live');
  if (event.status === 'draft') {
    banner.replaceChildren(el('strong', 'Not started yet. '), 'Scoring unlocks when the organiser makes the event live - this page updates by itself.');
  } else if (event.status === 'closed') {
    banner.replaceChildren(el('strong', 'This event has ended. '), 'Scoring is closed; your scores are shown read-only.');
  }
  if (!teams.some((t) => t._id === currentTeamId)) currentTeamId = teams.length ? teams[0]._id : null;
}

async function openEvent(eventId) {
  if (openEventId !== eventId) {
    stopLive();
    openEventId = eventId;
    currentTeamId = null;
    await loadEvent(eventId);
    // Start on the first team you have not scored yet.
    const first = data.teams.find((t) => !scoreFor(t));
    if (first) currentTeamId = first._id;
    watchEvent(eventId);
  } else {
    await loadEvent(eventId);
  }
  renderSteps();
  renderCurrent();
}

// Live updates for the open event:
//   status -> the organiser made it live / ended it: reload so rating unlocks or locks
//   roster -> a team joined: add it to the list without touching the card you're filling in
function watchEvent(eventId) {
  liveSource = new EventSource(`/api/events/${eventId}/stream`);
  liveSource.addEventListener('status', () =>
    safely(async () => {
      await loadEvent(eventId);
      renderSteps();
      renderCurrent();
      await loadMe();
    })
  );
  liveSource.addEventListener('roster', () =>
    safely(async () => {
      const shown = currentTeamId;
      await loadEvent(eventId);
      renderSteps();
      if (shown !== currentTeamId) renderCurrent();
    })
  );
  liveSource.addEventListener('open', () => $('live-flag').classList.remove('hidden'));
  liveSource.addEventListener('error', () => $('live-flag').classList.add('hidden'));
}

function stopLive() {
  if (liveSource) liveSource.close();
  liveSource = null;
  openEventId = null;
  $('live-flag').classList.add('hidden');
}

function showTeam(teamId) {
  currentTeamId = teamId;
  renderSteps();
  renderCurrent();
  window.scrollTo(0, 0);
}

// Id of the next team (after the current one) that you have not scored, or null.
function nextUnscored() {
  const { teams } = data;
  const from = currentIndex();
  for (let step = 1; step <= teams.length; step++) {
    const team = teams[(from + step) % teams.length];
    if (!scoreFor(team)) return team._id;
  }
  return null;
}

// Left column: every team with its number, status and your total.
function renderSteps() {
  const { teams } = data;
  const query = $('team-search').value.trim().toLowerCase();
  const list = $('team-steps');
  list.replaceChildren();
  if (teams.length === 0) list.append(el('li', 'No teams yet.', 'empty-text'));
  teams.forEach((team, i) => {
    if (query && !team.name.toLowerCase().includes(query)) return;
    const mine = scoreFor(team);
    const item = el('li');
    const button = el('button', null, team._id === currentTeamId ? 'current' : '');
    button.type = 'button';
    button.append(el('span', mine ? '✓' : String(i + 1), `step-num${mine ? ' done' : ''}`), el('span', team.name, 'step-name'));
    if (mine) button.append(el('span', mine.total, 'step-total'));
    button.addEventListener('click', () => showTeam(team._id));
    item.append(button);
    list.append(item);
  });
}
$('team-search').addEventListener('input', () => {
  if (data) renderSteps();
});

// Right column: the current team's rating card.
function renderCurrent() {
  const box = $('current-team');
  box.replaceChildren();
  const { event, teams } = data;
  if (teams.length === 0) {
    box.append(el('div', 'No teams in this event yet. They appear here as soon as they join.', 'card done-card'));
    return;
  }
  const team = teams[currentIndex()];
  box.append(buildTeamCard(event, team, scoreFor(team)));
}

// One team: a star row + slider per rubric criterion, feedback, and submit / navigation.
function buildTeamCard(event, team, existing) {
  const live = event.status === 'live';
  const index = currentIndex();
  const card = el('section', null, 'card score-card focus');
  card.append(el('p', `Team ${index + 1} of ${data.teams.length}`, 'step-counter'));
  const head = el('div', null, 'section-head');
  head.append(el('h3', team.name), el('span', existing ? 'scored' : 'not scored', `pill ${existing ? 'live' : 'draft'}`));
  card.append(head, el('div', team.members.join(', ') || 'No members listed', 'members'));

  // What the team shared: its GitHub repo and slides.
  const project = el('div', null, 'project-links');
  if (team.githubUrl) {
    const repo = el('a', 'GitHub repo ↗', 'secondary');
    repo.href = team.githubUrl;
    repo.target = '_blank';
    repo.rel = 'noopener';
    project.append(repo);
  }
  if (team.slides) {
    const slides = el('button', `Slides: ${team.slides.filename}`, 'secondary');
    slides.type = 'button';
    slides.title = fileSize(team.slides.size);
    slides.addEventListener('click', () =>
      openViewer({ path: `/api/judge/teams/${team._id}/slides`, role: 'judge', filename: team.slides.filename, size: team.slides.size, title: team.name })
    );
    project.append(slides);
  }
  if (!team.githubUrl && !team.slides) project.append(el('span', 'This team has not shared a repo or slides yet.', 'small muted'));
  card.append(project);

  const form = el('form');
  const inputs = {};

  for (const item of event.rubric) {
    const wrap = el('div', null, 'slider-field');
    const top = el('div', null, 'slider-top');
    const valueText = el('span');
    top.append(el('span', `${item.label}  ·  weight ${item.weight}`), valueText);

    const slider = el('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = item.max;
    slider.step = 0.5;
    slider.value = existing ? existing.criteria[item.key] : Math.round(item.max / 2);
    slider.disabled = !live;
    slider.setAttribute('aria-label', item.label);
    slider.addEventListener('input', update);

    // 5 clickable stars for quick rating. Clicking star N sets the mark to N/5 of the max.
    const starRow = el('div', null, 'star-input');
    const starButtons = [];
    for (let n = 1; n <= 5; n++) {
      const star = el('button', '★');
      star.type = 'button';
      star.disabled = !live;
      star.setAttribute('aria-label', `${n} star${n > 1 ? 's' : ''} for ${item.label}`);
      star.addEventListener('click', () => {
        slider.value = Math.round(((n * item.max) / 5) * 2) / 2; // nearest 0.5
        update();
      });
      // Hover preview: light up stars 1..n while the mouse is over star n.
      star.addEventListener('mouseenter', () => starButtons.forEach((b, i) => b.classList.toggle('on', i < n)));
      star.addEventListener('mouseleave', update);
      starButtons.push(star);
      starRow.append(star);
    }

    inputs[item.key] = { slider, valueText, max: item.max, starButtons };
    wrap.append(top, starRow, slider);
    form.append(wrap);
  }

  const commentLabel = el('label', 'Feedback for the team', 'field-label');
  const comment = el('textarea');
  comment.id = 'comment';
  commentLabel.htmlFor = 'comment';
  comment.maxLength = 1000;
  comment.placeholder = 'What stood out? What should they improve? The AI turns every judge’s notes into their feedback.';
  comment.value = existing ? existing.comment : '';
  comment.disabled = !live;

  const totalRow = el('div', null, 'total-row');
  const total = el('div', null, 'total-big');
  const nav = el('div', null, 'nav-buttons');
  const prev = el('button', '← Previous', 'secondary');
  prev.type = 'button';
  prev.disabled = index === 0;
  prev.addEventListener('click', () => showTeam(data.teams[index - 1]._id));
  const skip = el('button', 'Next →', 'secondary');
  skip.type = 'button';
  skip.disabled = index >= data.teams.length - 1;
  skip.addEventListener('click', () => showTeam(data.teams[index + 1]._id));
  const submit = el('button', existing ? 'Update & next' : 'Submit & next', 'primary');
  submit.type = 'submit';
  submit.disabled = !live;
  nav.append(prev, skip, submit);
  totalRow.append(total, nav);

  form.append(commentLabel, comment, totalRow);
  card.append(form);

  function readCriteria() {
    const criteria = {};
    for (const [key, input] of Object.entries(inputs)) criteria[key] = Number(input.slider.value);
    return criteria;
  }

  // Refreshes the mark text, the stars and the total preview.
  function update() {
    for (const input of Object.values(inputs)) {
      const value = Number(input.slider.value);
      input.valueText.textContent = `${value} / ${input.max}`;
      const starCount = (value / input.max) * 5; // e.g. 7 out of 10 -> 3.5 stars
      input.starButtons.forEach((b, i) => {
        b.classList.toggle('on', starCount >= i + 1);
        b.classList.toggle('half', starCount >= i + 0.5 && starCount < i + 1);
      });
    }
    const preview = previewTotal(event.rubric, readCriteria());
    total.replaceChildren(String(preview), el('small', ' / 10 '), starsFromScore(preview));
  }
  update();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    safely(async () => {
      submit.disabled = true;
      try {
        const body = { criteria: readCriteria(), comment: comment.value };
        // New score -> POST. Already scored -> PUT to edit (a second POST would hit the unique index).
        const saved = existing
          ? await api('PUT', `/api/scores/${existing._id}`, body, 'judge')
          : await api('POST', '/api/scores', { teamId: team._id, ...body }, 'judge');
        toast(`Saved ${team.name}: ${saved.total} / 10`);
        await loadEvent(openEventId);
        // Move on to the next team you haven't scored; when none are left, say so.
        const next = nextUnscored();
        if (next) showTeam(next);
        else showAllDone();
        safely(loadMe);
      } finally {
        submit.disabled = !live;
      }
    });
  });

  return card;
}

function showAllDone() {
  renderSteps();
  const box = $('current-team');
  const card = el('section', null, 'card done-card');
  const back = el('button', 'Review my scores', 'secondary');
  back.type = 'button';
  back.addEventListener('click', () => showTeam(data.teams[0]._id));
  card.append(el('div', '🎉'), el('h2', 'All teams scored'), el('p', 'You can still change a score while the event is live.', 'muted'), back);
  box.replaceChildren(card);
}

// ---------- Start ----------
safely(async () => {
  await loadMe();
  await route();
});
// Every 20s: check for new invitations (scoring updates arrive over the live stream).
setInterval(() => safely(loadMe), 20000);
