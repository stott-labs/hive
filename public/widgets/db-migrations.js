/* Widget: db-migrations */

WIDGET_REGISTRY['db-migrations'] = {
  title: 'DB Migrations',
  icon: '\uD83D\uDDC3\uFE0F',
  settingsKey: 'dbMigrations',
  defaultSize: { w: 4, h: 5 },
  minW: 3,
  minH: 3,

  init(contentEl, socket) {
    this._env = localStorage.getItem('migrate-env') || 'local';
    this._logHistory = '';
    this._socket = socket;
    this._el = contentEl;

    this._load();

    this._onOutput = (text) => this._appendLog(text);
    this._onDone = ({ success }) => {
      this._appendLog(success ? '\n--- Done ---\n' : '\n--- Failed ---\n');
      this._load();
    };
    socket.on('migrate-output', this._onOutput);
    socket.on('migrate-done', this._onDone);
  },

  async _load() {
    const contentEl = this._el;
    try {
      const res = await fetch(`/api/migrations/status?env=${this._env}`);
      const data = await res.json();

      let html = '<div class="migrations-toolbar">';
      html += '<div class="migrations-status">';
      html += `<span class="migrations-count"><span class="run">${data.run} run</span></span>`;
      html += `<span class="migrations-count"><span class="pending">${data.pending} pending</span></span>`;
      html += '</div>';
      html += '<select class="migrate-env-select widget-migrate-env" title="Knex environment">';
      for (const env of ['local', 'dev', 'prod']) {
        html += `<option value="${env}"${env === this._env ? ' selected' : ''}>${env}</option>`;
      }
      html += '</select>';
      html += '</div>';

      html += '<div class="migrations-actions">';
      html += '<button class="btn btn-start widget-migrate-latest">Migrate Latest</button>';
      html += '<button class="btn btn-stop widget-migrate-rollback">Rollback</button>';
      html += '<button class="btn widget-migrate-clear" title="Clear log">Clear</button>';
      html += '</div>';

      html += `<div class="migrations-log widget-migrate-log"></div>`;
      contentEl.innerHTML = html;

      const logEl = contentEl.querySelector('.widget-migrate-log');
      if (this._logHistory) {
        logEl.textContent = this._logHistory;
        logEl.scrollTop = logEl.scrollHeight;
      }

      contentEl.querySelector('.widget-migrate-env').addEventListener('change', (e) => {
        this._env = e.target.value;
        localStorage.setItem('migrate-env', this._env);
        this._load();
      });

      contentEl.querySelector('.widget-migrate-latest').addEventListener('click', () => {
        const ts = new Date().toLocaleTimeString();
        this._appendLog(`\n[${ts}] Running migrate:latest --env ${this._env}...\n`);
        this._socket.emit('migrate-latest', { env: this._env });
      });

      contentEl.querySelector('.widget-migrate-rollback').addEventListener('click', () => {
        const ts = new Date().toLocaleTimeString();
        this._appendLog(`\n[${ts}] Running migrate:rollback --env ${this._env}...\n`);
        this._socket.emit('migrate-rollback', { env: this._env });
      });

      contentEl.querySelector('.widget-migrate-clear').addEventListener('click', () => {
        this._logHistory = '';
        const log = contentEl.querySelector('.widget-migrate-log');
        if (log) log.textContent = '';
      });
    } catch (err) {
      contentEl.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  _appendLog(text) {
    this._logHistory += text;
    const logEl = this._el.querySelector('.widget-migrate-log');
    if (logEl) {
      logEl.textContent = this._logHistory;
      logEl.scrollTop = logEl.scrollHeight;
    }
  },

  refresh() { this._load(); },

  destroy(socket) {
    if (this._onOutput) socket.off('migrate-output', this._onOutput);
    if (this._onDone) socket.off('migrate-done', this._onDone);
  },
};
