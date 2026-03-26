/* Widget: service-log — registerServiceWidget factory */

function registerServiceWidget(key, def) {
  WIDGET_REGISTRY['service-' + key] = {
    title: def.label,
    icon: '\uD83D\uDDA5\uFE0F',
    defaultSize: { w: 4, h: 5 },
    minW: 3,
    minH: 3,
    serviceKey: key,

    init(contentEl, socket, config) {
      contentEl.innerHTML = `
        <div class="panel-header" style="padding:4px 8px;background:transparent;border:none">
          <div class="panel-title">
            <span class="status-dot unknown" id="widget-dot-${key}"></span>
            <span class="status-label" id="widget-status-${key}">\u2014</span>
          </div>
          <div class="panel-controls">
            <button class="btn btn-start" id="widget-start-${key}" data-action="start-service" data-service="${key}" title="Start" style="display:none">Start</button>
            <button class="btn btn-restart" id="widget-restart-${key}" data-action="restart-service" data-service="${key}" title="Restart" style="display:none">Restart</button>
            <button class="btn btn-stop" id="widget-stop-${key}" data-action="stop-service" data-service="${key}" title="Stop" style="display:none">Stop</button>
            <button class="btn btn-clear" data-action="clear-logs" data-service="${key}" title="Clear">Clear</button>
            <label class="log-errors-label"><input type="checkbox" class="log-errors-toggle" data-service="${key}"> Errors only</label>
          </div>
        </div>
        <div class="log-container" id="widget-log-${key}"></div>
      `;

      // Errors-only toggle
      const errToggle = contentEl.querySelector('.log-errors-toggle');
      const logEl = contentEl.querySelector('#widget-log-' + key);
      errToggle.addEventListener('change', () => {
        logEl.classList.toggle('errors-only', errToggle.checked);
      });

      // Register into global maps so flushLogs() works
      window.logContainers[key] = logEl;
      window.statusDots[key] = contentEl.querySelector('#widget-dot-' + key);
      window.statusLabels[key] = contentEl.querySelector('#widget-status-' + key);
      window.autoscrollFlags[key] = true;
      if (!window.pendingLogs[key]) window.pendingLogs[key] = [];

      logEl.addEventListener('scroll', () => {
        const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
        window.autoscrollFlags[key] = atBottom;
      });
    },

    refresh(socket) {
      // No explicit refresh for log streams
    },

    destroy(socket) {
      // Remove from global maps
      delete window.logContainers[key];
      delete window.statusDots[key];
      delete window.statusLabels[key];
      delete window.autoscrollFlags[key];
      // Keep pendingLogs[key] so reconnection doesn't error
    },
  };
}

window.registerServiceWidget = registerServiceWidget;
