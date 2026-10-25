// Team page: your live rank, average score, marks per criterion, every judge's
// own score, and (after the event closes) your AI feedback.

requireLogin('team');

let teamId = null;
let liveSource = null;

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

async function load() {
  const data = await api('GET', '/api/team/me', undefined, 'team');
  teamId = data.team._id;

  setupUserBar('team', data.team.name);
  setupShell(data.team.name);
  $('team-name').textContent = data.team.name;
  $('event-name').textContent = data.event.name;
  $('event-status').replaceChildren(el('span', data.event.status, `pill ${data.event.status}`));
  $('members').textContent = data.team.members.length ? `·  ${data.team.members.join(', ')}` : '';
  $('leaderboard-link').href = `leaderboard.html?event=${data.event._id}`;
  $('demo-banner').classList.toggle('hidden', !data.event.demo);

  showStanding(data.standing, data.totalTeams);
  showBreakdown(data.breakdown);
  showJudgeScores(data.event.rubric, data.judgeScores);
  showFeedback(data.event, data.feedback);

  // Listen to the event's public leaderboard stream and pick out our own row.
  if (!liveSource) {
    liveSource = new EventSource(`/api/events/${data.event._id}/stream`);
    liveSource.addEventListener('leaderboard', (msg) => {
      const rows = JSON.parse(msg.data);
      const mine = rows.find((r) => r.teamId === teamId);
      showStanding(mine || null, data.totalTeams);
    });
    liveSource.addEventListener('open', () => $('live-flag').classList.remove('hidden'));
    liveSource.addEventListener('error', () => $('live-flag').classList.add('hidden'));
  }
}

safely(load);
// Refresh the criterion breakdown every 30s (rank/average already update live).
setInterval(() => safely(load), 30000);
