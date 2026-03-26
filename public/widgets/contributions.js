/* Widget: contributions */

WIDGET_REGISTRY['contributions'] = {
  title: 'Contributions',
  icon: '\uD83D\uDFE9',
  defaultSize: { w: 8, h: 4 },
  minW: 3, minH: 3,

  init(contentEl) {
    this._author  = localStorage.getItem('contributions-author') || 'all';
    this._sources = new Set(JSON.parse(localStorage.getItem('contributions-sources') || '["github","ado"]'));
    this._data    = { github: {}, ado: {} };
    contentEl.innerHTML = `
      <div class="ch-filter-bar" id="contrib-filter-bar"></div>
      <div class="panel-body" id="contrib-body">${skeletonRows(3, 'list')}</div>`;
    this._interval = setInterval(() => this._load(contentEl), 10 * 60 * 1000);
    this._load(contentEl);
  },

  async _load(contentEl) {
    const body = contentEl.querySelector('#contrib-body');
    if (!body) return;
    try {
      const params = new URLSearchParams({ days: 180 });
      if (this._author !== 'all') params.set('author', this._author);

      const [ghRes, adoRes] = await Promise.all([
        fetch(`/api/github/contributions?${params}`),
        fetch(`/api/ado/contributions?${params}`),
      ]);

      this._data.github = ghRes.ok  ? await ghRes.json()  : {};
      this._data.ado    = adoRes.ok ? await adoRes.json() : {};

      this._renderFilterBar(contentEl);
      this._render(contentEl);
    } catch (err) {
      if (body) body.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  _renderFilterBar(contentEl) {
    const bar = contentEl.querySelector('#contrib-filter-bar');
    if (!bar) return;

    const SOURCE_LABELS = { github: 'GitHub', ado: 'ADO' };
    const users = window.DASH_CONFIG?.adoUsers || [];

    let html = '';
    // Source toggles
    for (const [key, label] of Object.entries(SOURCE_LABELS)) {
      const active = this._sources.has(key);
      html += `<button class="ado-filter-chip contrib-src-chip${active ? ' active' : ''}" data-source="${key}">${label}</button>`;
    }
    html += `<span class="contrib-filter-sep"></span>`;
    // Author filter
    html += `<button class="ado-filter-chip${this._author === 'all' ? ' active' : ''}" data-author="all">All</button>`;
    for (const u of users) {
      html += `<button class="ado-filter-chip${this._author === u ? ' active' : ''}" data-author="${esc(u)}">${esc(u.split(' ')[0])}</button>`;
    }
    bar.innerHTML = html;

    bar.querySelectorAll('.contrib-src-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.source;
        if (this._sources.has(src)) {
          if (this._sources.size > 1) this._sources.delete(src); // keep at least one
        } else {
          this._sources.add(src);
        }
        localStorage.setItem('contributions-sources', JSON.stringify([...this._sources]));
        this._renderFilterBar(contentEl);
        this._render(contentEl);
      });
    });
    bar.querySelectorAll('[data-author]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._author = btn.dataset.author;
        localStorage.setItem('contributions-author', this._author);
        this._load(contentEl);
      });
    });
  },

  _render(contentEl) {
    const body = contentEl.querySelector('#contrib-body');
    if (!body) return;

    // Merge active sources into combined byDay map
    const byDay = {};
    for (const src of this._sources) {
      for (const [day, count] of Object.entries(this._data[src] || {})) {
        if (!byDay[day]) byDay[day] = { total: 0, github: 0, ado: 0 };
        byDay[day][src]   = (byDay[day][src] || 0) + count;
        byDay[day].total += count;
      }
    }

    const total = Object.values(byDay).reduce((s, d) => s + d.total, 0);

    // Build 52-week grid
    const WEEKS = 26;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - WEEKS * 7 + 1);
    const dow = start.getDay();
    start.setDate(start.getDate() - (dow === 0 ? 6 : dow - 1));

    const cells = [];
    const monthMarks = [];
    let lastMonth = -1, weekIdx = 0, dayInWeek = 0;
    const d = new Date(start);
    while (d <= today) {
      const ds = d.toISOString().split('T')[0];
      const entry = byDay[ds] || { total: 0, github: 0, ado: 0 };
      const count = entry.total;
      const level = count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : count <= 10 ? 3 : 4;
      const parts = [];
      if (entry.github) parts.push(`GH:${entry.github}`);
      if (entry.ado)    parts.push(`ADO:${entry.ado}`);
      const tip = `${ds}: ${count} (${parts.join(', ') || 'none'})`;
      cells.push({ ds, count, level, tip });

      if (d.getMonth() !== lastMonth) {
        monthMarks.push({ weekIdx, label: d.toLocaleString('default', { month: 'short' }) });
        lastMonth = d.getMonth();
      }
      dayInWeek++;
      if (dayInWeek === 7) { dayInWeek = 0; weekIdx++; }
      d.setDate(d.getDate() + 1);
    }
    const totalWeeks = weekIdx + 1;

    // Stats
    let streak = 0, longest = 0, run = 0, bestDay = '', bestCount = 0;
    const sd = new Date(today);
    for (let i = 0; i < 365; i++) {
      const ds = sd.toISOString().split('T')[0];
      const c = (byDay[ds] || {}).total || 0;
      if (c > 0) {
        if (i === 0 || streak > 0) streak++;
        run++; if (run > longest) longest = run;
      } else { if (i === 0) streak = 0; run = 0; }
      if (c > bestCount) { bestCount = c; bestDay = ds; }
      sd.setDate(sd.getDate() - 1);
    }

    // Source legend
    const SRC_COLORS = { github: 'var(--green)', ado: 'var(--mauve)' };
    const legendHtml = [...this._sources].map(s =>
      `<span class="contrib-legend-dot" style="background:${SRC_COLORS[s]}"></span><span class="contrib-legend-label">${s === 'github' ? 'GitHub' : s.toUpperCase()}</span>`
    ).join('');

    const monthHtml = monthMarks.map(({ weekIdx: wi, label }) =>
      `<div class="contrib-month" style="grid-column:${wi+1}">${esc(label)}</div>`
    ).join('');

    const cellHtml = cells.map(({ tip, level }) =>
      `<div class="contrib-cell contrib-l${level}" title="${tip}"></div>`
    ).join('');

    body.innerHTML = `
      <div class="contrib-stats">
        <span>${total.toLocaleString()} contributions</span>
        <span class="contrib-sep">·</span>
        <span>streak <strong>${streak}d</strong></span>
        <span class="contrib-sep">·</span>
        <span>longest <strong>${longest}d</strong></span>
        ${bestCount ? `<span class="contrib-sep">·</span><span>best <strong>${bestCount}</strong> on ${bestDay}</span>` : ''}
        <span class="contrib-legend">${legendHtml}</span>
      </div>
      <div class="contrib-wrap">
        <div class="contrib-day-labels"><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span><span></span></div>
        <div class="contrib-right">
          <div class="contrib-months" style="grid-template-columns:repeat(${totalWeeks},10px)">${monthHtml}</div>
          <div class="contrib-grid" style="grid-template-columns:repeat(${totalWeeks},10px)">${cellHtml}</div>
        </div>
      </div>`;
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="contributions"] .widget-body');
    if (contentEl) this._load(contentEl);
  },
  destroy() { if (this._interval) clearInterval(this._interval); },
};
