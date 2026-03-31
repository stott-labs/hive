/* ==========================================================================
   Dev Dashboard — Client (GridStack version)
   ========================================================================== */

const socket = io();

// ---------------------------------------------------------------------------
// User preferences — per-user visibility settings
// Stored server-side in ~/.montra/dashboard-user-prefs.json so they survive
// browser clears and work across profiles. Never written to dashboard.config.json.
// ---------------------------------------------------------------------------
let _userPrefs = { hiddenRepos: [], hiddenServices: [] };

async function loadUserPrefs() {
  try {
    const res = await fetch('/api/user-prefs');
    if (res.ok) {
      const data = await res.json();
      _userPrefs = { hiddenRepos: [], hiddenServices: [], ...data };
    }
  } catch { /* use defaults */ }
}

function getHiddenRepos()    { return new Set(_userPrefs.hiddenRepos    || []); }
function getHiddenServices() { return new Set(_userPrefs.hiddenServices || []); }

async function _saveUserPrefs() {
  await fetch('/api/user-prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_userPrefs),
  });
}

async function toggleHiddenRepo(name) {
  const s = getHiddenRepos();
  if (s.has(name)) s.delete(name); else s.add(name);
  _userPrefs.hiddenRepos = [...s];
  await _saveUserPrefs();
}

async function toggleHiddenService(key) {
  const s = getHiddenServices();
  if (s.has(key)) s.delete(key); else s.add(key);
  _userPrefs.hiddenServices = [...s];
  await _saveUserPrefs();
}

// ---------------------------------------------------------------------------
// Global toast notifications
// ---------------------------------------------------------------------------
function showToast(message, type = 'info', duration = 6000) {
  let container = document.getElementById('global-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'global-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `global-toast global-toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
window.showToast = showToast;

// ---------------------------------------------------------------------------
// Load config from server — populates title, bookmarks, ADO users, etc.
// ---------------------------------------------------------------------------
let DASH_CONFIG = {};
window.DASH_CONFIG = DASH_CONFIG;

async function loadDashConfig() {
  try {
    const res = await fetch('/api/config');
    DASH_CONFIG = await res.json();
    window.DASH_CONFIG = DASH_CONFIG;
    // Update page title and header
    if (DASH_CONFIG.title) {
      document.title = DASH_CONFIG.title;
      const titleEl = document.getElementById('dashboard-title');
      if (titleEl) titleEl.textContent = DASH_CONFIG.title;
    }
    // Populate bookmarks and quick actions from config
    const menu = document.getElementById('bookmarks-menu');
    if (menu) {
      menu.innerHTML = '';
      if (DASH_CONFIG.bookmarks?.length) {
        for (const bm of DASH_CONFIG.bookmarks) {
          const btn = document.createElement('button');
          btn.className = 'bookmarks-item';
          btn.dataset.quickUrl = bm.url;
          btn.textContent = bm.label;
          menu.appendChild(btn);
        }
      }
      if (DASH_CONFIG.quickActions && Object.keys(DASH_CONFIG.quickActions).length) {
        const divider = document.createElement('div');
        divider.className = 'bookmarks-divider';
        menu.appendChild(divider);
        for (const [key, action] of Object.entries(DASH_CONFIG.quickActions)) {
          const btn = document.createElement('button');
          btn.className = 'bookmarks-item';
          btn.dataset.quickAction = key;
          btn.title = key;
          btn.textContent = key.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          menu.appendChild(btn);
        }
      }
    }
  } catch { /* config endpoint unavailable — use defaults */ }
}
loadDashConfig().catch(() => {});

// When the dashboard server restarts, Socket.IO auto-reconnects.
// Force a page reload so the browser doesn't run with stale state.
let _socketConnectedOnce = false;
socket.on('connect', () => {
  if (_socketConnectedOnce) {
    console.log('[dashboard] Server reconnected — reloading page');
    location.reload();
  }
  _socketConnectedOnce = true;
});

const ansi = new AnsiUp();
ansi.use_classes = false;

// DOM refs
const clockEl = document.getElementById('clock');

// ---------------------------------------------------------------------------
// Dynamic service tracking (populated after /api/services loads)
// Exposed globally so widgets.js service widgets can use them
// ---------------------------------------------------------------------------
const logContainers = {};
const statusDots = {};
const statusLabels = {};
const autoscrollFlags = {};   // true = pinned to bottom (default)
const pendingLogs = {};

window.logContainers = logContainers;
window.statusDots = statusDots;
window.statusLabels = statusLabels;
window.autoscrollFlags = autoscrollFlags;
window.pendingLogs = pendingLogs;

const MAX_LOG_LINES = 2000;
let serviceKeys = [];
window.serviceKeys = serviceKeys;

// ---------------------------------------------------------------------------
// Alarm system (Web Audio API) — global, used by external-services widget
// ---------------------------------------------------------------------------
let audioCtx = null;
let audioUnlocked = false;
let alarmOsc = null;
let alarmGain = null;
let alarmLfo = null;
let latestMonitors = [];
const MUTED_SERVICES_KEY = 'dashboard-muted-services';
const mutedServices = new Set(JSON.parse(localStorage.getItem(MUTED_SERVICES_KEY) || '[]'));
const downSince = {};           // key → timestamp of first consecutive failure
const ALARM_DELAY_MS = 3 * 60 * 1000; // 3 minutes before alarm sounds
const ALARM_ENABLED_KEY = 'dashboard-alarm-enabled';
let alarmEnabled = localStorage.getItem(ALARM_ENABLED_KEY) !== 'false'; // default on

function saveMutedServices() {
  localStorage.setItem(MUTED_SERVICES_KEY, JSON.stringify([...mutedServices]));
}

window.mutedServices = mutedServices;
window.getAlarmEnabled = () => alarmEnabled;
window.setAlarmEnabled = (val) => {
  alarmEnabled = val;
  localStorage.setItem(ALARM_ENABLED_KEY, val ? 'true' : 'false');
  if (!val) stopAlarm();
  else evaluateAlarm(latestMonitors);
};

function unlockAudio() {
  if (audioUnlocked) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioUnlocked = true;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => evaluateAlarm(latestMonitors));
  } else {
    evaluateAlarm(latestMonitors);
  }
}

document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

function startAlarm() {
  if (alarmOsc || !audioUnlocked) return;
  if (audioCtx.state === 'suspended') return;

  alarmOsc = audioCtx.createOscillator();
  alarmOsc.type = 'square';
  alarmOsc.frequency.value = 880;

  alarmLfo = audioCtx.createOscillator();
  alarmLfo.type = 'sine';
  alarmLfo.frequency.value = 3;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 300;
  alarmLfo.connect(lfoGain);
  lfoGain.connect(alarmOsc.frequency);

  alarmGain = audioCtx.createGain();
  alarmGain.gain.value = 0.25;
  alarmOsc.connect(alarmGain);
  alarmGain.connect(audioCtx.destination);

  alarmOsc.start();
  alarmLfo.start();
}

function stopAlarm() {
  if (!alarmOsc) return;
  alarmOsc.stop();
  alarmLfo.stop();
  alarmOsc.disconnect();
  alarmLfo.disconnect();
  alarmGain.disconnect();
  alarmOsc = null;
  alarmLfo = null;
  alarmGain = null;
}

function evaluateAlarm(monitors) {
  latestMonitors = monitors;
  const now = Date.now();
  for (const m of monitors) {
    if (m.status === 'down' || m.status === 'unreachable') {
      if (!downSince[m.key]) downSince[m.key] = now;
    } else {
      delete downSince[m.key];
    }
  }
  const confirmedDown = alarmEnabled && monitors.some(
    (m) => (m.status === 'down' || m.status === 'unreachable') && m.alarm !== false && downSince[m.key] && (now - downSince[m.key]) >= ALARM_DELAY_MS && !mutedServices.has(m.key),
  );
  if (confirmedDown) startAlarm();
  else stopAlarm();
}

// Expose for external-services widget
window.evaluateAlarm = evaluateAlarm;

// ---------------------------------------------------------------------------
// Utility: HTML escape
// ---------------------------------------------------------------------------
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
window.esc = esc;

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
function updateClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
updateClock();
setInterval(updateClock, 1000);

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
let docsLoaded = false;
let swaggerLoaded = false;
let databaseLoaded = false;
let settingsLoaded = false;
let repoViewerLoaded = false;

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });

  // Clear deep-link hashes when leaving their respective tabs
  if (name !== 'docs' && location.hash.startsWith('#docs/')) {
    history.replaceState(null, '', location.pathname);
  }
  if (name !== 'repo' && location.hash.startsWith('#repo/')) {
    history.replaceState(null, '', location.pathname);
  }

  if (name === 'docs' && !docsLoaded) {
    docsLoaded = true;
    if (typeof initDocs === 'function') initDocs();
  }
  if (name === 'swagger' && !swaggerLoaded) {
    swaggerLoaded = true;
    if (typeof initSwagger === 'function') initSwagger();
  }
  if (name === 'database' && !databaseLoaded) {
    databaseLoaded = true;
    if (typeof initDatabase === 'function') initDatabase();
  }
  if (name === 'settings' && !settingsLoaded) {
    settingsLoaded = true;
    if (typeof initSettings === 'function') initSettings();
  }
  if (name === 'repo' && !repoViewerLoaded) {
    repoViewerLoaded = true;
    if (typeof initRepo === 'function') initRepo();
  }

  // Reveal & scroll to active item in sidebar tree when switching tabs
  revealActiveInTab(name);
}

function scrollToActive(selector, scrollContainerId, delay = 50) {
  setTimeout(() => {
    const el = document.querySelector(selector);
    const container = scrollContainerId ? document.getElementById(scrollContainerId) : null;
    if (!el) return;
    if (container) {
      // Manual scroll: position element in the center of the container
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      container.scrollTop += eRect.top - cRect.top - container.clientHeight / 2 + el.clientHeight / 2;
    } else {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, delay);
}

function revealActiveInTab(name) {
  if (name === 'repo') {
    if (typeof revealFileInTree === 'function' && typeof repoTabs !== 'undefined' && typeof activeRepoTab !== 'undefined') {
      const tab = repoTabs[activeRepoTab];
      if (tab) revealFileInTree(tab.path);
    }
  } else if (name === 'docs') {
    if (typeof expandTreeToPath === 'function' && typeof currentDocPath === 'function' && typeof renderTree === 'function') {
      const path = currentDocPath();
      if (path && typeof docsTree !== 'undefined' && docsTree.length) {
        expandTreeToPath(path);
        renderTree(docsTree);
        scrollToActive('#docs-tree .tree-item.active', 'docs-tree');
      }
    }
  } else if (name === 'swagger') {
    if (typeof revealActiveEndpointInTree === 'function') {
      revealActiveEndpointInTree();
    }
  } else if (name === 'database') {
    setTimeout(() => {
      if (typeof window.revealActiveScriptInTree === 'function') {
        window.revealActiveScriptInTree();
      }
    }, 50);
  }
}

// ---------------------------------------------------------------------------
// Hash-based deep linking  (#docs/path/to/file.md)
// ---------------------------------------------------------------------------
function applyHashRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  if (hash.startsWith('docs/')) {
    const docPath = decodeURIComponent(hash.substring(5));
    switchTab('docs');
    const tryLoad = () => {
      if (typeof loadDoc === 'function') loadDoc(docPath);
      else setTimeout(tryLoad, 100);
    };
    tryLoad();
  }
  if (hash.startsWith('repo/')) {
    // initRepo handles the hash route itself after the dropdown is populated.
    // Just switch to the tab — initRepo reads location.hash directly.
    switchTab('repo');
  }
}

window.addEventListener('hashchange', applyHashRoute);

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ---------------------------------------------------------------------------
// Log rendering with rAF batching (shared by service widgets)
// ---------------------------------------------------------------------------
let rafScheduled = false;

function scheduleFlush() {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(flushLogs);
}

let activeHighlightTimer = null;
let highlightLock = false;

function highlightCorrelatedApi(eventId) {
  clearHighlights();

  const clicked = document.querySelector(`.web-event[data-event-id="${eventId}"]`);
  if (clicked) clicked.classList.add('selected');

  const apiContainer = logContainers['api'];
  if (!apiContainer) return;

  const children = Array.from(apiContainer.children);
  let firstIdx = -1, lastIdx = -1;
  for (let i = 0; i < children.length; i++) {
    if (children[i].dataset.eventId === String(eventId)) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  if (firstIdx !== -1) {
    for (let i = firstIdx; i <= lastIdx; i++) {
      children[i].classList.add('correlated');
    }
  }

  const first = apiContainer.querySelector('.correlated');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });

  highlightLock = true;

  if (activeHighlightTimer) clearTimeout(activeHighlightTimer);
  activeHighlightTimer = setTimeout(() => clearHighlights(), 15000);
}

function clearHighlights() {
  document.querySelectorAll('.log-line.correlated').forEach(el => el.classList.remove('correlated'));
  document.querySelectorAll('.web-event.selected').forEach(el => el.classList.remove('selected'));
  highlightLock = false;
  if (activeHighlightTimer) { clearTimeout(activeHighlightTimer); activeHighlightTimer = null; }
}

function flushLogs() {
  rafScheduled = false;

  for (const key of serviceKeys) {
    const batch = pendingLogs[key];
    if (!batch || batch.length === 0) continue;

    const container = logContainers[key];
    if (!container) continue;
    const fragment = document.createDocumentFragment();

    for (const entry of batch) {
      const div = document.createElement('div');
      const isEvent = entry.stream === 'event';
      const isWebEvent = isEvent && (entry.eventType === 'route' || entry.eventType === 'dialog');
      const isApiCall = isEvent && entry.eventType === 'api-call';
      div.className = 'log-line'
        + (entry.stream === 'stderr' ? ' stderr' : '')
        + (isWebEvent ? ` web-event web-event-${entry.eventType}` : '')
        + (isApiCall ? ' api-call-event' : '');
      div.dataset.ts = String(entry.ts);
      if (entry.eventId) {
        div.dataset.eventId = String(entry.eventId);
      }

      const ts = new Date(entry.ts);
      const timeStr = ts.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });

      const tsSpan = `<span class="log-ts">${timeStr}</span>`;
      div.innerHTML = tsSpan + ansi.ansi_to_html(entry.text);

      if (isWebEvent && entry.eventId) {
        div.title = 'Click to highlight correlated API calls';
        div.addEventListener('click', () => highlightCorrelatedApi(entry.eventId));
      }

      fragment.appendChild(div);
    }

    container.appendChild(fragment);
    batch.length = 0;

    while (container.children.length > MAX_LOG_LINES) {
      container.removeChild(container.firstChild);
    }

    if (autoscrollFlags[key] && !(highlightLock && key === 'api')) {
      container.scrollTop = container.scrollHeight;
    }
  }
}

// ---------------------------------------------------------------------------
// GridStack Dashboard Initialization
// ---------------------------------------------------------------------------
const DEFAULT_LAYOUT = [
  { id: 'git-status', x: 0, y: 0, w: 6, h: 4 },
  { id: 'external-services', x: 6, y: 0, w: 4, h: 4 },
  { id: 'claude-usage', x: 10, y: 0, w: 2, h: 4 },
  { id: 'ado', x: 0, y: 4, w: 4, h: 6 },
  { id: 'sentry', x: 4, y: 4, w: 4, h: 6 },
  { id: 'releases', x: 8, y: 4, w: 4, h: 6 },
  { id: 'db-migrations', x: 0, y: 10, w: 4, h: 5 },
  { id: 'env-diff', x: 4, y: 10, w: 4, h: 4 },
  { id: 'cli-tools', x: 8, y: 10, w: 4, h: 5 },
  { id: 'github',         x: 0,  y: 15, w: 6, h: 6 },
  { id: 'commit-history', x: 6,  y: 15, w: 6, h: 7 },
  { id: 'contributions',  x: 0,  y: 21, w: 8, h: 4 },
  { id: 'claude-skills', x: 8,  y: 21, w: 4, h: 7 },
];

// ---------------------------------------------------------------------------
// Dashboard Templates
// ---------------------------------------------------------------------------
const DASHBOARD_TEMPLATES = {
  // ── Status ─────────────────────────────────────────────────────────────────
  // "Is everything healthy?" — services, pipelines, repos, errors, activity
  'Status': [
    { id: 'external-services', x: 0,  y: 0,  w: 8,  h: 4 },
    { id: 'pipelines',         x: 8,  y: 0,  w: 4,  h: 4 },
    { id: 'git-status',        x: 0,  y: 4,  w: 5,  h: 5 },
    { id: 'sentry',            x: 5,  y: 4,  w: 7,  h: 5 },
    { id: 'activity-feed',     x: 0,  y: 9,  w: 12, h: 6 },
  ],

  // ── Workflow ────────────────────────────────────────────────────────────────
  // "What am I working on today?" — sprint, PRs, activity, contributions
  'Workflow': [
    { id: 'ado',           x: 0,  y: 0,  w: 4,  h: 10 },
    { id: 'github',        x: 4,  y: 0,  w: 8,  h: 5  },
    { id: 'activity-feed', x: 4,  y: 5,  w: 8,  h: 5  },
    { id: 'contributions', x: 0,  y: 10, w: 8,  h: 4  },
    { id: 'releases',      x: 8,  y: 10, w: 4,  h: 4  },
  ],

  // ── Dev Tasks ───────────────────────────────────────────────────────────────
  // "Heads-down coding" — repos, commits, DB, env, errors, CLI
  'Dev Tasks': [
    { id: 'git-status',     x: 0,  y: 0,  w: 7,  h: 5 },
    { id: 'commit-history', x: 7,  y: 0,  w: 5,  h: 5 },
    { id: 'db-migrations',  x: 0,  y: 5,  w: 4,  h: 5 },
    { id: 'env-diff',       x: 4,  y: 5,  w: 4,  h: 5 },
    { id: 'sentry',         x: 8,  y: 5,  w: 4,  h: 5 },
    { id: 'contributions',  x: 0,  y: 10, w: 8,  h: 4 },
    { id: 'cli-tools',      x: 8,  y: 10, w: 4,  h: 4 },
  ],
};

let grid = null;
let gridLocked = false;
const activeWidgets = {};  // widgetId → { widget, element }

// ---------------------------------------------------------------------------
// Named Layout Manager
// ---------------------------------------------------------------------------
// Layouts are persisted server-side in data/layouts.json via /api/layouts.
// A local cache (localStorage) provides instant reads; writes are debounced
// and flushed to the server so layouts survive browser data clears.
// ---------------------------------------------------------------------------
const LAYOUT_STORAGE_KEY = 'dashboard-layouts';       // localStorage cache
const ACTIVE_LAYOUT_KEY = 'dashboard-active-layout';  // localStorage cache
const DEFAULT_LAYOUT_NAME = 'Default';

let currentLayoutName = DEFAULT_LAYOUT_NAME;
let suppressSave = false;  // true during bulk operations (init, layout switch)
let _layoutSaveTimer = null;
const LAYOUT_SAVE_DEBOUNCE_MS = 1000;

function getAllLayouts() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function putAllLayouts(layouts) {
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layouts));
  _scheduleServerSync();
}

function getActiveLayoutName() {
  return localStorage.getItem(ACTIVE_LAYOUT_KEY) || DEFAULT_LAYOUT_NAME;
}

function setActiveLayoutName(name) {
  currentLayoutName = name;
  localStorage.setItem(ACTIVE_LAYOUT_KEY, name);
  _scheduleServerSync();
}

// Debounced sync to server — batches rapid grid-change events
function _scheduleServerSync() {
  if (_layoutSaveTimer) clearTimeout(_layoutSaveTimer);
  _layoutSaveTimer = setTimeout(_flushLayoutsToServer, LAYOUT_SAVE_DEBOUNCE_MS);
}

function _flushLayoutsToServer() {
  _layoutSaveTimer = null;
  const layouts = getAllLayouts();
  const active = getActiveLayoutName();
  const tabOrder = _getLayoutTabOrderRaw();
  fetch('/api/layouts', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layouts, active, tabOrder }),
  }).catch(() => { /* offline — localStorage still has the data */ });
}

// Load layouts from server into localStorage (called once at init).
// If server has data, it wins. If server is empty but localStorage has
// layouts, push them to the server (one-time migration).
async function _loadLayoutsFromServer() {
  try {
    const res = await fetch('/api/layouts');
    if (!res.ok) return;
    const data = await res.json();
    if (data.layouts && Object.keys(data.layouts).length > 0) {
      // Server has data — use it
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(data.layouts));
      if (data.active) localStorage.setItem(ACTIVE_LAYOUT_KEY, data.active);
      if (data.tabOrder) localStorage.setItem(LAYOUT_TAB_ORDER_KEY, JSON.stringify(data.tabOrder));
    } else {
      // Server empty — migrate localStorage to server if present
      const local = getAllLayouts();
      if (Object.keys(local).length > 0) {
        _flushLayoutsToServer();
      }
    }
  } catch { /* server unreachable — use localStorage cache */ }
}

function initGridStack() {
  grid = GridStack.init({
    column: 12,
    cellHeight: 90,
    margin: 8,
    animate: true,
    handle: '.widget-header',
    float: false,
    removable: false,
    disableOneColumnMode: true,
  }, '#dashboard-grid');

  // Lock the widget's vertical position during resize so width changes
  // don't cause the widget to jump upward. GridStack's engine tries to
  // repack on width change — we capture the original y on start and
  // restore it on stop.
  let _resizeOrigY = null;
  let _resizeNode = null;
  grid.on('resizestart', (_event, el) => {
    grid.float(true);
    _resizeNode = el;
    _resizeOrigY = parseInt(el.getAttribute('gs-y'));
  });
  grid.on('resizestop', (_event, el) => {
    // Restore the original row if GridStack moved the widget
    const currentY = parseInt(el.getAttribute('gs-y'));
    if (_resizeOrigY !== null && currentY !== _resizeOrigY) {
      grid.update(el, { y: _resizeOrigY });
    }
    _resizeNode = null;
    _resizeOrigY = null;
    grid.float(false);
    saveLayout();
  });
  grid.on('dragstop', () => saveLayout());
}

function getCurrentSnapshot() {
  if (!grid) return { grid: [], tabs: [], removed: [] };
  const items = grid.getGridItems().map(el => ({
    id: el.getAttribute('gs-id'),
    x: parseInt(el.getAttribute('gs-x')),
    y: parseInt(el.getAttribute('gs-y')),
    w: parseInt(el.getAttribute('gs-w')),
    h: parseInt(el.getAttribute('gs-h')),
  }));
  // Read tab order from DOM so drag-reordered tabs persist correctly
  const tabs = Array.from(document.querySelectorAll('.tab-bar .widget-tab'))
    .map(btn => btn.dataset.tab.replace('widget-', ''))
    .filter(id => tabWidgets[id]);
  // Track which registered widgets are intentionally absent (user removed them)
  const activeSet = new Set([...items.map(i => i.id), ...tabs]);
  const removed = Object.keys(WIDGET_REGISTRY).filter(id => !activeSet.has(id));
  return { grid: items, tabs, removed };
}

function saveLayout() {
  if (!grid || suppressSave) return;
  const layouts = getAllLayouts();
  layouts[currentLayoutName] = getCurrentSnapshot();
  putAllLayouts(layouts);
}

function loadLayout() {
  const layouts = getAllLayouts();
  const data = layouts[currentLayoutName];
  if (data && data.grid) return data.grid;
  return null;
}

// ---------------------------------------------------------------------------
// Layout Tab Strip UI
// ---------------------------------------------------------------------------
function refreshLayoutSelect() { refreshLayoutTabs(); } // backward-compat alias

function refreshLayoutTabs() {
  const strip = document.getElementById('dashboard-tab-strip');
  if (!strip) return;

  const layouts = getAllLayouts();
  let names = Object.keys(layouts);
  if (!names.includes(DEFAULT_LAYOUT_NAME)) names.unshift(DEFAULT_LAYOUT_NAME);
  names = getLayoutTabOrder(names);

  strip.innerHTML = '';

  names.forEach((name, i) => {
    const tab = document.createElement('div');
    tab.className = 'dbtab' + (name === currentLayoutName ? ' active' : '');
    tab.dataset.name = name;

    const label = document.createElement('span');
    label.className = 'dbtab-label';
    label.textContent = name;
    label.addEventListener('dblclick', (e) => {
      if (name === DEFAULT_LAYOUT_NAME) return;
      e.stopPropagation();
      _startTabRename(tab, name);
    });
    tab.appendChild(label);

    if (name !== DEFAULT_LAYOUT_NAME) {
      const close = document.createElement('button');
      close.className = 'dbtab-close';
      close.textContent = '×';
      close.title = `Delete "${name}"`;
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete dashboard "${name}"?`)) return;
        const ls = getAllLayouts();
        delete ls[name];
        putAllLayouts(ls);
        const newOrder = names.filter(n => n !== name);
        saveLayoutTabOrder(newOrder);
        if (currentLayoutName === name) {
          switchToLayout(DEFAULT_LAYOUT_NAME);
        } else {
          refreshLayoutTabs();
        }
      });
      tab.appendChild(close);
    }

    tab.addEventListener('click', () => {
      if (name !== currentLayoutName) switchToLayout(name);
    });

    // Right-click context menu
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof showContextMenu !== 'function') return;
      const nonDefault = names.filter(n => n !== DEFAULT_LAYOUT_NAME);
      const deleteLayout = (n) => {
        const ls = getAllLayouts();
        delete ls[n];
        putAllLayouts(ls);
        const newOrder = names.filter(x => x !== n);
        saveLayoutTabOrder(newOrder);
        if (currentLayoutName === n) switchToLayout(DEFAULT_LAYOUT_NAME);
        else refreshLayoutTabs();
      };
      const items = [];
      if (name !== DEFAULT_LAYOUT_NAME) {
        items.push({ label: 'Rename', action: () => _startTabRename(tab, name) });
        items.push({ separator: true });
        items.push({ label: 'Delete', action: () => { if (confirm(`Delete dashboard "${name}"?`)) deleteLayout(name); }, danger: true });
      }
      const others = nonDefault.filter(n => n !== name);
      if (others.length) {
        items.push({ label: 'Delete Others', action: () => { if (confirm(`Delete ${others.length} other dashboard${others.length > 1 ? 's' : ''}?`)) others.forEach(deleteLayout); }, danger: true });
      }
      if (nonDefault.length) {
        items.push({ label: 'Delete All', action: () => { if (confirm(`Delete all custom dashboards?`)) nonDefault.forEach(deleteLayout); }, danger: true });
      }
      if (items.length) showContextMenu(e, items);
    });

    // Drag-and-drop reordering
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      _layoutTabDragSrc = i;
      tab.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tab.addEventListener('dragend', () => {
      strip.querySelectorAll('.dbtab').forEach(t => t.classList.remove('tab-dragging', 'tab-drag-over'));
    });
    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      strip.querySelectorAll('.dbtab').forEach(t => t.classList.remove('tab-drag-over'));
      if (i !== _layoutTabDragSrc) tab.classList.add('tab-drag-over');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('tab-drag-over'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      if (_layoutTabDragSrc === null || _layoutTabDragSrc === i) return;
      const moved = names.splice(_layoutTabDragSrc, 1)[0];
      names.splice(i, 0, moved);
      _layoutTabDragSrc = null;
      saveLayoutTabOrder(names);
      refreshLayoutTabs();
    });

    strip.appendChild(tab);
  });

  // + New dashboard button
  const addBtn = document.createElement('button');
  addBtn.className = 'dbtab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New blank dashboard';
  addBtn.addEventListener('click', () => {
    const ls = getAllLayouts();
    let n = 2;
    while (ls[`Dashboard ${n}`]) n++;
    const newName = `Dashboard ${n}`;
    // Save an empty grid so switchToLayout treats it as a blank canvas (not the built-in default)
    ls[newName] = { grid: [], tabs: [], removed: [] };
    putAllLayouts(ls);
    switchToLayout(newName);
  });
  strip.appendChild(addBtn);
}

function _startTabRename(tab, oldName) {
  const label = tab.querySelector('.dbtab-label');
  const input = document.createElement('input');
  input.className = 'dbtab-rename-input';
  input.value = oldName;
  tab.replaceChild(input, label);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    if (!newName || newName === oldName) { tab.replaceChild(label, input); return; }
    if (newName === DEFAULT_LAYOUT_NAME) {
      alert('Cannot rename to "Default".');
      tab.replaceChild(label, input);
      return;
    }
    const ls = getAllLayouts();
    if (ls[newName] && !confirm(`"${newName}" already exists. Overwrite?`)) {
      tab.replaceChild(label, input);
      return;
    }
    ls[newName] = ls[oldName];
    delete ls[oldName];
    putAllLayouts(ls);
    setActiveLayoutName(newName);
    refreshLayoutTabs();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { tab.replaceChild(label, input); }
  });
}

function clearCurrentDashboard() {
  // Destroy all grid widgets
  Object.keys(activeWidgets).forEach(id => {
    const entry = activeWidgets[id];
    if (entry.widget.destroy) entry.widget.destroy(socket);
    delete activeWidgets[id];
  });
  grid.removeAll();

  // Destroy all tab widgets
  Object.keys(tabWidgets).forEach(id => removeWidgetTab(id));
}

function switchToLayout(name) {
  suppressSave = true;
  clearCurrentDashboard();
  setActiveLayoutName(name);

  const layouts = getAllLayouts();
  const data = layouts[name];

  // Restore tabs first
  if (data && data.tabs) {
    for (const id of data.tabs) {
      if (WIDGET_REGISTRY[id]) moveWidgetToTab(id);
    }
  }

  // Restore grid
  const gridItems = data && data.grid ? data.grid : null;
  const removedSet = new Set(data && data.removed ? data.removed : []);

  if (data) {
    // Layout has been explicitly saved — respect it even if the grid is empty
    if (gridItems && gridItems.length > 0) {
      applyLayout(gridItems);
      // Auto-add genuinely new widgets (not in saved grid, tabs, OR removed list)
      for (const id of Object.keys(WIDGET_REGISTRY)) {
        if (!gridItems.find(s => s.id === id) && !tabWidgets[id] && !activeWidgets[id] && !removedSet.has(id)) {
          const defaultItem = getFullDefault().find(d => d.id === id);
          if (defaultItem) addWidgetToGrid(id, defaultItem);
        }
      }
    }
    // else: saved with empty grid → blank canvas, nothing to add
  } else {
    // Never been saved → load the built-in default
    const gridDefault = getFullDefault().filter(item => !tabWidgets[item.id]);
    applyLayout(gridDefault);
  }

  suppressSave = false;
  updateWidgetPicker();
  refreshLayoutSelect();
  switchTab('dashboard');
}

// Save — overwrite current layout
document.getElementById('layout-save-btn')?.addEventListener('click', () => {
  saveLayout();
  const btn = document.getElementById('layout-save-btn');
  btn.textContent = 'Saved!';
  setTimeout(() => { btn.textContent = 'Save'; }, 1500);
});

// Templates dropdown
function applyTemplateGrid(gridItems) {
  suppressSave = true;
  clearCurrentDashboard();
  applyLayout(gridItems);
  suppressSave = false;
  updateWidgetPicker();
  saveLayout();
}

function buildTemplateItem(name, gridItems, canDelete) {
  const row = document.createElement('div');
  row.className = 'template-item';

  const label = document.createElement('span');
  label.textContent = name;
  label.style.flex = '1';
  row.appendChild(label);

  if (canDelete) {
    const del = document.createElement('button');
    del.className = 'template-item-del';
    del.textContent = '×';
    del.title = `Delete template "${name}"`;
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete template "${name}"?`)) return;
      await fetch(`/api/templates/${encodeURIComponent(name)}`, { method: 'DELETE' });
      refreshTemplateDropdown();
    });
    row.appendChild(del);
  }

  row.addEventListener('click', () => {
    if (!confirm(`Apply "${name}" template? This will replace the current dashboard layout.`)) return;
    document.getElementById('template-dropdown').style.display = 'none';
    applyTemplateGrid(gridItems);
  });

  return row;
}

async function refreshTemplateDropdown() {
  const dropdown = document.getElementById('template-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = '';

  // Built-in templates
  const builtinHeader = document.createElement('div');
  builtinHeader.className = 'template-section-label';
  builtinHeader.textContent = 'Built-in';
  dropdown.appendChild(builtinHeader);

  for (const [name, gridItems] of Object.entries(DASHBOARD_TEMPLATES)) {
    dropdown.appendChild(buildTemplateItem(name, gridItems, false));
  }

  // User templates
  try {
    const userTemplates = await fetch('/api/templates').then(r => r.json());
    const names = Object.keys(userTemplates);
    if (names.length > 0) {
      const userHeader = document.createElement('div');
      userHeader.className = 'template-section-label';
      userHeader.textContent = 'Saved';
      dropdown.appendChild(userHeader);
      for (const name of names) {
        dropdown.appendChild(buildTemplateItem(name, userTemplates[name].grid, true));
      }
    }
  } catch { /* server may not be ready */ }
}

(function wireTemplates() {
  const btn = document.getElementById('template-btn');
  const dropdown = document.getElementById('template-dropdown');
  const saveBtn = document.getElementById('template-save-btn');
  if (!btn || !dropdown) return;

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (dropdown.style.display !== 'none') { dropdown.style.display = 'none'; return; }
    await refreshTemplateDropdown();
    dropdown.style.display = 'block';
  });
  document.addEventListener('click', () => { if (dropdown) dropdown.style.display = 'none'; });

  saveBtn?.addEventListener('click', async () => {
    const name = prompt('Save current layout as template:', currentLayoutName);
    if (!name || !name.trim()) return;
    const trimmed = name.trim();

    // Collect current grid layout from GridStack
    const currentGrid = grid.save(false).map(item => ({
      id: item.id,
      x: item.x, y: item.y, w: item.w, h: item.h,
    }));

    const res = await fetch(`/api/templates/${encodeURIComponent(trimmed)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grid: currentGrid }),
    });

    if (res.ok) {
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save as Template\u2026'; }, 1500);
    } else {
      alert('Failed to save template.');
    }
  });
})();

function addWidgetToGrid(widgetId, layoutItem) {
  const reg = WIDGET_REGISTRY[widgetId];
  if (!reg || activeWidgets[widgetId]) return;

  const chromeHTML = `
    <div class="widget-chrome">
      <div class="widget-header">
        <span class="widget-drag-handle">\u2630</span>
        <span class="widget-title">${reg.title}</span>
        <div class="widget-controls">
          ${reg.settingsKey ? `<button class="widget-btn widget-settings" title="Settings" data-settings-key="${reg.settingsKey}">\u2699</button>` : ''}
          <button class="widget-btn widget-refresh" title="Refresh">\u21BB</button>
          <button class="widget-btn widget-popout" title="Pop Out">\u29C9</button>
          <button class="widget-btn widget-to-tab" title="Move to Tab">\u21E5</button>
          <button class="widget-btn widget-close" title="Remove">\u2715</button>
        </div>
      </div>
      <div class="widget-body"></div>
    </div>
  `;

  const opts = {
    id: widgetId,
    x: layoutItem ? layoutItem.x : 0,
    y: layoutItem ? layoutItem.y : 100,  // push to bottom if no position
    w: layoutItem ? layoutItem.w : (reg.defaultSize?.w || 4),
    h: layoutItem ? layoutItem.h : (reg.defaultSize?.h || 4),
    minW: reg.minW || 2,
    minH: reg.minH || 2,
    content: chromeHTML,
  };

  const gsWidget = grid.addWidget(opts);
  const chrome = gsWidget.querySelector('.widget-chrome');

  const body = chrome.querySelector('.widget-body');
  reg.init(body, socket, {});

  // Wire chrome buttons
  chrome.querySelector('.widget-refresh').addEventListener('click', () => {
    if (reg.refresh) reg.refresh(socket);
  });

  chrome.querySelector('.widget-popout').addEventListener('click', () => {
    const width = 800;
    const height = 600;
    const left = (screen.width / 2) - (width / 2);
    const top = (screen.height / 2) - (height / 2);
    window.open(
      `/popout.html?widget=${encodeURIComponent(widgetId)}`,
      `popout-${widgetId}`,
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );
  });

  chrome.querySelector('.widget-to-tab').addEventListener('click', () => {
    moveWidgetToTab(widgetId);
  });

  chrome.querySelector('.widget-close').addEventListener('click', () => {
    removeWidgetFromGrid(widgetId);
  });

  const settingsBtn = chrome.querySelector('.widget-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      switchTab('settings');
      setTimeout(() => {
        const section = document.querySelector(`.settings-section-body[data-section="${settingsBtn.dataset.settingsKey}"]`);
        if (section) {
          const details = section.closest('details');
          if (details) details.open = true;
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
    });
  }

  activeWidgets[widgetId] = { widget: reg, element: gsWidget };
  updateWidgetPicker();
}

function removeWidgetFromGrid(widgetId) {
  const entry = activeWidgets[widgetId];
  if (!entry) return;

  const reg = entry.widget;
  if (reg.destroy) reg.destroy(socket);

  grid.removeWidget(entry.element);
  delete activeWidgets[widgetId];
  saveLayout();
  updateWidgetPicker();
}

// ---------------------------------------------------------------------------
// Widget Picker
// ---------------------------------------------------------------------------
function updateWidgetPicker() {
  const dropdown = document.getElementById('widget-picker-dropdown');
  if (!dropdown) return;

  const available = Object.keys(WIDGET_REGISTRY).filter(id => !activeWidgets[id]);
  const builtinIds = available.filter(id => !id.startsWith('metric-'));
  const metricIds  = available.filter(id => id.startsWith('metric-'));

  let html = '';

  if (builtinIds.length === 0 && metricIds.length === 0) {
    html = '<div class="widget-picker-item disabled">All widgets active</div>';
  } else {
    if (builtinIds.length) {
      html += builtinIds.map(id => {
        const reg = WIDGET_REGISTRY[id];
        return `<div class="widget-picker-item" data-widget-id="${id}">${reg.icon || ''} ${reg.title}</div>`;
      }).join('');
    }
    // Custom Metrics section
    html += '<div class="widget-picker-divider"></div>';
    html += '<div class="widget-picker-group-label">Custom Metrics</div>';
    if (metricIds.length) {
      html += metricIds.map(id => {
        const reg = WIDGET_REGISTRY[id];
        return `<div class="widget-picker-item" data-widget-id="${id}">${reg.icon || '📊'} ${reg.title}</div>`;
      }).join('');
    }
    html += `<div class="widget-picker-item widget-picker-new-metric" id="widget-picker-new-metric">➕ New Metric…</div>`;
  }

  dropdown.innerHTML = html;

  dropdown.querySelectorAll('.widget-picker-item[data-widget-id]').forEach(item => {
    item.addEventListener('click', () => {
      addWidgetToGrid(item.dataset.widgetId, null);
      saveLayout();
      dropdown.classList.remove('open');
    });
  });

  dropdown.querySelector('#widget-picker-new-metric')?.addEventListener('click', () => {
    dropdown.classList.remove('open');
    openMetricCreator(null);
  });
}

// Add Widget button toggle
document.getElementById('add-widget-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('widget-picker-dropdown');
  dropdown.classList.toggle('open');
});

document.addEventListener('click', () => {
  document.getElementById('widget-picker-dropdown')?.classList.remove('open');
});

// Lock/Unlock toggle
document.getElementById('lock-layout-btn')?.addEventListener('click', () => {
  gridLocked = !gridLocked;
  const btn = document.getElementById('lock-layout-btn');
  if (gridLocked) {
    grid.enableMove(false);
    grid.enableResize(false);
    btn.innerHTML = '&#128274; Locked';
    btn.classList.add('locked');
  } else {
    grid.enableMove(true);
    grid.enableResize(true);
    btn.innerHTML = '&#128275; Unlocked';
    btn.classList.remove('locked');
  }
});

function applyLayout(layoutItems) {
  for (const item of layoutItems) {
    if (WIDGET_REGISTRY[item.id]) {
      addWidgetToGrid(item.id, item);
    }
  }
}

// ---------------------------------------------------------------------------
// Load dynamic services and register them as widgets
// ---------------------------------------------------------------------------
async function initServices() {
  try {
    const res = await fetch('/api/services');
    const defs = await res.json();
    serviceKeys = Object.keys(defs);
    window.serviceKeys = serviceKeys;

    for (const key of serviceKeys) {
      pendingLogs[key] = [];
      registerServiceWidget(key, defs[key]);
    }
  } catch (err) {
    console.error('Failed to load services:', err);
    serviceKeys = [];
    window.serviceKeys = serviceKeys;
  }
}

// ---------------------------------------------------------------------------
// Tab Widgets — move any widget from the grid into its own tab
// ---------------------------------------------------------------------------
const tabWidgets = {};  // widgetId → { widget, tabBtn, tabPane }

function moveWidgetToTab(widgetId) {
  const reg = WIDGET_REGISTRY[widgetId];
  if (!reg || tabWidgets[widgetId]) return;

  // Create tab button with close ×
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab widget-tab';
  tabBtn.dataset.tab = 'widget-' + widgetId;
  tabBtn.draggable = true;
  tabBtn.innerHTML = `${esc(reg.title)}<span class="tab-close" title="Close tab">\u00D7</span>`;

  tabBtn.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) {
      e.stopPropagation();
      removeWidgetTab(widgetId);
      return;
    }
    switchTab('widget-' + widgetId);
  });

  const tabBar = document.querySelector('.tab-bar');
  const settingsTab = tabBar.querySelector('.tab-settings');
  tabBar.insertBefore(tabBtn, settingsTab || null);

  // Create tab pane
  const tabPane = document.createElement('div');
  tabPane.className = 'tab-pane';
  tabPane.id = 'tab-widget-' + widgetId;

  const body = document.createElement('div');
  body.className = 'widget-tab-body';
  tabPane.appendChild(body);

  // Insert before the first <script> tag
  const firstScript = document.querySelector('script');
  document.body.insertBefore(tabPane, firstScript);

  // Init widget in the tab body
  reg.init(body, socket, {});

  tabWidgets[widgetId] = { widget: reg, tabBtn, tabPane };

  saveTabWidgets();
  updateWidgetPicker();
  switchTab('widget-' + widgetId);
}

function moveWidgetToDashboard(widgetId) {
  const entry = tabWidgets[widgetId];
  if (!entry) return;

  // Destroy widget in tab
  if (entry.widget.destroy) entry.widget.destroy(socket);
  entry.tabBtn.remove();
  entry.tabPane.remove();
  delete tabWidgets[widgetId];

  saveTabWidgets();

  // Add back to grid at bottom
  addWidgetToGrid(widgetId, null);
  saveLayout();

  switchTab('dashboard');
}

function removeWidgetTab(widgetId) {
  const entry = tabWidgets[widgetId];
  if (!entry) return;

  // If this tab is active, switch to dashboard first
  if (entry.tabPane.classList.contains('active')) {
    switchTab('dashboard');
  }

  if (entry.widget.destroy) entry.widget.destroy(socket);
  entry.tabBtn.remove();
  entry.tabPane.remove();
  delete tabWidgets[widgetId];

  saveTabWidgets();
  updateWidgetPicker();
}

function saveTabWidgets() {
  // Tab state is saved as part of the named layout
  saveLayout();
}

// ---------------------------------------------------------------------------
// Tab order persistence
// ---------------------------------------------------------------------------
const TAB_ORDER_KEY = 'dashboard-tab-order-v2';
const LAYOUT_TAB_ORDER_KEY = 'dashboard-layout-tab-order';
let _layoutTabDragSrc = null;

function getLayoutTabOrder(names) {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_TAB_ORDER_KEY));
    if (Array.isArray(saved)) {
      // merge: saved order first, then any new names not yet in saved
      const known = new Set(saved);
      return [...saved.filter(n => names.includes(n)), ...names.filter(n => !known.has(n))];
    }
  } catch { /* ignore */ }
  return names;
}

function _getLayoutTabOrderRaw() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_TAB_ORDER_KEY)) || [];
  } catch { return []; }
}

function saveLayoutTabOrder(names) {
  localStorage.setItem(LAYOUT_TAB_ORDER_KEY, JSON.stringify(names));
  _scheduleServerSync();
}

function saveTabOrder() {
  const tabBar = document.querySelector('.tab-bar');
  const order = Array.from(tabBar.querySelectorAll('.tab:not(.tab-settings)')).map(t => t.dataset.tab);
  localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
}

function restoreTabOrder() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY)); } catch { return; }
  if (!Array.isArray(saved)) return;
  const tabBar = document.querySelector('.tab-bar');
  const settingsTab = tabBar.querySelector('.tab-settings');
  for (const name of saved) {
    const tab = tabBar.querySelector(`.tab[data-tab="${name}"]`);
    if (tab) tabBar.insertBefore(tab, settingsTab || null);
  }
}

// ---------------------------------------------------------------------------
// Tab drag-and-drop reordering
// ---------------------------------------------------------------------------
function initTabDragDrop() {
  const tabBar = document.querySelector('.tab-bar');
  let dragSrc = null;

  tabBar.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.tab:not(.tab-settings)');
    if (!tab) return;
    dragSrc = tab;
    tab.classList.add('tab-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  tabBar.addEventListener('dragend', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab-dragging', 'tab-drag-over'));
    dragSrc = null;
  });

  tabBar.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.tab');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab-drag-over'));
    if (target && target !== dragSrc && !target.classList.contains('tab-settings')) {
      target.classList.add('tab-drag-over');
    }
  });

  tabBar.addEventListener('dragleave', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) tab.classList.remove('tab-drag-over');
  });

  tabBar.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const target = e.target.closest('.tab');
    if (!target || target === dragSrc || target.classList.contains('tab-settings')) return;
    target.classList.remove('tab-drag-over');

    const settingsTab = tabBar.querySelector('.tab-settings');
    const rect = target.getBoundingClientRect();
    if (e.clientX < rect.left + rect.width / 2) {
      tabBar.insertBefore(dragSrc, target);
    } else {
      tabBar.insertBefore(dragSrc, target.nextSibling || settingsTab);
    }
    // Ensure settings tab always stays last
    if (settingsTab) tabBar.appendChild(settingsTab);

    saveLayout();
    saveTabOrder();
  });
}

function loadTabWidgets() {
  const layouts = getAllLayouts();
  const data = layouts[currentLayoutName];
  if (data && data.tabs) return data.tabs;
  return [];
}

// ---------------------------------------------------------------------------
// Live-reload
// ---------------------------------------------------------------------------
socket.on('live-reload', (filename) => {
  if (filename.endsWith('.css')) {
    document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      if (link.href.includes('/style.css')) {
        link.href = '/style.css?t=' + Date.now();
      }
    });
  } else {
    location.reload();
  }
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
socket.on('log', (entry) => {
  if (pendingLogs[entry.service]) {
    pendingLogs[entry.service].push(entry);
    scheduleFlush();
  }
});

socket.on('service-status', ({ key, status }) => {
  if (statusDots[key]) {
    statusDots[key].className = 'status-dot ' + status;
  }
  if (statusLabels[key]) {
    const labels = { active: 'active', stale: 'stale', 'no-log': 'no log', unknown: '\u2014' };
    statusLabels[key].textContent = labels[status] || status;
  }
});

socket.on('service-running', ({ key, running }) => {
  const startBtn = document.getElementById(`widget-start-${key}`);
  const restartBtn = document.getElementById(`widget-restart-${key}`);
  const stopBtn = document.getElementById(`widget-stop-${key}`);
  if (startBtn) {
    startBtn.style.display = running ? 'none' : '';
    if (!running) { startBtn.disabled = false; startBtn.textContent = 'Start'; }
  }
  if (restartBtn) {
    restartBtn.style.display = running ? '' : 'none';
    if (running) { restartBtn.disabled = false; restartBtn.textContent = 'Restart'; }
  }
  if (stopBtn) {
    stopBtn.style.display = running ? '' : 'none';
    if (running) { stopBtn.disabled = false; stopBtn.textContent = 'Stop'; }
  }
});

socket.on('clear-logs', (key) => {
  if (logContainers[key]) {
    logContainers[key].innerHTML = '';
  }
});

// Quick action events
socket.on('quick-action-output', ({ action, text }) => {
  console.log(`[${action}]`, text);
});

socket.on('quick-action-done', ({ action, success }) => {
  const btn = document.querySelector(`[data-quick-action="${action}"]`);
  if (btn) {
    btn.classList.remove('running');
    btn.textContent = success ? btn.title : `${btn.title} (failed)`;
    setTimeout(() => { btn.textContent = btn.title; }, 3000);
  }
});

// ---------------------------------------------------------------------------
// ADO work item action (copy /create-bug to clipboard)
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.ado-wi-action');
  if (!btn) return;
  e.stopPropagation();
  const cmd = btn.dataset.cmd;
  try {
    await navigator.clipboard.writeText(cmd);
    btn.classList.add('copied');
    btn.title = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = `Copy ${cmd} to clipboard`;
    }, 2000);
  } catch (err) {
    console.error('Clipboard write failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Git pull button (delegated event — works across widget re-renders)
// ---------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.git-pull-btn');
  if (!btn) return;
  const repo = btn.dataset.repo;
  btn.textContent = 'Pulling...';
  btn.disabled = true;
  const prevErr = btn.parentElement.querySelector('.git-pull-error');
  if (prevErr) prevErr.remove();
  try {
    const res = await fetch('/api/repos/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Pull failed');
    btn.textContent = 'Done!';
    // Refresh the changes list if this repo's changes modal is open
    if (gitChangesRepo === repo) refreshGitChangesFiles();
  } catch (err) {
    btn.textContent = 'Failed';
    const errSpan = document.createElement('span');
    errSpan.className = 'git-pull-error';
    errSpan.title = err.message;
    errSpan.textContent = ' \u26A0 ' + (err.message.length > 60 ? err.message.substring(0, 60) + '...' : err.message);
    btn.parentElement.appendChild(errSpan);
    console.error('Pull failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Git Changes Modal — click "N changed" to open diff viewer + commit form
// ---------------------------------------------------------------------------
let gitChangesRepo = null;
let gitChangesFiles = [];
let gitChangesSelectedFile = null;
let gitChangesChecked = new Set(); // files checked for staging

document.addEventListener('click', (e) => {
  const link = e.target.closest('.git-changes-link');
  if (!link) return;
  e.stopPropagation();
  openGitChangesModal(link.dataset.repo);
});

async function openGitChangesModal(repo) {
  gitChangesRepo = repo;
  gitChangesSelectedFile = null;

  const modal = document.getElementById('git-changes-modal');
  const title = document.getElementById('git-changes-title');
  title.textContent = `Changes — ${repo}`;
  document.getElementById('git-commit-msg').value = '';
  document.getElementById('git-changes-diff').innerHTML = '<div class="git-diff-placeholder">Select a file to view diff</div>';
  modal.style.display = '';
  applyWordWrapState();

  await refreshGitChangesFiles();
}

async function refreshGitChangesFiles() {
  const fileList = document.getElementById('git-changes-file-list');
  fileList.innerHTML = '<div class="git-diff-placeholder">Loading...</div>';

  try {
    const res = await fetch(`/api/repos/${encodeURIComponent(gitChangesRepo)}/changed-files`);
    const data = await res.json();
    gitChangesFiles = data.files || [];

    // Show branch warning + disable push if on a protected branch
    const branch = data.branch || '';
    const isProtected = /^(main|master)$/.test(branch);
    const warningEl = document.getElementById('git-branch-warning');
    const pushBtn   = document.getElementById('git-commit-push-btn');
    if (warningEl) {
      if (isProtected) {
        warningEl.style.display = '';
        warningEl.innerHTML = `⚠ On <strong>${esc(branch)}</strong> — direct push is blocked. Commit locally, then create a PR.`;
      } else {
        warningEl.style.display = 'none';
        warningEl.innerHTML = '';
      }
    }
    if (pushBtn) pushBtn.disabled = isProtected;

    // Default: all checked
    gitChangesChecked = new Set(gitChangesFiles.map(f => f.file));
    document.getElementById('git-stage-all').checked = true;

    renderGitChangesFileList();
  } catch (err) {
    fileList.innerHTML = `<div class="git-diff-placeholder" style="color:var(--red)">Error: ${err.message}</div>`;
  }
}

function renderGitChangesFileList() {
  const fileList = document.getElementById('git-changes-file-list');
  fileList.innerHTML = '';

  if (gitChangesFiles.length === 0) {
    fileList.innerHTML = '<div class="git-diff-placeholder">No changes</div>';
    return;
  }

  for (const f of gitChangesFiles) {
    const row = document.createElement('div');
    row.className = 'git-file-row' + (gitChangesSelectedFile === f.file ? ' active' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'git-file-check';
    cb.checked = gitChangesChecked.has(f.file);
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) gitChangesChecked.add(f.file);
      else gitChangesChecked.delete(f.file);
      // Update stage-all checkbox
      document.getElementById('git-stage-all').checked = gitChangesChecked.size === gitChangesFiles.length;
    });

    const statusBadge = document.createElement('span');
    statusBadge.className = 'git-file-status git-file-' + f.statusLabel;
    statusBadge.textContent = f.status;
    statusBadge.title = f.statusLabel;

    const name = document.createElement('span');
    name.className = 'git-file-name';
    name.textContent = f.file;
    name.title = f.file;

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn git-file-discard';
    discardBtn.textContent = '\u2715';
    discardBtn.title = 'Discard changes';
    discardBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Discard changes to ${f.file}?`)) return;
      discardBtn.disabled = true;
      try {
        const res = await fetch(`/api/repos/${encodeURIComponent(gitChangesRepo)}/discard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: f.file }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await refreshGitChangesFiles();
        document.getElementById('git-changes-diff').innerHTML = '<div class="git-diff-placeholder">File discarded</div>';
      } catch (err) {
        alert('Discard failed: ' + err.message);
        discardBtn.disabled = false;
      }
    });

    row.appendChild(cb);
    row.appendChild(statusBadge);
    row.appendChild(name);
    row.appendChild(discardBtn);

    row.addEventListener('click', () => {
      gitChangesSelectedFile = f.file;
      renderGitChangesFileList();
      loadGitDiff(f.file);
    });

    fileList.appendChild(row);
  }
}

async function loadGitDiff(file) {
  const diffEl = document.getElementById('git-changes-diff');
  diffEl.innerHTML = '<div class="git-diff-placeholder">Loading diff...</div>';

  try {
    const res = await fetch(`/api/repos/${encodeURIComponent(gitChangesRepo)}/diff?file=${encodeURIComponent(file)}`);
    const data = await res.json();
    renderDiffView(diffEl, data.diff || 'No changes');
  } catch (err) {
    diffEl.innerHTML = `<div class="git-diff-placeholder" style="color:var(--red)">Error: ${err.message}</div>`;
  }
}

// Word wrap toggle — persists across sessions
let gitDiffWordWrap = localStorage.getItem('gitDiffWordWrap') !== 'false';

function applyWordWrapState() {
  const btn = document.getElementById('git-wordwrap-btn');
  const pre = document.querySelector('.git-diff-content');
  if (btn) btn.classList.toggle('active', gitDiffWordWrap);
  if (pre) pre.classList.toggle('git-diff-nowrap', !gitDiffWordWrap);
}

document.getElementById('git-wordwrap-btn').addEventListener('click', () => {
  gitDiffWordWrap = !gitDiffWordWrap;
  localStorage.setItem('gitDiffWordWrap', gitDiffWordWrap);
  applyWordWrapState();
});

function renderDiffView(container, diff) {
  container.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'git-diff-content';
  if (!gitDiffWordWrap) pre.classList.add('git-diff-nowrap');

  const lines = diff.split('\n');
  for (const line of lines) {
    const span = document.createElement('span');
    span.className = 'git-diff-line';
    if (line.startsWith('+++') || line.startsWith('---')) {
      span.classList.add('git-diff-meta');
    } else if (line.startsWith('@@')) {
      span.classList.add('git-diff-hunk');
    } else if (line.startsWith('+')) {
      span.classList.add('git-diff-add');
    } else if (line.startsWith('-')) {
      span.classList.add('git-diff-del');
    }
    span.textContent = line;
    pre.appendChild(span);
    pre.appendChild(document.createTextNode('\n'));
  }

  container.appendChild(pre);
}

// Commit / Commit & Push handlers
document.getElementById('git-commit-btn').addEventListener('click', () => doGitCommit(false));
document.getElementById('git-commit-push-btn').addEventListener('click', () => doGitCommit(true));

async function doGitCommit(push) {
  const msg = document.getElementById('git-commit-msg').value.trim();
  if (!msg) {
    document.getElementById('git-commit-msg').focus();
    document.getElementById('git-commit-msg').style.borderColor = 'var(--red)';
    setTimeout(() => { document.getElementById('git-commit-msg').style.borderColor = ''; }, 2000);
    return;
  }

  const stageAll = document.getElementById('git-stage-all').checked;
  const files = stageAll ? [] : [...gitChangesChecked]; // empty = stage all on server

  const commitBtn = document.getElementById('git-commit-btn');
  const pushBtn = document.getElementById('git-commit-push-btn');
  const errEl = document.getElementById('git-commit-error');
  if (errEl) errEl.style.display = 'none';
  commitBtn.disabled = pushBtn.disabled = true;
  const origText = push ? pushBtn.textContent : commitBtn.textContent;
  (push ? pushBtn : commitBtn).textContent = push ? 'Pushing...' : 'Committing...';

  try {
    const res = await fetch(`/api/repos/${encodeURIComponent(gitChangesRepo)}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, files, push }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    (push ? pushBtn : commitBtn).textContent = push ? 'Pushed!' : 'Committed!';
    document.getElementById('git-commit-msg').value = '';

    // Refresh file list — may be empty now
    await refreshGitChangesFiles();
    document.getElementById('git-changes-diff').innerHTML = '<div class="git-diff-placeholder">Commit successful</div>';

    setTimeout(() => {
      commitBtn.disabled = pushBtn.disabled = false;
      commitBtn.textContent = 'Commit';
      pushBtn.textContent = 'Commit & Push';
    }, 2000);
  } catch (err) {
    (push ? pushBtn : commitBtn).textContent = 'Failed!';
    const errEl = document.getElementById('git-commit-error');
    if (errEl) { errEl.textContent = err.message; errEl.style.display = ''; }
    setTimeout(() => {
      commitBtn.disabled = pushBtn.disabled = false;
      commitBtn.textContent = 'Commit';
      pushBtn.textContent = 'Commit & Push';
    }, 2000);
  }
}

// Stage all checkbox
document.getElementById('git-stage-all').addEventListener('change', (e) => {
  if (e.target.checked) {
    gitChangesChecked = new Set(gitChangesFiles.map(f => f.file));
  } else {
    gitChangesChecked.clear();
  }
  renderGitChangesFileList();
});

// Close modal
document.getElementById('git-changes-close').addEventListener('click', () => {
  document.getElementById('git-changes-modal').style.display = 'none';
});
document.getElementById('git-changes-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('git-changes-modal').style.display = 'none';
  }
});

// ---------------------------------------------------------------------------
// Button controls (clear logs, start/stop/restart service)
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const service = btn.dataset.service;
  if (action === 'clear-logs') {
    socket.emit('clear-logs', service);
  }
  if (action === 'start-service') {
    btn.disabled = true;
    btn.textContent = 'Starting\u2026';
    fetch('/api/services/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: service }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.already) {
          btn.textContent = 'Running';
          setTimeout(() => { btn.style.display = 'none'; }, 1000);
        } else {
          btn.textContent = 'Launched';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'Start'; }, 3000);
        }
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = 'Start';
      });
  }
  if (action === 'stop-service') {
    btn.disabled = true;
    btn.textContent = 'Stopping\u2026';
    fetch('/api/services/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: service }),
    })
      .then(r => r.json())
      .then(data => {
        btn.textContent = data.already ? 'Already stopped' : 'Stopped';
        setTimeout(() => { btn.style.display = 'none'; }, 1500);
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = 'Stop';
      });
  }
  if (action === 'restart-service') {
    btn.disabled = true;
    btn.textContent = 'Restarting\u2026';
    const stopBtn = document.getElementById(`widget-stop-${service}`);
    if (stopBtn) stopBtn.disabled = true;
    fetch('/api/services/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: service }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          btn.textContent = 'Restarted';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'Restart'; }, 3000);
        } else {
          btn.textContent = 'Failed';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'Restart'; }, 3000);
        }
        if (stopBtn) stopBtn.disabled = false;
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = 'Restart';
        if (stopBtn) stopBtn.disabled = false;
      });
  }
});

// ---------------------------------------------------------------------------
// Bookmarks dropdown
// ---------------------------------------------------------------------------
const bookmarksBtn = document.getElementById('bookmarks-btn');
const bookmarksMenu = document.getElementById('bookmarks-menu');

if (bookmarksBtn && bookmarksMenu) {
  bookmarksBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    bookmarksMenu.classList.toggle('open');
  });
  document.addEventListener('click', () => bookmarksMenu.classList.remove('open'));
  bookmarksMenu.addEventListener('click', () => bookmarksMenu.classList.remove('open'));
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------
document.addEventListener('click', (e) => {
  const urlBtn = e.target.closest('[data-quick-url]');
  if (urlBtn) {
    window.open(urlBtn.dataset.quickUrl, '_blank');
    return;
  }

  const actionBtn = e.target.closest('[data-quick-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.quickAction;
    actionBtn.classList.add('running');
    actionBtn.textContent = 'Running...';
    socket.emit('quick-action', action);
  }
});

// ---------------------------------------------------------------------------
// Init: load dynamic services, initialize GridStack, apply layout
// ---------------------------------------------------------------------------

// Build full default layout including dynamic service widgets
function getFullDefault() {
  const full = [...DEFAULT_LAYOUT];
  let yOffset = 15;
  for (let i = 0; i < serviceKeys.length; i++) {
    full.push({
      id: 'service-' + serviceKeys[i],
      x: (i * 4) % 12,
      y: yOffset + Math.floor((i * 4) / 12) * 5,
      w: 4,
      h: 5,
    });
  }
  return full;
}

(async function init() {
  await loadUserPrefs();

  // Load layouts from server into localStorage cache (server is source of truth)
  await _loadLayoutsFromServer();

  // Migrate old single-layout localStorage keys to named layout system
  const legacyGrid = localStorage.getItem('dashboard-layout');
  const legacyTabs = localStorage.getItem('dashboard-tab-widgets');
  if (legacyGrid || legacyTabs) {
    const layouts = getAllLayouts();
    if (!layouts[DEFAULT_LAYOUT_NAME]) {
      layouts[DEFAULT_LAYOUT_NAME] = {
        grid: legacyGrid ? JSON.parse(legacyGrid) : [],
        tabs: legacyTabs ? JSON.parse(legacyTabs) : [],
      };
      putAllLayouts(layouts);
    }
    localStorage.removeItem('dashboard-layout');
    localStorage.removeItem('dashboard-tab-widgets');
  }

  // Load services first so widgets can be registered before layout applies
  await initServices();

  // Initialize GridStack
  initGridStack();

  // Restore the active named layout — suppress saves during bulk widget creation
  suppressSave = true;
  currentLayoutName = getActiveLayoutName();

  // Restore tab order (default + widget tabs) before adding widget tabs
  restoreTabOrder();

  // Restore tab widgets first (so they're excluded from grid)
  const savedTabIds = loadTabWidgets();
  for (const id of savedTabIds) {
    if (WIDGET_REGISTRY[id]) {
      moveWidgetToTab(id);
    }
  }

  // Enable drag-and-drop tab reordering
  initTabDragDrop();

  // Load saved or default layout
  const savedLayout = loadLayout();
  const fullDefault = getFullDefault();
  const layouts = getAllLayouts();
  const currentData = layouts[currentLayoutName];
  const removedSet = new Set(currentData && currentData.removed ? currentData.removed : []);

  if (savedLayout && savedLayout.length > 0) {
    applyLayout(savedLayout);
    // Only auto-add genuinely new widgets (not in saved grid, tabs, OR removed list)
    for (const item of fullDefault) {
      if (!savedLayout.find(s => s.id === item.id) && !tabWidgets[item.id] && !removedSet.has(item.id) && WIDGET_REGISTRY[item.id]) {
        addWidgetToGrid(item.id, item);
      }
    }
  } else {
    const gridDefault = fullDefault.filter(item => !tabWidgets[item.id]);
    applyLayout(gridDefault);
  }

  suppressSave = false;
  updateWidgetPicker();
  refreshLayoutSelect();

  // Load and register saved metrics
  await initMetrics();

  // Apply hash route if present, otherwise show dashboard
  if (location.hash && location.hash.length > 1) {
    applyHashRoute();
  } else {
    switchTab('dashboard');
  }
})();

// ---------------------------------------------------------------------------
// Metrics — load and register all saved metrics as dynamic widgets
// ---------------------------------------------------------------------------
async function initMetrics() {
  try {
    const res = await fetch('/api/metrics');
    if (!res.ok) return;
    const metrics = await res.json();
    for (const metric of metrics) {
      if (window.registerMetricWidget) window.registerMetricWidget(metric);
    }
    updateWidgetPicker();
  } catch { /* metrics unavailable */ }
}

// ---------------------------------------------------------------------------
// Metric Creator Wizard
// ---------------------------------------------------------------------------
(function initMetricCreator() {
  // Internal state
  let _wizState = {
    step: 1,
    source: 'script',        // 'script' | 'inline'
    scriptPath: null,
    scriptSql: null,
    sql: null,
    connectionId: null,
    previewData: null,        // { columns, rows, rowCount, time }
    widgetType: null,
    widgetConfig: {},
    editingId: null,          // non-null when editing existing metric
  };

  // ---- Helpers ----
  function wizEl(id) { return document.getElementById(id); }

  function showWizError(step, msg) {
    const el = wizEl(`mwiz-step${step}-error`);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function setStep(n) {
    _wizState.step = n;
    // Update step indicators
    document.querySelectorAll('.mwiz-step').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.step) === n);
    });
    // Show/hide panes
    for (let i = 1; i <= 3; i++) {
      const pane = wizEl(`mwiz-pane-${i}`);
      if (pane) pane.style.display = (i === n) ? 'flex' : 'none';
    }
    // Back button visibility
    const backBtn = wizEl('mwiz-back-btn');
    if (backBtn) backBtn.style.display = n > 1 ? 'inline-flex' : 'none';
    // Next/Save label
    const nextBtn = wizEl('mwiz-next-btn');
    if (nextBtn) nextBtn.textContent = n === 3 ? '💾 Save' : 'Next →';
  }

  // ---- Open / Close ----
  window.openMetricCreator = async function openMetricCreator(editMetricId) {
    const overlay = wizEl('metric-creator-modal');
    if (!overlay) return;

    // Reset state
    _wizState = {
      step: 1, source: 'script', scriptPath: null, scriptSql: null,
      sql: null, connectionId: null, previewData: null,
      widgetType: null, widgetConfig: {}, editingId: editMetricId || null,
    };

    wizEl('metric-creator-title').textContent = editMetricId ? 'Edit Metric' : 'Create Metric';
    wizEl('mwiz-delete-btn').style.display = editMetricId ? 'inline-flex' : 'none';

    // If editing, pre-populate from registry
    if (editMetricId) {
      const reg = WIDGET_REGISTRY['metric-' + editMetricId];
      if (reg) {
        // Fetch full metric def from server
        try {
          const res = await fetch('/api/metrics');
          const metrics = await res.json();
          const m = metrics.find(x => x.id === editMetricId);
          if (m) {
            _wizState.sql = m.sql;
            _wizState.connectionId = m.connectionId;
            _wizState.widgetType = m.widgetType;
            _wizState.widgetConfig = { ...m.widgetConfig };
            if (m.scriptPath) {
              _wizState.source = 'script';
              _wizState.scriptPath = m.scriptPath;
            } else {
              _wizState.source = 'inline';
            }
          }
        } catch { /* ignore */ }
      }
    }

    overlay.style.display = 'flex';
    setStep(1);
    await populateStep1();

    // Restore edit state in UI
    if (_wizState.source === 'inline') {
      switchSource('inline');
      if (_wizState.sql) wizEl('mwiz-sql-editor').value = _wizState.sql;
    } else {
      switchSource('script');
    }
  };

  function closeMetricCreator() {
    const overlay = wizEl('metric-creator-modal');
    if (overlay) overlay.style.display = 'none';
  }

  wizEl('metric-creator-close')?.addEventListener('click', closeMetricCreator);
  wizEl('metric-creator-modal')?.addEventListener('click', (e) => {
    if (e.target === wizEl('metric-creator-modal')) closeMetricCreator();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wizEl('metric-creator-modal')?.style.display !== 'none') {
      closeMetricCreator();
    }
  });

  // ---- Step 1 setup ----
  async function populateStep1() {
    // Populate connection dropdown
    const sel = wizEl('mwiz-connection');
    if (sel) {
      try {
        const res = await fetch('/api/db/connections');
        const conns = await res.json();
        sel.innerHTML = conns.map(c =>
          `<option value="${esc(c.id)}"${c.id === _wizState.connectionId ? ' selected' : ''}>${esc(c.name || c.id)}</option>`
        ).join('');
        if (!_wizState.connectionId && conns.length) {
          _wizState.connectionId = conns[0].id;
        }
      } catch {
        sel.innerHTML = '<option value="">No connections found</option>';
      }
      sel.addEventListener('change', () => { _wizState.connectionId = sel.value; });
    }

    // Load script tree
    await loadScriptTree();

    showWizError(1, '');
  }

  async function loadScriptTree() {
    const treeEl = wizEl('mwiz-script-tree');
    if (!treeEl) return;
    try {
      const res = await fetch('/api/db/scripts/tree');
      const tree = await res.json();
      treeEl.innerHTML = renderScriptTree(tree);
      wireScriptTree(treeEl);

      // Re-select previously picked script
      if (_wizState.scriptPath) {
        const item = treeEl.querySelector(`[data-path="${CSS.escape(_wizState.scriptPath)}"]`);
        if (item) {
          item.classList.add('selected');
          showSelectedScript(_wizState.scriptPath);
        }
      }
    } catch {
      treeEl.innerHTML = '<div style="color:var(--subtext0);padding:6px">Could not load scripts</div>';
    }
  }

  function renderScriptTree(nodes, depth = 0) {
    return nodes.map(node => {
      if (node.type === 'dir' || node.type === 'folder') {
        const children = node.children?.length
          ? `<div class="mwiz-tree-children">${renderScriptTree(node.children, depth + 1)}</div>`
          : '';
        return `<div class="mwiz-tree-folder" data-folder="${esc(node.path)}">📁 ${esc(node.name)}</div>${children}`;
      } else {
        return `<div class="mwiz-tree-file" data-path="${esc(node.path)}">${esc(node.name)}</div>`;
      }
    }).join('');
  }

  function wireScriptTree(treeEl) {
    treeEl.querySelectorAll('.mwiz-tree-file').forEach(el => {
      el.addEventListener('click', async () => {
        treeEl.querySelectorAll('.mwiz-tree-file').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        _wizState.scriptPath = el.dataset.path;
        showSelectedScript(el.dataset.path);
        // Load SQL content
        try {
          const res = await fetch(`/api/db/scripts/file?path=${encodeURIComponent(el.dataset.path)}`);
          const data = await res.json();
          _wizState.scriptSql = data.content || '';
        } catch {
          _wizState.scriptSql = null;
        }
      });
    });
    treeEl.querySelectorAll('.mwiz-tree-folder').forEach(el => {
      el.addEventListener('click', () => {
        const sibling = el.nextElementSibling;
        if (sibling?.classList.contains('mwiz-tree-children')) {
          sibling.style.display = sibling.style.display === 'none' ? '' : 'none';
        }
      });
    });
  }

  function showSelectedScript(path) {
    const wrap = wizEl('mwiz-selected-script');
    const label = wizEl('mwiz-selected-path');
    if (wrap && label) {
      label.textContent = path;
      wrap.style.display = 'flex';
    }
  }

  // Script search filter
  wizEl('mwiz-script-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const treeEl = wizEl('mwiz-script-tree');
    if (!treeEl) return;
    treeEl.querySelectorAll('.mwiz-tree-file').forEach(el => {
      const match = !q || el.dataset.path.toLowerCase().includes(q);
      el.style.display = match ? '' : 'none';
    });
  });

  // Source tab switching
  function switchSource(src) {
    _wizState.source = src;
    document.querySelectorAll('.mwiz-src-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.src === src);
    });
    const scriptPanel = wizEl('mwiz-script-panel');
    const inlinePanel = wizEl('mwiz-inline-panel');
    if (scriptPanel) scriptPanel.style.display = src === 'script' ? 'flex' : 'none';
    if (inlinePanel) inlinePanel.style.display = src === 'inline' ? 'flex' : 'none';
  }

  document.querySelectorAll('.mwiz-src-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSource(tab.dataset.src));
  });

  // Preview button
  wizEl('mwiz-preview-btn')?.addEventListener('click', async () => {
    showWizError(1, '');
    const btn = wizEl('mwiz-preview-btn');
    const resultEl = wizEl('mwiz-preview-result');
    btn.disabled = true;
    btn.textContent = '…';

    const sql = _wizState.source === 'inline'
      ? (wizEl('mwiz-sql-editor')?.value || '').trim()
      : _wizState.scriptSql;

    if (!sql) {
      showWizError(1, _wizState.source === 'inline' ? 'Please enter a SQL query.' : 'Please select a script first.');
      btn.disabled = false;
      btn.textContent = '▶ Preview';
      return;
    }

    _wizState.sql = sql;

    try {
      const connParam = _wizState.connectionId ? `?connectionId=${encodeURIComponent(_wizState.connectionId)}` : '';
      const res = await fetch(`/api/db/query${connParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, writeMode: false }),
      });
      const data = await res.json();
      if (data.error) {
        showWizError(1, data.error);
        resultEl.style.display = 'none';
      } else {
        _wizState.previewData = data;
        resultEl.style.display = 'block';
        resultEl.innerHTML = renderPreviewTable(data);
        // Enable Next
      }
    } catch (err) {
      showWizError(1, 'Preview failed: ' + err.message);
      resultEl.style.display = 'none';
    }

    btn.disabled = false;
    btn.textContent = '▶ Preview';
  });

  function renderPreviewTable(data) {
    const { columns, rows, rowCount, time } = data;
    if (!columns.length) return '<div class="mwiz-preview-meta">Query returned no columns.</div>';
    const thead = columns.map(c => `<th>${esc(c)}</th>`).join('');
    const tbody = rows.map(row =>
      `<tr>${columns.map(c => `<td>${esc(row[c] ?? '')}</td>`).join('')}</tr>`
    ).join('');
    return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
      <div class="mwiz-preview-meta">${rowCount} row${rowCount !== 1 ? 's' : ''} · ${time}ms</div>`;
  }

  // ---- Step 2 setup ----
  function populateStep2() {
    const data = _wizState.previewData;
    if (!data) return;
    const { columns, rows } = data;

    // Summary
    const summaryEl = wizEl('mwiz-preview-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `Result: <strong>${data.rowCount} rows</strong>, <strong>${columns.length} columns</strong> (${columns.map(c => `<code>${esc(c)}</code>`).join(', ')})`;
    }

    // Determine suggested types
    const suggested = suggestWidgetTypes(columns, rows);
    document.querySelectorAll('.mwiz-type-card').forEach(card => {
      const isS = suggested.includes(card.dataset.type);
      card.classList.toggle('suggested', isS);
      // Remove old suggest tag
      card.querySelector('.mwiz-type-suggest-tag')?.remove();
      if (isS) {
        const tag = document.createElement('span');
        tag.className = 'mwiz-type-suggest-tag';
        tag.textContent = 'Suggested';
        card.appendChild(tag);
      }
    });

    // Restore selection if editing
    if (_wizState.widgetType) {
      document.querySelectorAll('.mwiz-type-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.type === _wizState.widgetType);
      });
      showTypeConfig(_wizState.widgetType, columns);
    }

    // Wire type card clicks
    document.querySelectorAll('.mwiz-type-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.mwiz-type-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        _wizState.widgetType = card.dataset.type;
        showTypeConfig(card.dataset.type, columns);
      });
    });

    showWizError(2, '');
  }

  function suggestWidgetTypes(columns, rows) {
    const suggestions = [];
    const numCols = columns.length;
    const numRows = rows.length;

    if (numCols === 1 && numRows === 1) suggestions.push('number-metric', 'delta-metric');
    if (numCols === 1 && numRows === 1) suggestions.push('gauge');
    if (numCols >= 2 && numRows === 1) suggestions.push('kv-card');
    if (numCols >= 2 && numRows > 1) suggestions.push('table-list');
    if (numCols === 2 && numRows > 1) {
      // Check if second col is numeric
      const secondVal = rows[0]?.[columns[1]];
      if (!isNaN(parseFloat(secondVal))) suggestions.push('bar-chart');
    }
    // Check for boolean/status-like values
    const hasStatus = columns.some(c =>
      rows.some(r => /^(true|false|yes|no|active|inactive|ok|error|up|down)$/i.test(String(r[c] ?? '')))
    );
    if (hasStatus) suggestions.push('status-badges');
    if (!suggestions.length) suggestions.push('table-list');
    return [...new Set(suggestions)];
  }

  function showTypeConfig(type, columns) {
    const wrap = wizEl('mwiz-type-config');
    const inner = wizEl('mwiz-type-config-inner');
    if (!wrap || !inner) return;

    const colOptions = columns.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    const cfg = _wizState.widgetConfig;
    let html = '';

    switch (type) {
      case 'number-metric':
      case 'delta-metric':
        html = `
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Value Column</label>
              <select class="mwiz-config-select" data-cfg="valueColumn">${colOptions}</select>
            </div>
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Label</label>
              <input class="mwiz-config-input" data-cfg="label" placeholder="e.g. Total Users" value="${esc(cfg.label || '')}">
            </div>
          </div>
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Unit Suffix</label>
              <input class="mwiz-config-input" data-cfg="unit" placeholder="e.g. ms, %, rows" value="${esc(cfg.unit || '')}">
            </div>
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Decimal Places</label>
              <input class="mwiz-config-input" type="number" min="0" max="6" data-cfg="decimalPlaces" value="${cfg.decimalPlaces ?? 0}">
            </div>
          </div>`;
        break;
      case 'gauge':
        html = `
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Value Column</label>
              <select class="mwiz-config-select" data-cfg="valueColumn">${colOptions}</select>
            </div>
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Max Value</label>
              <input class="mwiz-config-input" type="number" data-cfg="maxValue" placeholder="100" value="${esc(cfg.maxValue || '')}">
            </div>
          </div>
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Label</label>
              <input class="mwiz-config-input" data-cfg="label" placeholder="e.g. CPU Usage" value="${esc(cfg.label || '')}">
            </div>
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Unit Suffix</label>
              <input class="mwiz-config-input" data-cfg="unit" placeholder="e.g. %" value="${esc(cfg.unit || '')}">
            </div>
          </div>`;
        break;
      case 'table-list':
        html = `
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Row Limit</label>
              <input class="mwiz-config-input" type="number" min="5" max="500" data-cfg="rowLimit" placeholder="50" value="${cfg.rowLimit || 50}">
            </div>
          </div>`;
        break;
      case 'kv-card':
        html = `<div style="font-size:11px;color:var(--subtext0)">Displays all columns from the first row as key/value pairs. No additional config needed.</div>`;
        break;
      case 'bar-chart':
        html = `
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Label Column</label>
              <select class="mwiz-config-select" data-cfg="labelColumn">${colOptions}</select>
            </div>
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Value Column</label>
              <select class="mwiz-config-select" data-cfg="valueColumn">${colOptions}</select>
            </div>
          </div>
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Row Limit</label>
              <input class="mwiz-config-input" type="number" min="1" max="50" data-cfg="rowLimit" placeholder="20" value="${cfg.rowLimit || 20}">
            </div>
          </div>`;
        break;
      case 'status-badges':
        html = `
          <div class="mwiz-config-row">
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Status Column</label>
              <select class="mwiz-config-select" data-cfg="statusColumn">${colOptions}</select>
            </div>
            <div class="mwiz-config-field">
              <label class="mwiz-config-label">Label Column</label>
              <select class="mwiz-config-select" data-cfg="labelColumn">${colOptions}</select>
            </div>
          </div>`;
        break;
    }

    inner.innerHTML = html;
    wrap.style.display = html ? 'block' : 'none';

    // Restore select values from config
    inner.querySelectorAll('[data-cfg]').forEach(el => {
      const key = el.dataset.cfg;
      if (cfg[key] !== undefined && el.tagName === 'SELECT') {
        el.value = cfg[key];
      }
      el.addEventListener('change', () => collectTypeConfig());
      el.addEventListener('input',  () => collectTypeConfig());
    });
    collectTypeConfig();
  }

  function collectTypeConfig() {
    const inner = wizEl('mwiz-type-config-inner');
    if (!inner) return;
    inner.querySelectorAll('[data-cfg]').forEach(el => {
      const key = el.dataset.cfg;
      const val = el.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value;
      if (val !== undefined && val !== '') {
        _wizState.widgetConfig[key] = val;
      } else {
        delete _wizState.widgetConfig[key];
      }
    });
  }

  // ---- Step 3 setup ----
  function populateStep3() {
    const nameEl = wizEl('mwiz-name');
    if (nameEl && !nameEl.value) {
      // Auto-suggest name from script filename or first word of SQL
      if (_wizState.scriptPath) {
        const base = _wizState.scriptPath.split('/').pop().replace(/\.sql$/i, '').replace(/[-_]/g, ' ');
        nameEl.value = base.replace(/\b\w/g, c => c.toUpperCase());
      }
    }
    showWizError(3, '');
  }

  // ---- Navigation ----
  wizEl('mwiz-next-btn')?.addEventListener('click', async () => {
    const step = _wizState.step;

    if (step === 1) {
      if (!_wizState.previewData) {
        showWizError(1, 'Run a preview first to proceed.');
        return;
      }
      setStep(2);
      populateStep2();

    } else if (step === 2) {
      if (!_wizState.widgetType) {
        showWizError(2, 'Please select a widget type.');
        return;
      }
      collectTypeConfig();
      setStep(3);
      populateStep3();

    } else if (step === 3) {
      await saveMetric();
    }
  });

  wizEl('mwiz-back-btn')?.addEventListener('click', () => {
    if (_wizState.step > 1) setStep(_wizState.step - 1);
  });

  // ---- Save ----
  async function saveMetric() {
    const nameEl = wizEl('mwiz-name');
    const name = nameEl?.value.trim();
    if (!name) {
      showWizError(3, 'Please enter a name for this metric.');
      return;
    }

    const id = _wizState.editingId || crypto.randomUUID();
    const metric = {
      id,
      name,
      sql: _wizState.sql,
      scriptPath: _wizState.source === 'script' ? _wizState.scriptPath : null,
      connectionId: _wizState.connectionId,
      refreshInterval: parseInt(wizEl('mwiz-refresh')?.value || '60', 10),
      widgetType: _wizState.widgetType,
      widgetConfig: _wizState.widgetConfig,
      defaultSize: {
        w: parseInt(wizEl('mwiz-width')?.value || '3', 10),
        h: parseInt(wizEl('mwiz-height')?.value || '3', 10),
      },
    };

    try {
      const res = await fetch(`/api/metrics/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metric),
      });
      if (!res.ok) {
        const err = await res.json();
        showWizError(3, err.error || 'Save failed.');
        return;
      }
    } catch (err) {
      showWizError(3, 'Save failed: ' + err.message);
      return;
    }

    // Re-register widget
    if (window.registerMetricWidget) window.registerMetricWidget(metric);
    updateWidgetPicker();

    // If new, add to grid; if editing, refresh running widget
    const widgetId = 'metric-' + id;
    if (!_wizState.editingId) {
      addWidgetToGrid(widgetId, null);
      saveLayout();
    } else {
      // Force re-init of running widget
      const entry = activeWidgets[widgetId];
      if (entry) {
        const body = entry.element.querySelector('.widget-body');
        const titleEl = entry.element.querySelector('.widget-title');
        if (titleEl) titleEl.textContent = metric.name;
        if (body && WIDGET_REGISTRY[widgetId]) {
          if (WIDGET_REGISTRY[widgetId].destroy) WIDGET_REGISTRY[widgetId].destroy();
          WIDGET_REGISTRY[widgetId].init(body, socket, {});
        }
      }
    }

    showToast(_wizState.editingId ? `Metric "${name}" updated` : `Metric "${name}" created`, 'success');
    closeMetricCreator();
  }

  // ---- Delete ----
  wizEl('mwiz-delete-btn')?.addEventListener('click', async () => {
    const id = _wizState.editingId;
    if (!id) return;
    const reg = WIDGET_REGISTRY['metric-' + id];
    if (!confirm(`Delete metric "${reg?.title || id}"? This cannot be undone.`)) return;

    try {
      await fetch(`/api/metrics/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }

    // Remove from grid if active
    removeWidgetFromGrid('metric-' + id);
    if (window.unregisterMetricWidget) window.unregisterMetricWidget(id);
    updateWidgetPicker();
    showToast(`Metric deleted`, 'info');
    closeMetricCreator();
  });
})();
