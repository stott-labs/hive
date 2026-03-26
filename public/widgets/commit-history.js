/* Widget: commit-history */

WIDGET_REGISTRY['commit-history'] = {
  title: 'Commit History',
  icon: '\uD83D\uDDD3',
  defaultSize: { w: 6, h: 7 },
  minW: 4, minH: 4,

  init(contentEl) {
    this._author = localStorage.getItem('commit-history-author') || 'all';
    this._expanded = new Set();
    this._cached = [];
    contentEl.innerHTML = `
      <div class="ch-filter-bar" id="ch-filter-bar"></div>
      <div class="panel-body" id="ch-body">${skeletonRows(6, 'list')}</div>`;
    this._interval = setInterval(() => this._load(contentEl), 5 * 60 * 1000);
    this._load(contentEl);
  },

  async _load(contentEl) {
    const body = contentEl.querySelector('#ch-body');
    if (!body) return;
    try {
      const params = new URLSearchParams({ limit: 80 });
      if (this._author !== 'all') params.set('author', this._author);
      const res = await fetch(`/api/commits?${params}`);
      this._cached = res.ok ? await res.json() : [];
      this._renderFilterBar(contentEl);
      this._render(contentEl);
    } catch (err) {
      if (body) body.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  _renderFilterBar(contentEl) {
    const bar = contentEl.querySelector('#ch-filter-bar');
    if (!bar) return;
    const users = window.DASH_CONFIG?.adoUsers || [];
    let html = `<button class="ado-filter-chip${this._author === 'all' ? ' active' : ''}" data-author="all">All</button>`;
    for (const u of users) {
      html += `<button class="ado-filter-chip${this._author === u ? ' active' : ''}" data-author="${esc(u)}">${esc(u.split(' ')[0])}</button>`;
    }
    bar.innerHTML = html;
    bar.querySelectorAll('.ado-filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        this._author = btn.dataset.author;
        localStorage.setItem('commit-history-author', this._author);
        this._load(contentEl);
      });
    });
  },

  _render(contentEl) {
    const body = contentEl.querySelector('#ch-body');
    if (!body) return;
    const commits = this._cached;
    if (!commits.length) { body.innerHTML = '<div class="ch-empty">No commits found</div>'; return; }

    const repoNames = [...new Set(commits.map(c => c.repo))].sort();
    const repoColor = Object.fromEntries(repoNames.map((r, i) => [r, i % 8]));

    const now = new Date();
    function groupLabel(dateStr) {
      const diffDays = Math.floor((now - new Date(dateStr)) / 86400000);
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7)  return 'This Week';
      if (diffDays < 14) return 'Last Week';
      return new Date(dateStr).toLocaleString('default', { month: 'long', year: 'numeric' });
    }
    function timeAgo(dateStr) {
      const s = Math.floor((now - new Date(dateStr)) / 1000);
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s/60)}m`;
      if (s < 86400) return `${Math.floor(s/3600)}h`;
      return `${Math.floor(s/86400)}d`;
    }
    function linkify(msg) {
      const adoOrg  = window.DASH_CONFIG?.adoOrg     || '';
      const adoProj = window.DASH_CONFIG?.adoProject  || '';
      return esc(msg)
        .replace(/AB#(\d+)/g, adoOrg
          ? `<a class="ch-link" href="https://dev.azure.com/${esc(adoOrg)}/${esc(adoProj)}/_workitems/edit/$1" target="_blank">AB#$1</a>`
          : `<span class="ch-ref">AB#$1</span>`)
        .replace(/(?<!AB)#(\d+)(?!\d)/g, `<span class="ch-ref">#$1</span>`);
    }

    let html = '';
    let lastGroup = '';
    for (const c of commits) {
      const group = groupLabel(c.date);
      if (group !== lastGroup) {
        if (lastGroup) html += '</div>';
        html += `<div class="ch-group"><div class="ch-group-label">${esc(group)}</div>`;
        lastGroup = group;
      }
      const ci = repoColor[c.repo];
      html += `<div class="ch-row" data-hash="${esc(c.hash)}">
        <span class="ch-dot ch-color-${ci}"></span>
        <span class="ch-repo ch-color-text-${ci}" title="${esc(c.repo)}">${esc(c.repo.split('-').pop())}</span>
        <span class="ch-hash">${esc(c.shortHash)}</span>
        <span class="ch-msg">${linkify(c.message)}</span>
        <span class="ch-meta">${esc(c.author.split(' ')[0])} <span class="ch-time">${timeAgo(c.date)}</span></span>
      </div>`;
    }
    if (lastGroup) html += '</div>';
    body.innerHTML = html;
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="commit-history"] .widget-body');
    if (contentEl) this._load(contentEl);
  },
  destroy() { if (this._interval) clearInterval(this._interval); },
};
