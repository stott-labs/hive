/* Widget: contributions */

WIDGET_REGISTRY['contributions'] = {
  title: 'Contributions',
  icon: '\uD83D\uDFE9',
  defaultSize: { w: 8, h: 4 },
  minW: 3, minH: 3,

  init(contentEl) {
    this._author       = localStorage.getItem('contributions-author') || 'all';
    this._sources      = new Set(JSON.parse(localStorage.getItem('contributions-sources') || '["github","ado"]'));
    this._hideWeekends = !!localStorage.getItem('contributions-hide-weekends');
    this._data         = { github: {}, ado: {} };
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

      // GitHub contribution calendar is per-authenticated-user only — skip when
      // an ADO author filter is active since we can't map ADO names to GH logins.
      const skipGh = this._author !== 'all';
      const [ghRes, adoRes] = await Promise.all([
        skipGh ? null : fetch(`/api/github/contributions?${params}`),
        fetch(`/api/ado/contributions?${params}`),
      ]);

      this._data.github = (ghRes?.ok) ? await ghRes.json() : {};
      this._data.ado    = adoRes.ok   ? await adoRes.json() : {};

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
    html += `<span class="contrib-filter-sep"></span>`;
    html += `<button class="ado-filter-chip${this._hideWeekends ? ' active' : ''}" data-toggle="weekends">Hide weekends</button>`;
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
    bar.querySelector('[data-toggle="weekends"]')?.addEventListener('click', () => {
      this._hideWeekends = !this._hideWeekends;
      localStorage.setItem('contributions-hide-weekends', this._hideWeekends ? '1' : '');
      this._renderFilterBar(contentEl);
      this._render(contentEl);
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
      const dateLabel  = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const countLabel = count ? `${count}${parts.length ? ` (${parts.join(', ')})` : ''}` : 'no activity';
      const tip = `${dateLabel} · ${countLabel}`;
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

    // Hex grid geometry — flat-top hexagons, rectangular grid (no stagger)
    const HR       = 7;                    // radius (center to vertex)
    const HH       = HR * Math.sqrt(3);    // flat-to-flat height ≈ 12.12
    const GAP      = 4;                    // gap between adjacent hexes
    const COL_STEP = HR * 1.5 + GAP;      // x spacing between column centers
    const ROW_STEP = HH + GAP;            // y spacing between rows
    const GX       = 26;                   // left offset (room for day labels incl. "Th")
    const GY       = 28;                   // top offset (room for month labels)

    const DAY_LABELS  = ['M','T','W','Th','F','Sa','Su'];
    const visibleRows = this._hideWeekends ? [0,1,2,3,4] : [0,1,2,3,4,5,6];
    const numRows     = visibleRows.length;

    function colX(col)    { return GX + HR + col * COL_STEP; }
    function rowY(visRow) { return GY + visRow * ROW_STEP; }
    function hexPts(cx, cy) {
      let s = '';
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        s += (cx + HR * Math.cos(a)).toFixed(1) + ',' + (cy + HR * Math.sin(a)).toFixed(1) + (i < 5 ? ' ' : '');
      }
      return s;
    }

    const svgW = Math.ceil(GX + HR + (totalWeeks - 1) * COL_STEP + HR + 4);
    const svgH = Math.ceil(GY + (numRows - 1) * ROW_STEP + HH / 2 + 4);

    const monthSvg = monthMarks.map(({ weekIdx: wi, label }) =>
      `<text x="${colX(wi).toFixed(1)}" y="14" class="contrib-svg-label">${esc(label)}</text>`
    ).join('');

    const daySvg = visibleRows.map((row, visRow) =>
      `<text x="${GX - 3}" y="${(rowY(visRow) + 3).toFixed(1)}" class="contrib-svg-label" text-anchor="end">${DAY_LABELS[row]}</text>`
    ).join('');

    const hexSvg = cells.reduce((parts, { tip, level }, idx) => {
      const col    = Math.floor(idx / 7);
      const row    = idx % 7;
      const visRow = visibleRows.indexOf(row);
      if (visRow === -1) return parts;
      parts.push(`<polygon points="${hexPts(colX(col), rowY(visRow))}" class="hex-cell hex-l${level}"><title>${tip}</title></polygon>`);
      return parts;
    }, []).join('');

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
        <svg class="contrib-svg" width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">${monthSvg}${daySvg}${hexSvg}</svg>
      </div>`;
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="contributions"] .widget-body');
    if (contentEl) this._load(contentEl);
  },
  destroy() { if (this._interval) clearInterval(this._interval); },
};
