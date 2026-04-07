/* ==========================================================================
   Dev Dashboard — Docs Browser (tabbed)
   ========================================================================== */

/* global marked, hljs, esc */

// SVG icon constants (ICON_FOLDER, ICON_FOLDER_OPEN, ICON_FILE, etc.) defined in app.js

let docsTree = [];
let searchTimeout = null;
let selectedDir = '';  // last clicked/expanded directory path

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
const DOCS_TABS_KEY = 'dashboard_docs_tabs';
let docTabs = [];      // [{ path, content, frontmatter, raw, scrollTop, isEditing }]
let activeDocTab = -1; // index into docTabs
let _docTabDragSrc = null;

function getActiveTab() {
  return docTabs[activeDocTab] || null;
}

function persistDocTabs() {
  try {
    const data = {
      tabs: docTabs.map(t => ({ path: t.path })),
      active: activeDocTab,
    };
    localStorage.setItem(DOCS_TABS_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}

function restoreDocTabs() {
  try {
    const raw = localStorage.getItem(DOCS_TABS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.tabs && data.tabs.length > 0) {
      // Restore tab entries — content will be loaded on switch
      docTabs = data.tabs.map(t => ({
        path: t.path,
        content: null,
        frontmatter: null,
        raw: null,
        scrollTop: 0,
        isEditing: false,
        loaded: false,
      }));
      activeDocTab = Math.min(data.active || 0, docTabs.length - 1);
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initDocsSidebarResize() {
  const resizer = document.getElementById('docs-sidebar-resizer');
  const sidebar = document.getElementById('docs-sidebar');
  if (!resizer || !sidebar) return;

  const STORAGE_KEY = 'docs-sidebar-width';
  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved && saved > 0) sidebar.style.width = saved + 'px';

  let startX, startW;
  resizer.addEventListener('mousedown', e => {
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    resizer.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    const w = Math.max(160, Math.min(600, startW + e.clientX - startX));
    sidebar.style.width = w + 'px';
  }
  function onUp() {
    resizer.classList.remove('dragging');
    localStorage.setItem(STORAGE_KEY, sidebar.offsetWidth);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

function initDocs() {
  const searchInput = document.getElementById('docs-search-input');
  if (!searchInput) return; // Docs tab not present in DOM

  initDocsSidebarResize();
  restoreDocTabs();
  loadDocsTree();
  refreshDocsGitStatus();

  // If we have restored tabs, load the active one
  if (docTabs.length > 0 && activeDocTab >= 0) {
    renderDocTabBar();
    fetchAndShowTab(activeDocTab);
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      renderTree(docsTree);
      return;
    }
    searchTimeout = setTimeout(() => searchDocs(q), 300);
  });

  document.getElementById('docs-pull-btn')?.addEventListener('click', doDocsPull);
  document.getElementById('docs-push-btn')?.addEventListener('click', doDocsPush);
  document.getElementById('docs-refresh-btn')?.addEventListener('click', refreshDocs);
  document.getElementById('docs-new-file-btn')?.addEventListener('click', createDocFile);
  document.getElementById('docs-new-folder-btn')?.addEventListener('click', createDocFolder);
}

// ---------------------------------------------------------------------------
// Tree loading and rendering
// ---------------------------------------------------------------------------
async function loadDocsTree() {
  const treeEl = document.getElementById('docs-tree');
  treeEl.innerHTML = '<div class="skeleton"><div class="skeleton-row"><div class="skeleton-bar w-lg"></div></div><div class="skeleton-row"><div class="skeleton-bar w-xl"></div></div><div class="skeleton-row"><div class="skeleton-bar w-md"></div></div><div class="skeleton-row"><div class="skeleton-bar w-lg"></div></div><div class="skeleton-row"><div class="skeleton-bar w-md"></div></div></div>';
  try {
    const res = await fetch('/api/docs/tree');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    docsTree = await res.json();
    if (!Array.isArray(docsTree)) docsTree = [];
    renderTree(docsTree);
  } catch (err) {
    treeEl.innerHTML =
      `<div style="padding:12px;color:var(--overlay0)">Failed to load docs: ${err.message}</div>`;
  }
}

const expandedDirs = new Set();

function expandTreeToPath(filePath) {
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    expandedDirs.add(parts.slice(0, i).join('/'));
  }
}

function renderTree(tree, container) {
  const treeEl = container || document.getElementById('docs-tree');
  treeEl.innerHTML = '';
  renderDocsTreeNodes(tree, treeEl, 0);
}

function currentDocPath() {
  const tab = getActiveTab();
  return tab ? tab.path : null;
}

function renderDocsTreeNodes(nodes, parent, depth) {
  for (const node of nodes) {
    const item = document.createElement('div');
    item.style.paddingLeft = (12 + depth * 16) + 'px';

    // Check if this node or any descendant has uncommitted changes
    const isChanged = node.type === 'file' && docsChangedPaths.has(node.path);
    const dirHasChanges = node.type === 'dir' && docsChangedPaths.size > 0 &&
      [...docsChangedPaths].some(p => p.startsWith(node.path + '/'));

    if (node.type === 'dir') {
      item.className = 'tree-item dir' + (expandedDirs.has(node.path) ? ' expanded' : '');

      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle';
      toggle.textContent = expandedDirs.has(node.path) ? '\u25BE' : '\u25B8';

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.innerHTML = expandedDirs.has(node.path) ? ICON_FOLDER_OPEN : ICON_FOLDER;

      const label = document.createElement('span');
      label.textContent = node.name;

      if (dirHasChanges) {
        const badge = document.createElement('span');
        badge.className = 'docs-changed-badge';
        badge.textContent = '\u2022';
        badge.title = 'Contains uncommitted changes';
        label.appendChild(badge);
      }

      item.appendChild(toggle);
      item.appendChild(icon);
      item.appendChild(label);

      item.addEventListener('click', () => {
        selectedDir = node.path;
        if (expandedDirs.has(node.path)) {
          expandedDirs.delete(node.path);
        } else {
          expandedDirs.add(node.path);
        }
        renderTree(docsTree);
      });

      parent.appendChild(item);

      if (expandedDirs.has(node.path) && node.children) {
        renderDocsTreeNodes(node.children, parent, depth + 1);
      }
    } else {
      const isActive = currentDocPath() === node.path;
      const isOpen = docTabs.some(t => t.path === node.path);
      item.className = 'tree-item' + (isActive ? ' active' : '') + (isOpen && !isActive ? ' open-tab' : '');

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.innerHTML = ICON_FILE;

      const label = document.createElement('span');
      label.textContent = node.name.replace(/\.md$/, '');
      if (isChanged) {
        item.classList.add('docs-changed');
        label.title = 'Uncommitted changes';
      }

      const shareBtn = document.createElement('span');
      shareBtn.className = 'tree-share-btn';
      shareBtn.textContent = '\uD83D\uDD17';
      shareBtn.title = 'Copy share link';
      shareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = location.origin + '/#docs/' + encodeURIComponent(node.path);
        navigator.clipboard.writeText(url).then(() => {
          shareBtn.textContent = '\u2705';
          setTimeout(() => { shareBtn.textContent = '\uD83D\uDD17'; }, 1500);
        }).catch(() => {
          const tmp = document.createElement('input');
          tmp.value = url;
          document.body.appendChild(tmp);
          tmp.select();
          document.execCommand('copy');
          tmp.remove();
          shareBtn.textContent = '\u2705';
          setTimeout(() => { shareBtn.textContent = '\uD83D\uDD17'; }, 1500);
        });
      });

      item.appendChild(icon);
      item.appendChild(label);
      item.appendChild(shareBtn);

      item.addEventListener('click', () => openDocTab(node.path));
      parent.appendChild(item);
    }
  }
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------
function renderDocTabBar() {
  const bar = document.getElementById('docs-tab-bar');
  if (!bar) return;
  bar.innerHTML = '';

  if (docTabs.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  docTabs.forEach((tab, i) => {
    const tabEl = document.createElement('div');
    tabEl.className = 'docs-open-tab' + (i === activeDocTab ? ' active' : '');
    tabEl.title = tab.path;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'docs-open-tab-name';
    const filename = tab.path.split('/').pop().replace(/\.md$/, '');
    nameSpan.textContent = filename;

    const closeBtn = document.createElement('span');
    closeBtn.className = 'docs-open-tab-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDocTab(i);
    });

    tabEl.appendChild(nameSpan);
    tabEl.appendChild(closeBtn);

    tabEl.addEventListener('click', () => switchDocTab(i));

    // Middle-click to close
    tabEl.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeDocTab(i);
      }
    });

    // Right-click context menu
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDocTabContextMenu(e, i);
    });

    // Drag-and-drop reordering
    tabEl.draggable = true;
    tabEl.addEventListener('dragstart', (e) => {
      _docTabDragSrc = i;
      tabEl.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tabEl.addEventListener('dragend', () => {
      document.querySelectorAll('.docs-open-tab').forEach(t => t.classList.remove('tab-dragging', 'tab-drag-over'));
    });
    tabEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.docs-open-tab').forEach(t => t.classList.remove('tab-drag-over'));
      if (i !== _docTabDragSrc) tabEl.classList.add('tab-drag-over');
    });
    tabEl.addEventListener('dragleave', () => tabEl.classList.remove('tab-drag-over'));
    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (_docTabDragSrc === null || _docTabDragSrc === i) return;
      const moved = docTabs.splice(_docTabDragSrc, 1)[0];
      docTabs.splice(i, 0, moved);
      if (activeDocTab === _docTabDragSrc) activeDocTab = i;
      else if (_docTabDragSrc < activeDocTab && i >= activeDocTab) activeDocTab--;
      else if (_docTabDragSrc > activeDocTab && i <= activeDocTab) activeDocTab++;
      _docTabDragSrc = null;
      renderDocTabBar();
      persistDocTabs();
    });

    bar.appendChild(tabEl);
  });

  renderTree(docsTree);
}

function openDocTab(path) {
  // Save current tab state before switching
  saveCurrentDocTabState();

  // Check if already open
  const existingIdx = docTabs.findIndex(t => t.path === path);
  if (existingIdx >= 0) {
    activeDocTab = existingIdx;
    renderDocTabBar();
    showDocTab(existingIdx);
    persistDocTabs();
    return;
  }

  // Create new tab
  docTabs.push({
    path,
    content: null,
    frontmatter: null,
    raw: null,
    scrollTop: 0,
    isEditing: false,
    loaded: false,
  });
  activeDocTab = docTabs.length - 1;
  renderDocTabBar();
  fetchAndShowTab(activeDocTab);
  persistDocTabs();
}

function switchDocTab(index) {
  if (index === activeDocTab) return;
  saveCurrentDocTabState();
  activeDocTab = index;
  renderDocTabBar();
  showDocTab(index);
  persistDocTabs();
  // Sync tree selection to match the newly active tab
  const tab = docTabs[index];
  if (tab && docsTree.length) {
    expandTreeToPath(tab.path);
    renderTree(docsTree);
    requestAnimationFrame(() => {
      document.querySelector('#docs-tree .tree-item.active')?.scrollIntoView({ block: 'nearest' });
    });
  }
}

function closeDocTab(index) {
  saveCurrentDocTabState();
  docTabs.splice(index, 1);

  if (docTabs.length === 0) {
    activeDocTab = -1;
    renderDocTabBar();
    const contentEl = document.getElementById('docs-content');
    contentEl.innerHTML = '<div class="docs-placeholder">Select a document from the sidebar to begin reading.</div>';
    history.replaceState(null, '', location.pathname);
    persistDocTabs();
    renderTree(docsTree);
    return;
  }

  if (activeDocTab > index) {
    activeDocTab--;
  } else if (activeDocTab >= docTabs.length) {
    activeDocTab = docTabs.length - 1;
  } else if (activeDocTab === index) {
    activeDocTab = Math.min(index, docTabs.length - 1);
  }

  renderDocTabBar();
  showDocTab(activeDocTab);
  persistDocTabs();
}

function saveCurrentDocTabState() {
  const tab = getActiveTab();
  if (!tab) return;

  const contentEl = document.getElementById('docs-content');
  tab.scrollTop = contentEl.scrollTop;

  // If editing, save textarea content
  if (tab.isEditing) {
    const textarea = document.getElementById('docs-edit-area');
    if (textarea) tab.raw = textarea.value;
  }
}

function showDocTab(index) {
  const tab = docTabs[index];
  if (!tab) return;

  // Update hash
  history.replaceState(null, '', '#docs/' + encodeURIComponent(tab.path));

  // Expand parent dirs in tree
  const parts = tab.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    expandedDirs.add(parts.slice(0, i).join('/'));
  }

  if (!tab.loaded) {
    fetchAndShowTab(index);
    return;
  }

  // Render from cached state
  renderDocView(tab.path, { frontmatter: tab.frontmatter, content: tab.content });

  // Restore edit mode if it was editing
  if (tab.isEditing) {
    toggleEdit();
    const textarea = document.getElementById('docs-edit-area');
    if (textarea && tab.raw) textarea.value = tab.raw;
  }

  // Restore scroll position
  const contentEl = document.getElementById('docs-content');
  requestAnimationFrame(() => { contentEl.scrollTop = tab.scrollTop; });
}

async function fetchAndShowTab(index) {
  const tab = docTabs[index];
  if (!tab) return;

  // Update hash
  history.replaceState(null, '', '#docs/' + encodeURIComponent(tab.path));

  // Expand parent dirs
  const parts = tab.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    expandedDirs.add(parts.slice(0, i).join('/'));
  }
  renderTree(docsTree);

  const contentEl = document.getElementById('docs-content');
  contentEl.innerHTML = '<div class="docs-placeholder">Loading...</div>';

  try {
    const res = await fetch(`/api/docs/file?path=${encodeURIComponent(tab.path)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();

    tab.content = data.content;
    tab.frontmatter = data.frontmatter;
    tab.raw = data.rawContent || reconstructRaw(data.frontmatter, data.content);
    tab.isEditing = false;
    tab.loaded = true;

    // Only render if this tab is still the active one
    if (index === activeDocTab) {
      renderDocView(tab.path, data);
    }
  } catch (err) {
    if (index === activeDocTab) {
      contentEl.innerHTML = `<div class="docs-placeholder">Error loading document: ${err.message}</div>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Document rendering
// ---------------------------------------------------------------------------
function reconstructRaw(frontmatter, content) {
  const fm = frontmatter || {};
  if (Object.keys(fm).length === 0) return content;
  let raw = '---\n';
  for (const [k, v] of Object.entries(fm)) {
    raw += `${k}: ${v}\n`;
  }
  raw += '---\n\n' + content;
  return raw;
}

function renderDocView(path, data) {
  const contentEl = document.getElementById('docs-content');
  let html = '';

  // Edit bar
  html += '<div class="docs-edit-bar">';

  // Breadcrumb (inline)
  html += '<div class="docs-breadcrumb" style="margin:0;flex:1">';
  const breadParts = path.split('/');
  for (let i = 0; i < breadParts.length; i++) {
    if (i > 0) html += '<span class="separator">/</span>';
    const segment = breadParts[i].replace(/\.md$/, '');
    const partPath = breadParts.slice(0, i + 1).join('/');
    if (i < breadParts.length - 1) {
      html += `<span onclick="expandToDir('${partPath}')">${escHtml(segment)}</span>`;
    } else {
      html += `<span style="color:var(--text)">${escHtml(segment)}</span>`;
    }
  }
  html += '</div>';
  html += '<button class="btn btn-quick" id="docs-share-btn" title="Copy share link">\uD83D\uDD17 Share</button>';
  html += '<button class="btn btn-quick" id="docs-edit-toggle">Edit</button>';
  html += '</div>';

  // Frontmatter badges
  const fm = data.frontmatter || {};
  if (Object.keys(fm).length > 0) {
    html += '<div class="docs-badges">';
    if (fm.type) html += `<span class="docs-badge type">${escHtml(fm.type)}</span>`;
    if (fm.status) html += `<span class="docs-badge status">${escHtml(fm.status)}</span>`;
    if (fm.severity) {
      const sev = fm.severity.toLowerCase();
      html += `<span class="docs-badge severity-${escHtml(sev)}">${escHtml(fm.severity)}</span>`;
    }
    for (const [k, v] of Object.entries(fm)) {
      if (!['type', 'status', 'severity'].includes(k)) {
        html += `<span class="docs-badge type" title="${escHtml(k)}">${escHtml(k)}: ${escHtml(v)}</span>`;
      }
    }
    html += '</div>';
  }

  // Render markdown
  html += '<div class="docs-rendered">' + renderMarkdown(data.content) + '</div>';

  contentEl.innerHTML = html;
  contentEl.scrollTop = 0;

  // Apply syntax highlighting
  contentEl.querySelectorAll('pre code').forEach((block) => {
    if (typeof hljs !== 'undefined') hljs.highlightElement(block);
  });

  // Wire wiki-link clicks (must happen after innerHTML insertion)
  contentEl.querySelectorAll('.wiki-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const rawPath = link.dataset.docPath;
      if (rawPath) openDocTab(resolveWikilink(rawPath));
    });
  });

  // Wire edit toggle
  document.getElementById('docs-edit-toggle').addEventListener('click', toggleEdit);

  // Wire share button
  document.getElementById('docs-share-btn').addEventListener('click', () => {
    const url = location.origin + '/#docs/' + encodeURIComponent(path);
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('docs-share-btn');
      btn.textContent = '\u2705 Copied!';
      setTimeout(() => { btn.textContent = '\uD83D\uDD17 Share'; }, 2000);
    }).catch(() => {
      // Fallback: select a temporary input
      const tmp = document.createElement('input');
      tmp.value = location.origin + '/#docs/' + encodeURIComponent(path);
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
      const btn = document.getElementById('docs-share-btn');
      btn.textContent = '\u2705 Copied!';
      setTimeout(() => { btn.textContent = '\uD83D\uDD17 Share'; }, 2000);
    });
  });
}

function toggleEdit() {
  const tab = getActiveTab();
  if (!tab) return;

  const contentEl = document.getElementById('docs-content');
  const btn = document.getElementById('docs-edit-toggle');

  if (!tab.isEditing) {
    // Switch to edit mode
    tab.isEditing = true;
    btn.textContent = 'Preview';

    // Keep the edit bar, replace the rest
    const editBar = contentEl.querySelector('.docs-edit-bar');
    const badges = contentEl.querySelector('.docs-badges');
    const rendered = contentEl.querySelector('.docs-rendered');

    // Add save button
    if (!document.getElementById('docs-save-btn')) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-quick';
      saveBtn.id = 'docs-save-btn';
      saveBtn.textContent = 'Save';
      saveBtn.style.marginLeft = '4px';
      saveBtn.addEventListener('click', saveDoc);
      editBar.appendChild(saveBtn);
    }

    // Replace rendered content with textarea
    if (badges) badges.style.display = 'none';
    if (rendered) rendered.remove();

    const textarea = document.createElement('textarea');
    textarea.className = 'docs-edit-textarea';
    textarea.id = 'docs-edit-area';
    textarea.value = tab.raw;
    // Tab key inserts tab instead of changing focus (unless autocomplete is open)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && (!_wikilinkDropdown || _wikilinkDropdown.style.display === 'none')) {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }
    });
    contentEl.appendChild(textarea);
    attachWikilinkAutocomplete(textarea);
  } else {
    // Switch to preview mode
    tab.isEditing = false;

    // Grab edited content from textarea
    const textarea = document.getElementById('docs-edit-area');
    if (textarea) tab.raw = textarea.value;

    // Re-parse frontmatter and content
    let fm = {};
    let content = tab.raw;
    if (tab.raw.startsWith('---')) {
      const end = tab.raw.indexOf('---', 3);
      if (end !== -1) {
        const fmBlock = tab.raw.substring(3, end).trim();
        content = tab.raw.substring(end + 3).trim();
        for (const line of fmBlock.split('\n')) {
          const colon = line.indexOf(':');
          if (colon > 0) {
            fm[line.substring(0, colon).trim()] = line.substring(colon + 1).trim();
          }
        }
      }
    }
    tab.content = content;
    tab.frontmatter = fm;

    renderDocView(tab.path, { frontmatter: fm, content });
  }
}

async function saveDoc() {
  const tab = getActiveTab();
  if (!tab) return;
  const textarea = document.getElementById('docs-edit-area');
  if (textarea) tab.raw = textarea.value;

  const saveBtn = document.getElementById('docs-save-btn');
  if (saveBtn) { saveBtn.textContent = 'Saving...'; saveBtn.disabled = true; }

  try {
    const res = await fetch('/api/docs/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content: tab.raw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (saveBtn) { saveBtn.textContent = 'Saved!'; setTimeout(() => { if (saveBtn) saveBtn.textContent = 'Save'; }, 2000); }
    refreshDocsGitStatus();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible loadDoc (used by deep-link, search, wiki-links)
// ---------------------------------------------------------------------------
async function loadDoc(path) {
  openDocTab(path);
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------
async function doDocsPull() {
  const btn = document.getElementById('docs-pull-btn');
  btn.textContent = 'Pulling...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/docs/git/pull', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    btn.textContent = 'Pulled!';
    // Reload tree and current doc
    loadDocsTree();
    const tab = getActiveTab();
    if (tab) fetchAndShowTab(activeDocTab);
    refreshDocsGitStatus();
  } catch (err) {
    alert('Pull failed: ' + err.message);
  } finally {
    setTimeout(() => { btn.textContent = 'Pull'; btn.disabled = false; }, 2000);
  }
}

async function doDocsPush() {
  const message = prompt('Commit message:', 'Update docs from dashboard');
  if (!message) return;

  const btn = document.getElementById('docs-push-btn');
  btn.textContent = 'Pushing...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/docs/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    btn.textContent = 'Pushed!';
    refreshDocsGitStatus();
  } catch (err) {
    alert('Push failed: ' + err.message);
  } finally {
    setTimeout(() => { btn.textContent = 'Push'; btn.disabled = false; }, 2000);
  }
}

let docsChangedPaths = new Set();

async function refreshDocsGitStatus() {
  const statusEl = document.getElementById('docs-git-status');
  if (!statusEl) return;
  try {
    const res = await fetch('/api/docs/git/status');
    const data = await res.json();
    if (!res.ok) { statusEl.textContent = ''; docsChangedPaths.clear(); return; }
    statusEl.textContent = data.dirty ? `${data.files} changed` : 'clean';
    statusEl.style.color = data.dirty ? 'var(--peach)' : 'var(--green)';
    docsChangedPaths = new Set(data.changedPaths || []);
    if (docsTree.length) renderTree(docsTree);
  } catch {
    statusEl.textContent = '';
    docsChangedPaths.clear();
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
function renderMarkdown(content) {
  // Pre-process: Obsidian callouts
  content = content.replace(
    /^> \[!(info|warning|danger|error|tip|success|note|example|quote)\](.*)?$/gm,
    (match, type, title) => {
      const displayTitle = (title && title.trim()) || type;
      return `<div class="callout ${type}"><div class="callout-title">${escHtml(displayTitle)}</div><div class="callout-body">`;
    }
  );
  // Close callout blocks (lines after the callout that start with >)
  let inCallout = false;
  const lines = content.split('\n');
  const processed = [];
  for (const line of lines) {
    if (line.includes('<div class="callout ')) {
      inCallout = true;
      processed.push(line);
    } else if (inCallout) {
      if (line.startsWith('> ')) {
        processed.push(line.substring(2));
      } else {
        processed.push('</div></div>');
        inCallout = false;
        processed.push(line);
      }
    } else {
      processed.push(line);
    }
  }
  if (inCallout) processed.push('</div></div>');
  content = processed.join('\n');

  // Pre-process: Obsidian image embeds ![[image.png]] or ![[path/image.png]]
  content = content.replace(/!\[\[([^\]]+?\.(png|jpg|jpeg|gif|svg|webp|bmp))\]\]/gi, (match, imgPath) => {
    // Resolve relative to the current doc's directory
    const tab = getActiveTab();
    let resolvedPath = imgPath;
    if (tab && !imgPath.includes('/')) {
      // Image name only — look in same directory as the current doc
      const docDir = tab.path.substring(0, tab.path.lastIndexOf('/'));
      if (docDir) resolvedPath = docDir + '/' + imgPath;
    }
    const src = '/api/docs/asset?path=' + encodeURIComponent(resolvedPath);
    return `<img src="${src}" alt="${escHtml(imgPath)}" style="max-width:100%">`;
  });

  // Pre-process: Wiki links [[path|display]] or [[path]]
  // Obsidian escapes the pipe as \| in raw markdown, so match both \| and | as separator
  content = content.replace(/\[\[([^\]|]+?)\\?\|([^\]]+)\]\]|\[\[([^\]]+?)\]\]/g, (match, pathWithDisplay, display, pathOnly) => {
    const rawPath = pathWithDisplay || pathOnly;
    const label = display || rawPath.split('/').pop();
    const mdPath = rawPath.endsWith('.md') ? rawPath : rawPath + '.md';
    return `<a href="#" class="wiki-link" data-doc-path="${escHtml(mdPath)}">${escHtml(label)}</a>`;
  });

  // Configure marked
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
    const html = marked.parse(content);

    return html;
  }

  // Fallback: return escaped content
  return `<pre>${escHtml(content)}</pre>`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
async function searchDocs(query) {
  try {
    const res = await fetch(`/api/docs/search?q=${encodeURIComponent(query)}`);
    const results = await res.json();

    const treeEl = document.getElementById('docs-tree');
    treeEl.innerHTML = '';

    if (results.length === 0) {
      treeEl.innerHTML = '<div style="padding:12px;color:var(--overlay0)">No results found</div>';
      return;
    }

    const container = document.createElement('div');
    container.className = 'search-results';

    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'search-result';
      item.innerHTML = `
        <div class="search-result-name">${escHtml(r.name)}</div>
        <div class="search-result-snippet">${escHtml(r.snippet || r.path)}</div>
      `;
      item.addEventListener('click', () => {
        const docPath = r.path;
        // Clear search and restore tree
        document.getElementById('docs-search-input').value = '';
        renderTree(docsTree);
        // Open in a tab
        openDocTab(docPath);
      });
      container.appendChild(item);
    }

    treeEl.appendChild(container);
  } catch (err) {
    console.error('Search failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Refresh / Create
// ---------------------------------------------------------------------------
async function refreshDocs() {
  const btn = document.getElementById('docs-refresh-btn');
  btn.disabled = true;
  try {
    await fetch('/api/docs/refresh', { method: 'POST' });
    await loadDocsTree();
    const tab = getActiveTab();
    if (tab) fetchAndShowTab(activeDocTab);
    refreshDocsGitStatus();
  } catch (err) {
    console.error('Refresh failed:', err);
  } finally {
    btn.disabled = false;
  }
}

async function createDocFile() {
  const name = prompt('New file name (without .md):');
  if (!name || !name.trim()) return;

  try {
    const res = await fetch('/api/docs/new-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: selectedDir, name: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Expand parent directory and refresh tree
    if (selectedDir) expandedDirs.add(selectedDir);
    await loadDocsTree();
    openDocTab(data.path);
    refreshDocsGitStatus();
  } catch (err) {
    alert('Create file failed: ' + err.message);
  }
}

async function createDocFolder() {
  const name = prompt('New folder name:');
  if (!name || !name.trim()) return;

  try {
    const res = await fetch('/api/docs/new-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: selectedDir, name: name.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Expand parent and new folder, refresh tree
    if (selectedDir) expandedDirs.add(selectedDir);
    expandedDirs.add(data.path);
    await loadDocsTree();
    refreshDocsGitStatus();
  } catch (err) {
    alert('Create folder failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Tab context menu
// ---------------------------------------------------------------------------
function showDocTabContextMenu(e, tabIndex) {
  const items = [
    { label: 'Close', action: () => closeDocTab(tabIndex) },
    { label: 'Close Others', action: () => closeOtherDocTabs(tabIndex) },
    { label: 'Close All to the Right', action: () => closeDocTabsToRight(tabIndex) },
    { label: 'Close All', action: () => closeAllDocTabs() },
  ];
  // Reuse the global context menu from swagger.js
  if (typeof showContextMenu === 'function') {
    showContextMenu(e, items);
  }
}

function closeOtherDocTabs(keepIndex) {
  saveCurrentDocTabState();
  const kept = [docTabs[keepIndex]];
  docTabs.length = 0;
  docTabs.push(...kept);
  activeDocTab = 0;
  renderDocTabBar();
  showDocTab(0);
  persistDocTabs();
}

function closeDocTabsToRight(fromIndex) {
  saveCurrentDocTabState();
  for (let i = docTabs.length - 1; i > fromIndex; i--) {
    docTabs.splice(i, 1);
  }
  if (activeDocTab >= docTabs.length) {
    activeDocTab = docTabs.length - 1;
  }
  renderDocTabBar();
  showDocTab(activeDocTab);
  persistDocTabs();
}

function closeAllDocTabs() {
  docTabs.length = 0;
  activeDocTab = -1;
  renderDocTabBar();
  const contentEl = document.getElementById('docs-content');
  contentEl.innerHTML = '<div class="docs-placeholder">Select a document from the sidebar to begin reading.</div>';
  history.replaceState(null, '', location.pathname);
  persistDocTabs();
  renderTree(docsTree);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escHtml(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// Called from breadcrumb onclick
// eslint-disable-next-line no-unused-vars
function expandToDir(path) {
  expandedDirs.add(path);
  renderTree(docsTree);
}

// Expose for global breadcrumb onclick
window.expandToDir = expandToDir;

// ---------------------------------------------------------------------------
// Wikilink resolution (Obsidian-style: filename-only links search the vault)
// ---------------------------------------------------------------------------
function resolveWikilink(rawPath) {
  const mdPath = rawPath.endsWith('.md') ? rawPath : rawPath + '.md';
  // If it already contains a slash, treat as an explicit path
  if (mdPath.includes('/')) return mdPath;
  // Search the docs tree for a file matching this name
  const allFiles = flattenDocsTree(docsTree);
  const match = allFiles.find(f => f.split('/').pop() === mdPath);
  return match || mdPath;
}

// ---------------------------------------------------------------------------
// Wikilink autocomplete for editor
// ---------------------------------------------------------------------------
function flattenDocsTree(nodes, result) {
  result = result || [];
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node.path);
    } else if (node.children) {
      flattenDocsTree(node.children, result);
    }
  }
  return result;
}

let _wikilinkDropdown = null;
let _wikilinkSelected = 0;
let _wikilinkMatches = [];

function getWikilinkContext(textarea) {
  const pos = textarea.selectionStart;
  const text = textarea.value.substring(0, pos);
  // Find the last [[ that hasn't been closed
  const lastOpen = text.lastIndexOf('[[');
  if (lastOpen === -1) return null;
  const afterOpen = text.substring(lastOpen + 2);
  // If there's a ]] between [[ and cursor, the link is closed
  if (afterOpen.includes(']]')) return null;
  // If there's a newline, abandon
  if (afterOpen.includes('\n')) return null;
  return { start: lastOpen, query: afterOpen };
}

function showWikilinkDropdown(textarea) {
  const ctx = getWikilinkContext(textarea);
  if (!ctx) { hideWikilinkDropdown(); return; }

  const query = ctx.query.toLowerCase();
  const allFiles = flattenDocsTree(docsTree);
  // Filter and score: prefer filename match over path match
  _wikilinkMatches = allFiles
    .filter(f => f.toLowerCase().includes(query))
    .sort((a, b) => {
      const aName = a.split('/').pop().toLowerCase();
      const bName = b.split('/').pop().toLowerCase();
      const aNameMatch = aName.includes(query);
      const bNameMatch = bName.includes(query);
      if (aNameMatch && !bNameMatch) return -1;
      if (!aNameMatch && bNameMatch) return 1;
      const aStarts = aName.startsWith(query);
      const bStarts = bName.startsWith(query);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.localeCompare(b);
    })
    .slice(0, 20);

  if (_wikilinkMatches.length === 0) { hideWikilinkDropdown(); return; }
  _wikilinkSelected = Math.min(_wikilinkSelected, _wikilinkMatches.length - 1);

  if (!_wikilinkDropdown) {
    _wikilinkDropdown = document.createElement('div');
    _wikilinkDropdown.className = 'wikilink-dropdown';
    document.body.appendChild(_wikilinkDropdown);
  }

  // Position relative to textarea cursor
  const rect = textarea.getBoundingClientRect();
  // Approximate cursor position using a mirror div
  const mirror = document.createElement('div');
  const style = window.getComputedStyle(textarea);
  mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;`
    + `width:${style.width};font:${style.font};padding:${style.padding};border:${style.border};`
    + `line-height:${style.lineHeight};letter-spacing:${style.letterSpacing};`;
  mirror.textContent = textarea.value.substring(0, textarea.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '|';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const cursorRelY = markerRect.top - mirrorRect.top;
  const cursorRelX = markerRect.left - mirrorRect.left;
  document.body.removeChild(mirror);

  const dropdownTop = rect.top + cursorRelY - textarea.scrollTop + 24;
  const dropdownLeft = rect.left + Math.min(cursorRelX, rect.width - 320);
  _wikilinkDropdown.style.top = Math.min(dropdownTop, window.innerHeight - 300) + 'px';
  _wikilinkDropdown.style.left = Math.max(dropdownLeft, rect.left) + 'px';

  // Render items
  _wikilinkDropdown.innerHTML = '';
  _wikilinkMatches.forEach((filePath, i) => {
    const item = document.createElement('div');
    item.className = 'wikilink-dropdown-item' + (i === _wikilinkSelected ? ' selected' : '');
    const name = filePath.split('/').pop().replace(/\.md$/, '');
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '';
    item.innerHTML = `<div class="wikilink-item-name">${escHtml(name)}</div>`
      + `<div class="wikilink-item-path">${escHtml(dir)}</div>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      acceptWikilinkCompletion(textarea, filePath);
    });
    item.addEventListener('mouseenter', () => {
      _wikilinkSelected = i;
      _wikilinkDropdown.querySelectorAll('.wikilink-dropdown-item').forEach((el, j) => {
        el.classList.toggle('selected', j === i);
      });
    });
    _wikilinkDropdown.appendChild(item);
  });

  _wikilinkDropdown.style.display = 'block';
  // Scroll selected into view
  const selectedEl = _wikilinkDropdown.querySelector('.selected');
  if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
}

function hideWikilinkDropdown() {
  if (_wikilinkDropdown) {
    _wikilinkDropdown.style.display = 'none';
  }
  _wikilinkSelected = 0;
  _wikilinkMatches = [];
}

function acceptWikilinkCompletion(textarea, filePath) {
  const ctx = getWikilinkContext(textarea);
  if (!ctx) return;
  // Remove .md extension for the wiki link path
  const linkPath = filePath.replace(/\.md$/, '');
  const before = textarea.value.substring(0, ctx.start + 2);
  const after = textarea.value.substring(textarea.selectionStart);
  // If after already starts with ]], don't double-close
  const suffix = after.startsWith(']]') ? '' : ']]';
  textarea.value = before + linkPath + suffix + after;
  const newPos = ctx.start + 2 + linkPath.length + suffix.length;
  textarea.selectionStart = textarea.selectionEnd = newPos;
  textarea.focus();
  hideWikilinkDropdown();
  // Update tab raw content
  const tab = getActiveTab();
  if (tab) tab.raw = textarea.value;
}

function attachWikilinkAutocomplete(textarea) {
  textarea.addEventListener('input', () => {
    showWikilinkDropdown(textarea);
  });

  textarea.addEventListener('keydown', (e) => {
    if (!_wikilinkDropdown || _wikilinkDropdown.style.display === 'none') return;
    if (_wikilinkMatches.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _wikilinkSelected = (_wikilinkSelected + 1) % _wikilinkMatches.length;
      showWikilinkDropdown(textarea);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _wikilinkSelected = (_wikilinkSelected - 1 + _wikilinkMatches.length) % _wikilinkMatches.length;
      showWikilinkDropdown(textarea);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acceptWikilinkCompletion(textarea, _wikilinkMatches[_wikilinkSelected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideWikilinkDropdown();
    }
  });

  textarea.addEventListener('blur', () => {
    // Delay to allow mousedown on dropdown items
    setTimeout(hideWikilinkDropdown, 200);
  });

  textarea.addEventListener('scroll', () => {
    if (_wikilinkDropdown && _wikilinkDropdown.style.display !== 'none') {
      showWikilinkDropdown(textarea);
    }
  });
}
