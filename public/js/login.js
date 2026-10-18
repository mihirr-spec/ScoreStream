// One login screen for all three roles. The selected role decides which
// API endpoint we call and which page we open afterwards.

const ROLES = {
  admin: {
    endpoint: '/api/auth/admin-login',
    field: 'password', // name of the JSON field the server expects
    label: 'Admin password',
    inputType: 'password',
    placeholder: '',
    next: 'admin.html',
    image: 'img/admin.jpg',
    title: 'Run the whole event',
    text: 'Create events, add teams and judges, and watch every score arrive in real time.',
    hint: 'Use the admin password set in the server configuration.',
    demo: 'Demo admin: manage a sample event with 3 teams (your real events stay hidden).',
  },
  judge: {
    endpoint: '/api/auth/judge-login',
    field: 'code',
    label: 'Judge access code',
    inputType: 'text',
    placeholder: 'e.g. JUDGE003',
    next: 'judge.html',
    image: 'img/judge.jpg',
    title: 'Score in seconds',
    text: 'Tap the stars, leave a comment, and the leaderboard updates for everyone.',
    hint: 'Your code was given to you by the event organiser. Demo: JUDGE003',
    demo: 'Demo judge: rate the 3 sample teams with stars and watch the leaderboard move.',
  },
  team: {
    endpoint: '/api/auth/team-login',
    field: 'code',
    label: 'Team access code',
    inputType: 'text',
    placeholder: 'e.g. TEAM001',
    next: 'team.html',
    image: 'img/team.jpg',
    title: 'See where you stand',
    text: 'Follow your live rank and read your AI feedback once the event closes.',
    hint: 'Your team code was given to you by the event organiser. Demo: TEAM001',
    demo: "Demo team: follow a sample team's live rank, stars and scores.",
  },
};

// Start on the role from the URL (login.html?role=judge), default admin.
const params = new URLSearchParams(location.search);
let currentRole = params.get('role');
// Read ?demo=1 now, because selectRole() rewrites the URL.
const startDemo = params.get('demo') === '1';
if (!ROLES[currentRole]) currentRole = 'admin';

function selectRole(role) {
  currentRole = role;
  const r = ROLES[role];

  for (const tab of document.querySelectorAll('.role-tab')) {
    tab.classList.toggle('active', tab.dataset.role === role);
    tab.setAttribute('aria-selected', tab.dataset.role === role);
  }
  $('secret-label').textContent = r.label;
  $('secret').type = r.inputType;
  $('secret').placeholder = r.placeholder;
  $('secret').value = '';
  $('login-btn').textContent = `Log in as ${role[0].toUpperCase()}${role.slice(1)}`;
  $('login-hint').textContent = r.hint;
  $('demo-btn').textContent = `Try the demo ${role[0].toUpperCase()}${role.slice(1)}`;
  $('demo-text').textContent = r.demo;
  $('side-img').src = r.image;
  $('side-title').textContent = r.title;
  $('side-text').textContent = r.text;

  // Keep the URL in sync so the page can be bookmarked / shared per role.
  history.replaceState(null, '', `login.html?role=${role}`);
  $('secret').focus();
}

for (const tab of document.querySelectorAll('.role-tab')) {
  tab.addEventListener('click', () => selectRole(tab.dataset.role));
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  safely(async () => {
    const r = ROLES[currentRole];
    const button = $('login-btn');
    button.disabled = true;
    try {
      // No role passed to api(), because we don't have a token yet.
      const data = await api('POST', r.endpoint, { [r.field]: $('secret').value });
      auth.set(currentRole, data.token);
      location.href = r.next;
    } finally {
      button.disabled = false;
    }
  });
});

// One-click demo account: the server returns a token limited to the demo event.
async function demoLogin() {
  const button = $('demo-btn');
  button.disabled = true;
  try {
    const data = await api('POST', '/api/auth/demo-login', { role: currentRole });
    auth.set(currentRole, data.token);
    location.href = ROLES[currentRole].next;
  } finally {
    button.disabled = false;
  }
}
$('demo-btn').addEventListener('click', () => safely(demoLogin));

selectRole(currentRole);

// Links like login.html?role=judge&demo=1 (from the landing page) start the demo straight away.
if (startDemo) safely(demoLogin);
