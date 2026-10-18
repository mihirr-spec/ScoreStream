// One sign-in screen for all three roles. The selected role decides which
// API endpoint we call and which page we open afterwards.
// "Student" = a member of a team, who signs in with the team's access code.

const ROLES = {
  team: {
    endpoint: '/api/auth/team-login',
    field: 'code', // name of the JSON field the server expects
    label: 'Team access code',
    placeholder: 'e.g. TEAM001',
    isPassword: false,
    next: 'team.html',
    demoLabel: 'Try the demo Student account',
    forgot: 'Team codes are given out by your event organiser. Ask them for a new one - the admin can reset a code in one click.',
  },
  judge: {
    endpoint: '/api/auth/judge-login',
    field: 'code',
    label: 'Judge access code',
    placeholder: 'e.g. JUDGE003',
    isPassword: false,
    next: 'judge.html',
    demoLabel: 'Try the demo Judge account',
    forgot: 'Judge codes are given out by your event organiser. Ask them for a new one - the admin can reset a code in one click.',
  },
  admin: {
    endpoint: '/api/auth/admin-login',
    field: 'password',
    label: 'Admin password',
    placeholder: 'Enter your password',
    isPassword: true,
    next: 'admin.html',
    demoLabel: 'Try the demo Administrator account',
    forgot: 'The admin password is set in the server configuration (ADMIN_PASSWORD in the .env file).',
  },
};

// Start on the role from the URL (login.html?role=judge), default Student.
const params = new URLSearchParams(location.search);
let currentRole = ROLES[params.get('role')] ? params.get('role') : 'team';
// Read ?demo=1 now, because selectRole() rewrites the URL.
const startDemo = params.get('demo') === '1';

function selectRole(role) {
  currentRole = role;
  const r = ROLES[role];

  for (const tab of document.querySelectorAll('.login2-tab')) {
    tab.classList.toggle('active', tab.dataset.role === role);
    tab.setAttribute('aria-selected', tab.dataset.role === role);
  }
  $('secret-label').textContent = r.label;
  $('secret').type = r.isPassword ? 'password' : 'text';
  $('secret').placeholder = r.placeholder;
  $('secret').value = '';
  $('icon-key').classList.toggle('hidden', r.isPassword);
  $('icon-lock').classList.toggle('hidden', !r.isPassword);
  $('eye-btn').classList.toggle('hidden', !r.isPassword);
  $('forgot-btn').textContent = r.isPassword ? 'Forgot password?' : 'Forgot your code?';
  $('forgot-text').classList.add('hidden');
  $('demo-label').textContent = r.demoLabel;

  // Keep the URL in sync so the page can be bookmarked / shared per role.
  history.replaceState(null, '', `login.html?role=${role}`);
  $('secret').focus();
}

for (const tab of document.querySelectorAll('.login2-tab')) {
  tab.addEventListener('click', () => selectRole(tab.dataset.role));
}

// Eye button: show / hide the admin password.
$('eye-btn').addEventListener('click', () => {
  const input = $('secret');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('eye-btn').setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
});

// "Forgot" explains how codes/passwords work (there is no email reset).
$('forgot-btn').addEventListener('click', () => {
  $('forgot-text').textContent = ROLES[currentRole].forgot;
  $('forgot-text').classList.toggle('hidden');
});

// Saves the token. "Remember me" keeps it after the browser is closed.
function finishLogin(token) {
  auth.set(currentRole, token, $('remember').checked);
  location.href = ROLES[currentRole].next;
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
      finishLogin(data.token);
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
    finishLogin(data.token);
  } finally {
    button.disabled = false;
  }
}
$('demo-btn').addEventListener('click', () => safely(demoLogin));

selectRole(currentRole);

// Links like login.html?role=judge&demo=1 (from the landing page) start the demo straight away.
if (startDemo) safely(demoLogin);
