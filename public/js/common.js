// Helpers shared by every page (loaded before the page's own script).
// We always put user data on the page with textContent (never innerHTML),
// so names typed by users can't inject HTML/JavaScript.

function $(id) {
  return document.getElementById(id);
}

// Creates an element with optional text and CSS class.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Small pop-up message at the bottom of the screen.
function toast(message, type = 'ok') {
  let box = $('toast');
  if (!box) {
    box = el('div');
    box.id = 'toast';
    document.body.append(box);
  }
  box.textContent = message;
  box.className = `show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (box.className = ''), 3500);
}

// ---------- Login tokens ----------
// Each role keeps its own token. Normally it goes in sessionStorage (forgotten when
// the browser closes); with "Remember me" it goes in localStorage (kept until log out).
const auth = {
  get(role) {
    try {
      return sessionStorage.getItem(`${role}Token`) || localStorage.getItem(`${role}Token`);
    } catch {
      return null;
    }
  },
  set(role, token, remember = false) {
    try {
      this.clear(role);
      (remember ? localStorage : sessionStorage).setItem(`${role}Token`, token);
    } catch {
      /* storage blocked - the user just has to log in again next time */
    }
  },
  clear(role) {
    try {
      sessionStorage.removeItem(`${role}Token`);
      localStorage.removeItem(`${role}Token`);
    } catch {
      /* ignore */
    }
  },
};

// Pages that need a login call this first. No token -> go to the login page.
function requireLogin(role) {
  const token = auth.get(role);
  if (!token) {
    location.href = `login.html?role=${role}`;
    throw new Error('Not logged in'); // stops the rest of the page script
  }
  return token;
}

function logout(role) {
  auth.clear(role);
  location.href = `login.html?role=${role}`;
}

// Calls our JSON API. Sends the role's token if there is one.
// Throws an Error with the server's { error } message when the request fails.
async function api(method, path, body, role) {
  const headers = { 'Content-Type': 'application/json' };
  const token = role ? auth.get(role) : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Expired/invalid login -> back to the login page for that role.
  if (res.status === 401 && role) {
    logout(role);
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Runs an async action and shows any error as a red toast.
async function safely(action) {
  try {
    await action();
  } catch (err) {
    if (err.message !== 'Not logged in') toast(err.message, 'error');
  }
}

// Fills the "user chip" in the top bar and wires up the Log out button.
function setupUserBar(role, name) {
  const chip = $('user-name');
  if (chip) chip.textContent = name;
  const btn = $('logout-btn');
  if (btn) btn.addEventListener('click', () => logout(role));
}

// ---------- Sidebar pages ----------
// Each sidebar link is its own page: an element with data-view="name", shown at
// URL #name (so Back, refresh and bookmarks work). views = { name: { title, desc } }.
// onChange(name) runs after a page is shown.
function setupViews(views, defaultView, onChange) {
  function show() {
    const wanted = location.hash.slice(1);
    const name = views[wanted] ? wanted : defaultView;
    for (const section of document.querySelectorAll('[data-view]')) section.classList.toggle('hidden', section.dataset.view !== name);
    for (const link of document.querySelectorAll('.nav-item[data-nav]')) {
      const active = link.dataset.nav === name;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const view = views[name];
    const crumb = $('section-context');
    if (crumb) crumb.textContent = view.crumb || view.title;
    if ($('page-title') && view.title) $('page-title').textContent = view.title;
    if ($('page-desc') && view.desc !== undefined) $('page-desc').textContent = view.desc;
    window.scrollTo(0, 0);
    if (onChange) onChange(name);
  }
  window.addEventListener('hashchange', show);
  show();
  return (name) => {
    if (location.hash === `#${name}`) show();
    else location.hash = name;
  };
}

// Judge and Team pages: the account menu in the top bar and the avatar initials.
// (The sidebar pages themselves are handled by setupViews.)
function setupShell(name) {
  const avatar = $('avatar');
  if (avatar) avatar.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  const account = $('account');
  const menu = $('account-menu');
  if (account && menu && !account.dataset.ready) {
    account.dataset.ready = '1';
    account.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = menu.classList.contains('hidden');
      menu.classList.toggle('hidden', !opening);
      account.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', () => {
      menu.classList.add('hidden');
      account.setAttribute('aria-expanded', 'false');
    });
  }
}

// Badge element for an event status or sentiment label.
function badge(text, kind) {
  return el('span', text, `badge ${kind || text}`);
}

// Reads the data inside a login token (a JWT is three base64 parts: header.payload.signature).
// Only used to show things like "demo mode" - the SERVER still checks every request.
function tokenPayload(role) {
  const token = auth.get(role);
  if (!token) return {};
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

// Read-only star display: value from 0 to 5 (halves allowed), e.g. stars(3.5).
function stars(value) {
  const wrap = el('span', null, 'stars');
  wrap.setAttribute('aria-label', `${value} out of 5 stars`);
  for (let i = 1; i <= 5; i++) {
    const kind = value >= i ? 'full' : value >= i - 0.5 ? 'half' : 'off';
    wrap.append(el('span', '★', `star ${kind}`));
  }
  return wrap;
}

// A score out of 10 shown as stars out of 5 (rounded to the nearest half star).
function starsFromScore(scoreOutOf10) {
  return stars(Math.round(scoreOutOf10) / 2);
}

// ---------- Navbar search (public pages) ----------
// The round search button opens a small box that filters the public events
// (GET /api/leaderboard/events) and links to each event's leaderboard.
function setupSearch() {
  const btn = $('search-btn');
  if (!btn) return;
  const pop = $('search-pop');
  const input = $('search-input');
  let events = null; // loaded once, the first time the box opens

  function render() {
    const query = input.value.trim().toLowerCase();
    const matches = (events || []).filter((e) => e.name.toLowerCase().includes(query));
    const box = $('search-results');
    box.replaceChildren();
    if (matches.length === 0) box.append(el('div', events ? 'No matching events' : 'Loading...', 'search-empty'));
    for (const event of matches.slice(0, 8)) {
      const link = el('a', null, 'search-item');
      link.href = `leaderboard.html?event=${event._id}`;
      link.append(el('span', event.name), badge(event.status));
      box.append(link);
    }
  }

  function close() {
    pop.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const opening = pop.classList.contains('hidden');
    if (!opening) return close();
    pop.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    input.value = '';
    input.focus();
    render();
    if (!events) {
      events = await api('GET', '/api/leaderboard/events').catch(() => []);
      render();
    }
  });
  input.addEventListener('input', render);
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}
setupSearch();

// ---------- Light / dark mode ----------
// The <head> of every page already applied the saved theme before drawing.
// This button flips it and remembers the choice in localStorage.
function setupThemeToggle() {
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme !== 'dark';
      if (dark) document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
      try {
        localStorage.setItem('theme', dark ? 'dark' : 'light');
      } catch {
        /* storage blocked - the theme just won't be remembered */
      }
    });
  }
}
setupThemeToggle();
