// Judge page. #overview shows your progress; #score shows ONE team at a time:
// rate each criterion with stars (or the slider), write feedback, then
// "Submit & next" moves on to the next team you have not scored yet.
// 5 stars = the criterion's max mark, so 1 star = max / 5 (e.g. 2 marks out of 10).
// The page shows a total preview, but the SERVER calculates and stores the real total.

requireLogin('judge');

const goTo = setupViews(
  {
    overview: { crumb: 'Overview' },
    score: { crumb: 'Score teams' },
  },
  'overview'
);
$('refresh-btn').addEventListener('click', () => safely(loadDashboard));

let data = null; // { judge, event, teams, myScores } from /api/judge/me
let currentIndex = 0;

// Same formula as services/scoring.js - only used for the live preview.
function previewTotal(rubric, criteria) {
  let sum = 0;
  for (const item of rubric) sum += ((criteria[item.key] || 0) / item.max) * item.weight;
  return Math.round(sum * 10 * 100) / 100;
}

const scoreFor = (team) => data.myScores.find((s) => s.teamId === team._id);

async function loadDashboard() {
  data = await api('GET', '/api/judge/me', undefined, 'judge');
  const { judge, event, teams, myScores } = data;

  setupUserBar('judge', judge.name);
  setupShell(judge.name);
  $('event-name').textContent = event.name;
  $('event-status').replaceChildren(el('span', event.status, `pill ${event.status}`));
  $('leaderboard-link').href = `leaderboard.html?event=${event._id}`;
  $('not-live').classList.toggle('hidden', event.status === 'live');
  $('demo-banner').classList.toggle('hidden', !event.demo);

  $('stat-teams').textContent = teams.length;
  $('stat-done').textContent = myScores.length;
  $('stat-left').textContent = Math.max(teams.length - myScores.length, 0);
  $('stat-avg').textContent = myScores.length ? (myScores.reduce((sum, s) => sum + s.total, 0) / myScores.length).toFixed(2) : '-';

  // Overview page: one row per team, scored or not. Clicking opens it on the Score page.
  const progress = $('progress-list');
  progress.replaceChildren();
  if (teams.length === 0) progress.append(el('p', 'No teams in this event yet.', 'empty-text'));
  teams.forEach((team, i) => {
    const mine = scoreFor(team);
    const row = el('div', null, 'score-row');
    const name = el('button', team.name, 'score-label');
    name.type = 'button';
    name.addEventListener('click', () => openTeam(i));
    const right = el('span', null, 'action-row');
    right.style.alignItems = 'center';
    if (mine) right.append(el('span', `${mine.total} / 10`, 'score-status'));
    right.append(el('span', mine ? 'scored' : 'not scored', `pill ${mine ? 'live' : 'draft'}`));
    row.append(name, right);
    progress.append(row);
  });

  if (currentIndex >= teams.length) currentIndex = 0;
  renderSteps();
  renderCurrent();
}

function openTeam(index) {
  currentIndex = index;
  renderSteps();
  renderCurrent();
  goTo('score');
}

// Index of the next team (after `from`) that this judge has not scored, or -1.
function nextUnscored(from) {
  const { teams } = data;
  for (let step = 1; step <= teams.length; step++) {
    const i = (from + step) % teams.length;
    if (!scoreFor(teams[i])) return i;
  }
  return -1;
}

// Left column: every team with its number, status and your total.
function renderSteps() {
  const { teams } = data;
  const query = $('team-search').value.trim().toLowerCase();
  const list = $('team-steps');
  list.replaceChildren();
  $('steps-note').textContent = `${data.myScores.length} of ${teams.length} scored`;
  teams.forEach((team, i) => {
    if (query && !team.name.toLowerCase().includes(query)) return;
    const mine = scoreFor(team);
    const item = el('li');
    const button = el('button', null, i === currentIndex ? 'current' : '');
    button.type = 'button';
    button.append(el('span', mine ? '✓' : String(i + 1), `step-num${mine ? ' done' : ''}`), el('span', team.name, 'step-name'));
    if (mine) button.append(el('span', mine.total, 'step-total'));
    button.addEventListener('click', () => openTeam(i));
    item.append(button);
    list.append(item);
  });
}
$('team-search').addEventListener('input', () => {
  renderSteps();
  goTo('score');
});

// Right column: the current team's rating card.
function renderCurrent() {
  const box = $('current-team');
  box.replaceChildren();
  const { event, teams } = data;
  if (teams.length === 0) {
    box.append(el('div', 'No teams in this event yet.', 'card done-card'));
    return;
  }
  box.append(buildTeamCard(event, teams[currentIndex], scoreFor(teams[currentIndex])));
}

// One team: a star row + slider per rubric criterion, feedback, and submit / navigation.
function buildTeamCard(event, team, existing) {
  const live = event.status === 'live';
  const card = el('section', null, 'card score-card focus');
  card.append(el('p', `Team ${currentIndex + 1} of ${data.teams.length}`, 'step-counter'));
  const head = el('div', null, 'section-head');
  head.append(el('h3', team.name), el('span', existing ? 'scored' : 'not scored', `pill ${existing ? 'live' : 'draft'}`));
  card.append(head, el('div', team.members.join(', ') || 'No members listed', 'members'));

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
  prev.disabled = currentIndex === 0;
  prev.addEventListener('click', () => openTeam(currentIndex - 1));
  const skip = el('button', 'Next →', 'secondary');
  skip.type = 'button';
  skip.disabled = currentIndex >= data.teams.length - 1;
  skip.addEventListener('click', () => openTeam(currentIndex + 1));
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
        const from = currentIndex;
        await loadDashboard();
        // Move on to the next team you haven't scored; when none are left, say so.
        const next = nextUnscored(from);
        if (next === -1) showAllDone();
        else openTeam(next);
      } finally {
        submit.disabled = !live;
      }
    });
  });

  return card;
}

function showAllDone() {
  const box = $('current-team');
  const card = el('section', null, 'card done-card');
  const back = el('button', 'Review my scores', 'secondary');
  back.type = 'button';
  back.addEventListener('click', () => openTeam(0));
  card.append(el('div', '🎉'), el('h2', 'All teams scored'), el('p', 'You can still change a score while the event is live.', 'muted'), back);
  box.replaceChildren(card);
}

safely(loadDashboard);
