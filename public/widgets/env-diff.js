/* Widget: env-diff */

WIDGET_REGISTRY['env-diff'] = {
  title: 'Env Diff',
  icon: '\uD83D\uDD0D',
  defaultSize: { w: 6, h: 4 },
  minW: 3,
  minH: 2,

  init(contentEl) {
    this._el = contentEl;
    this._load();
  },

  async _load() {
    const el = this._el;
    try {
      const res = await fetch('/api/env-diff');
      const data = await res.json();

      if (!data.matrix || data.matrix.length === 0) {
        el.innerHTML = '<span class="panel-loading">No .env files found</span>';
        return;
      }

      const mismatches = data.matrix.filter(r => r.mismatch);

      let html = '<table class="envdiff-table"><thead><tr><th>Key</th>';
      for (const env of data.envNames) {
        const avail = data.available[env];
        html += `<th>${esc(env)}${avail ? '' : ' (N/A)'}</th>`;
      }
      html += '</tr></thead><tbody>';

      if (mismatches.length === 0) {
        html += `<tr><td colspan="${data.envNames.length + 1}" style="color:var(--green)">All keys match across available environments</td></tr>`;
      } else {
        for (const row of mismatches.slice(0, 30)) {
          html += `<tr class="mismatch"><td class="envdiff-key">${esc(row.key)}</td>`;
          for (const env of data.envNames) {
            if (!data.available[env]) {
              html += '<td class="envdiff-na">-</td>';
            } else if (row[env]) {
              html += '<td class="envdiff-present">&#10004;</td>';
            } else {
              html += '<td class="envdiff-missing">&#10008;</td>';
            }
          }
          html += '</tr>';
        }
        if (mismatches.length > 30) {
          html += `<tr><td colspan="${data.envNames.length + 1}" style="color:var(--overlay0)">...and ${mismatches.length - 30} more</td></tr>`;
        }
      }

      html += '</tbody></table>';
      el.innerHTML = html;
    } catch (err) {
      el.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  refresh() { this._load(); },
  destroy() {},
};
