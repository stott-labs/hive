/* Widget: claude-skills */

WIDGET_REGISTRY['claude-skills'] = {
  title: 'Claude Skills',
  icon: '⚡',
  defaultSize: { w: 5, h: 7 },
  minW: 3,
  minH: 4,

  init(contentEl, socket, config) {
    contentEl.innerHTML = `<div class="cs-root">
      <div class="cs-toolbar">
        <span class="cs-summary" id="cs-summary">Loading…</span>
        <button class="btn cs-sync-btn" id="cs-sync-btn" title="Run setup.sh / setup.ps1 to sync junctions">⟳ Sync Junctions</button>
      </div>
      <div class="cs-body" id="cs-body">${skeletonRows(6, 'list')}</div>
    </div>`;
    this._load(contentEl);

    contentEl.querySelector('#cs-sync-btn').addEventListener('click', () => this._runSync(contentEl));
  },

  async _load(contentEl) {
    const body = contentEl.querySelector('#cs-body');
    const summary = contentEl.querySelector('#cs-summary');
    if (!body) return;

    let data;
    try {
      data = await fetch('/api/claude/skills').then(r => r.json());
    } catch (e) {
      body.innerHTML = `<div class="cs-error">Failed to load: ${e.message}</div>`;
      return;
    }

    const { shared = [], personal = [], stale = [], repos = {}, claudeMds = [] } = data;
    const repoEntries = Object.entries(repos);
    const totalShared = shared.length;
    const linked = shared.filter(s => s.linkStatus === 'linked').length;
    const totalPersonal = personal.length;
    const totalRepo = repoEntries.reduce((n, [, s]) => n + s.length, 0);
    const totalMds = claudeMds.filter(m => m.exists).length;

    summary.textContent = `${linked}/${totalShared} linked · ${totalMds} CLAUDE.md${totalPersonal ? ` · ${totalPersonal} personal` : ''}${totalRepo ? ` · ${totalRepo} project` : ''}`;

    let html = '';

    // CLAUDE.md files — rendered as a depth-sorted tree
    if (claudeMds.length) {
      html += `<div class="cs-section-hd">CLAUDE.md Hierarchy <span class="cs-badge cs-badge-claudemd">load order ↑</span></div>`;

      const pathDepth = p => p.replace(/\\/g, '/').split('/').filter(Boolean).length;
      const dirName   = p => p.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || p;
      const baseName  = p => p.replace(/\\/g, '/').split('/').slice(-2, -1)[0] || p; // parent dir name

      // Separate global from the rest; sort rest shallow→deep (ancestor→project)
      const globalMds = claudeMds.filter(m => m.label.startsWith('Global'));
      const treeMds   = claudeMds.filter(m => !m.label.startsWith('Global'))
                                 .sort((a, b) => pathDepth(a.path) - pathDepth(b.path));

      const minDepth = treeMds.length ? pathDepth(treeMds[0].path) : 0;

      // Global entry (always first — loaded before everything)
      for (const m of globalMds) {
        const badge = m.exists ? `<span class="cs-badge cs-badge-ok">✓</span>` : `<span class="cs-badge cs-badge-muted">—</span>`;
        const clickable = m.exists ? `data-claudemd="${btoa(m.path)}" data-name="${m.label}"` : '';
        html += `<div class="cs-row cs-tree-global ${m.exists ? '' : 'cs-row-missing'}" ${clickable}>
          <div class="cs-row-main"><span class="cs-name cs-name-md">~/.claude/CLAUDE.md</span>${badge}</div>
          ${m.preview ? `<div class="cs-preview">${m.preview.replace(/</g,'&lt;')}</div>` : '<div class="cs-desc cs-row-missing-hint">not found — global instructions go here</div>'}
        </div>`;
      }

      // Tree entries
      for (let i = 0; i < treeMds.length; i++) {
        const m = treeMds[i];
        const depth = pathDepth(m.path) - minDepth;
        const isLast = i === treeMds.length - 1 ||
                       (pathDepth(treeMds[i + 1].path) - minDepth) <= depth;
        const connector = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
        const dirLabel = baseName(m.path);
        const badge = m.exists ? `<span class="cs-badge cs-badge-ok">✓</span>` : `<span class="cs-badge cs-badge-muted">—</span>`;
        const clickable = m.exists ? `data-claudemd="${btoa(m.path)}" data-name="${dirLabel}"` : '';

        const indent = depth * 14;
        html += `<div class="cs-row cs-tree-item ${m.exists ? '' : 'cs-row-missing'}" data-depth="${depth}" style="padding-left:${indent + 10}px" ${clickable}>
          <div class="cs-row-main">
            ${connector ? `<span class="cs-tree-connector">${connector}</span>` : ''}
            <span class="cs-name cs-name-md">CLAUDE.md</span>
            ${badge}
            <span class="cs-tree-dir">${dirLabel}/</span>
          </div>
          ${m.preview ? `<div class="cs-preview cs-tree-preview" style="padding-left:${connector ? 16 : 0}px">${m.preview.replace(/</g,'&lt;')}</div>` : ''}
        </div>`;
      }
    }

    // Shared skills
    html += `<div class="cs-section-hd">Skills — Shared <span class="cs-badge cs-badge-shared">claude-shared</span></div>`;
    for (const s of shared) {
      const badge = s.linkStatus === 'linked'
        ? `<span class="cs-badge cs-badge-ok">✓ linked</span>`
        : s.linkStatus === 'directory'
          ? `<span class="cs-badge cs-badge-warn">⚠ dir</span>`
          : `<span class="cs-badge cs-badge-err">✗ not linked</span>`;
      html += `<div class="cs-row" data-path="${btoa(s.path)}" data-name="${s.name}">
        <div class="cs-row-main"><span class="cs-name">/${s.name}</span>${badge}</div>
        <div class="cs-desc">${s.description || ''}</div>
      </div>`;
    }

    // Stale junctions
    if (stale.length) {
      html += `<div class="cs-section-hd cs-section-warn">Stale Junctions</div>`;
      for (const s of stale) {
        html += `<div class="cs-row">
          <div class="cs-row-main"><span class="cs-name">/${s.name}</span><span class="cs-badge cs-badge-err">⚠ stale</span></div>
          <div class="cs-desc" style="color:var(--subtext0);font-size:10px">${s.linkTarget}</div>
        </div>`;
      }
    }

    // Personal
    if (personal.length) {
      html += `<div class="cs-section-hd">Skills — Personal <span class="cs-badge cs-badge-personal">~/.claude/skills</span></div>`;
      for (const s of personal) {
        html += `<div class="cs-row" data-path="${btoa(s.path)}" data-name="${s.name}">
          <div class="cs-row-main"><span class="cs-name">/${s.name}</span></div>
          <div class="cs-desc">${s.description || ''}</div>
        </div>`;
      }
    }

    // Per-repo skills
    for (const [repoName, skills] of repoEntries) {
      html += `<div class="cs-section-hd">Skills — ${repoName} <span class="cs-badge cs-badge-repo">.claude/skills</span></div>`;
      for (const s of skills) {
        html += `<div class="cs-row" data-path="${btoa(s.path)}" data-name="${s.name}">
          <div class="cs-row-main"><span class="cs-name">/${s.name}</span></div>
          <div class="cs-desc">${s.description || ''}</div>
        </div>`;
      }
    }

    body.innerHTML = html;

    // Wire skill rows → SKILL.md editor
    body.querySelectorAll('.cs-row[data-path]').forEach(row => {
      row.addEventListener('click', () => this._openEditor(row.dataset.name, row.dataset.path, 'skill'));
    });
    // Wire CLAUDE.md rows → CLAUDE.md editor
    body.querySelectorAll('.cs-row[data-claudemd]').forEach(row => {
      row.addEventListener('click', () => this._openEditor(row.dataset.name, row.dataset.claudemd, 'claudemd'));
    });
  },

  async _openEditor(name, pathB64, type = 'skill') {
    let content, mdPath, exists = true;
    try {
      const url = type === 'claudemd'
        ? `/api/claude/claudemd?p=${encodeURIComponent(pathB64)}`
        : `/api/claude/skill?p=${encodeURIComponent(pathB64)}`;
      const r = await fetch(url).then(r => r.json());
      content = r.content;
      mdPath = r.path;
      exists = r.exists !== false;
    } catch (e) {
      alert('Could not load skill: ' + e.message);
      return;
    }

    // Build modal
    const overlay = document.createElement('div');
    const fileLabel = type === 'claudemd' ? 'CLAUDE.md' : 'SKILL.md';
    const newFilePlaceholder = !exists ? `\n<!-- New file — will be created on save -->` : '';

    overlay.className = 'cs-modal-overlay';
    overlay.innerHTML = `
      <div class="cs-modal">
        <div class="cs-modal-header">
          <span class="cs-modal-title">${name} — ${fileLabel}</span>
          <span class="cs-modal-path">${mdPath}</span>
          <button class="cs-modal-close" title="Close">×</button>
        </div>
        <textarea class="cs-modal-editor" spellcheck="false">${(content || newFilePlaceholder).replace(/</g, '&lt;')}</textarea>
        <div class="cs-modal-footer">
          <span class="cs-modal-status">${!exists ? '⚠ File does not exist yet — Save to create it' : ''}</span>
          <button class="btn cs-modal-save">Save</button>
          <button class="btn cs-modal-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    overlay.querySelector('.cs-modal-close').addEventListener('click', close);
    overlay.querySelector('.cs-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('.cs-modal-save').addEventListener('click', async () => {
      const newContent = overlay.querySelector('.cs-modal-editor').value;
      const status = overlay.querySelector('.cs-modal-status');
      status.textContent = 'Saving…';
      const saveUrl = type === 'claudemd' ? '/api/claude/claudemd' : '/api/claude/skill';
      try {
        const r = await fetch(saveUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ p: pathB64, content: newContent }),
        });
        if (r.ok) { status.textContent = '✓ Saved'; setTimeout(close, 800); }
        else { const e = await r.json(); status.textContent = '✗ ' + e.error; }
      } catch (e) { status.textContent = '✗ ' + e.message; }
    });
  },

  async _runSync(contentEl) {
    const btn = contentEl.querySelector('#cs-sync-btn');
    btn.disabled = true;
    btn.textContent = '⟳ Syncing…';

    // Stream output to a log panel
    const body = contentEl.querySelector('#cs-body');
    const pre = document.createElement('pre');
    pre.className = 'cs-sync-log';
    pre.textContent = '';
    body.innerHTML = '';
    body.appendChild(pre);

    try {
      const resp = await fetch('/api/claude/sync', { method: 'POST' });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pre.textContent += dec.decode(value);
        pre.scrollTop = pre.scrollHeight;
      }
    } catch (e) {
      pre.textContent += '\nError: ' + e.message;
    }

    btn.disabled = false;
    btn.textContent = '⟳ Sync Junctions';
    setTimeout(() => this._load(contentEl), 1000);
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="claude-skills"] .widget-body');
    if (contentEl) this._load(contentEl);
  },
  destroy() {},
};
