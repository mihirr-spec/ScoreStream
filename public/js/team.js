// Team page: your live rank, average score, marks per criterion,
// and (after the event closes) your AI feedback.

requireLogin('team');

let teamId = null;
let liveSource = null;

// Fills the rank card and the score ring.
function showStanding(standing, totalTeams) {
  if (!standing) {
    $('rank').textContent = '-';
    $('rank-note').textContent = 'Waiting for the first judge to score you.';
    $('avg').textContent = '-';
    $('ring-text').textContent = '-';
    $('judges').textContent = '0 judges have scored you';
    $('team-stars').replaceChildren(stars(0));
    return;
  }
  $('rank').replaceChildren(`#${standing.rank}`, el('small', ` of ${totalTeams}`));
  $('rank-note').textContent = standing.rank === 1 ? 'You are leading the event!' : `Keep going - ${standing.rank - 1} team(s) ahead of you.`;
  $('avg').textContent = standing.avgScore.toFixed(2);
  $('ring-text').textContent = standing.avgScore.toFixed(1);
  // The ring's full circumference is 314.16; offset shows the unfilled part.
  $('ring-fill').style.strokeDashoffset = String(314.16 * (1 - standing.avgScore / 10));
  $('judges').textContent = `${standing.judgesCount} judge(s) have scored you`;
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

function showFeedback(event, feedback) {
  const box = $('feedback');
  box.replaceChildren();

  if (event.status !== 'closed') {
    box.append(el('p', '🔒 Your feedback unlocks when the organiser closes the event. Judges are still scoring.', 'muted'));
    return;
  }
  if (!feedback) {
    box.append(el('p', 'The event is closed. Your feedback is being prepared by the organiser - check back soon.', 'muted'));
    return;
  }

  const title = el('div', null, 'row');
  title.style.marginBottom = '10px';
  title.append(badge(`${feedback.sentiment.label} (${feedback.sentiment.score})`, feedback.sentiment.label));
  if (feedback.source === 'mock') title.append(badge('mock'));
  box.append(title, el('p', feedback.summary));

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
  $('team-name').textContent = data.team.name;
  $('event-name').textContent = data.event.name;
  $('event-status').replaceChildren(badge(data.event.status));
  $('members').textContent = data.team.members.join(', ');
  $('leaderboard-link').href = `leaderboard.html?event=${data.event._id}`;
  $('demo-banner').classList.toggle('hidden', !data.event.demo);

  showStanding(data.standing, data.totalTeams);
  showBreakdown(data.breakdown);
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
