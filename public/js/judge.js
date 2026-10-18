// Judge page: rate each team of your event with stars (and a slider for fine-tuning).
// 5 stars = the criterion's max mark, so 1 star = max / 5 (e.g. 2 marks out of 10).
// The page shows a total preview, but the SERVER calculates and stores the real total.

requireLogin('judge');
$('refresh-btn').addEventListener('click', () => safely(loadDashboard));

// Same formula as services/scoring.js - only used for the live preview.
function previewTotal(rubric, criteria) {
  let sum = 0;
  for (const item of rubric) sum += ((criteria[item.key] || 0) / item.max) * item.weight;
  return Math.round(sum * 10 * 100) / 100;
}

async function loadDashboard() {
  const { judge, event, teams, myScores } = await api('GET', '/api/judge/me', undefined, 'judge');

  setupUserBar('judge', judge.name);
  $('event-name').textContent = event.name;
  $('event-status').replaceChildren(badge(event.status));
  $('leaderboard-link').href = `leaderboard.html?event=${event._id}`;
  $('not-live').classList.toggle('hidden', event.status === 'live');
  $('demo-banner').classList.toggle('hidden', !event.demo);

  $('stat-teams').textContent = teams.length;
  $('stat-done').textContent = myScores.length;
  $('stat-left').textContent = Math.max(teams.length - myScores.length, 0);
  $('stat-avg').textContent = myScores.length
    ? (myScores.reduce((sum, s) => sum + s.total, 0) / myScores.length).toFixed(2)
    : '-';

  const cards = $('team-cards');
  cards.replaceChildren();
  if (teams.length === 0) cards.append(el('div', 'No teams in this event yet.', 'card empty'));

  // Unscored teams first, so the judge sees what is left to do.
  const sorted = [...teams].sort((a, b) => {
    const aDone = myScores.some((s) => s.teamId === a._id);
    const bDone = myScores.some((s) => s.teamId === b._id);
    return aDone - bDone;
  });
  for (const team of sorted) {
    const existing = myScores.find((s) => s.teamId === team._id);
    cards.append(buildTeamCard(event, team, existing));
  }
}

// One card per team: a slider per rubric criterion, a comment and a submit button.
function buildTeamCard(event, team, existing) {
  const card = el('section', null, 'card score-card');
  const head = el('div', null, 'card-head');
  head.append(el('h3', team.name), existing ? badge('scored', 'live') : badge('not scored', 'draft'));
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
    slider.disabled = event.status !== 'live';
    slider.setAttribute('aria-label', item.label);
    slider.addEventListener('input', update);

    // 5 clickable stars for quick rating. Clicking star N sets the mark to N/5 of the max.
    const starRow = el('div', null, 'star-input');
    const starButtons = [];
    for (let n = 1; n <= 5; n++) {
      const star = el('button', '★');
      star.type = 'button';
      star.disabled = event.status !== 'live';
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

  const comment = el('textarea');
  comment.maxLength = 1000;
  comment.placeholder = 'What stood out? What should they improve? (used for AI feedback)';
  comment.value = existing ? existing.comment : '';
  comment.disabled = event.status !== 'live';

  const totalRow = el('div', null, 'total-row');
  const total = el('div', null, 'total-big');
  const button = el('button', existing ? 'Update score' : 'Submit score', 'btn btn-primary');
  button.type = 'submit';
  button.disabled = event.status !== 'live';
  totalRow.append(total, button);

  form.append(comment, totalRow);
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
      button.disabled = true;
      const body = { criteria: readCriteria(), comment: comment.value };
      // New score -> POST. Already scored -> PUT to edit (a second POST would hit the unique index).
      const saved = existing
        ? await api('PUT', `/api/scores/${existing._id}`, body, 'judge')
        : await api('POST', '/api/scores', { teamId: team._id, ...body }, 'judge');
      toast(`Saved ${team.name}: ${saved.total} / 10`);
      await loadDashboard();
    }).finally(() => (button.disabled = event.status !== 'live'));
  });

  return card;
}

safely(loadDashboard);
