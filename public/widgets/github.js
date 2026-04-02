/* Widget: github */

function _ghTimeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

WIDGET_REGISTRY['github'] = {
  title: 'GitHub',
  icon: '\uD83D\uDC19',
  settingsKey: 'github',
  defaultSize: { w: 6, h: 6 },
  minW: 3,
  minH: 3,

  init(contentEl, socket, config) {
    contentEl.innerHTML = `<div class="panel-body" id="widget-github-content">${skeletonRows(5, 'list')}</div>`;
    this._cachedPrs = [];
    this._cachedActions = [];
    this._interval = setInterval(() => this._load(contentEl), 120000);
    this._load(contentEl);
  },

  async _load(contentEl) {
    const el = contentEl.querySelector('#widget-github-content');
    if (!el) return;
    try {
      const statusRes = await fetch('/api/github/status');
      const { configured } = await statusRes.json();
      if (!configured) {
        el.innerHTML = `<div class="github-setup">
          <p>GitHub integration requires a <code>GITHUB_TOKEN</code> environment variable.</p>
          <p>Add a <code>github</code> block to <code>dashboard.config.json</code> with <code>prRepos</code> and <code>watchRepos</code>.</p>
        </div>`;
        return;
      }
      el.innerHTML = skeletonRows(4, 'list');
      const [prsRes, actionsRes] = await Promise.all([
        fetch('/api/github/prs'),
        fetch('/api/github/actions'),
      ]);
      this._cachedPrs     = prsRes.ok     ? await prsRes.json()     : [];
      this._cachedActions = actionsRes.ok ? await actionsRes.json() : [];
      this._render(contentEl);
    } catch (err) {
      if (el) el.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  _render(contentEl) {
    const el = contentEl.querySelector('#widget-github-content');
    if (!el) return;
    const prs     = this._cachedPrs;
    const actions = this._cachedActions;
    let html = '';

    // PRs
    html += `<div class="section-title" style="margin-top:0">Open Pull Requests</div>`;
    if (!prs.length) {
      html += `<div class="github-empty">No open PRs</div>`;
    } else {
      html += `<div class="github-pr-list">`;
      for (const pr of prs) {
        const repoShort = pr.repo.split('/').pop();
        const draft = pr.draft ? `<span class="github-badge github-badge-draft">Draft</span>` : '';
        html += `<div class="github-pr-item">
          <span class="github-pr-repo">${esc(repoShort)}</span>
          <span class="github-pr-title"><a href="${esc(pr.url)}" target="_blank">${esc(pr.title)}</a>${draft}</span>
          <span class="github-pr-meta">${esc(pr.author)} · updated ${_ghTimeAgo(pr.updatedAt)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    // Actions
    html += `<div class="section-title">Actions</div>`;
    if (!actions.length) {
      html += `<div class="github-empty">No workflow runs — add repos to <code>watchRepos</code> in config</div>`;
    } else {
      html += `<div class="github-actions-list">`;
      for (const run of actions) {
        const repoShort = run.repo.split('/').pop();
        const done = run.status === 'completed';
        const cls = !done ? 'github-run-in-progress'
          : run.conclusion === 'success' ? 'github-run-success'
          : run.conclusion === 'failure' ? 'github-run-failure'
          : 'github-run-neutral';
        const icon = !done ? '\u23F3'
          : run.conclusion === 'success' ? '\u2713'
          : run.conclusion === 'failure' ? '\u2717'
          : '\u2212';
        html += `<div class="github-run-item">
          <span class="github-run-status ${cls}" title="${esc(run.conclusion || run.status)}">${icon}</span>
          <span class="github-run-repo">${esc(repoShort)}</span>
          <span class="github-run-name"><a href="${esc(run.url)}" target="_blank">${esc(run.name)}</a></span>
          <span class="github-run-branch">${esc(run.branch)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    el.innerHTML = html;
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="github"] .widget-body');
    if (contentEl) this._load(contentEl);
  },

  destroy() {
    if (this._interval) clearInterval(this._interval);
  },
};
