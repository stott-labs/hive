/* ==========================================================================
   Sentry Issue Detail Overlay — stack frame viewer with Repo viewer jump
   ========================================================================== */

(function () {
  let isOpen = false;
  let loadingId = null;

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------
  function openOverlay() {
    isOpen = true;
    const el = document.getElementById('sentry-detail-overlay');
    if (el) el.style.display = 'flex';
  }

  function closeOverlay() {
    isOpen = false;
    const el = document.getElementById('sentry-detail-overlay');
    if (el) el.style.display = 'none';
    loadingId = null;
  }

  // ---------------------------------------------------------------------------
  // Main entry point — called by Sentry widget row click
  // ---------------------------------------------------------------------------
  async function openSentryIssue(id) {
    if (loadingId === id) return;
    loadingId = id;

    renderLoading();
    openOverlay();

    try {
      const resp = await fetch(`/api/sentry/issue/${encodeURIComponent(id)}`);
      if (!resp.ok) {
        const { error } = await resp.json().catch(() => ({}));
        renderError(error || `HTTP ${resp.status}`);
        return;
      }
      const data = await resp.json();
      if (loadingId !== id) return; // overlay was closed or different issue opened
      renderIssue(data);
    } catch (err) {
      if (loadingId === id) renderError(err.message);
    }
  }
  window.openSentryIssue = openSentryIssue;

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------
  function getBody() { return document.getElementById('sentry-detail-body'); }

  function renderLoading() {
    const hdr = document.getElementById('sentry-detail-header');
    if (hdr) hdr.innerHTML = '<span style="color:var(--subtext0)">Loading…</span>';
    const body = getBody();
    if (body) body.innerHTML = '<div class="sentry-detail-placeholder">Fetching issue details…</div>';
  }

  function renderError(msg) {
    const body = getBody();
    if (body) body.innerHTML = `<div class="sentry-detail-placeholder sentry-detail-error">${esc(msg)}</div>`;
  }

  function renderIssue(issue) {
    // Header
    const hdr = document.getElementById('sentry-detail-header');
    if (hdr) {
      const levelClass = issue.level === 'fatal' ? 'error' : (issue.level || 'error');
      hdr.innerHTML = `
        <span class="sentry-level ${esc(levelClass)}">${esc(issue.level || 'error')}</span>
        <span class="sentry-detail-short-id">${esc(issue.shortId)}</span>
        <span class="sentry-detail-title">${esc(issue.title)}</span>
        <div class="sentry-detail-meta">
          <span>${issue.count}x</span>
          <span>${issue.userCount} user${issue.userCount !== 1 ? 's' : ''}</span>
          <span>${relativeTime(issue.lastSeen)}</span>
          ${issue.repo ? `<span class="sentry-detail-repo-badge">${esc(issue.repo)}</span>` : ''}
          <a class="sentry-detail-ext-link" href="${esc(issue.permalink)}" target="_blank" title="Open in Sentry">↗ Sentry</a>
        </div>
      `;
    }

    // Body — exception groups + frames
    const body = getBody();
    if (!body) return;

    if (!issue.groups || issue.groups.length === 0) {
      body.innerHTML = '<div class="sentry-detail-placeholder">No stack trace available for this issue.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    let hasNavigable = false;

    for (const group of issue.groups) {
      // Exception header
      if (group.type || group.value) {
        const excHdr = document.createElement('div');
        excHdr.className = 'sentry-exc-header';
        excHdr.innerHTML = group.type
          ? `<span class="sentry-exc-type">${esc(group.type)}</span>${group.value ? `: <span class="sentry-exc-msg">${esc(truncate(group.value, 200))}</span>` : ''}`
          : esc(group.value);
        frag.appendChild(excHdr);
      }

      if (!group.frames || group.frames.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'sentry-detail-placeholder';
        empty.style.padding = '8px 16px';
        empty.textContent = 'No frames';
        frag.appendChild(empty);
        continue;
      }

      // Split into app frames (navigable or inApp) vs library frames
      const appFrames = group.frames.filter(f => f.inApp || f.navigable);
      const libFrames = group.frames.filter(f => !f.inApp && !f.navigable);

      // Render app frames first
      for (const frame of appFrames) {
        frag.appendChild(buildFrameEl(frame, issue.repo));
        if (frame.navigable) hasNavigable = true;
      }

      // Library frames collapsed
      if (libFrames.length > 0) {
        const libWrap = document.createElement('div');
        libWrap.className = 'sentry-lib-frames';

        const toggle = document.createElement('button');
        toggle.className = 'sentry-lib-toggle';
        toggle.textContent = `${libFrames.length} framework frame${libFrames.length !== 1 ? 's' : ''} hidden`;
        toggle.addEventListener('click', () => {
          const expanded = toggle.dataset.expanded === 'true';
          toggle.dataset.expanded = !expanded;
          toggle.textContent = expanded
            ? `${libFrames.length} framework frame${libFrames.length !== 1 ? 's' : ''} hidden`
            : `${libFrames.length} framework frame${libFrames.length !== 1 ? 's' : ''} shown`;
          libList.style.display = expanded ? 'none' : 'block';
        });

        const libList = document.createElement('div');
        libList.style.display = 'none';
        for (const frame of libFrames) {
          libList.appendChild(buildFrameEl(frame, null));
        }

        libWrap.appendChild(toggle);
        libWrap.appendChild(libList);
        frag.appendChild(libWrap);
      }
    }

    if (!hasNavigable) {
      const hint = document.createElement('div');
      hint.className = 'sentry-detail-placeholder';
      hint.style.cssText = 'margin-top:8px;font-size:11px';
      hint.textContent = 'No source-mapped frames found. Deploy with source maps to enable file navigation.';
      frag.appendChild(hint);
    }

    body.innerHTML = '';
    body.appendChild(frag);
  }

  function buildFrameEl(frame, defaultRepo) {
    const el = document.createElement('div');
    const isNavigable = frame.navigable;
    el.className = 'sentry-frame' + (frame.inApp ? ' sentry-frame-app' : ' sentry-frame-lib') + (isNavigable ? ' sentry-frame-nav' : '');

    // File path display — strip long common prefixes for readability
    const displayPath = frame.resolvedPath || frame.filename || '<unknown>';
    const pathParts = displayPath.split('/');
    const fileName = pathParts.pop();
    const dirPart = pathParts.join('/');

    let lineInfo = '';
    if (frame.lineno) lineInfo = `:${frame.lineno}`;

    el.innerHTML = `
      <div class="sentry-frame-top">
        <span class="sentry-frame-icon">${frame.inApp ? '⬤' : '○'}</span>
        <span class="sentry-frame-path">${dirPart ? `<span class="sentry-frame-dir">${esc(dirPart)}/</span>` : ''}<span class="sentry-frame-file">${esc(fileName)}</span>${lineInfo ? `<span class="sentry-frame-line">${esc(lineInfo)}</span>` : ''}</span>
        ${frame.function ? `<span class="sentry-frame-fn">${esc(frame.function)}</span>` : ''}
        ${isNavigable ? '<span class="sentry-frame-open-hint">→ open</span>' : ''}
      </div>
      ${frame.context && frame.context.length > 0 ? buildContextEl(frame.context, frame.lineno) : ''}
    `;

    if (isNavigable) {
      el.addEventListener('click', () => {
        closeOverlay();
        if (typeof switchTab === 'function') switchTab('repo');
        const repo = frame.repo || defaultRepo;
        const path = frame.resolvedPath;
        const line = frame.lineno;
        setTimeout(() => {
          if (line && typeof openRepoFileAtLine === 'function') {
            openRepoFileAtLine(repo, path, line);
          } else if (typeof openRepoFile === 'function') {
            openRepoFile(repo, path);
          }
        }, 50);
      });
    }

    return el;
  }

  function buildContextEl(context, currentLine) {
    if (!context.length) return '';
    let html = '<div class="sentry-frame-context">';
    for (const { ln, code } of context) {
      const isCurrent = ln === currentLine;
      html += `<div class="sentry-ctx-line${isCurrent ? ' sentry-ctx-current' : ''}">`;
      html += `<span class="sentry-ctx-ln">${ln}</span>`;
      html += `<span class="sentry-ctx-code">${esc(code)}</span>`;
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function relativeTime(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  // ---------------------------------------------------------------------------
  // DOM wiring
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('sentry-detail-close')?.addEventListener('click', closeOverlay);
    document.getElementById('sentry-detail-overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('sentry-detail-overlay')) closeOverlay();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen) closeOverlay();
    });
  });
})();
