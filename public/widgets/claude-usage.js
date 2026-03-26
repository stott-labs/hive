/* Widget: claude-usage */

WIDGET_REGISTRY['claude-usage'] = {
  title: 'Claude Usage',
  icon: '\uD83E\uDD16',
  defaultSize: { w: 2, h: 4 },
  minW: 2,
  minH: 2,

  init(contentEl, socket, config) {
    contentEl.innerHTML = '<div id="widget-claude-usage"></div>';
    const el = contentEl.querySelector('#widget-claude-usage');

    this._handler = (data) => {
      if (!data || (!data.usage && !data.sessionStats && !data.rateLimited)) {
        el.innerHTML = '<span class="panel-loading">No data</span>';
        return;
      }

      let html = '<div class="claude-usage-panel" style="margin-top:0;border:none">';

      if (data.rateLimited) {
        html += `<div class="claude-usage-rate-limit">\u26A0 Rate limited \u2014 retrying in ${data.backoffMins}m${data.usage ? ' (showing cached data)' : ''}</div>`;
      }

      if (data.usage) {
        const u = data.usage;
        html += '<div class="claude-usage-grid">';
        if (u.five_hour) html += _renderUsageBar('5-Hour', u.five_hour.utilization, u.five_hour.resets_at);
        if (u.seven_day) html += _renderUsageBar('Weekly', u.seven_day.utilization, u.seven_day.resets_at);
        if (u.seven_day_opus && u.seven_day_opus.utilization != null)
          html += _renderUsageBar('Opus (7d)', u.seven_day_opus.utilization, u.seven_day_opus.resets_at);
        if (u.seven_day_sonnet && u.seven_day_sonnet.utilization != null)
          html += _renderUsageBar('Sonnet (7d)', u.seven_day_sonnet.utilization, u.seven_day_sonnet.resets_at);
        html += '</div>';

        if (u.extra_usage && u.extra_usage.is_enabled && u.extra_usage.used_credits > 0) {
          html += `<div class="claude-usage-extra">Overuse: $${u.extra_usage.used_credits.toFixed(2)} / $${u.extra_usage.monthly_limit}</div>`;
        }
      }

      if (data.sessionStats) {
        const ss = data.sessionStats;
        html += '<div class="claude-usage-stats">';
        html += `<span class="claude-stat"><span class="claude-stat-val">${_formatNum(ss.last7Days.messages)}</span> msgs</span>`;
        html += `<span class="claude-stat"><span class="claude-stat-val">${ss.last7Days.sessions}</span> sessions</span>`;
        html += `<span class="claude-stat"><span class="claude-stat-val">${_formatNum(ss.last7Days.toolCalls)}</span> tools</span>`;
        if (ss.today) {
          html += `<span class="claude-stat today"><span class="claude-stat-val">${_formatNum(ss.today.messageCount)}</span> today</span>`;
        }
        html += '</div>';
      }

      html += '</div>';
      el.innerHTML = html;
    };

    socket.on('claude-usage', this._handler);
  },

  refresh(socket) {
    socket.emit('refresh', 'claude');
  },

  destroy(socket) {
    if (this._handler) socket.off('claude-usage', this._handler);
  },
};

// Usage bar helpers (private to widget)
function _renderUsageBar(label, pct, resetTime) {
  const barClass = pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : '';
  const resetStr = resetTime ? _formatReset(resetTime) : '';
  return `<div class="claude-usage-row">
    <span class="claude-usage-label">${label}</span>
    <div class="claude-usage-bar-wrap">
      <div class="claude-usage-bar ${barClass}" style="width:${Math.min(pct, 100)}%"></div>
    </div>
    <span class="claude-usage-pct">${Math.round(pct)}%</span>
    ${resetStr ? `<span class="claude-usage-reset" title="Resets ${resetTime}">\u21BB ${resetStr}</span>` : ''}
  </div>`;
}

function _formatNum(n) {
  const num = Number(n);
  if (isNaN(num)) return n;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

function _formatReset(isoStr) {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = d - now;
    if (diffMs <= 0) return 'now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm';
    const days = Math.floor(hrs / 24);
    return days + 'd ' + (hrs % 24) + 'h';
  } catch { return ''; }
}
