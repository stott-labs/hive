/* ==========================================================================
   Repo Viewer — Monaco-based file browser and editor with AI completions
   ========================================================================== */

// SVG icon constants (ICON_FOLDER, ICON_FOLDER_OPEN, ICON_FILE, etc.) defined in app.js

const REPO_TABS_KEY    = 'repo-viewer-tabs';
const REPO_ACTIVE_KEY  = 'repo-viewer-active';
const REPO_REPO_KEY    = 'repo-viewer-repo';
const REPO_SIDEBAR_KEY = 'repo-viewer-sidebar-width';

let repoViewerReady = false;
let monacoEditor    = null;
let repoTabs        = [];  // [{ repo, path, lang, content, model, dirty, scrollTop }]
let activeRepoTab   = -1;
let _repoTabDragSrc = null;
let currentRepo     = null;
let dirtyFiles      = new Set();
let treeOpenDirs    = new Set();
let repoTree        = [];  // top-level entries, children populated lazily
let pendingRevealLine = null; // set by openRepoFileAtLine before opening
let repoWordWrap = localStorage.getItem('repoWordWrap') === 'on';
const INDENT_PRESETS = {
  '2s': { tabSize: 2, insertSpaces: true,  label: '2 Spaces' },
  '4s': { tabSize: 4, insertSpaces: true,  label: '4 Spaces' },
  'tab': { tabSize: 4, insertSpaces: false, label: 'Tab' },
};
let repoIndent = localStorage.getItem('repoIndent') || '2s';

// ---------------------------------------------------------------------------
// Language map
// ---------------------------------------------------------------------------
const EXT_LANG = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  vue: 'html', json: 'json', md: 'markdown', html: 'html', css: 'css',
  scss: 'scss', less: 'less', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', cs: 'csharp', php: 'php', sh: 'shell',
  bash: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
  graphql: 'graphql', toml: 'ini', env: 'ini', conf: 'ini', ini: 'ini',
  dockerfile: 'dockerfile', tf: 'hcl', proto: 'protobuf',
};

function getLang(path) {
  const name = path.split('/').pop() || '';
  if (/dockerfile/i.test(name)) return 'dockerfile';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return EXT_LANG[ext] || 'plaintext';
}

// ---------------------------------------------------------------------------
// Monaco initialization — loaded dynamically to avoid AMD conflicts with
// ansi_up / marked / gridstack (all UMD bundles that break if define is set
// at page-load time)
// ---------------------------------------------------------------------------
const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';

function waitForMonaco(cb) {
  if (window.monacoReady) return cb();

  // Queue callbacks in case multiple calls arrive before Monaco finishes
  window._monacoQueue = window._monacoQueue || [];
  window._monacoQueue.push(cb);
  if (window._monacoLoading) return;
  window._monacoLoading = true;

  // Inject the AMD loader script dynamically — after all page scripts have
  // already run, so it can't stomp on UMD bundles
  const loaderScript    = document.createElement('script');
  loaderScript.src      = MONACO_CDN + '/loader.min.js';
  loaderScript.onload   = () => {
    require.config({ paths: { vs: MONACO_CDN } });
    require(['vs/editor/editor.main'], () => {
      window.monacoReady = true;
      (window._monacoQueue || []).forEach(fn => fn());
      window._monacoQueue   = [];
      window._monacoLoading = false;
    });
  };
  document.head.appendChild(loaderScript);
}

function initMonacoEditor() {
  if (monacoEditor) return;
  const container = document.getElementById('repo-editor-container');
  if (!container) return;

  monaco.editor.defineTheme('catppuccin-mocha', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '',                  foreground: 'cdd6f4', background: '1e1e2e' },
      { token: 'comment',           foreground: '6c7086', fontStyle: 'italic' },
      { token: 'keyword',           foreground: 'cba6f7' },
      { token: 'keyword.operator',  foreground: '89dceb' },
      { token: 'string',            foreground: 'a6e3a1' },
      { token: 'number',            foreground: 'fab387' },
      { token: 'type',              foreground: 'f5c2e7' },
      { token: 'class',             foreground: 'f9e2af' },
      { token: 'function',          foreground: '89b4fa' },
      { token: 'variable',          foreground: 'cdd6f4' },
      { token: 'constant',          foreground: 'fab387' },
      { token: 'tag',               foreground: 'f38ba8' },
      { token: 'attribute.name',    foreground: 'fab387' },
      { token: 'attribute.value',   foreground: 'a6e3a1' },
      { token: 'delimiter',         foreground: '89dceb' },
      { token: 'regexp',            foreground: 'f38ba8' },
    ],
    colors: {
      'editor.background':                  '#1e1e2e',
      'editor.foreground':                  '#cdd6f4',
      'editor.lineHighlightBackground':     '#313244aa',
      'editorCursor.foreground':            '#f5c2e7',
      'editor.selectionBackground':         '#45475a',
      'editor.inactiveSelectionBackground': '#31324488',
      'editorLineNumber.foreground':        '#6c7086',
      'editorLineNumber.activeForeground':  '#cdd6f4',
      'editor.findMatchBackground':         '#fab38755',
      'editor.findMatchHighlightBackground': '#fab38733',
      'editorWidget.background':            '#181825',
      'editorWidget.border':                '#313244',
      'editorSuggestWidget.background':     '#181825',
      'editorSuggestWidget.border':         '#313244',
      'editorSuggestWidget.selectedBackground': '#313244',
      'input.background':                   '#313244',
      'input.foreground':                   '#cdd6f4',
      'scrollbarSlider.background':         '#45475a88',
      'scrollbarSlider.hoverBackground':    '#45475aaa',
      'editorGutter.background':            '#1e1e2e',
      'editorInlayHint.background':         '#31324488',
      'editorInlayHint.foreground':         '#6c7086',
    },
  });

  monacoEditor = monaco.editor.create(container, {
    theme:                'catppuccin-mocha',
    language:             'plaintext',
    automaticLayout:      true,
    minimap:              { enabled: true },
    fontSize:             13,
    fontFamily:           "'IBM Plex Mono', 'Fira Code', 'Consolas', monospace",
    fontLigatures:        true,
    lineNumbers:          'on',
    wordWrap:             repoWordWrap ? 'on' : 'off',
    tabSize:              INDENT_PRESETS[repoIndent].tabSize,
    insertSpaces:         INDENT_PRESETS[repoIndent].insertSpaces,
    detectIndentation:    false,
    scrollBeyondLastLine: true,
    renderWhitespace:     'selection',
    bracketPairColorization: { enabled: true },
    folding:              true,
    glyphMargin:          true,
    showFoldingControls:  'mouseover',
    padding:              { top: 8 },
    smoothScrolling:      true,
    cursorBlinking:       'smooth',
    inlineSuggest:        { enabled: true },
  });

  // Ctrl+S to save
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);

  // Alt+\ to trigger AI inline suggestion explicitly
  monacoEditor.addAction({
    id: 'ai-complete',
    label: 'AI: Complete at Cursor',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash],
    run: () => monacoEditor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {}),
  });

  // Ctrl+/ comment out — also appears in right-click context menu
  monacoEditor.addAction({
    id: 'comment-out',
    label: 'Comment Out',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: (editor) => editor.trigger('contextmenu', 'editor.action.commentLine', null),
  });

  // Ctrl+I — AI inline edit panel
  monacoEditor.addAction({
    id: 'ai-inline-edit',
    label: 'AI: Edit Selection (Ctrl+I)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: openAiEditPanel,
  });

  // F1 — Quick Open (command palette / file search)
  monacoEditor.addCommand(monaco.KeyCode.F1, () => openQuickOpen('command'));

  // Ctrl+P — Quick Open in file mode
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openQuickOpen('file'));

  // Track dirty state per tab
  monacoEditor.onDidChangeModelContent(() => {
    const tab = repoTabs[activeRepoTab];
    if (!tab || tab.dirty) return;
    tab.dirty = true;
    renderRepoTabBar();
  });

  registerAiCompletions();
}

// ---------------------------------------------------------------------------
// AI Inline Completions — on explicit trigger (Alt+\) only
// Built on top of Monaco's built-in IntelliSense (additive, not replacing)
// ---------------------------------------------------------------------------
function registerAiCompletions() {
  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    provideInlineCompletions: async (model, position, context, token) => {
      // Only fire on explicit trigger (Alt+\ shortcut) to avoid API spam
      const isExplicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if (!isExplicit) return { items: [] };

      const offset = model.getOffsetAt(position);
      const fullText = model.getValue();
      const prefix = fullText.slice(0, offset);
      const suffix = fullText.slice(offset);

      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      try {
        const resp = await fetch('/api/ai/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prefix,
            suffix,
            language: model.getLanguageId(),
            filename: repoTabs[activeRepoTab]?.path || '',
          }),
          signal: controller.signal,
        });
        if (!resp.ok || token.isCancellationRequested) return { items: [] };
        const { completion } = await resp.json();
        if (!completion) return { items: [] };
        return {
          items: [{
            insertText: completion,
            range: {
              startLineNumber: position.lineNumber,
              startColumn:     position.column,
              endLineNumber:   position.lineNumber,
              endColumn:       position.column,
            },
          }],
        };
      } catch {
        return { items: [] };
      }
    },
    freeInlineCompletions: () => {},
  });
}

// ---------------------------------------------------------------------------
// AI Inline Edit — sends selection to Copilot Chat panel (Ctrl+I)
// ---------------------------------------------------------------------------
let repoEditContext = null; // { editor, range, tabKey } — used by repoApplyCode

function openAiEditPanel(editor) {
  const model     = editor.getModel();
  const sel       = editor.getSelection();
  const editRange = sel.isEmpty()
    ? new monaco.Range(sel.startLineNumber, 1, sel.startLineNumber, model.getLineLength(sel.startLineNumber) + 1)
    : sel;

  const tab  = repoTabs[activeRepoTab];
  const lang = model.getLanguageId();
  const path = tab?.path || '';
  const code = model.getValueInRange(editRange);
  const label = path ? path.split('/').pop() + ' (selection)' : 'Selection';
  const content = `\`\`\`${lang}\n// ${tab?.repo || ''}/${path}\n${code}\n\`\`\``;

  // Store context so Copilot Apply button knows where to write back
  repoEditContext = { editor, range: editRange, tabKey: activeRepoTab };
  window._repoEditContext = repoEditContext;

  if (typeof window.copilotInjectCode === 'function') {
    window.copilotInjectCode(label, content);
  } else {
    showToast('Copilot Chat panel not available', 'error');
  }
}

// Called by the Apply button in Copilot Chat to write code back into the editor
window.repoApplyCode = function(code) {
  const ctx = repoEditContext;
  if (!ctx) {
    // Fallback: apply to entire current active editor
    if (monacoEditor) {
      const model = monacoEditor.getModel();
      const fullRange = model.getFullModelRange();
      monacoEditor.executeEdits('copilot-apply', [{ range: fullRange, text: code, forceMoveMarkers: true }]);
      const tab = repoTabs[activeRepoTab];
      if (tab) { tab.dirty = true; renderTabs(); }
      showToast('Applied to editor', 'success');
    } else {
      showToast('No editor context — use Ctrl+I to set a target selection first', 'error');
    }
    return;
  }
  ctx.editor.executeEdits('copilot-apply', [{ range: ctx.range, text: code, forceMoveMarkers: true }]);
  const tab = repoTabs[ctx.tabKey];
  if (tab) { tab.dirty = true; renderTabs(); }
  repoEditContext = null;
  window._repoEditContext = null;
  showToast('Applied to editor', 'success');
};

// ---------------------------------------------------------------------------
// Quick Open (F1 = command palette, Ctrl+P = file search)
// ---------------------------------------------------------------------------
const QUICK_COMMANDS = [
  { label: 'Format Document',        desc: 'editor.action.formatDocument',       icon: '⌥', run: () => monacoEditor?.getAction('editor.action.formatDocument')?.run() },
  { label: 'Go to Line…',            desc: 'Ctrl+G',                             icon: '#', run: () => monacoEditor?.trigger('', 'editor.action.gotoLine', {}) },
  { label: 'Find in File',           desc: 'Ctrl+F',                             icon: '🔍', run: () => monacoEditor?.trigger('', 'actions.find', {}) },
  { label: 'Find & Replace in File', desc: 'Ctrl+H',                             icon: '↔', run: () => monacoEditor?.trigger('', 'editor.action.startFindReplaceAction', {}) },
  { label: 'Toggle Word Wrap',       desc: 'Alt+Z',                              icon: '⏎', run: () => { const btn = document.getElementById('repo-wordwrap-btn'); btn?.click(); } },
  { label: 'Toggle Minimap',         desc: '',                                   icon: '▤', run: () => { const v = monacoEditor?.getOption(monaco.editor.EditorOption.minimap)?.enabled; monacoEditor?.updateOptions({ minimap: { enabled: !v } }); } },
  { label: 'Save File',             desc: 'Ctrl+S',                             icon: '💾', run: () => saveCurrentFile() },
  { label: 'Close Tab',             desc: '',                                   icon: '✕', run: () => closeRepoTab(activeRepoTab) },
  { label: 'Search in Sidebar',     desc: 'focus search panel',                 icon: '🔎', run: () => { document.getElementById('repo-search-input')?.focus(); } },
];

let _qoMode = 'command'; // 'command' | 'file'
let _qoFiles = [];
let _qoSelected = -1;

async function openQuickOpen(mode = 'command') {
  const overlay = document.getElementById('quick-open-overlay');
  const modal   = document.getElementById('quick-open-modal');
  const input   = document.getElementById('quick-open-input');
  const prefix  = document.getElementById('quick-open-prefix');
  if (!modal || !input) return;

  _qoMode     = mode;
  _qoSelected = -1;

  overlay.style.display = '';
  modal.style.display   = '';
  input.value = '';
  prefix.textContent = mode === 'command' ? '>' : '';
  document.getElementById('quick-open-hint').style.display = mode === 'command' ? '' : 'none';

  if (mode === 'file' && currentRepo) {
    _qoFiles = [];
    try {
      const r = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/files`);
      if (r.ok) { const { files } = await r.json(); _qoFiles = files; }
    } catch { /* ignore */ }
  }

  _renderQuickOpenResults('');
  input.focus();
}

function closeQuickOpen() {
  document.getElementById('quick-open-overlay').style.display = 'none';
  document.getElementById('quick-open-modal').style.display   = 'none';
  monacoEditor?.focus();
}

function _renderQuickOpenResults(q) {
  const list = document.getElementById('quick-open-results');
  if (!list) return;
  list.innerHTML = '';
  _qoSelected = -1;

  let items = [];
  if (_qoMode === 'command') {
    items = QUICK_COMMANDS.filter(c =>
      !q || c.label.toLowerCase().includes(q.toLowerCase())
    ).map(c => ({ label: c.label, sub: c.desc, icon: c.icon, run: c.run }));
  } else {
    const lq = q.toLowerCase();
    items = (lq
      ? _qoFiles.filter(f => f.toLowerCase().includes(lq))
      : _qoFiles
    ).slice(0, 50).map(f => {
      const parts = f.split('/');
      return { label: parts.pop(), sub: parts.join('/'), icon: null, run: () => openFile(f) };
    });
  }

  items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'quick-open-item';
    el.dataset.idx = i;
    el.innerHTML =
      (item.icon ? `<span class="quick-open-item-icon">${esc(item.icon)}</span>` : '') +
      `<span class="quick-open-item-label">${esc(item.label)}</span>` +
      (item.sub ? `<span class="quick-open-item-sub">${esc(item.sub)}</span>` : '');
    el.addEventListener('click', () => { item.run(); closeQuickOpen(); });
    el.addEventListener('mouseenter', () => _qoSetSelected(i));
    list.appendChild(el);
  });
  list._items = items;
}

function _qoSetSelected(idx) {
  const list  = document.getElementById('quick-open-results');
  const items = list?.querySelectorAll('.quick-open-item');
  if (!items) return;
  items.forEach((el, i) => el.classList.toggle('selected', i === idx));
  _qoSelected = idx;
  if (idx >= 0) items[idx]?.scrollIntoView({ block: 'nearest' });
}

function initQuickOpen() {
  const overlay = document.getElementById('quick-open-overlay');
  const input   = document.getElementById('quick-open-input');
  const prefix  = document.getElementById('quick-open-prefix');
  if (!input) return;

  overlay?.addEventListener('click', closeQuickOpen);

  // F1 when no file is open (Monaco not focused) — intercept browser help
  document.addEventListener('keydown', e => {
    if (e.key !== 'F1') return;
    if (!document.getElementById('tab-repo')?.classList.contains('active')) return;
    e.preventDefault();
    openQuickOpen('command');
  });

  input.addEventListener('keydown', e => {
    const list = document.getElementById('quick-open-results');
    const count = list?.querySelectorAll('.quick-open-item').length || 0;

    if (e.key === 'Escape') { e.preventDefault(); closeQuickOpen(); return; }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _qoSetSelected(Math.min(_qoSelected + 1, count - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _qoSetSelected(Math.max(_qoSelected - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const items = list?._items;
      if (items && _qoSelected >= 0 && items[_qoSelected]) {
        items[_qoSelected].run();
        closeQuickOpen();
      } else if (items?.[0]) {
        items[0].run();
        closeQuickOpen();
      }
      return;
    }

    // Backspace on empty command prefix → switch to file mode
    if (e.key === 'Backspace' && _qoMode === 'command' && input.value === '') {
      _qoMode = 'file';
      prefix.textContent = '';
      document.getElementById('quick-open-hint').style.display = 'none';
      if (currentRepo && !_qoFiles.length) {
        const results = document.getElementById('quick-open-results');
        if (results) {
          results.innerHTML = '<div class="quick-open-item" style="opacity:0.5;pointer-events:none"><span class="quick-open-item-label">Loading files…</span></div>';
        }
        fetch(`/api/repos/${encodeURIComponent(currentRepo)}/files`)
          .then(r => r.ok ? r.json() : { files: [] })
          .then(({ files }) => {
            _qoFiles = files;
            const cur = document.getElementById('quick-open-input');
            _renderQuickOpenResults(cur?.value.trim() || '');
            _qoSetSelected(0);
          })
          .catch(() => {});
      } else {
        _renderQuickOpenResults('');
      }
    }
  });

  input.addEventListener('input', () => {
    _renderQuickOpenResults(input.value.trim());
    _qoSetSelected(0);
  });
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------
async function loadRepoTree(repo) {
  currentRepo = repo;
  treeOpenDirs.clear();
  dirtyFiles = new Set();
  repoTree = [];

  const treeEl = document.getElementById('repo-tree');
  if (treeEl) treeEl.innerHTML = '<div class="repo-tree-empty">Loading…</div>';

  try {
    const [treeResp, dirtyResp] = await Promise.all([
      fetch(`/api/repos/${encodeURIComponent(repo)}/tree`),
      fetch(`/api/repos/${encodeURIComponent(repo)}/changed-files`),
    ]);
    if (treeResp.ok) repoTree = await treeResp.json();
    if (dirtyResp.ok) {
      const { files } = await dirtyResp.json();
      dirtyFiles = new Set((files || []).map(f => f.file.replace(/\\/g, '/')));
    }
  } catch (err) {
    console.error('Failed to load repo tree:', err);
  }

  renderRepoTree();
}

function renderRepoTree() {
  const container = document.getElementById('repo-tree');
  if (!container) return;
  container.innerHTML = '';
  if (!repoTree.length) {
    container.innerHTML = '<div class="repo-tree-empty">No files found</div>';
    return;
  }
  renderTreeNodes(repoTree, container, 0);
}

// ---------------------------------------------------------------------------
// Drag state
// ---------------------------------------------------------------------------
let dragNode = null;

function renderTreeNodes(nodes, container, depth) {
  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = 'repo-tree-item' + (node.type === 'dir' ? ' repo-tree-dir' : ' repo-tree-file') + (node.ignored ? ' repo-tree-ignored' : '');
    el.style.paddingLeft = (8 + depth * 14) + 'px';
    el.dataset.path  = node.path;
    el.dataset.type  = node.type;
    el.dataset.depth = String(depth);
    el.draggable     = true;

    const activeTab = repoTabs[activeRepoTab];
    if (node.type === 'file' && activeTab?.path === node.path) el.classList.add('active');

    const isOpen  = treeOpenDirs.has(node.path);
    const isDirty = dirtyFiles.has(node.path);

    if (node.type === 'dir') {
      el.innerHTML = `<span class="repo-tree-icon">${isOpen ? ICON_FOLDER_OPEN : ICON_FOLDER}</span><span class="repo-tree-name">${esc(node.name)}</span>`;
      el.addEventListener('click', e => { if (!e.defaultPrevented) toggleDir(node, el); });
    } else {
      el.innerHTML = `<span class="repo-tree-icon">${ICON_FILE}</span><span class="repo-tree-name">${esc(node.name)}</span>${isDirty ? '<span class="repo-tree-dirty">M</span>' : ''}<button class="repo-tree-delete" title="Delete file">×</button>`;
      el.addEventListener('click', e => {
        if (e.target.closest('.repo-tree-delete')) { e.stopPropagation(); deleteFile(node.path); }
        else if (!e.defaultPrevented) openFile(node.path);
      });
    }

    // Context menu
    el.addEventListener('contextmenu', e => { e.preventDefault(); showRepoContextMenu(e, node); });

    // Drag & drop
    el.addEventListener('dragstart', e => {
      dragNode = node;
      el.classList.add('repo-tree-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
    });
    el.addEventListener('dragend', () => {
      dragNode = null;
      el.classList.remove('repo-tree-dragging');
      document.querySelectorAll('.repo-tree-drop-target').forEach(x => x.classList.remove('repo-tree-drop-target'));
    });
    el.addEventListener('dragover', e => {
      if (!dragNode || dragNode.path === node.path) return;
      // Prevent dropping a folder into itself or its own children
      if (node.path.startsWith(dragNode.path + '/')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.repo-tree-drop-target').forEach(x => x.classList.remove('repo-tree-drop-target'));
      el.classList.add('repo-tree-drop-target');
    });
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('repo-tree-drop-target');
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.classList.remove('repo-tree-drop-target');
      if (!dragNode || dragNode.path === node.path) return;
      if (node.path.startsWith(dragNode.path + '/')) return;

      const targetDir = node.type === 'dir'
        ? node.path
        : node.path.split('/').slice(0, -1).join('/');
      const destPath = targetDir ? `${targetDir}/${dragNode.name}` : dragNode.name;
      if (destPath === dragNode.path) return;
      await moveItem(dragNode.path, destPath);
    });

    container.appendChild(el);

    if (node.type === 'dir' && isOpen && node.children?.length) {
      const childWrap = document.createElement('div');
      childWrap.dataset.children = node.path;
      renderTreeNodes(node.children, childWrap, depth + 1);
      container.appendChild(childWrap);
    }
  }
}

async function toggleDir(node, el) {
  const depth  = parseInt(el.dataset.depth || '0');
  const isOpen = treeOpenDirs.has(node.path);
  const iconEl = el.querySelector('.repo-tree-icon');

  if (isOpen) {
    treeOpenDirs.delete(node.path);
    if (iconEl) iconEl.innerHTML = ICON_FOLDER;
    const childWrap = el.nextSibling;
    if (childWrap?.dataset?.children === node.path) childWrap.remove();
  } else {
    treeOpenDirs.add(node.path);
    if (iconEl) iconEl.innerHTML = ICON_FOLDER_OPEN;
    if (!node.children) {
      try {
        const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/tree?path=${encodeURIComponent(node.path)}`);
        node.children = resp.ok ? await resp.json() : [];
      } catch { node.children = []; }
    }
    if (node.children?.length) {
      const childWrap = document.createElement('div');
      childWrap.dataset.children = node.path;
      renderTreeNodes(node.children, childWrap, depth + 1);
      el.insertAdjacentElement('afterend', childWrap);
    }
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function getRepoContextMenu() {
  let menu = document.getElementById('repo-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id        = 'repo-context-menu';
    menu.className = 'repo-context-menu';
    document.body.appendChild(menu);
    document.addEventListener('click',   () => hideRepoContextMenu());
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hideRepoContextMenu(); });
  }
  return menu;
}

function hideRepoContextMenu() {
  const m = document.getElementById('repo-context-menu');
  if (m) m.style.display = 'none';
}

function showRepoContextMenu(e, node) {
  const menu  = getRepoContextMenu();
  menu.innerHTML = '';

  const items = node.type === 'file' ? [
    { label: 'Open',           action: () => openFile(node.path) },
    { divider: true },
    { label: 'Copy Path',      action: () => copyText(node.path) },
    { label: 'Copy Link',      action: () => copyRepoNodeLink(node) },
    { divider: true },
    { label: 'Rename',         action: () => startRename(node) },
    { label: 'Delete',         action: () => deleteFile(node.path), danger: true },
  ] : [
    { label: 'New File Here…', action: () => showNewFileInput(node.path + '/') },
    { label: 'New Folder Here…', action: () => showNewFolderInput(node.path + '/') },
    { divider: true },
    { label: 'Rename',         action: () => startRename(node) },
  ];

  for (const item of items) {
    if (item.divider) {
      const d = document.createElement('div');
      d.className = 'repo-ctx-divider';
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'repo-ctx-item' + (item.danger ? ' danger' : '');
    btn.textContent = item.label;
    btn.addEventListener('click', e => { e.stopPropagation(); hideRepoContextMenu(); item.action(); });
    menu.appendChild(btn);
  }

  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth  - menu.offsetWidth  - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showToast('Copied', 'success'); }
  catch { showToast('Copy failed', 'error'); }
}

function copyRepoNodeLink(node) {
  const hash = '#repo/' + encodeURIComponent(node.repo || currentRepo) + '/' + node.path.split('/').map(encodeURIComponent).join('/');
  copyText(location.href.split('#')[0] + hash);
}

// ---------------------------------------------------------------------------
// Rename (inline)
// ---------------------------------------------------------------------------
function startRename(node) {
  const el = document.querySelector(`.repo-tree-item[data-path="${CSS.escape(node.path)}"]`);
  if (!el) return;
  const nameEl = el.querySelector('.repo-tree-name');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.className = 'repo-rename-input';
  input.value     = node.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (!newName || newName === node.name) { await loadRepoTree(currentRepo); return; }
    const parentDir = node.path.split('/').slice(0, -1).join('/');
    const newPath   = parentDir ? `${parentDir}/${newName}` : newName;
    await moveItem(node.path, newPath);
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; loadRepoTree(currentRepo); }
  });
  input.addEventListener('blur', commit);
}

// ---------------------------------------------------------------------------
// Move (rename/drag-drop)
// ---------------------------------------------------------------------------
async function moveItem(fromPath, toPath) {
  try {
    const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromPath, to: toPath }),
    });
    if (!resp.ok) {
      const { error } = await resp.json().catch(() => ({}));
      showToast(error || 'Move failed', 'error');
      await loadRepoTree(currentRepo);
      return;
    }
    // Update open tabs that reference the moved path or moved directory
    for (const tab of repoTabs) {
      if (tab.path === fromPath || tab.path.startsWith(fromPath + '/')) {
        const oldPath = tab.path;
        tab.path = oldPath.replace(fromPath, toPath);
        tab.lang = getLang(tab.path);
        if (tab.model && window.monaco) {
          const newModel = monaco.editor.createModel(tab.model.getValue(), tab.lang);
          tab.model.dispose();
          tab.model = newModel;
          if (repoTabs[activeRepoTab] === tab) monacoEditor?.setModel(tab.model);
        }
      }
    }
    renderRepoTabBar();
    await loadRepoTree(currentRepo);
    persistRepoTabs();
  } catch {
    showToast('Move failed', 'error');
  }
}

// ---------------------------------------------------------------------------
// Repo search
// ---------------------------------------------------------------------------
let _searchDebounce = null;
let _searchActive   = false;

function _highlightRepoMatch(text, q) {
  const escaped = esc(text);
  try {
    const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(new RegExp(pattern, 'gi'), m => `<mark class="repo-search-mark">${m}</mark>`);
  } catch {
    return escaped;
  }
}

function initRepoSearch() {
  const input     = document.getElementById('repo-search-input');
  const clearBtn  = document.getElementById('repo-search-clear');
  const expandBtn = document.getElementById('repo-search-expand');
  const advanced  = document.getElementById('repo-search-advanced');
  const replaceInput  = document.getElementById('repo-replace-input');
  const replaceAllBtn = document.getElementById('repo-replace-all-btn');
  if (!input) return;

  // Expand/collapse toggle
  expandBtn?.addEventListener('click', () => {
    const open = advanced.style.display === 'none';
    advanced.style.display = open ? '' : 'none';
    expandBtn.classList.toggle('open', open);
    if (open) replaceInput?.focus();
  });

  // Trigger search when include/exclude change
  const filterInputs = [
    document.getElementById('repo-search-include'),
    document.getElementById('repo-search-exclude'),
  ];
  filterInputs.forEach(el => {
    el?.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(_searchDebounce);
      if (q) _searchDebounce = setTimeout(() => runRepoSearch(q), 400);
    });
  });

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.style.display = q ? 'block' : 'none';
    clearTimeout(_searchDebounce);
    if (!q) { clearRepoSearch(); return; }
    _searchDebounce = setTimeout(() => runRepoSearch(q), 300);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; clearRepoSearch(); input.blur(); }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    clearRepoSearch();
    input.focus();
  });

  // Replace All — opens each matched file in Monaco and does find+replace
  replaceAllBtn?.addEventListener('click', async () => {
    const q = input.value.trim();
    const r = replaceInput?.value || '';
    if (!q || !r || !currentRepo) return;
    const include = document.getElementById('repo-search-include')?.value.trim() || '';
    const exclude = document.getElementById('repo-search-exclude')?.value.trim() || '';
    const params  = new URLSearchParams({ q });
    if (include) params.set('include', include);
    if (exclude) params.set('exclude', exclude);
    const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/search?${params}`).catch(() => null);
    if (!resp?.ok) return;
    const { results } = await resp.json();
    if (!results.length) { showToast('No matches to replace', 'info'); return; }
    // Open the first file and trigger Monaco's find+replace with terms pre-filled
    await openFile(results[0].path);
    setTimeout(() => {
      if (monacoEditor) {
        monacoEditor.trigger('', 'editor.action.startFindReplaceAction', {});
        // After widget opens, seed the values via DOM (Monaco doesn't expose a public API for this)
        setTimeout(() => {
          const findInput = document.querySelector('.monaco-editor .findMatch, .monaco-editor .find-widget input');
          showToast(`Replace opened — ${results.length} file(s) have matches`, 'info');
        }, 150);
      }
    }, 200);
  });
}

function clearRepoSearch() {
  _searchActive = false;
  const bar = document.getElementById('repo-search-bar');
  if (bar) bar.classList.remove('active');
  renderRepoTree(); // restore normal tree
}

async function runRepoSearch(q) {
  if (!currentRepo) return;
  _searchActive = true;
  const bar = document.getElementById('repo-search-bar');
  if (bar) bar.classList.add('active');

  const container = document.getElementById('repo-tree');
  if (container) container.innerHTML = '<div class="repo-tree-empty">Searching…</div>';

  try {
    const include = document.getElementById('repo-search-include')?.value.trim() || '';
    const exclude = document.getElementById('repo-search-exclude')?.value.trim() || '';
    const params  = new URLSearchParams({ q });
    if (include) params.set('include', include);
    if (exclude) params.set('exclude', exclude);
    const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/search?${params}`);
    if (!resp.ok) throw new Error('search failed');
    const { results } = await resp.json();

    // Abort if a newer search cleared/replaced us
    if (!_searchActive) return;

    if (container) {
      container.innerHTML = '';
      if (!results.length) {
        container.innerHTML = '<div class="repo-tree-empty">No results</div>';
        return;
      }

      const totalMatches = results.reduce((n, f) => n + (f.matches.length || 1), 0);
      const summary = document.createElement('div');
      summary.className = 'repo-search-summary';
      summary.textContent = `${results.length} file${results.length !== 1 ? 's' : ''}, ${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`;
      container.appendChild(summary);

      for (const file of results) {
        const fileName = file.path.split('/').pop();
        const fileDir  = file.path.split('/').slice(0, -1).join('/');

        const fileEl = document.createElement('div');
        fileEl.className = 'repo-search-result-file';
        fileEl.innerHTML =
          `<span class="repo-tree-icon">${ICON_FILE}</span>` +
          `<span class="repo-search-result-name">${esc(fileName)}</span>` +
          (fileDir ? `<span class="repo-search-result-dir">${esc(fileDir)}</span>` : '') +
          (file.matches.length ? `<span class="repo-search-result-count">${file.matches.length}</span>` : '');
        fileEl.addEventListener('click', () => openFile(file.path));
        container.appendChild(fileEl);

        for (const m of file.matches) {
          const matchEl = document.createElement('div');
          matchEl.className = 'repo-search-result-match';
          matchEl.innerHTML =
            `<span class="repo-search-result-line">${m.line}</span>` +
            `<span class="repo-search-result-text">${_highlightRepoMatch(m.text.trimStart().slice(0, 120), q)}</span>`;
          matchEl.addEventListener('click', () => openRepoFileAtLine(currentRepo, file.path, m.line));
          container.appendChild(matchEl);
        }
      }
    }
  } catch {
    if (container && _searchActive) container.innerHTML = '<div class="repo-tree-empty">Search error</div>';
  }
}

// ---------------------------------------------------------------------------
// Reveal file in tree — expands all parent dirs and scrolls into view
// ---------------------------------------------------------------------------
async function revealFileInTree(filePath) {
  if (!repoTree.length) return;

  // Build ordered list of ancestor dir paths
  const parts = filePath.split('/');
  const dirPaths = [];
  for (let i = 1; i < parts.length; i++) {
    dirPaths.push(parts.slice(0, i).join('/'));
  }

  // Walk the live tree nodes, opening and fetching children as needed
  let nodes = repoTree;
  for (const dirPath of dirPaths) {
    const node = nodes.find(n => n.path === dirPath && n.type === 'dir');
    if (!node) break;
    treeOpenDirs.add(dirPath);
    if (!node.children) {
      try {
        const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/tree?path=${encodeURIComponent(dirPath)}`);
        node.children = resp.ok ? await resp.json() : [];
      } catch { node.children = []; }
    }
    nodes = node.children || [];
  }

  renderRepoTree();

  requestAnimationFrame(() => {
    const el = document.querySelector(`.repo-tree-item[data-path="${CSS.escape(filePath)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  });
}

// ---------------------------------------------------------------------------
// File tabs
// ---------------------------------------------------------------------------
function openFile(path) {
  if (!currentRepo) return;
  revealFileInTree(path); // expand tree to show this file (fire-and-forget)
  const existingIdx = repoTabs.findIndex(t => t.repo === currentRepo && t.path === path);
  if (existingIdx >= 0) {
    setActiveRepoTab(existingIdx);
    return;
  }
  const lang = getLang(path);
  repoTabs.push({ repo: currentRepo, path, lang, content: null, model: null, dirty: false, scrollTop: 0, mtime: null, mdPreview: lang === 'markdown' });
  setActiveRepoTab(repoTabs.length - 1);
}

// ---------------------------------------------------------------------------
// New file / delete file
// ---------------------------------------------------------------------------
function showNewFileInput(prefix = '') {
  if (!currentRepo) { showToast('Select a repo first', 'error'); return; }
  const tree = document.getElementById('repo-tree');
  if (!tree || document.getElementById('repo-new-file-row')) return;

  const icon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
  const placeholder = prefix ? 'filename.ts' : 'path/to/file.ts';
  const row = document.createElement('div');
  row.id        = 'repo-new-file-row';
  row.className = 'repo-new-file-row';
  row.innerHTML = `${icon}${prefix ? `<span class="repo-new-file-prefix">${esc(prefix)}</span>` : ''}<input id="repo-new-file-input" class="repo-new-file-input" placeholder="${placeholder}" spellcheck="false" />`;
  tree.insertBefore(row, tree.firstChild);

  const input = row.querySelector('input');
  input.focus();

  let committed = false;
  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      committed = true;
      const typed = input.value.trim().replace(/^\/+/, '');
      row.remove();
      if (typed) await createNewFile((prefix + typed).replace(/^\/+/, ''));
    } else if (e.key === 'Escape') {
      committed = true; row.remove();
    }
  });
  input.addEventListener('blur', () => { if (!committed) setTimeout(() => row.remove(), 150); });
}

function showNewFolderInput(prefix = '') {
  if (!currentRepo) { showToast('Select a repo first', 'error'); return; }
  const tree = document.getElementById('repo-tree');
  if (!tree || document.getElementById('repo-new-file-row')) return;

  const icon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const row = document.createElement('div');
  row.id        = 'repo-new-file-row';
  row.className = 'repo-new-file-row';
  row.innerHTML = `${icon}${prefix ? `<span class="repo-new-file-prefix">${esc(prefix)}</span>` : ''}<input id="repo-new-file-input" class="repo-new-file-input" placeholder="folder-name" spellcheck="false" />`;
  tree.insertBefore(row, tree.firstChild);

  const input = row.querySelector('input');
  input.focus();

  let committed = false;
  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      committed = true;
      const typed = input.value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
      row.remove();
      if (typed) await createNewFolder((prefix + typed).replace(/^\/+/, ''));
    } else if (e.key === 'Escape') {
      committed = true; row.remove();
    }
  });
  input.addEventListener('blur', () => { if (!committed) setTimeout(() => row.remove(), 150); });
}

async function createNewFolder(path) {
  try {
    const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!resp.ok) { showToast('Failed to create folder', 'error'); return; }
    showToast(`Created ${path.split('/').pop()}/`, 'success');
    await loadRepoTree(currentRepo);
  } catch {
    showToast('Failed to create folder', 'error');
  }
}

async function createNewFile(path) {
  try {
    const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: '' }),
    });
    if (!resp.ok) { showToast('Failed to create file', 'error'); return; }
    showToast(`Created ${path.split('/').pop()}`, 'success');
    await loadRepoTree(currentRepo);
    openFile(path);
  } catch {
    showToast('Failed to create file', 'error');
  }
}

async function deleteFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

  // Close the tab if open
  const tabIdx = repoTabs.findIndex(t => t.repo === currentRepo && t.path === path);
  if (tabIdx >= 0) {
    repoTabs[tabIdx].dirty = false; // skip unsaved-changes prompt
    closeRepoTab(tabIdx);
  }

  try {
    const resp = await fetch(`/api/repos/${encodeURIComponent(currentRepo)}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) { showToast('Failed to delete file', 'error'); return; }
    showToast(`Deleted ${name}`, 'success');
    await loadRepoTree(currentRepo);
  } catch {
    showToast('Failed to delete file', 'error');
  }
}

// Public — called by app.js hash router
async function openRepoFile(repo, path) {
  const select = document.getElementById('repo-select');
  if (currentRepo !== repo) {
    if (select) select.value = repo;
    await loadRepoTree(repo);
  }
  openFile(path);
}
window.openRepoFile = openRepoFile;

// Public — called by search overlay to open at a specific line
async function openRepoFileAtLine(repo, path, line) {
  pendingRevealLine = line;
  await openRepoFile(repo, path);
}
window.openRepoFileAtLine = openRepoFileAtLine;

// Public — called by other widgets to switch to a repo without opening a file
let _pendingRepo = null;
window.openRepo = async function(repo) {
  if (repoViewerReady) {
    const select = document.getElementById('repo-select');
    if (select) select.value = repo;
    await loadRepoTree(repo);
  } else {
    // initRepo hasn't populated the dropdown yet — store and let it pick up after init
    _pendingRepo = repo;
  }
};

async function setActiveRepoTab(idx) {
  // Persist scroll of outgoing tab
  if (activeRepoTab >= 0 && monacoEditor && repoTabs[activeRepoTab]) {
    repoTabs[activeRepoTab].scrollTop = monacoEditor.getScrollTop();
  }

  activeRepoTab = idx;
  renderRepoTabBar();

  const tab = repoTabs[idx];
  if (tab) revealFileInTree(tab.path);
  if (!tab) {
    showRepoEmpty(true);
    return;
  }
  showRepoEmpty(false);

  // Load content if not yet fetched
  if (tab.content === null) {
    try {
      const resp = await fetch(`/api/repos/${encodeURIComponent(tab.repo)}/file?path=${encodeURIComponent(tab.path)}`);
      if (!resp.ok) { showToast('Failed to load file', 'error'); return; }
      const { content, mtime } = await resp.json();
      tab.content = content;
      tab.mtime = mtime ?? null;
    } catch {
      showToast('Failed to load file', 'error');
      return;
    }
  }

  // Update URL hash for deep-linking
  history.replaceState(null, '', '#repo/' + encodeURIComponent(tab.repo) + '/' + tab.path.split('/').map(encodeURIComponent).join('/'));
  updateCopyLinkBtn();

  waitForMonaco(() => {
    initMonacoEditor();
    if (!tab.model) {
      tab.model = monaco.editor.createModel(tab.content, tab.lang);
    }
    monacoEditor.setModel(tab.model);
    if (tab.scrollTop) monacoEditor.setScrollTop(tab.scrollTop);
    // Show MD preview or editor depending on tab state
    if (tab.lang === 'markdown' && tab.mdPreview) {
      showMdPreview(tab.content);
    } else {
      hideMdPreview();
      monacoEditor.focus();
    }
    // Reveal a specific line if requested (e.g. from global search)
    if (pendingRevealLine) {
      const lineNo = pendingRevealLine;
      pendingRevealLine = null;
      monacoEditor.revealLineInCenter(lineNo);
      monacoEditor.setPosition({ lineNumber: lineNo, column: 1 });
      // Flash the line with a temporary decoration
      const deco = monacoEditor.deltaDecorations([], [{
        range: new monaco.Range(lineNo, 1, lineNo, 1),
        options: { isWholeLine: true, className: 'repo-search-line-highlight' },
      }]);
      setTimeout(() => monacoEditor.deltaDecorations(deco, []), 2000);
    }
    // Highlight active file in tree
    document.querySelectorAll('.repo-tree-item').forEach(el => {
      el.classList.toggle('active', el.dataset.path === tab.path && el.dataset.type === 'file');
    });
  });

  persistRepoTabs();
}

function closeRepoTab(idx) {
  const tab = repoTabs[idx];
  if (!tab) return;
  if (tab.dirty && !confirm(`Close "${tab.path.split('/').pop()}" without saving?`)) return;
  if (tab.model) tab.model.dispose();
  repoTabs.splice(idx, 1);

  if (repoTabs.length === 0) {
    activeRepoTab = -1;
    if (monacoEditor) monacoEditor.setModel(monaco.editor.createModel('', 'plaintext'));
    showRepoEmpty(true);
    renderRepoTabBar();
  } else {
    const next = Math.min(idx, repoTabs.length - 1);
    activeRepoTab = -1; // force re-render
    setActiveRepoTab(next);
  }
  persistRepoTabs();
}

async function saveCurrentFile() {
  const tab = repoTabs[activeRepoTab];
  if (!tab || !monacoEditor) return;
  const content = monacoEditor.getValue();
  try {
    const resp = await fetch(`/api/repos/${encodeURIComponent(tab.repo)}/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tab.path, content }),
    });
    if (!resp.ok) { showToast('Save failed', 'error'); return; }
    const { mtime } = await resp.json();
    tab.content = content;
    tab.dirty   = false;
    tab.mtime   = mtime ?? null;
    renderRepoTabBar();
    showToast(`Saved ${tab.path.split('/').pop()}`, 'success');
  } catch {
    showToast('Save failed', 'error');
  }
}
window.saveCurrentRepoFile = saveCurrentFile;

function renderRepoTabBar() {
  const bar     = document.getElementById('repo-open-tabs');
  const toolbar = document.getElementById('repo-editor-toolbar');
  if (!bar) return;
  bar.innerHTML = '';
  for (let i = 0; i < repoTabs.length; i++) {
    const tab  = repoTabs[i];
    const name = tab.path.split('/').pop();
    const el   = document.createElement('div');
    el.className = 'repo-open-tab' + (i === activeRepoTab ? ' active' : '');
    el.title = tab.path;
    el.innerHTML = `<span class="repo-open-tab-name${tab.dirty ? ' dirty' : ''}">${tab.dirty ? '● ' : ''}${esc(name)}</span><button class="repo-open-tab-close" title="Close">×</button>`;
    el.addEventListener('click', e => {
      if (e.target.closest('.repo-open-tab-close')) closeRepoTab(i);
      else setActiveRepoTab(i);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof showContextMenu === 'function') {
        showContextMenu(e, [
          { label: 'Close',               action: () => closeRepoTab(i) },
          { label: 'Close Others',        action: () => { repoTabs = [repoTabs[i]]; activeRepoTab = 0; renderRepoTabBar(); setActiveRepoTab(0); persistRepoTabs(); } },
          { label: 'Close to the Right',  action: () => { repoTabs.splice(i + 1); if (activeRepoTab > i) activeRepoTab = i; renderRepoTabBar(); setActiveRepoTab(Math.min(activeRepoTab, repoTabs.length - 1)); persistRepoTabs(); } },
          { label: 'Close All',           action: () => { repoTabs.forEach(t => { if (t.model) t.model.dispose(); }); repoTabs = []; activeRepoTab = -1; if (monacoEditor) monacoEditor.setModel(monaco.editor.createModel('', 'plaintext')); showRepoEmpty(true); renderRepoTabBar(); persistRepoTabs(); } },
        ]);
      }
    });

    // Drag-and-drop reordering
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      _repoTabDragSrc = i;
      el.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      document.querySelectorAll('.repo-open-tab').forEach(t => t.classList.remove('tab-dragging', 'tab-drag-over'));
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.repo-open-tab').forEach(t => t.classList.remove('tab-drag-over'));
      if (i !== _repoTabDragSrc) el.classList.add('tab-drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (_repoTabDragSrc === null || _repoTabDragSrc === i) return;
      const moved = repoTabs.splice(_repoTabDragSrc, 1)[0];
      repoTabs.splice(i, 0, moved);
      if (activeRepoTab === _repoTabDragSrc) activeRepoTab = i;
      else if (_repoTabDragSrc < activeRepoTab && i >= activeRepoTab) activeRepoTab--;
      else if (_repoTabDragSrc > activeRepoTab && i <= activeRepoTab) activeRepoTab++;
      _repoTabDragSrc = null;
      renderRepoTabBar();
      persistRepoTabs();
    });

    bar.appendChild(el);
  }

  // Toolbar row (indent / wrap / link) — rendered into the separate sub-header
  if (toolbar) {
    toolbar.innerHTML = '';
    if (repoTabs[activeRepoTab]) {
      // Indent selector
      const indentSel = document.createElement('select');
      indentSel.id        = 'repo-indent-select';
      indentSel.className = 'repo-indent-select';
      indentSel.title     = 'Indentation';
      for (const [key, preset] of Object.entries(INDENT_PRESETS)) {
        const opt = document.createElement('option');
        opt.value       = key;
        opt.textContent = preset.label;
        opt.selected    = key === repoIndent;
        indentSel.appendChild(opt);
      }
      indentSel.addEventListener('change', () => {
        repoIndent = indentSel.value;
        localStorage.setItem('repoIndent', repoIndent);
        const p = INDENT_PRESETS[repoIndent];
        if (monacoEditor) monacoEditor.updateOptions({ tabSize: p.tabSize, insertSpaces: p.insertSpaces });
      });
      toolbar.appendChild(indentSel);

      // Word wrap toggle
      const wrapBtn = document.createElement('button');
      wrapBtn.id        = 'repo-wordwrap-btn';
      wrapBtn.className = 'repo-toolbar-btn' + (repoWordWrap ? ' active' : '');
      wrapBtn.title     = 'Toggle word wrap';
      wrapBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><path d="M3 12h13a3 3 0 0 1 0 6h-1"/><polyline points="12 15 9 18 12 21"/><line x1="3" y1="18" x2="9" y2="18" opacity="0"/></svg>Wrap`;
      wrapBtn.addEventListener('click', () => {
        repoWordWrap = !repoWordWrap;
        localStorage.setItem('repoWordWrap', repoWordWrap ? 'on' : 'off');
        if (monacoEditor) monacoEditor.updateOptions({ wordWrap: repoWordWrap ? 'on' : 'off' });
        wrapBtn.classList.toggle('active', repoWordWrap);
      });
      toolbar.appendChild(wrapBtn);

      // MD preview toggle (markdown files only)
      const activeTab = repoTabs[activeRepoTab];
      if (activeTab && activeTab.lang === 'markdown') {
        const previewBtn = document.createElement('button');
        previewBtn.id        = 'repo-md-preview-btn';
        previewBtn.className = 'repo-toolbar-btn' + (activeTab.mdPreview ? ' active' : '');
        previewBtn.title     = 'Toggle markdown preview';
        previewBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Preview`;
        previewBtn.addEventListener('click', () => {
          activeTab.mdPreview = !activeTab.mdPreview;
          previewBtn.classList.toggle('active', activeTab.mdPreview);
          if (activeTab.mdPreview) {
            showMdPreview(activeTab.content);
          } else {
            hideMdPreview();
            waitForMonaco(() => {
              initMonacoEditor();
              monacoEditor.setModel(activeTab.model);
              monacoEditor.focus();
            });
          }
        });
        toolbar.appendChild(previewBtn);
      }

      // Copy-link button
      const btn = document.createElement('button');
      btn.id        = 'repo-copy-link-btn';
      btn.className = 'repo-toolbar-btn';
      btn.title     = 'Copy link to this file';
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
      btn.addEventListener('click', copyRepoLink);
      toolbar.appendChild(btn);
    }
  }
}

function updateCopyLinkBtn() {
  // Re-render just the button state without full tab bar rebuild
  const btn = document.getElementById('repo-copy-link-btn');
  if (btn) btn.classList.remove('copied');
}

async function copyRepoLink() {
  const url = location.href.split('#')[0] + location.hash;
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById('repo-copy-link-btn');
    if (btn) {
      btn.classList.add('copied');
      btn.title = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Copy link to this file'; }, 2000);
    }
  } catch {
    showToast('Could not copy to clipboard', 'error');
  }
}

function showMdPreview(content) {
  const editor  = document.getElementById('repo-editor-container');
  const preview = document.getElementById('repo-md-preview');
  if (editor)  editor.style.display  = 'none';
  if (preview) {
    preview.style.display = 'block';
    const html = typeof marked !== 'undefined'
      ? marked.parse(content, { breaks: true, gfm: true })
      : `<pre>${esc(content)}</pre>`;
    preview.innerHTML = html;
    preview.querySelectorAll('pre code').forEach(block => {
      if (typeof hljs !== 'undefined') hljs.highlightElement(block);
    });
  }
}

function hideMdPreview() {
  const editor  = document.getElementById('repo-editor-container');
  const preview = document.getElementById('repo-md-preview');
  if (editor)  editor.style.display  = 'block';
  if (preview) preview.style.display = 'none';
}

function showRepoEmpty(show) {
  const empty   = document.getElementById('repo-empty');
  const editor  = document.getElementById('repo-editor-container');
  const preview = document.getElementById('repo-md-preview');
  if (empty)  empty.style.display  = show ? 'flex' : 'none';
  if (show) {
    if (editor)  editor.style.display  = 'none';
    if (preview) preview.style.display = 'none';
  } else {
    if (editor)  editor.style.display  = 'block';
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function persistRepoTabs() {
  const data = repoTabs.map(t => ({ repo: t.repo, path: t.path, lang: t.lang }));
  localStorage.setItem(REPO_TABS_KEY,   JSON.stringify(data));
  localStorage.setItem(REPO_ACTIVE_KEY, String(activeRepoTab));
  if (currentRepo) localStorage.setItem(REPO_REPO_KEY, currentRepo);
}

// ---------------------------------------------------------------------------
// Sidebar resize
// ---------------------------------------------------------------------------
function initSidebarResize() {
  const resizer = document.getElementById('repo-sidebar-resizer');
  const sidebar = document.querySelector('.repo-sidebar');
  if (!resizer || !sidebar) return;

  const saved = localStorage.getItem(REPO_SIDEBAR_KEY);
  if (saved) sidebar.style.width = saved + 'px';

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
    localStorage.setItem(REPO_SIDEBAR_KEY, sidebar.offsetWidth);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function initRepo() {
  if (repoViewerReady) return;
  repoViewerReady = true;

  initSidebarResize();
  initRepoSearch();
  initQuickOpen();

  const select = document.getElementById('repo-select');
  if (!select) return;

  // Populate repo dropdown
  async function populateRepoDropdown() {
    try {
      const resp  = await fetch('/api/repo/list');
      const allRepos = await resp.json();
      const hiddenRepos = typeof getHiddenRepos === 'function' ? getHiddenRepos() : new Set();
      const repos = allRepos.filter(r => !hiddenRepos.has(r));
      const prev = select.value;
      select.innerHTML = '<option value="">Select a repo…</option>' +
        repos.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
      if (prev && repos.includes(prev)) select.value = prev;
    } catch {
      select.innerHTML = '<option value="">Failed to load repos</option>';
    }
  }
  await populateRepoDropdown();

  // Allow settings page to refresh the list after config save
  window.refreshRepoList = populateRepoDropdown;

  document.getElementById('repo-new-file-btn')?.addEventListener('click', () => showNewFileInput());

  select.addEventListener('change', async () => {
    if (!select.value) return;
    // Clear any active search and reset search input
    const searchInput = document.getElementById('repo-search-input');
    const clearBtn    = document.getElementById('repo-search-clear');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    clearTimeout(_searchDebounce);
    _searchActive = false;
    // Close all tabs when switching repos
    repoTabs.forEach(t => { if (t.model) t.model.dispose(); });
    repoTabs = [];
    activeRepoTab = -1;
    renderRepoTabBar();
    showRepoEmpty(true);
    await loadRepoTree(select.value);
    persistRepoTabs();
  });

  // If a #repo/ hash route is present, it takes priority over saved state.
  // Parse it now so we can use it after the dropdown is populated.
  const hashMatch = location.hash.match(/^#repo\/([^/]+)\/(.+)/);
  const hashRepo  = hashMatch ? decodeURIComponent(hashMatch[1]) : null;
  const hashPath  = hashMatch ? hashMatch[2].split('/').map(decodeURIComponent).join('/') : null;

  if (_pendingRepo) {
    const target = _pendingRepo;
    _pendingRepo = null;
    select.value = target;
    await loadRepoTree(target);
  } else if (hashRepo) {
    // Ensure the repo is in the dropdown (it may not be if it was shared by someone else)
    if (!select.querySelector(`option[value="${hashRepo}"]`)) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = hashRepo;
      select.appendChild(opt);
    }
    select.value = hashRepo;
    await loadRepoTree(hashRepo);
    openFile(hashPath);
  } else {
    // Normal session restore
    try {
      const savedRepo   = localStorage.getItem(REPO_REPO_KEY);
      const savedTabs   = JSON.parse(localStorage.getItem(REPO_TABS_KEY)  || '[]');
      const savedActive = parseInt(localStorage.getItem(REPO_ACTIVE_KEY)  || '-1');

      if (savedRepo) {
        select.value = savedRepo;
        await loadRepoTree(savedRepo);

        if (savedTabs.length) {
          repoTabs = savedTabs.map(t => ({ ...t, content: null, model: null, dirty: false, scrollTop: 0 }));
          const targetIdx = savedActive >= 0 && savedActive < repoTabs.length ? savedActive : 0;
          await setActiveRepoTab(targetIdx);
        }
      }
    } catch { /* ignore persistence errors */ }
  }
}

window.initRepo = initRepo;

// ── File-change watcher ──────────────────────────────────────────────────────
// Polls open tabs every 2s. If a file changed on disk and the tab isn't dirty,
// silently reload it so the dashboard follows along with external edits (e.g. Claude).

async function pollOpenFiles() {
  for (let i = 0; i < repoTabs.length; i++) {
    const tab = repoTabs[i];
    if (tab.mtime === null || tab.dirty) continue; // skip unloaded or dirty tabs

    try {
      const res = await fetch(`/api/repos/${encodeURIComponent(tab.repo)}/filemtime?path=${encodeURIComponent(tab.path)}`);
      if (!res.ok) continue;
      const { mtime } = await res.json();
      if (mtime === tab.mtime) continue; // no change

      // File changed — fetch new content
      const fileRes = await fetch(`/api/repos/${encodeURIComponent(tab.repo)}/file?path=${encodeURIComponent(tab.path)}`);
      if (!fileRes.ok) continue;
      const { content, mtime: newMtime } = await fileRes.json();
      tab.content = content;
      tab.mtime = newMtime ?? mtime;

      if (i === activeRepoTab && tab.model) {
        // Active tab: update model in place, preserving cursor position
        const pos = monacoEditor.getPosition();
        tab.model.setValue(content);
        if (pos) monacoEditor.setPosition(pos);
      } else if (tab.model) {
        // Inactive tab: update the model so it's ready when switched to
        tab.model.setValue(content);
      }
    } catch { /* ignore transient errors */ }
  }
}

setInterval(pollOpenFiles, 2000);
