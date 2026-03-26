/* ==========================================================================
   Pop-out Window — initializes a single widget in its own window
   ========================================================================== */

(function () {
  const params = new URLSearchParams(window.location.search);
  const widgetId = params.get('widget');
  const container = document.getElementById('popout-container');

  if (!widgetId) {
    container.innerHTML = '<div class="popout-loading">No widget specified</div>';
    return;
  }

  const socket = io();
  const ansi = new AnsiUp();
  ansi.use_classes = false;

  // Expose globals that widgets might reference
  window.DASH_CONFIG = {};
  window.mutedServices = new Set();
  window.logContainers = {};
  window.statusDots = {};
  window.statusLabels = {};
  window.autoscrollFlags = {};
  window.pendingLogs = {};
  window.serviceKeys = [];

  // Minimal esc() for widgets
  window.esc = function (str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  };

  // Minimal alarm stubs (alarm lives in main window)
  window.evaluateAlarm = function () {};

  // Load config
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => { window.DASH_CONFIG = cfg; })
    .catch(() => {});

  // For service widgets, we need flushLogs
  const MAX_LOG_LINES = 2000;
  let rafScheduled = false;

  function scheduleFlush() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(flushLogs);
  }

  function flushLogs() {
    rafScheduled = false;
    for (const key of window.serviceKeys) {
      const batch = window.pendingLogs[key];
      if (!batch || batch.length === 0) continue;
      const cont = window.logContainers[key];
      if (!cont) continue;
      const fragment = document.createDocumentFragment();
      for (const entry of batch) {
        const div = document.createElement('div');
        div.className = 'log-line' + (entry.stream === 'stderr' ? ' stderr' : '');
        const ts = new Date(entry.ts);
        const timeStr = ts.toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        div.innerHTML = `<span class="log-ts">${timeStr}</span>` + ansi.ansi_to_html(entry.text);
        fragment.appendChild(div);
      }
      cont.appendChild(fragment);
      batch.length = 0;
      while (cont.children.length > MAX_LOG_LINES) cont.removeChild(cont.firstChild);
      if (window.autoscrollFlags[key]) cont.scrollTop = cont.scrollHeight;
    }
  }

  socket.on('log', (entry) => {
    if (window.pendingLogs[entry.service]) {
      window.pendingLogs[entry.service].push(entry);
      scheduleFlush();
    }
  });

  socket.on('service-status', ({ key, status }) => {
    if (window.statusDots[key]) window.statusDots[key].className = 'status-dot ' + status;
    if (window.statusLabels[key]) {
      const labels = { active: 'active', stale: 'stale', 'no-log': 'no log', unknown: '\u2014' };
      window.statusLabels[key].textContent = labels[status] || status;
    }
  });

  socket.on('service-running', ({ key, running }) => {
    const startBtn = document.getElementById(`widget-start-${key}`);
    const restartBtn = document.getElementById(`widget-restart-${key}`);
    const stopBtn = document.getElementById(`widget-stop-${key}`);
    if (startBtn) startBtn.style.display = running ? 'none' : '';
    if (restartBtn) restartBtn.style.display = running ? '' : 'none';
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  });

  socket.on('clear-logs', (key) => {
    if (window.logContainers[key]) window.logContainers[key].innerHTML = '';
  });

  // Service action buttons (start/stop/restart/clear)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const service = btn.dataset.service;
    if (action === 'clear-logs') socket.emit('clear-logs', service);
    if (action === 'start-service') {
      btn.disabled = true; btn.textContent = 'Starting\u2026';
      fetch('/api/services/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: service }) })
        .then(r => r.json()).then(() => { btn.textContent = 'Launched'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Start'; }, 3000); })
        .catch(() => { btn.disabled = false; btn.textContent = 'Start'; });
    }
    if (action === 'stop-service') {
      btn.disabled = true; btn.textContent = 'Stopping\u2026';
      fetch('/api/services/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: service }) })
        .then(r => r.json()).then(() => { btn.textContent = 'Stopped'; setTimeout(() => { btn.style.display = 'none'; }, 1500); })
        .catch(() => { btn.disabled = false; btn.textContent = 'Stop'; });
    }
    if (action === 'restart-service') {
      btn.disabled = true; btn.textContent = 'Restarting\u2026';
      fetch('/api/services/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: service }) })
        .then(r => r.json()).then(() => { btn.textContent = 'Restarted'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Restart'; }, 3000); })
        .catch(() => { btn.disabled = false; btn.textContent = 'Restart'; });
    }
  });

  // Initialize the widget
  async function initWidget() {
    // For service widgets, load service defs first
    if (widgetId.startsWith('service-')) {
      try {
        const res = await fetch('/api/services');
        const defs = await res.json();
        window.serviceKeys = Object.keys(defs);
        for (const [key, def] of Object.entries(defs)) {
          window.pendingLogs[key] = [];
          registerServiceWidget(key, def);
        }
      } catch (err) {
        console.error('Failed to load services:', err);
      }
    }

    const widget = WIDGET_REGISTRY[widgetId];
    if (!widget) {
      container.innerHTML = `<div class="popout-loading">Unknown widget: ${widgetId}</div>`;
      return;
    }

    document.title = widget.title + ' \u2014 Dev Dashboard';
    container.innerHTML = '';
    container.className = 'popout-container';

    widget.init(container, socket, {});
  }

  initWidget();
})();
