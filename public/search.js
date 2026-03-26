/* ==========================================================================
   Global Code Search — cross-repo ripgrep/git-grep powered search overlay
   ========================================================================== */

(function () {
  let allRepos = [];
  let activeRepos = new Set();   // repos to include in search (empty = all)
  let caseSensitive = false;
  let useRegex = false;
  let searchDebounce = null;
  let lastQuery = '';
  let isOpen = false;

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------
  function openSearch() {
    if (isOpen) {
      document.getElementById('search-input')?.focus();
      return;
    }
    isOpen = true;
    const overlay = document.getElementById('search-overlay');
    if (overlay) overlay.style.display = 'flex';
    const input = document.getElementById('search-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function closeSearch() {
    isOpen = false;
    const overlay = document.getElementById('search-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  window.openGlobalSearch = openSearch;

  // ---------------------------------------------------------------------------
  // Init repo list — fetched once
  // ---------------------------------------------------------------------------
  async function loadRepos() {
    try {
      const resp = await fetch('/api/repo/list');
      if (!resp.ok) return;
      allRepos = await resp.json();
      renderRepoFilter();
    } catch { /* ignore */ }
  }

  function renderRepoFilter() {
    const row = document.getElementById('search-repo-row');
    if (!row) return;
    row.innerHTML = '';

    const allBtn = document.createElement('button');
    allBtn.className = 'search-repo-chip' + (activeRepos.size === 0 ? ' active' : '');
    allBtn.textContent = 'All repos';
    allBtn.addEventListener('click', () => {
      activeRepos.clear();
      renderRepoFilter();
      triggerSearch();
    });
    row.appendChild(allBtn);

    for (const repo of allRepos) {
      const btn = document.createElement('button');
      btn.className = 'search-repo-chip' + (activeRepos.has(repo) ? ' active' : '');
      btn.textContent = repo;
      btn.addEventListener('click', () => {
        if (activeRepos.has(repo)) {
          activeRepos.delete(repo);
          if (activeRepos.size === 0) { /* back to all */ }
        } else {
          activeRepos.add(repo);
        }
        renderRepoFilter();
        triggerSearch();
      });
      row.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  function triggerSearch() {
    clearTimeout(searchDebounce);
    const q = (document.getElementById('search-input')?.value || '').trim();
    if (q.length < 2) {
      setStatus('');
      document.getElementById('search-results').innerHTML =
        '<div class="search-placeholder">Type at least 2 characters to search</div>';
      return;
    }
    setStatus('Searching…');
    searchDebounce = setTimeout(() => runSearch(q), 300);
  }

  async function runSearch(q) {
    lastQuery = q;
    const params = new URLSearchParams({ q, caseSensitive, regex: useRegex });
    if (activeRepos.size > 0) params.set('repos', [...activeRepos].join(','));

    try {
      const resp = await fetch('/api/search?' + params.toString());
      if (!resp.ok) {
        const { error } = await resp.json().catch(() => ({}));
        setStatus('Error: ' + (error || resp.statusText));
        document.getElementById('search-results').innerHTML =
          '<div class="search-placeholder search-error">' + esc(error || 'Search failed') + '</div>';
        return;
      }
      const { results, total, truncated } = await resp.json();

      // If query changed while we were waiting, discard stale results
      const currentQ = (document.getElementById('search-input')?.value || '').trim();
      if (currentQ !== q) return;

      renderResults(results, q);
      const statusText = total === 0
        ? 'No results'
        : `${total} result${total !== 1 ? 's' : ''}${truncated ? ' (truncated — refine your query)' : ''}`;
      setStatus(statusText);
    } catch (err) {
      setStatus('Search failed: ' + err.message);
    }
  }

  function setStatus(text) {
    const el = document.getElementById('search-status-bar');
    if (el) el.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Render results — grouped by repo → file
  // ---------------------------------------------------------------------------
  function renderResults(results, q) {
    const container = document.getElementById('search-results');
    if (!results.length) {
      container.innerHTML = '<div class="search-placeholder">No results</div>';
      return;
    }

    // Group: repo → file → [matches]
    const byRepo = new Map();
    for (const r of results) {
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, new Map());
      const byFile = byRepo.get(r.repo);
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }

    const frag = document.createDocumentFragment();

    for (const [repo, fileMap] of byRepo) {
      // Repo header
      const repoHdr = document.createElement('div');
      repoHdr.className = 'search-group-repo';
      const matchCount = [...fileMap.values()].reduce((s, a) => s + a.length, 0);
      repoHdr.innerHTML = `<span class="search-repo-name">${esc(repo)}</span><span class="search-group-count">${matchCount}</span>`;
      frag.appendChild(repoHdr);

      for (const [file, matches] of fileMap) {
        // File header
        const fileHdr = document.createElement('div');
        fileHdr.className = 'search-group-file';
        const fileName = file.split('/').pop();
        const fileDir  = file.split('/').slice(0, -1).join('/');
        fileHdr.innerHTML = `<span class="search-file-name">${esc(fileName)}</span>${fileDir ? `<span class="search-file-dir">${esc(fileDir)}</span>` : ''}<span class="search-group-count">${matches.length}</span>`;
        frag.appendChild(fileHdr);

        // Match lines
        for (const match of matches) {
          const row = document.createElement('div');
          row.className = 'search-match-row';
          row.dataset.repo = match.repo;
          row.dataset.file = match.file;
          row.dataset.line = match.line;

          const lineNum = document.createElement('span');
          lineNum.className = 'search-match-line';
          lineNum.textContent = match.line;

          const preview = document.createElement('span');
          preview.className = 'search-match-text';
          preview.innerHTML = highlightMatch(match.text, q, useRegex, caseSensitive);

          row.appendChild(lineNum);
          row.appendChild(preview);
          row.addEventListener('click', () => openMatch(match));
          frag.appendChild(row);
        }
      }
    }

    container.innerHTML = '';
    container.appendChild(frag);
  }

  // ---------------------------------------------------------------------------
  // Highlight the query term in result text
  // ---------------------------------------------------------------------------
  function highlightMatch(text, q, isRegex, isCaseSensitive) {
    const escaped = esc(text);
    try {
      const flags = isCaseSensitive ? 'g' : 'gi';
      const pattern = isRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return escaped.replace(new RegExp(pattern, flags), m => `<mark class="search-mark">${m}</mark>`);
    } catch {
      return escaped;
    }
  }

  // ---------------------------------------------------------------------------
  // Open a match in the Repo viewer
  // ---------------------------------------------------------------------------
  function openMatch(match) {
    closeSearch();
    // Switch to Repo tab
    if (typeof switchTab === 'function') switchTab('repo');
    // Open file at line — use a small delay to let the tab switch complete
    const tryOpen = () => {
      if (typeof openRepoFileAtLine === 'function') {
        openRepoFileAtLine(match.repo, match.file, match.line);
      } else if (typeof openRepoFile === 'function') {
        openRepoFile(match.repo, match.file);
      }
    };
    setTimeout(tryOpen, 50);
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcut & button wiring
  // ---------------------------------------------------------------------------
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === 'Escape' && isOpen) {
      closeSearch();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    // Trigger button in header
    document.getElementById('search-trigger-btn')?.addEventListener('click', openSearch);

    // Close button
    document.getElementById('search-close')?.addEventListener('click', closeSearch);

    // Click outside panel to close
    document.getElementById('search-overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('search-overlay')) closeSearch();
    });

    // Search input
    const input = document.getElementById('search-input');
    if (input) {
      input.addEventListener('input', triggerSearch);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          clearTimeout(searchDebounce);
          const q = input.value.trim();
          if (q.length >= 2) runSearch(q);
        }
      });
    }

    // Case-sensitive toggle
    const caseBtn = document.getElementById('search-case-btn');
    caseBtn?.addEventListener('click', () => {
      caseSensitive = !caseSensitive;
      caseBtn.dataset.active = caseSensitive;
      triggerSearch();
    });

    // Regex toggle
    const regexBtn = document.getElementById('search-regex-btn');
    regexBtn?.addEventListener('click', () => {
      useRegex = !useRegex;
      regexBtn.dataset.active = useRegex;
      triggerSearch();
    });

    // Load repo list for filter chips
    loadRepos();
  });
})();
