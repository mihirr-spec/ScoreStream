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

// Uploads a file as the raw request body (used for team slides).
// Uses XMLHttpRequest rather than fetch because only XHR reports upload progress:
// onProgress(percent) is called as the file is sent, so slow uploads don't look stuck.
function uploadFile(path, file, role, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    xhr.setRequestHeader('Authorization', `Bearer ${auth.get(role)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (e) => {
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 401) logout(role);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'Upload failed'));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed - check your connection and try again')));
    xhr.send(file);
  });
}

// Fetches a protected file (it needs the login token, so a plain link won't do).
async function fetchFile(path, role) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${auth.get(role)}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) logout(role);
    throw new Error(data.error || 'Could not open the file');
  }
  return res.blob();
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// SheetJS reads and writes .xlsx/.xls/.csv in the browser. It is only downloaded
// the first time it is needed (Excel import/export, or viewing a spreadsheet).
let sheetJs = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJs) {
    sheetJs = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => {
        sheetJs = null;
        reject(new Error('Could not load the Excel library. Check your internet connection.'));
      };
      document.head.append(script);
    });
  }
  return sheetJs;
}

// ---------- In-page file viewer ----------
// openViewer({ path, role, filename, size, title }) shows an uploaded file over the page:
//   PDF            -> the browser's own PDF viewer
//   PNG / JPG      -> the image
//   Excel / CSV    -> SheetJS turns each sheet into a table (one tab per sheet)
//   PowerPoint/Word-> Microsoft's Office viewer (browsers can't draw these themselves).
//                     It fetches the file through a 15-minute view link from the server.
const OFFICE_TYPES = ['ppt', 'pptx', 'doc', 'docx'];
const SHEET_TYPES = ['xls', 'xlsx', 'csv'];
const IMAGE_TYPES = ['png', 'jpg', 'jpeg'];

function openViewer({ path, role, filename, size, title }) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const urls = []; // object URLs to free when the viewer closes
  let blobPromise = null;
  const getBlob = () => (blobPromise ||= fetchFile(path, role));

  const backdrop = el('div', null, 'viewer-backdrop');
  const box = el('div', null, 'viewer');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', `Preview of ${filename}`);

  const head = el('div', null, 'viewer-head');
  const name = el('div', null, 'viewer-name');
  name.append(el('strong', title || filename), el('span', `${filename}${size ? `  ·  ${fileSize(size)}` : ''}`));
  const actions = el('div', null, 'action-row');
  const download = el('button', 'Download', 'secondary');
  download.type = 'button';
  download.addEventListener('click', () => safely(async () => saveBlob(await getBlob(), filename)));
  const close = el('button', '✕', 'icon-button viewer-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close preview');
  actions.append(download, close);
  head.append(name, actions);

  const body = el('div', null, 'viewer-body');
  body.append(el('p', 'Loading preview...', 'viewer-msg'));
  box.append(head, body);
  backdrop.append(box);
  document.body.append(backdrop);
  document.body.classList.add('no-scroll');
  close.focus();

  function shut() {
    backdrop.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
  function onKey(e) {
    if (e.key === 'Escape') shut();
  }
  close.addEventListener('click', shut);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) shut();
  });
  document.addEventListener('keydown', onKey);

  const frame = (src) => {
    const iframe = el('iframe', null, 'viewer-frame');
    iframe.title = filename;
    iframe.src = src;
    return iframe;
  };
  const message = (text) => {
    const p = el('div', null, 'viewer-msg');
    p.append(el('p', text));
    const again = el('button', 'Download instead', 'primary');
    again.type = 'button';
    again.addEventListener('click', () => download.click());
    p.append(again);
    return p;
  };

  (async () => {
    if (ext === 'pdf' || IMAGE_TYPES.includes(ext)) {
      const url = URL.createObjectURL(await getBlob());
      urls.push(url);
      if (ext === 'pdf') body.replaceChildren(frame(url));
      else {
        const img = el('img', null, 'viewer-image');
        img.src = url;
        img.alt = filename;
        body.replaceChildren(img);
      }
    } else if (SHEET_TYPES.includes(ext)) {
      const [XLSX, blob] = await Promise.all([loadSheetJs(), getBlob()]);
      const book = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
      const tabs = el('div', null, 'viewer-tabs');
      // The table goes in a sandboxed iframe: file contents can never run as page code.
      const sheet = el('iframe', null, 'viewer-frame');
      sheet.title = filename;
      sheet.setAttribute('sandbox', '');
      const show = (sheetName) => {
        for (const t of tabs.children) t.classList.toggle('active', t.textContent === sheetName);
        const style =
          '<style>body{font:13px system-ui,sans-serif;margin:0;padding:12px;color:#102a43}table{border-collapse:collapse}' +
          'td{border:1px solid #d6e2ed;padding:5px 9px;white-space:nowrap}tr:first-child td{background:#eaf3ff;font-weight:700}</style>';
        sheet.srcdoc = style + XLSX.utils.sheet_to_html(book.Sheets[sheetName], { header: '', footer: '' });
      };
      for (const sheetName of book.SheetNames) {
        const tab = el('button', sheetName, 'tab');
        tab.type = 'button';
        tab.addEventListener('click', () => show(sheetName));
        tabs.append(tab);
      }
      body.replaceChildren(...(book.SheetNames.length > 1 ? [tabs] : []), sheet);
      show(book.SheetNames[0]);
    } else if (OFFICE_TYPES.includes(ext)) {
      // Microsoft's servers must download the file, so this can't work on localhost.
      if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
        body.replaceChildren(message('PowerPoint and Word previews use Microsoft’s Office viewer, which can only open files from the deployed site, not from localhost.'));
        return;
      }
      const { url } = await api('GET', `${path}/link`, undefined, role);
      body.replaceChildren(frame(`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`));
      body.append(el('p', 'Preview by Microsoft Office Online. If it stays blank, use Download.', 'viewer-note'));
    } else {
      body.replaceChildren(message('This file type cannot be previewed.'));
    }
  })().catch((err) => body.replaceChildren(message(err.message || 'Could not open the file')));
}

// "2400000" -> "2.3 MB"
function fileSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
// Only used to show things like the username - the SERVER still checks every request.
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
