/* Widget: metric — registerMetricWidget factory + unregisterMetricWidget */

const METRIC_ICONS = {
  'number-metric': '🔢',
  'delta-metric':  '📈',
  'table-list':    '📋',
  'kv-card':       '🗂️',
  'bar-chart':     '📊',
  'status-badges': '🏷️',
  'gauge':         '🌡️',
};

function _metricEsc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMetricWidget(metric, data) {
  const { widgetType, widgetConfig = {} } = metric;
  const { columns = [], rows = [] } = data;

  if (!columns.length && !rows.length) {
    return `<div class="metric-empty">No data returned</div>`;
  }

  switch (widgetType) {
    case 'number-metric': {
      const col = widgetConfig.valueColumn || columns[0];
      const val = rows[0] ? rows[0][col] : null;
      const display = val == null ? '—' : Number(val).toLocaleString(undefined, {
        maximumFractionDigits: widgetConfig.decimalPlaces ?? 0,
      });
      const unit = widgetConfig.unit ? `<span class="metric-unit">${_metricEsc(widgetConfig.unit)}</span>` : '';
      const label = widgetConfig.label || metric.name;
      return `<div class="metric-number-wrap">
        <div class="metric-number-value">${_metricEsc(display)}${unit}</div>
        <div class="metric-number-label">${_metricEsc(label)}</div>
      </div>`;
    }

    case 'delta-metric': {
      const col = widgetConfig.valueColumn || columns[0];
      const val = rows[0] ? rows[0][col] : null;
      const prev = metric._prevValue;
      const display = val == null ? '—' : Number(val).toLocaleString(undefined, {
        maximumFractionDigits: widgetConfig.decimalPlaces ?? 0,
      });
      const unit = widgetConfig.unit ? `<span class="metric-unit">${_metricEsc(widgetConfig.unit)}</span>` : '';
      const label = widgetConfig.label || metric.name;
      let deltaHtml = '';
      if (prev != null && val != null) {
        const diff = Number(val) - Number(prev);
        const sign = diff >= 0 ? '+' : '';
        const cls = diff > 0 ? 'metric-delta-up' : diff < 0 ? 'metric-delta-down' : 'metric-delta-flat';
        const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '▶';
        deltaHtml = `<span class="${cls}">${arrow} ${sign}${diff.toLocaleString(undefined, { maximumFractionDigits: widgetConfig.decimalPlaces ?? 0 })}</span>`;
      }
      return `<div class="metric-number-wrap">
        <div class="metric-number-value">${_metricEsc(display)}${unit}</div>
        <div class="metric-delta-row">${deltaHtml}</div>
        <div class="metric-number-label">${_metricEsc(label)}</div>
      </div>`;
    }

    case 'table-list': {
      const limit = widgetConfig.rowLimit || 50;
      const visibleCols = widgetConfig.columns?.length ? widgetConfig.columns : columns;
      const sliced = rows.slice(0, limit);
      const thead = visibleCols.map(c => `<th>${_metricEsc(c)}</th>`).join('');
      const tbody = sliced.map(row =>
        `<tr>${visibleCols.map(c => `<td>${_metricEsc(row[c] ?? '')}</td>`).join('')}</tr>`
      ).join('');
      const more = rows.length > limit ? `<div class="metric-table-more">Showing ${limit} of ${rows.length} rows</div>` : '';
      return `<div class="metric-table-wrap"><table class="metric-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>${more}</div>`;
    }

    case 'kv-card': {
      const row = rows[0] || {};
      const pairs = columns.map(c => `
        <div class="metric-kv-row">
          <span class="metric-kv-key">${_metricEsc(c)}</span>
          <span class="metric-kv-val">${_metricEsc(row[c] ?? '—')}</span>
        </div>`).join('');
      return `<div class="metric-kv-wrap">${pairs}</div>`;
    }

    case 'bar-chart': {
      const labelCol = widgetConfig.labelColumn || columns[0];
      const valueCol = widgetConfig.valueColumn || columns[1] || columns[0];
      const limit = widgetConfig.rowLimit || 20;
      const sliced = rows.slice(0, limit);
      const vals = sliced.map(r => parseFloat(r[valueCol]) || 0);
      const maxVal = Math.max(...vals, 1);
      const bars = sliced.map(row => {
        const pct = Math.round((parseFloat(row[valueCol]) || 0) / maxVal * 100);
        return `<div class="metric-bar-row">
          <span class="metric-bar-label" title="${_metricEsc(row[labelCol])}">${_metricEsc(row[labelCol])}</span>
          <div class="metric-bar-track"><div class="metric-bar-fill" style="width:${pct}%"></div></div>
          <span class="metric-bar-val">${_metricEsc(row[valueCol])}</span>
        </div>`;
      }).join('');
      return `<div class="metric-barchart-wrap">${bars}</div>`;
    }

    case 'status-badges': {
      const statusCol = widgetConfig.statusColumn || columns[0];
      const labelCol  = widgetConfig.labelColumn  || (columns.find(c => c !== statusCol) || columns[0]);
      const colorMap  = widgetConfig.colorMap || {};
      const badges = rows.map(row => {
        const status = String(row[statusCol] ?? '');
        const label  = widgetConfig.showLabel !== false ? String(row[labelCol] ?? '') : '';
        const color  = colorMap[status] || (
          /true|yes|ok|active|up|pass/i.test(status) ? 'var(--green)' :
          /false|no|error|fail|down|inactive/i.test(status) ? 'var(--red)' :
          'var(--yellow)'
        );
        return `<div class="metric-badge" style="--badge-color:${color}">
          ${label ? `<span class="metric-badge-label">${_metricEsc(label)}</span>` : ''}
          <span class="metric-badge-status">${_metricEsc(status)}</span>
        </div>`;
      }).join('');
      return `<div class="metric-badges-wrap">${badges}</div>`;
    }

    case 'gauge': {
      const col    = widgetConfig.valueColumn || columns[0];
      const val    = parseFloat(rows[0]?.[col]) || 0;
      const maxVal = parseFloat(widgetConfig.maxValue) || 100;
      const pct    = Math.min(Math.max(val / maxVal, 0), 1);
      const label  = widgetConfig.label || metric.name;
      const unit   = widgetConfig.unit || '';
      // SVG arc gauge (half-circle)
      const r = 54, cx = 64, cy = 70;
      const startAngle = Math.PI;
      const endAngle   = 2 * Math.PI;
      const angle      = startAngle + pct * Math.PI;
      const sx = cx + r * Math.cos(startAngle);
      const sy = cy + r * Math.sin(startAngle);
      const ex = cx + r * Math.cos(endAngle);
      const ey = cy + r * Math.sin(endAngle);
      const fx = cx + r * Math.cos(angle);
      const fy = cy + r * Math.sin(angle);
      const trackPath  = `M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey}`;
      const fillPath   = `M ${sx} ${sy} A ${r} ${r} 0 ${pct > 0.5 ? 1 : 0} 1 ${fx} ${fy}`;
      const hue = Math.round(pct * 120);
      const fillColor = `hsl(${hue},70%,60%)`;
      return `<div class="metric-gauge-wrap">
        <svg viewBox="0 0 128 80" class="metric-gauge-svg">
          <path d="${trackPath}" fill="none" stroke="var(--surface1)" stroke-width="12" stroke-linecap="round"/>
          <path d="${fillPath}" fill="none" stroke="${fillColor}" stroke-width="12" stroke-linecap="round"/>
          <text x="${cx}" y="${cy - 8}" text-anchor="middle" class="metric-gauge-val">${_metricEsc(val.toLocaleString())}${_metricEsc(unit)}</text>
          <text x="${cx}" y="${cy + 10}" text-anchor="middle" class="metric-gauge-label">${_metricEsc(label)}</text>
        </svg>
      </div>`;
    }

    default:
      return `<div class="metric-empty">Unknown widget type: ${_metricEsc(widgetType)}</div>`;
  }
}

window.registerMetricWidget = function registerMetricWidget(metric) {
  const widgetId = 'metric-' + metric.id;

  WIDGET_REGISTRY[widgetId] = {
    title: metric.name,
    icon: METRIC_ICONS[metric.widgetType] || '📊',
    defaultSize: metric.defaultSize || { w: 3, h: 3 },
    minW: 2,
    minH: 2,
    _metricId: metric.id,

    init(contentEl, _socket, _config) {
      this._contentEl = contentEl;
      contentEl.innerHTML = skeletonRows(3, 'card');
      this._doLoad();
      const interval = metric.refreshInterval;
      if (interval > 0) {
        this._timer = setInterval(() => this._doLoad(), interval * 1000);
      }
    },

    async _doLoad() {
      const el = this._contentEl;
      if (!el) return;
      try {
        const res  = await fetch(`/api/metrics/${metric.id}/query`, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
          el.innerHTML = `<div class="metric-error">${_metricEsc(data.error)}</div>`;
          return;
        }
        // Store previous value for delta metrics
        if (metric.widgetType === 'delta-metric') {
          const col = metric.widgetConfig?.valueColumn || (data.columns[0]);
          if (data.rows[0] && col) {
            metric._prevValue = metric._currentValue ?? null;
            metric._currentValue = data.rows[0][col];
          }
        }
        el.innerHTML = renderMetricWidget(metric, data) +
          `<div class="metric-footer">
            <span class="metric-footer-time">${data.time}ms · ${data.rowCount} row${data.rowCount !== 1 ? 's' : ''}</span>
            <button class="metric-edit-btn" data-metric-id="${metric.id}" title="Edit metric">✎</button>
          </div>`;
        el.querySelector('.metric-edit-btn')?.addEventListener('click', () => {
          if (window.openMetricCreator) window.openMetricCreator(metric.id);
        });
      } catch (err) {
        el.innerHTML = `<div class="metric-error">Failed to load: ${_metricEsc(err.message)}</div>`;
      }
    },

    refresh() { this._doLoad(); },

    destroy() {
      if (this._timer) clearInterval(this._timer);
    },
  };
};

window.unregisterMetricWidget = function unregisterMetricWidget(metricId) {
  delete WIDGET_REGISTRY['metric-' + metricId];
};
