// One sign-in screen for all three roles. The selected role decides which
// API endpoint we call and which page we open afterwards.
//   Student (team)  -> team code + password, or register a new team
//   Judge           -> judge code + password, or register as a judge
//   Administrator   -> username + password, or create an organiser account

const ROLES = {
  team: {
    endpoint: '/api/auth/team-login',
    name: { field: 'code', label: 'Team code', placeholder: 'e.g. TM7K4Q2X', autocomplete: 'username' },
    secret: { field: 'password', label: 'Password', placeholder: 'Your team password', isPassword: true },
    next: 'team.html',
    forgot: 'Your team code is shown on your team dashboard. There is no password reset yet - register a new team if you lost it.',
    register: {
      endpoint: '/api/auth/team-register',
      name: { field: 'name', label: 'Team name', placeholder: 'e.g. Byte Bandits', autocomplete: 'off' },
      members: true,
      question: 'New team?',
      title: 'team',
      action: 'Register your team',
      sub: 'Register once and get a permanent team code. Organisers use it to invite you to events.',
      next: 'team.html?welcome=1',
    },
  },
  judge: {
    endpoint: '/api/auth/judge-login',
    name: { field: 'code', label: 'Judge code', placeholder: 'e.g. JG3H8M2P', autocomplete: 'username' },
    secret: { field: 'password', label: 'Password', placeholder: 'Your password', isPassword: true },
    next: 'judge.html',
    forgot: 'Your judge code is shown on your judge dashboard. There is no password reset yet - register again if you lost it.',
    register: {
      endpoint: '/api/auth/judge-register',
      name: { field: 'name', label: 'Your name', placeholder: 'e.g. Prof. Rao', autocomplete: 'name' },
      members: false,
      question: 'New judge?',
      action: 'Create a judge account',
      sub: 'Register once and get a permanent judge code. Organisers use it to invite you to judge their events.',
      title: 'judge account',
      next: 'judge.html?welcome=1',
    },
  },
  admin: {
    endpoint: '/api/auth/admin-login',
    name: { field: 'username', label: 'Username', placeholder: 'Enter your username', autocomplete: 'username' },
    secret: { field: 'password', label: 'Password', placeholder: 'Enter your password', isPassword: true },
    next: 'admin.html',
    forgot: 'There is no email reset yet. If you are the main admin, your login is ADMIN_USERNAME / ADMIN_PASSWORD in the server\'s .env file.',
    register: {
      endpoint: '/api/auth/admin-register',
      name: { field: 'username', label: 'Username', placeholder: '3-30 letters or digits', autocomplete: 'username' },
      members: false,
      question: 'New organiser?',
      title: 'account',
      action: 'Create an account',
      sub: 'Register as an organiser to create events, add judges and invite teams.',
      next: 'admin.html',
    },
  },
};

// Start on the role from the URL (login.html?role=judge), default Student.
const params = new URLSearchParams(location.search);
let currentRole = ROLES[params.get('role')] ? params.get('role') : 'team';
// true = the "register" form of the current role instead of "sign in".
let registering = params.get('register') === '1';

function selectRole(role) {
  currentRole = role;
  const r = ROLES[role];
  if (!r.register) registering = false;
  const name = registering ? r.register.name : r.name;

  for (const tab of document.querySelectorAll('.login2-tab')) {
    tab.classList.toggle('active', tab.dataset.role === role);
    tab.setAttribute('aria-selected', tab.dataset.role === role);
  }

  // First field: username / judge name / team code / team name.
  $('username-block').classList.remove('hidden');
  $('username').required = true;
  $('username-label').textContent = name.label;
  $('username').placeholder = name.placeholder;
  $('username').autocomplete = name.autocomplete;
  $('username').value = '';

  // Team members (team registration only).
  const members = registering && r.register.members;
  $('members-block').classList.toggle('hidden', !members);
  $('members').value = '';

  // Second field: password or judge code.
  const isPassword = r.secret.isPassword;
  $('secret-label').textContent = r.secret.label;
  $('secret').type = isPassword ? 'password' : 'text';
  $('secret').placeholder = isPassword && registering ? 'At least 8 characters' : r.secret.placeholder;
  $('secret').autocomplete = isPassword ? (registering ? 'new-password' : 'current-password') : 'off';
  $('secret').value = '';
  $('icon-key').classList.toggle('hidden', isPassword);
  $('icon-lock').classList.toggle('hidden', !isPassword);
  $('eye-btn').classList.toggle('hidden', !isPassword);

  $('confirm-block').classList.toggle('hidden', !registering);
  $('confirm').required = registering;
  $('confirm').value = '';

  $('forgot-btn').textContent = isPassword ? 'Forgot password?' : 'Forgot your code?';
  $('forgot-btn').classList.toggle('hidden', registering);
  $('forgot-text').classList.add('hidden');

  // Every role can sign up: teams, judges and organisers.
  $('register-foot').classList.toggle('hidden', !r.register);
  if (r.register) {
    $('register-q').textContent = registering ? 'Already registered?' : r.register.question;
    $('register-toggle').textContent = registering ? 'Sign in' : r.register.action;
  }
  $('login-title').replaceChildren(...(registering ? [role === 'team' ? 'Register your ' : 'Create your ', el('span', r.register.title)] : ['Welcome ', el('span', 'back')]));
  $('login-sub').textContent = registering ? r.register.sub : 'Sign in to manage your events, scores and teams.';
  $('login-btn').firstChild.textContent = registering ? (role === 'team' ? 'Register team ' : 'Create account ') : 'Sign In ';

  // Keep the URL in sync so the page can be bookmarked / shared per role.
  history.replaceState(null, '', `login.html?role=${role}${registering ? '&register=1' : ''}`);
  $('username').focus();
}

for (const tab of document.querySelectorAll('.login2-tab')) {
  tab.addEventListener('click', () => selectRole(tab.dataset.role));
}

$('register-toggle').addEventListener('click', () => {
  registering = !registering;
  selectRole(currentRole);
});

// Eye button: show / hide the password.
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
function finishLogin(token, next) {
  auth.set(currentRole, token, $('remember').checked);
  location.href = next || ROLES[currentRole].next;
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
      const mode = registering ? r.register : r;
      const body = { [mode.name.field]: $('username').value, [r.secret.field]: $('secret').value };
      if (registering && r.register.members) {
        body.members = $('members').value.split(',').map((m) => m.trim()).filter(Boolean);
      }
      const data = await api('POST', mode.endpoint, body);
      finishLogin(data.token, mode.next);
    } finally {
      button.disabled = false;
    }
  });
});

selectRole(currentRole);
