/* Widget: sentry */

WIDGET_REGISTRY['sentry'] = {
  title: 'Sentry',
  icon: '\uD83D\uDC1B',
  settingsKey: 'sentry',
  defaultSize: { w: 4, h: 6 },
  minW: 3,
  minH: 3,

  init(contentEl, socket, config) {
    contentEl.innerHTML = `
      <div class="section-title-row" style="margin-bottom:4px">
        <div class="sentry-filter-bar" id="widget-sentry-filter-bar"></div>
      </div>
      <div class="panel-body" id="widget-sentry-content">
        ${skeletonRows(5, 'list')}
      </div>
    `;

    this._projectFilter = localStorage.getItem('sentry-project-filter') || null;
    this._interval = setInterval(() => this._load(contentEl), 60000);
    this._load(contentEl);
  },

  async _load(contentEl) {
    const el = contentEl.querySelector('#widget-sentry-content');
    const filterBar = contentEl.querySelector('#widget-sentry-filter-bar');
    if (!el) return;

    try {
      const statusRes = await fetch('/api/sentry/status');
      const statusData = await statusRes.json();

      if (!statusData.configured) {
        el.innerHTML = `<div class="ado-setup">
          <p>Sentry integration requires configuration.</p>
        </div>`;
        return;
      }

      const sentryProjects = (window.DASH_CONFIG || {}).sentryProjects || [];
      if (!this._projectFilter || (sentryProjects.length > 0 && !sentryProjects.includes(this._projectFilter))) {
        this._projectFilter = sentryProjects[0] || '';
        localStorage.setItem('sentry-project-filter', this._projectFilter);
      }

      if (filterBar) {
        let filterHtml = '';
        for (const proj of sentryProjects) {
          filterHtml += `<button class="ado-filter-chip${this._projectFilter === proj ? ' active' : ''}" data-sentry-filter="${esc(proj)}">${esc(proj)}</button>`;
        }
        filterBar.innerHTML = filterHtml;
        filterBar.querySelectorAll('.ado-filter-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            this._projectFilter = chip.dataset.sentryFilter;
            localStorage.setItem('sentry-project-filter', this._projectFilter);
            this._load(contentEl);
          });
        });
      }

      const res = await fetch('/api/sentry/issues?project=' + encodeURIComponent(this._projectFilter));
      const issues = await res.json();

      if (issues.error) throw new Error(issues.error);

      if (!issues.length) {
        el.innerHTML = '<span class="panel-loading">No unresolved issues</span>';
        return;
      }

      let html = '<ul class="ado-wi-list">';
      for (const issue of issues) {
        const levelClass = issue.level === 'fatal' ? 'error' : issue.level;
        html += `<li class="ado-wi-item sentry-issue-row" data-issue-id="${esc(issue.id)}" title="Click to view stack trace">
          <span class="sentry-level ${esc(levelClass)}">${esc(issue.level)}</span>
          <span class="ado-wi-id"><a href="${esc(issue.permalink)}" target="_blank" onclick="event.stopPropagation()">${esc(issue.shortId)}</a></span>
          <span class="ado-wi-title">${esc(issue.title)}</span>
          <span class="sentry-counts">${issue.count}x / ${issue.userCount}u</span>
          <span class="sentry-time">${_relativeTime(issue.lastSeen)}</span>
          <button class="ado-wi-action" data-cmd="/create-bug ${esc(issue.title)}" title="Copy /create-bug to clipboard" onclick="event.stopPropagation()">&#128027;</button>
        </li>`;
      }
      html += '</ul>';
      el.innerHTML = html;

      // Wire up click → Sentry detail overlay
      el.querySelectorAll('.sentry-issue-row').forEach(row => {
        row.addEventListener('click', () => {
          if (typeof window.openSentryIssue === 'function') {
            window.openSentryIssue(row.dataset.issueId);
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="sentry"] .widget-body');
    if (contentEl) this._load(contentEl);
  },

  destroy() {
    if (this._interval) clearInterval(this._interval);
  },
};

function _relativeTime(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}
