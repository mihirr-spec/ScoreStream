// One sign-in screen for all three roles. The selected role decides which
// API endpoint we call and which page we open afterwards.
// "Student" = a member of a team, who signs in with the team's access code.
// Judges sign in with their name AND their code. Administrators sign in with a
// username + password, or create a new organiser account.

const ROLES = {
  team: {
    endpoint: '/api/auth/team-login',
    field: 'code', // name of the JSON field the server expects
    label: 'Team access code',
    placeholder: 'e.g. TEAM001',
    isPassword: false,
    name: null, // no name field for teams
    next: 'team.html',
    demoLabel: 'Try the demo Student account',
    forgot: 'Team codes are given out by your event organiser. Ask them for a new one - the admin can reset a code in one click.',
  },
  judge: {
    endpoint: '/api/auth/judge-login',
    field: 'code',
    label: 'Judge access code',
    placeholder: 'e.g. JUDGE001',
    isPassword: false,
    name: { field: 'name', label: 'Your name', placeholder: 'Exactly as the organiser added you', autocomplete: 'name' },
    next: 'judge.html',
    demoLabel: 'Try the demo Judge account',
    forgot: 'Your name and code are given out by your event organiser. Ask them for a new code - the admin can reset it in one click.',
  },
  admin: {
    endpoint: '/api/auth/admin-login',
    field: 'password',
    label: 'Password',
    placeholder: 'Enter your password',
    isPassword: true,
    name: { field: 'username', label: 'Username', placeholder: 'Enter your username', autocomplete: 'username' },
    next: 'admin.html',
    demoLabel: 'Try the demo Administrator account',
    forgot: 'There is no email reset yet. If you are the main admin, your login is ADMIN_USERNAME / ADMIN_PASSWORD in the server\'s .env file.',
  },
};

// Start on the role from the URL (login.html?role=judge), default Student.
const params = new URLSearchParams(location.search);
let currentRole = ROLES[params.get('role')] ? params.get('role') : 'team';
// Administrator only: true = "Create an account" form instead of "Sign in".
let registering = params.get('register') === '1';
// Read ?demo=1 now, because selectRole() rewrites the URL.
const startDemo = params.get('demo') === '1';

function selectRole(role) {
  currentRole = role;
  if (role !== 'admin') registering = false;
  const r = ROLES[role];

  for (const tab of document.querySelectorAll('.login2-tab')) {
    tab.classList.toggle('active', tab.dataset.role === role);
    tab.setAttribute('aria-selected', tab.dataset.role === role);
  }
  $('secret-label').textContent = r.label;
  $('secret').type = r.isPassword ? 'password' : 'text';
  $('secret').placeholder = r.isPassword && registering ? 'At least 8 characters' : r.placeholder;
  $('secret').autocomplete = r.isPassword ? (registering ? 'new-password' : 'current-password') : 'off';
  $('secret').value = '';

  // Name / username field (Judge and Administrator).
  $('username-block').classList.toggle('hidden', !r.name);
  $('username').required = Boolean(r.name);
  if (r.name) {
    $('username-label').textContent = r.name.label;
    $('username').placeholder = r.name.placeholder;
    $('username').autocomplete = r.name.autocomplete;
  }

  $('icon-key').classList.toggle('hidden', r.isPassword);
  $('icon-lock').classList.toggle('hidden', !r.isPassword);
  $('eye-btn').classList.toggle('hidden', !r.isPassword);
  $('forgot-btn').textContent = r.isPassword ? 'Forgot password?' : 'Forgot your code?';
  $('forgot-btn').classList.toggle('hidden', registering);
  $('forgot-text').classList.add('hidden');
  $('demo-label').textContent = r.demoLabel;

  // Organiser sign-up only exists for the Administrator tab.
  $('register-foot').classList.toggle('hidden', role !== 'admin');
  $('confirm-block').classList.toggle('hidden', !registering);
  $('confirm').required = registering;
  $('confirm').value = '';
  $('register-q').textContent = registering ? 'Already have an account?' : 'New organiser?';
  $('register-toggle').textContent = registering ? 'Sign in' : 'Create an account';
  $('login-title').replaceChildren(...(registering ? ['Create your ', el('span', 'account')] : ['Welcome ', el('span', 'back')]));
  $('login-sub').textContent = registering
    ? 'Register as an organiser to create events, add judges and import teams.'
    : 'Sign in to manage your events, scores and teams.';
  $('login-btn').firstChild.textContent = registering ? 'Create account ' : 'Sign In ';

  // Keep the URL in sync so the page can be bookmarked / shared per role.
  history.replaceState(null, '', `login.html?role=${role}${registering ? '&register=1' : ''}`);
  (r.name ? $('username') : $('secret')).focus();
}

for (const tab of document.querySelectorAll('.login2-tab')) {
  tab.addEventListener('click', () => selectRole(tab.dataset.role));
}

$('register-toggle').addEventListener('click', () => {
  registering = !registering;
  selectRole('admin');
});

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
    if (registering && $('secret').value !== $('confirm').value) {
      throw new Error('The two passwords do not match');
    }
    const button = $('login-btn');
    button.disabled = true;
    try {
      // No role passed to api(), because we don't have a token yet.
      const body = { [r.field]: $('secret').value };
      if (r.name) body[r.name.field] = $('username').value;
      const data = await api('POST', registering ? '/api/auth/admin-register' : r.endpoint, body);
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
