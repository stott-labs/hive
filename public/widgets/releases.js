/* Widget: releases */

WIDGET_REGISTRY['releases'] = {
  title: 'Releases',
  icon: '\uD83D\uDE80',
  defaultSize: { w: 4, h: 6 },
  minW: 2,
  minH: 2,

  init(contentEl, socket, config) {
    contentEl.innerHTML = `<div class="panel-body" id="widget-releases-content">${skeletonRows(4, 'card')}</div>`;
    this._load(contentEl);
  },

  async _load(contentEl) {
    const el = contentEl.querySelector('#widget-releases-content') || contentEl;
    try {
      const res = await fetch('/api/releases');
      const data = await res.json();
      if (!data.length) {
        el.innerHTML = '<span class="panel-loading">No releases found</span>';
        return;
      }

      let html = '<div class="releases-timeline">';
      for (const r of data.slice(0, 8)) {
        html += `<div class="release-item">
          <span class="release-version">${esc(r.version || r.buildId || '')}</span>
          <span class="release-date">${esc(r.date || '')}</span>
          <span class="release-desc" title="${esc(r.description || '')}">${esc(r.description || r.title || '')}</span>
        </div>`;
      }
      html += '</div>';
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="releases"] .widget-body');
    if (contentEl) this._load(contentEl);
  },

  destroy() {},
};
