/* Widget: cli-tools */

WIDGET_REGISTRY['cli-tools'] = {
  title: 'CLI Tools',
  icon: '\u2318',
  defaultSize: { w: 6, h: 5 },
  minW: 3,
  minH: 3,

  init(contentEl, socket) {
    this._el = contentEl;
    this._socket = socket;
    this._env = localStorage.getItem('cli-tool-env') || 'local';
    this._logs = {};
    this._running = {};

    this._onOutput = ({ id, text }) => this._appendLog(id, text);
    this._onDone = ({ id, success }) => {
      this._appendLog(id, success ? '--- Done ---\n' : '--- Failed ---\n');
      this._running[id] = false;
      const btn = this._el.querySelector(`.cli-tool-run-btn[data-tool-id="${id}"]`);
      if (btn) {
        btn.classList.remove('running');
        btn.textContent = 'Run';
      }
    };
    socket.on('cli-tool-output', this._onOutput);
    socket.on('cli-tool-done', this._onDone);

    this._render();
  },

  _render() {
    const el = this._el;
    const tools = (window.DASH_CONFIG || {}).cliTools || [];

    if (!tools.length) {
      el.innerHTML = '<div style="padding:12px;color:var(--overlay0);font-size:12px">No CLI tools configured. Add <code>cliTools</code> to <code>dashboard.config.json</code>.</div>';
      return;
    }

    let html = '<div class="cli-tools-toolbar">';
    html += '<select class="migrate-env-select widget-cli-env" title="Environment">';
    for (const env of ['local', 'dev', 'prod']) {
      html += `<option value="${env}"${env === this._env ? ' selected' : ''}>${env}</option>`;
    }
    html += '</select>';
    html += '</div>';

    const grouped = {};
    for (const tool of tools) {
      if (!grouped[tool.category]) grouped[tool.category] = [];
      grouped[tool.category].push(tool);
    }

    for (const [cat, catTools] of Object.entries(grouped)) {
      html += `<div class="cli-tools-category"><span class="cli-tools-cat-label">${esc(cat)}</span></div>`;
      for (const tool of catTools) {
        html += `<div class="cli-tool-card" data-tool-id="${tool.id}">`;
        html += `<div class="cli-tool-header">`;
        html += `<div class="cli-tool-info"><strong>${esc(tool.name)}</strong><span class="cli-tool-desc">${esc(tool.desc)}</span></div>`;
        html += `<button class="btn btn-start cli-tool-run-btn" data-tool-id="${tool.id}">Run</button>`;
        html += `</div>`;
        html += `<div class="cli-tool-log widget-cli-log" data-tool-id="${tool.id}">${esc(this._logs[tool.id] || '')}</div>`;
        html += `</div>`;
      }
    }

    el.innerHTML = html;

    el.querySelector('.widget-cli-env').addEventListener('change', (e) => {
      this._env = e.target.value;
      localStorage.setItem('cli-tool-env', this._env);
    });

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.cli-tool-run-btn');
      if (!btn) return;
      const toolId = btn.dataset.toolId;
      if (this._running[toolId]) return;
      const tool = tools.find(t => t.id === toolId);
      if (!tool) return;

      this._running[toolId] = true;
      btn.classList.add('running');
      btn.textContent = 'Running...';

      const ts = new Date().toLocaleTimeString();
      this._appendLog(toolId, `\n[${ts}] Running ${tool.name} --env ${this._env}...\n`);
      this._socket.emit('cli-tool-run', { id: toolId, cmd: tool.cmd, args: tool.args, env: this._env });
    });
  },

  _appendLog(toolId, text) {
    if (!this._logs[toolId]) this._logs[toolId] = '';
    this._logs[toolId] += text;
    const logEl = this._el.querySelector(`.widget-cli-log[data-tool-id="${toolId}"]`);
    if (logEl) {
      logEl.textContent = this._logs[toolId];
      logEl.scrollTop = logEl.scrollHeight;
    }
  },

  refresh() { this._render(); },

  destroy(socket) {
    if (this._onOutput) socket.off('cli-tool-output', this._onOutput);
    if (this._onDone) socket.off('cli-tool-done', this._onDone);
  },
};
