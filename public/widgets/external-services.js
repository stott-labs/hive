/* Widget: external-services */

WIDGET_REGISTRY['external-services'] = {
  title: 'External Services',
  icon: '\uD83C\uDF10',
  settingsKey: 'externalMonitors',
  defaultSize: { w: 4, h: 4 },
  minW: 3,
  minH: 2,

  init(contentEl, socket, config) {
    contentEl.innerHTML = '<div class="status-grid" id="widget-status-grid"></div>';
    const grid = contentEl.querySelector('#widget-status-grid');

    this._handler = (monitors) => {
      grid.innerHTML = '';

      const hiddenServices = typeof getHiddenServices === 'function' ? getHiddenServices() : new Set();
      const visibleMonitors = monitors.filter(m => !hiddenServices.has(m.key));

      for (const m of visibleMonitors) {
        const isDown = m.status === 'down';
        const isUnreachable = m.status === 'unreachable';

        const row = document.createElement('div');
        row.className = 'status-card' + (isDown ? ' danger' : isUnreachable ? ' warning' : '');
        row.title = (m.description || m.status) + ` — checks every ${m.interval || 30}s`;
        row.addEventListener('click', (e) => {
          if (e.target.closest('.btn-mute')) return;
          const openUrl = m.key === 'claude' ? 'https://status.claude.com' : m.url;
          window.open(openUrl, '_blank');
        });

        const dot = document.createElement('span');
        dot.className = 'status-dot ' + m.status;

        const name = document.createElement('span');
        name.className = 'status-card-name';
        name.textContent = m.label;

        const code = document.createElement('span');
        code.className = 'status-card-code';
        code.textContent = m.statusCode != null ? m.statusCode : '\u2014';

        const time = document.createElement('span');
        const ms = m.responseTime;
        let timeClass = 'fast';
        if (ms == null) timeClass = 'slow';
        else if (ms >= 2000) timeClass = 'slow';
        else if (ms >= 500) timeClass = 'medium';
        time.className = 'status-card-time ' + timeClass;
        time.textContent = ms != null ? ms + 'ms' : '\u2014';

        const statusLabel = document.createElement('span');
        statusLabel.className = 'status-card-status ' + m.status;
        statusLabel.textContent = m.status;

        const muteBtn = document.createElement('button');
        const isMuted = window.mutedServices && window.mutedServices.has(m.key);
        muteBtn.className = 'btn-mute' + (isMuted ? ' muted' : '');
        muteBtn.title = isMuted ? 'Alarm silenced — click to re-enable' : 'Silence alarm for this service';
        muteBtn.textContent = isMuted ? '\uD83D\uDD07' : '\uD83D\uDD14';
        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!window.mutedServices) return;
          if (window.mutedServices.has(m.key)) window.mutedServices.delete(m.key);
          else window.mutedServices.add(m.key);
          if (typeof saveMutedServices === 'function') saveMutedServices();
          this._handler(monitors);
        });

        const hideBtn = document.createElement('button');
        hideBtn.className = 'btn-hide-service';
        hideBtn.title = 'Hide this service (manage in Settings)';
        hideBtn.textContent = '\uD83D\uDC41';
        hideBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (typeof toggleHiddenService === 'function') await toggleHiddenService(m.key);
          this._handler(monitors);
        });

        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(code);
        row.appendChild(time);
        row.appendChild(statusLabel);
        row.appendChild(muteBtn);
        row.appendChild(hideBtn);
        grid.appendChild(row);
      }

      // Trigger global alarm evaluation (uses full list so hidden services still alarm)
      if (typeof evaluateAlarm === 'function') evaluateAlarm(monitors);
    };

    socket.on('external-status', this._handler);
  },

  refresh(socket) {
    socket.emit('refresh', 'external');
  },

  destroy(socket) {
    if (this._handler) socket.off('external-status', this._handler);
  },
};
