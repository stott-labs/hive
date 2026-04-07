/* ==========================================================================
   Dev Dashboard — API Client (Postman-like)
   ========================================================================== */

// SVG icon constants (ICON_FOLDER, ICON_FOLDER_OPEN, ICON_FILE, ICON_COLLECTION, etc.) defined in app.js

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let collections = [];
let environments = [];
let activeEnvIndex = 0;
let requestHistory = [];
let swaggerSpec = null;
let currentResponse = null;
let requestVariables = {};
let consoleLog = []; // Postman-style HTTP console entries
let currentUsername = ''; // OS username for per-user privacy

// Track where a loaded request came from: [collectionId, folderId?, requestId]
let currentCollectionPath = [];
let currentRequestData = null;

// Suppress bidirectional URL <-> Params sync loops
let suppressParamsSync = false;
let suppressUrlSync = false;

// Open request tabs (multi-tab interface)
let openTabs = [];
let activeTabIndex = 0;
let _apiTabDragSrc = null;
const TABS_STORAGE_KEY = 'api-client-open-tabs';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initSwagger() {
  // Fetch current user for per-user privacy filtering
  fetch('/api/user').then(r => r.json()).then(d => { currentUsername = d.username || ''; }).catch(() => {});

  loadEnvironments();
  loadCollections();
  loadHistory();

  // Request bar
  const methodSelect = document.getElementById('api-method');
  methodSelect.addEventListener('change', () => {
    updateMethodColor();
    if (isDocsTabActive()) renderDocsPanel();
    markTabDirtyIfNeeded();
  });
  updateMethodColor();

  const urlInput = document.getElementById('api-url');
  urlInput.addEventListener('input', () => {
    if (!suppressUrlSync) syncUrlToParams();
    if (isDocsTabActive()) renderDocsPanel();
    markTabDirtyIfNeeded();
    updateUrlTooltip();
  });

  document.getElementById('api-send').addEventListener('click', sendRequest);
  document.getElementById('api-save').addEventListener('click', saveCurrentRequest);
  document.getElementById('api-save-as').addEventListener('click', openSaveModal);

  // Keyboard shortcuts when Endpoints tab is active
  document.addEventListener('keydown', (e) => {
    const swaggerTab = document.getElementById('tab-swagger');
    if (!swaggerTab || !swaggerTab.classList.contains('active')) return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendRequest();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 't') {
      e.preventDefault();
      openNewTab();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrentRequest();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
      e.preventDefault();
      closeTab(activeTabIndex);
    }
  });

  // Sidebar tabs
  document.querySelectorAll('.api-sidebar-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.api-sidebar-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.sidebar;
      document.querySelectorAll('.api-sidebar-content').forEach(el => el.style.display = 'none');
      document.getElementById('api-sidebar-' + target).style.display = '';
      if (target === 'browse' && !swaggerSpec) loadSwaggerSpec();
      if (target === 'history') renderHistory();
    });
  });

  // Request tabs
  document.querySelectorAll('.api-request-tabs .api-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.api-request-tabs .api-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.api-request-panel > .api-tab-content').forEach(el => el.style.display = 'none');
      document.getElementById('api-reqtab-' + btn.dataset.reqtab).style.display = '';
      if (btn.dataset.reqtab === 'docs') renderDocsPanel();
    });
  });

  // Response tabs
  document.querySelectorAll('.api-response-tabs .api-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.api-response-tabs .api-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.api-response-panel > .api-tab-content').forEach(el => el.style.display = 'none');
      document.getElementById('api-restab-' + btn.dataset.restab).style.display = '';
    });
  });

  // Environment gear
  document.getElementById('api-env-gear').addEventListener('click', openEnvManager);
  document.getElementById('api-env-modal-close').addEventListener('click', closeEnvManager);
  document.getElementById('api-env-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeEnvManager();
  });
  document.getElementById('api-env-add').addEventListener('click', addEnvironment);

  // Environment selector
  document.getElementById('api-env-select').addEventListener('change', (e) => {
    activeEnvIndex = parseInt(e.target.value) || 0;
    updateUrlTooltip();
  });

  // Save modal
  document.getElementById('api-save-modal-close').addEventListener('click', closeSaveModal);
  document.getElementById('api-save-cancel').addEventListener('click', closeSaveModal);
  document.getElementById('api-save-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSaveModal();
  });
  document.getElementById('api-save-confirm').addEventListener('click', confirmSave);

  // Collection actions
  document.getElementById('api-new-collection').addEventListener('click', createNewCollection);
  document.getElementById('api-import-btn').addEventListener('click', (e) => { e.stopPropagation(); showImportMenu(e); });

  // Postman import modal
  document.getElementById('api-postman-modal-close').addEventListener('click', closePostmanModal);
  document.getElementById('api-postman-cancel').addEventListener('click', closePostmanModal);
  document.getElementById('api-postman-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePostmanModal();
  });
  document.getElementById('api-postman-import').addEventListener('click', () => {
    if (postmanModalMode === 'environment') doPostmanEnvImport();
    else doPostmanImport();
  });

  // File drop/browse for Postman import
  const dropZone = document.getElementById('api-postman-drop-zone');
  const fileInput = document.getElementById('api-postman-file');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--blue)'; });
  dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--surface1)'; });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--surface1)';
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.json'));
    if (postmanModalMode === 'environment' && files.length > 0) {
      importEnvFiles(files);
    } else if (files[0]) {
      readPostmanFile(files[0]);
    }
  });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if (postmanModalMode === 'environment' && files.length > 0) {
      importEnvFiles(files);
    } else if (files[0]) {
      readPostmanFile(files[0]);
    }
  });

  // Collections filter
  document.getElementById('api-collections-filter').addEventListener('input', () => renderCollectionsTree());

  // Browse API
  document.getElementById('api-browse-refresh').addEventListener('click', () => { swaggerSpec = null; loadSwaggerSpec(); });
  document.getElementById('api-browse-filter').addEventListener('input', () => renderBrowseList());
  document.getElementById('api-import-all').addEventListener('click', importAllAsCollection);

  // Resizable dividers
  initDivider();
  initSidebarResizer();

  // Close context menu on click elsewhere
  document.addEventListener('click', () => {
    document.getElementById('api-context-menu').style.display = 'none';
  });

  // Initialize open tabs (restores from localStorage or creates one empty tab)
  restoreTabs();

  // Background-load swagger spec for the Docs tab
  loadSwaggerSpec();
}

// ---------------------------------------------------------------------------
// Method color
// ---------------------------------------------------------------------------
function updateMethodColor() {
  const sel = document.getElementById('api-method');
  sel.className = 'api-method-select method-' + sel.value.toLowerCase();
}

// ---------------------------------------------------------------------------
// URL preview (variable resolution)
// ---------------------------------------------------------------------------
function resolveVariables(text) {
  if (!text) return text;
  const vars = {};

  // 1. Collection variables (lowest priority in this layer)
  if (currentCollectionPath.length > 0) {
    const collId = currentCollectionPath[0];
    const coll = collections.find(c => c.id === collId);
    if (coll) {
      for (const v of (coll.variables || [])) {
        if (v.enabled !== false && v.key) vars[v.key] = v.value;
      }

      // 2. Folder variables (walk from outermost to innermost so inner overrides outer)
      const folderIds = currentCollectionPath.slice(1, -1);
      for (const fid of folderIds) {
        const folder = findFolderById(coll, fid);
        if (folder) {
          for (const v of (folder.variables || [])) {
            if (v.enabled !== false && v.key) vars[v.key] = v.value;
          }
        }
      }
    }
  }

  // 3. Environment variables
  const env = environments[activeEnvIndex];
  if (env) {
    for (const v of env.variables) {
      if (v.enabled !== false && v.key) vars[v.key] = v.value;
    }
  }

  // 4. Request-scoped variables (highest priority)
  for (const [k, v] of Object.entries(requestVariables)) {
    vars[k] = v;
  }

  return text.replace(/\{\{([\w.:-]+)\}\}/g, (match, key) => vars[key] !== undefined ? vars[key] : match);
}

function updateUrlTooltip() {
  const urlInput = document.getElementById('api-url');
  if (!urlInput) return;
  const raw = urlInput.value || '';
  if (/\{\{[\w.:-]+\}\}/.test(raw)) {
    const resolved = resolveVariables(raw);
    // Build a breakdown: show each variable → value
    const lines = [resolved];
    const seen = new Set();
    raw.replace(/\{\{([\w.:-]+)\}\}/g, (_, key) => {
      if (seen.has(key)) return;
      seen.add(key);
      const val = resolveVariables(`{{${key}}}`);
      lines.push(`{{${key}}} = ${val === `{{${key}}}` ? '(undefined)' : val}`);
    });
    urlInput.title = lines.join('\n');
  } else {
    urlInput.title = '';
  }
}

function isDocsTabActive() {
  const docsPane = document.getElementById('api-reqtab-docs');
  return docsPane && docsPane.style.display !== 'none';
}

// ---------------------------------------------------------------------------
// Open Request Tabs (multi-tab interface)
// ---------------------------------------------------------------------------
function createEmptyTab() {
  return {
    id: 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    name: 'New Request',
    method: 'GET',
    url: '',
    paramsRows: [{ key: '', value: '', enabled: false }],
    pathVarsRows: [],
    headersRows: [
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: '', value: '', enabled: false },
    ],
    authConfig: { type: 'none' },
    bodyMode: 'none',
    bodyContent: '',
    bodyFormData: [{ key: '', value: '', enabled: false }],
    preScript: '',
    testScript: '',
    preScriptLogs: [],
    testScriptLogs: [],
    collectionPath: [],
    requestData: null,
    response: null,
  };
}

function saveCurrentTabState() {
  if (openTabs.length === 0) return;
  const tab = openTabs[activeTabIndex];
  if (!tab) return;
  tab.method = document.getElementById('api-method').value;
  tab.url = document.getElementById('api-url').value;
  tab.timeout = document.getElementById('api-timeout').value;
  tab.paramsRows = paramsRows.map(r => ({ ...r }));
  tab.pathVarsRows = pathVarsRows.map(r => ({ ...r }));
  tab.headersRows = headersRows.map(r => ({ ...r }));
  tab.authConfig = { ...authConfig };
  tab.bodyMode = bodyMode;
  tab.bodyContent = bodyContent;
  tab.bodyFormData = bodyFormData.map(r => { const { _file, ...rest } = r; return rest; });
  tab.preScript = preScript;
  tab.testScript = testScript;
  tab.preScriptLogs = [...preScriptLogs];
  tab.testScriptLogs = [...testScriptLogs];
  tab.collectionPath = [...currentCollectionPath];
  tab.requestData = currentRequestData;
  tab.response = currentResponse;
  // Update display name
  if (currentRequestData && currentRequestData.name) {
    tab.name = currentRequestData.name;
  } else if (tab.url) {
    const path = tab.url.split('?')[0];
    const segments = path.replace(/^\{\{[^}]+\}\}/, '').split('/').filter(Boolean);
    tab.name = segments.length > 0 ? segments.slice(-2).join('/') : tab.url.substring(0, 30);
  }
  persistTabs();
}

function loadTabState(tab) {
  document.getElementById('api-method').value = tab.method || 'GET';
  updateMethodColor();
  document.getElementById('api-url').value = tab.url || '';
  document.getElementById('api-timeout').value = tab.timeout || '600000';

  paramsRows = tab.paramsRows && tab.paramsRows.length > 0
    ? tab.paramsRows.map(r => ({ ...r }))
    : [{ key: '', value: '', enabled: false }];
  pathVarsRows = tab.pathVarsRows && tab.pathVarsRows.length > 0
    ? tab.pathVarsRows.map(r => ({ ...r }))
    : [];
  syncUrlToPathVars();
  renderParamsEditor();

  headersRows = tab.headersRows && tab.headersRows.length > 0
    ? tab.headersRows.map(r => ({ ...r }))
    : [{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: '', value: '', enabled: false }];
  renderHeadersEditor();

  authConfig = tab.authConfig ? { ...tab.authConfig } : { type: 'none' };
  renderAuthPanel();

  bodyMode = tab.bodyMode || 'none';
  bodyContent = tab.bodyContent || '';
  bodyFormData = tab.bodyFormData && tab.bodyFormData.length > 0
    ? tab.bodyFormData.map(r => ({ ...r }))
    : [{ key: '', value: '', enabled: false }];
  renderBodyPanel();

  preScript = tab.preScript || '';
  testScript = tab.testScript || '';
  preScriptLogs = tab.preScriptLogs || [];
  testScriptLogs = tab.testScriptLogs || [];
  renderScriptPanel('pre-script');
  renderScriptPanel('tests');

  currentCollectionPath = tab.collectionPath || [];
  currentRequestData = tab.requestData || null;

  // Rehydrate requestData from collection if we have a path but lost the reference (e.g. page refresh)
  if (!currentRequestData && currentCollectionPath.length >= 2) {
    const collId = currentCollectionPath[0];
    const reqId = currentCollectionPath[currentCollectionPath.length - 1];
    const coll = collections.find(c => c.id === collId);
    if (coll) {
      currentRequestData = findRequestInCollection(coll, reqId) || null;
    }
  }
  currentResponse = tab.response || null;

  // Restore response panel
  if (currentResponse) {
    renderResponse(currentResponse, []);
  } else {
    document.getElementById('api-response-bar').innerHTML = '<span class="api-response-placeholder">Hit Send to get a response</span>';
    document.getElementById('api-response-tabs').style.display = 'none';
    ['body', 'headers', 'test-results', 'console'].forEach(t => {
      document.getElementById('api-restab-' + t).style.display = 'none';
    });
  }

  // Refresh Docs tab if it's currently visible
  if (isDocsTabActive()) renderDocsPanel();

  renderCollectionsTree();
  updateSaveButton();
  updateUrlTooltip();
}

function switchToTab(index) {
  if (index === activeTabIndex && openTabs.length > 0) return;
  saveCurrentTabState();
  activeTabIndex = index;
  loadTabState(openTabs[index]);
  renderOpenTabs();
  revealActiveEndpointInTree();
}

function openNewTab() {
  saveCurrentTabState();
  const tab = createEmptyTab();
  openTabs.push(tab);
  activeTabIndex = openTabs.length - 1;
  loadTabState(tab);
  renderOpenTabs();
}

function closeTab(index) {
  if (openTabs.length <= 1) {
    openTabs[0] = createEmptyTab();
    activeTabIndex = 0;
    loadTabState(openTabs[0]);
    renderOpenTabs();
    return;
  }
  // Save current before modifying array
  if (index !== activeTabIndex) saveCurrentTabState();
  openTabs.splice(index, 1);
  if (activeTabIndex > index) {
    activeTabIndex--;
  } else if (activeTabIndex >= openTabs.length) {
    activeTabIndex = openTabs.length - 1;
  } else if (activeTabIndex === index) {
    activeTabIndex = Math.min(index, openTabs.length - 1);
    loadTabState(openTabs[activeTabIndex]);
  }
  renderOpenTabs();
  persistTabs();
}

function renderOpenTabs() {
  const bar = document.getElementById('api-open-tabs-bar');
  bar.innerHTML = '';

  openTabs.forEach((tab, i) => {
    const tabEl = document.createElement('div');
    tabEl.className = 'api-open-tab' + (i === activeTabIndex ? ' active' : '');

    const methodBadge = document.createElement('span');
    methodBadge.className = 'api-open-tab-method ' + (tab.method || 'get').toLowerCase();
    methodBadge.textContent = (tab.method || 'GET').substring(0, 3);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'api-open-tab-name';
    nameSpan.textContent = tab.name || 'New Request';

    const closeBtn = document.createElement('span');
    closeBtn.className = 'api-open-tab-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(i);
    });

    tabEl.appendChild(methodBadge);
    tabEl.appendChild(nameSpan);
    if (tab._dirty) {
      const dot = document.createElement('span');
      dot.className = 'api-open-tab-dirty';
      dot.title = 'Unsaved changes';
      tabEl.appendChild(dot);
    }
    tabEl.appendChild(closeBtn);
    tabEl.addEventListener('click', () => switchToTab(i));
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTabContextMenu(e, i);
    });

    // Drag-and-drop reordering
    tabEl.draggable = true;
    tabEl.addEventListener('dragstart', (e) => {
      _apiTabDragSrc = i;
      tabEl.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tabEl.addEventListener('dragend', () => {
      document.querySelectorAll('.api-open-tab').forEach(t => t.classList.remove('tab-dragging', 'tab-drag-over'));
    });
    tabEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.api-open-tab').forEach(t => t.classList.remove('tab-drag-over'));
      if (i !== _apiTabDragSrc) tabEl.classList.add('tab-drag-over');
    });
    tabEl.addEventListener('dragleave', () => tabEl.classList.remove('tab-drag-over'));
    tabEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (_apiTabDragSrc === null || _apiTabDragSrc === i) return;
      const moved = openTabs.splice(_apiTabDragSrc, 1)[0];
      openTabs.splice(i, 0, moved);
      if (activeTabIndex === _apiTabDragSrc) activeTabIndex = i;
      else if (_apiTabDragSrc < activeTabIndex && i >= activeTabIndex) activeTabIndex--;
      else if (_apiTabDragSrc > activeTabIndex && i <= activeTabIndex) activeTabIndex++;
      _apiTabDragSrc = null;
      renderOpenTabs();
      persistTabs();
    });

    bar.appendChild(tabEl);
  });

  // "+" button
  const addBtn = document.createElement('div');
  addBtn.className = 'api-open-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New tab (Ctrl+T)';
  addBtn.addEventListener('click', openNewTab);
  bar.appendChild(addBtn);
}

function persistTabs() {
  try {
    const data = openTabs.map(t => ({
      id: t.id,
      name: t.name,
      method: t.method,
      url: t.url,
      paramsRows: t.paramsRows,
      pathVarsRows: t.pathVarsRows,
      headersRows: t.headersRows,
      authConfig: t.authConfig,
      bodyMode: t.bodyMode,
      bodyContent: t.bodyContent,
      bodyFormData: t.bodyFormData,
      preScript: t.preScript,
      testScript: t.testScript,
      collectionPath: t.collectionPath,
    }));
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs: data, active: activeTabIndex }));
  } catch { /* quota exceeded — ignore */ }
}

function restoreTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY));
    if (saved && saved.tabs && saved.tabs.length > 0) {
      openTabs = saved.tabs.map(t => ({ ...createEmptyTab(), ...t }));
      activeTabIndex = Math.min(saved.active || 0, openTabs.length - 1);
      loadTabState(openTabs[activeTabIndex]);
      renderOpenTabs();
      return;
    }
  } catch { /* corrupt data — ignore */ }
  // Default: one empty tab
  openTabs = [createEmptyTab()];
  activeTabIndex = 0;
  loadTabState(openTabs[0]);
  renderOpenTabs();
}

// ---------------------------------------------------------------------------
// Docs Tab (API documentation from Swagger spec)
// ---------------------------------------------------------------------------
function findSwaggerEndpoint(url, method) {
  if (!swaggerSpec || !swaggerSpec.paths) return null;

  // Extract path portion
  let path = url;
  path = path.replace(/^\{\{[^}]+\}\}/, ''); // strip {{baseUrl}} prefix
  path = path.replace(/^https?:\/\/[^/]+/, ''); // strip http://host:port
  path = path.split('?')[0]; // strip query string

  const urlSegments = path.split('/').filter(Boolean);
  const methodLower = (method || 'get').toLowerCase();

  for (const [swaggerPath, methods] of Object.entries(swaggerSpec.paths)) {
    if (!methods[methodLower]) continue;
    const swaggerSegments = swaggerPath.split('/').filter(Boolean);
    if (swaggerSegments.length !== urlSegments.length) continue;

    let match = true;
    for (let i = 0; i < swaggerSegments.length; i++) {
      const sw = swaggerSegments[i];
      const ur = urlSegments[i];
      if (sw.startsWith('{') && sw.endsWith('}')) continue; // swagger param
      if (ur.startsWith('{{') && ur.endsWith('}}')) continue; // template var
      if (sw !== ur) { match = false; break; }
    }
    if (match) {
      return { path: swaggerPath, method: methodLower, endpoint: methods[methodLower] };
    }
  }
  return null;
}

function renderDocsPanel() {
  const container = document.getElementById('api-reqtab-docs');
  if (!container) return;

  const method = document.getElementById('api-method').value;
  const url = document.getElementById('api-url').value;

  if (!url) {
    container.innerHTML = '<div class="api-docs-empty">Enter a URL to see matching API documentation.</div>';
    return;
  }

  if (!swaggerSpec) {
    container.innerHTML = '<div class="api-docs-empty">API spec not loaded. <button class="btn btn-quick" id="api-docs-load-btn">Load Now</button></div>';
    document.getElementById('api-docs-load-btn')?.addEventListener('click', () => {
      loadSwaggerSpec().then(() => renderDocsPanel());
    });
    return;
  }

  const match = findSwaggerEndpoint(url, method);
  if (!match) {
    container.innerHTML = '<div class="api-docs-empty">No matching endpoint found in the API spec for this URL and method.</div>';
    return;
  }

  const ep = match.endpoint;
  let html = '<div class="api-docs-content">';

  // Method + Path
  html += `<div class="api-docs-header">
    <span class="method-badge ${match.method}">${match.method.toUpperCase()}</span>
    <span class="api-docs-path">${esc(match.path)}</span>
  </div>`;

  // Summary
  if (ep.summary) {
    html += `<div class="api-docs-summary">${esc(ep.summary)}</div>`;
  }

  // Description
  if (ep.description) {
    html += `<div class="api-docs-description">${esc(ep.description)}</div>`;
  }

  // Tags
  if (ep.tags && ep.tags.length) {
    html += `<div class="api-docs-tags">${ep.tags.map(t => `<span class="api-docs-tag">${esc(t)}</span>`).join('')}</div>`;
  }

  // Parameters
  const params = ep.parameters || [];
  if (params.length > 0) {
    html += `<div class="api-docs-section">
      <h4>Parameters</h4>
      <table class="api-docs-params-table">
        <thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>`;
    for (const p of params) {
      const type = p.schema ? (p.schema.type || 'any') : 'any';
      html += `<tr>
        <td class="api-docs-param-name">${esc(p.name)}</td>
        <td>${esc(p.in)}</td>
        <td>${esc(type)}</td>
        <td>${p.required ? 'Yes' : 'No'}</td>
        <td>${esc(p.description || '')}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Request Body
  if (ep.requestBody) {
    html += `<div class="api-docs-section"><h4>Request Body</h4>`;
    if (ep.requestBody.description) {
      html += `<div class="api-docs-description">${esc(ep.requestBody.description)}</div>`;
    }
    const content = ep.requestBody.content;
    if (content) {
      for (const [mediaType, spec] of Object.entries(content)) {
        html += `<div class="api-docs-media-type">${esc(mediaType)}</div>`;
        if (spec.schema) {
          try {
            const example = buildSchemaExample(spec.schema, swaggerSpec);
            html += `<pre class="api-docs-schema"><code class="language-json">${esc(JSON.stringify(example, null, 2))}</code></pre>`;
          } catch { /* skip on error */ }
        }
      }
    }
    html += `</div>`;
  }

  // Responses
  if (ep.responses) {
    html += `<div class="api-docs-section"><h4>Responses</h4>`;
    for (const [code, resp] of Object.entries(ep.responses)) {
      const codeNum = parseInt(code);
      const codeClass = codeNum < 300 ? 's2xx' : codeNum < 400 ? 's3xx' : codeNum < 500 ? 's4xx' : 's5xx';
      html += `<div class="api-docs-response">
        <span class="api-docs-response-code ${codeClass}">${esc(code)}</span>
        <span class="api-docs-response-desc">${esc(resp.description || '')}</span>
      </div>`;
      if (resp.content) {
        for (const [, spec] of Object.entries(resp.content)) {
          if (spec.schema) {
            try {
              const example = buildSchemaExample(spec.schema, swaggerSpec);
              html += `<pre class="api-docs-schema"><code class="language-json">${esc(JSON.stringify(example, null, 2))}</code></pre>`;
            } catch { /* skip */ }
          }
        }
      }
    }
    html += `</div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // Highlight code blocks
  container.querySelectorAll('pre code').forEach(block => {
    if (window.hljs) hljs.highlightElement(block);
  });
}

// ---------------------------------------------------------------------------
// KV Editor (reusable)
// ---------------------------------------------------------------------------
function renderKeyValueEditor(containerId, rows, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const { onChange, hasDescription, hasTypeSelect, readOnlyKeys } = options;

  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'api-kv-editor';

  let dragSrcIdx = null;

  function buildRow(row, idx) {
    const div = document.createElement('div');
    let cls = 'api-kv-row';
    if (hasDescription) cls += ' has-desc';
    if (hasTypeSelect) cls += ' has-type';
    div.className = cls;
    div.dataset.idx = idx;

    // Drag-to-reorder (handle-only — set draggable only while grip is held)
    div.addEventListener('dragstart', (e) => {
      dragSrcIdx = idx;
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    div.addEventListener('dragend', () => { div.classList.remove('dragging'); div.draggable = false; dragSrcIdx = null; });
    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => { div.classList.remove('drag-over'); });
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.classList.remove('drag-over');
      if (dragSrcIdx == null || dragSrcIdx === idx) return;
      const [moved] = rows.splice(dragSrcIdx, 1);
      rows.splice(idx, 0, moved);
      renderKeyValueEditor(containerId, rows, options);
      if (onChange) onChange(rows);
      markTabDirtyIfNeeded();
    });

    const grip = document.createElement('span');
    grip.className = 'api-kv-grip';
    grip.textContent = '\u2261';
    grip.title = 'Drag to reorder';
    grip.addEventListener('mousedown', () => { div.draggable = true; });
    grip.addEventListener('mouseup', () => { div.draggable = false; });

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'api-kv-check';
    check.checked = row.enabled !== false;
    check.addEventListener('change', () => { row.enabled = check.checked; if (onChange) onChange(rows); markTabDirtyIfNeeded(); });

    div.appendChild(grip);
    div.appendChild(check);

    // Type select (Text/File) for form-data
    if (hasTypeSelect) {
      const typeSelect = document.createElement('select');
      typeSelect.className = 'api-kv-type-select';
      typeSelect.innerHTML = '<option value="text">Text</option><option value="file">File</option>';
      typeSelect.value = row.type || 'text';
      typeSelect.addEventListener('change', () => {
        row.type = typeSelect.value;
        if (row.type === 'text') {
          delete row._file;
          row.value = row.value || '';
        } else {
          row.value = '';
        }
        renderKeyValueEditor(containerId, rows, options);
        if (onChange) onChange(rows);
        markTabDirtyIfNeeded();
      });
      div.appendChild(typeSelect);
    }

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'api-kv-input' + (readOnlyKeys ? ' api-kv-readonly' : '');
    keyInput.placeholder = 'Key';
    keyInput.value = row.key || '';
    if (readOnlyKeys) {
      keyInput.readOnly = true;
    } else {
      keyInput.addEventListener('input', () => {
        row.key = keyInput.value;
        if (onChange) onChange(rows);
        maybeAddRow(idx);
      });
    }
    div.appendChild(keyInput);

    // Value column: file picker or text input
    if (hasTypeSelect && row.type === 'file') {
      const fileWrapper = document.createElement('div');
      fileWrapper.className = 'api-kv-file-wrapper';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.className = 'api-kv-file-input';
      fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
          row._file = fileInput.files[0];
          row.value = fileInput.files[0].name;
          fileLabel.textContent = fileInput.files[0].name;
          fileLabel.classList.add('has-file');
        } else {
          delete row._file;
          row.value = '';
          fileLabel.textContent = 'No file selected';
          fileLabel.classList.remove('has-file');
        }
        if (onChange) onChange(rows);
        maybeAddRow(idx);
        markTabDirtyIfNeeded();
      });

      const fileLabel = document.createElement('span');
      fileLabel.className = 'api-kv-file-label';
      if (row._file) {
        fileLabel.textContent = row._file.name;
        fileLabel.classList.add('has-file');
      } else {
        fileLabel.textContent = 'No file selected';
      }

      const fileBtn = document.createElement('button');
      fileBtn.className = 'api-kv-file-btn';
      fileBtn.textContent = 'Choose';
      fileBtn.type = 'button';
      fileBtn.addEventListener('click', () => fileInput.click());

      fileWrapper.appendChild(fileInput);
      fileWrapper.appendChild(fileBtn);
      fileWrapper.appendChild(fileLabel);
      div.appendChild(fileWrapper);
    } else {
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'api-kv-input';
      valInput.placeholder = 'Value';
      valInput.value = row.value || '';
      valInput.addEventListener('input', () => {
        row.value = valInput.value;
        if (onChange) onChange(rows);
        maybeAddRow(idx);
      });
      div.appendChild(valInput);
    }

    if (hasDescription) {
      const descInput = document.createElement('input');
      descInput.type = 'text';
      descInput.className = 'api-kv-input';
      descInput.placeholder = 'Description';
      descInput.value = row.description || '';
      descInput.addEventListener('input', () => { row.description = descInput.value; });
      div.appendChild(descInput);
    }

    const del = document.createElement('button');
    del.className = 'api-kv-delete';
    del.innerHTML = '&times;';
    del.addEventListener('click', () => {
      rows.splice(idx, 1);
      if (rows.length === 0) rows.push({ key: '', value: '', enabled: false });
      renderKeyValueEditor(containerId, rows, options);
      if (onChange) onChange(rows);
      markTabDirtyIfNeeded();
    });
    div.appendChild(del);

    return div;
  }

  function maybeAddRow(idx) {
    if (idx === rows.length - 1) {
      const last = rows[idx];
      if (last.key || last.value) {
        const newRow = { key: '', value: '', enabled: false };
        rows.push(newRow);
        // Append new row without re-rendering (preserves focus)
        wrapper.appendChild(buildRow(newRow, rows.length - 1));
      }
    }
    markTabDirtyIfNeeded();
  }

  // Always ensure a trailing empty row for easy entry
  const last = rows[rows.length - 1];
  if (!last || last.key || last.value) {
    rows.push({ key: '', value: '', enabled: false });
  }

  for (let i = 0; i < rows.length; i++) {
    wrapper.appendChild(buildRow(rows[i], i));
  }

  container.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Params tab (bidirectional sync with URL) + Path Variables
// ---------------------------------------------------------------------------
let paramsRows = [{ key: '', value: '', enabled: false }];
let pathVarsRows = [];

function renderParamsEditor() {
  const container = document.getElementById('api-reqtab-params');
  if (!container) return;
  container.innerHTML = '';

  // Query Params section
  const qLabel = document.createElement('div');
  qLabel.className = 'api-params-section-label';
  qLabel.textContent = 'Query Params';
  container.appendChild(qLabel);

  const qDiv = document.createElement('div');
  qDiv.id = 'api-params-query';
  container.appendChild(qDiv);

  renderKeyValueEditor('api-params-query', paramsRows, {
    hasDescription: true,
    onChange: () => {
      if (!suppressParamsSync) syncParamsToUrl();
    },
  });

  // Path Variables section (only show when there are path vars)
  if (pathVarsRows.length > 0) {
    const pLabel = document.createElement('div');
    pLabel.className = 'api-params-section-label';
    pLabel.textContent = 'Path Variables';
    container.appendChild(pLabel);

    const pDiv = document.createElement('div');
    pDiv.id = 'api-params-pathvars';
    container.appendChild(pDiv);

    renderKeyValueEditor('api-params-pathvars', pathVarsRows, {
      hasDescription: true,
      onChange: () => { markTabDirtyIfNeeded(); },
      readOnlyKeys: true,
    });
  }
}

function syncParamsToUrl() {
  suppressUrlSync = true;
  const urlInput = document.getElementById('api-url');
  let url = urlInput.value;
  const qIdx = url.indexOf('?');
  const base = qIdx >= 0 ? url.substring(0, qIdx) : url;

  const activeParams = paramsRows.filter(r => r.enabled !== false && r.key);
  if (activeParams.length > 0) {
    const qs = activeParams.map(r => encodeURIComponent(r.key) + '=' + encodeURIComponent(r.value || '')).join('&');
    urlInput.value = base + '?' + qs;
  } else {
    urlInput.value = base;
  }

  suppressUrlSync = false;
}

// Extract :param tokens from URL path and sync to pathVarsRows
function syncUrlToPathVars() {
  const url = document.getElementById('api-url').value;
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.substring(0, qIdx) : url;

  // Match :paramName tokens (not inside {{ }})
  const paramNames = [];
  path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    if (!paramNames.includes(name)) paramNames.push(name);
  });

  // Build new pathVarsRows, preserving existing values
  const oldMap = {};
  for (const row of pathVarsRows) {
    if (row.key) oldMap[row.key] = row;
  }

  const newRows = paramNames.map(name => ({
    key: name,
    value: oldMap[name] ? oldMap[name].value : '',
    description: oldMap[name] ? oldMap[name].description : '',
    enabled: true,
  }));

  const changed = newRows.length !== pathVarsRows.length ||
    newRows.some((r, i) => r.key !== (pathVarsRows[i] || {}).key);

  pathVarsRows = newRows;
  if (changed) renderParamsEditor();
}

function syncUrlToParams() {
  suppressParamsSync = true;
  const url = document.getElementById('api-url').value;
  const qIdx = url.indexOf('?');
  if (qIdx < 0) {
    // Keep params that have keys (user might have typed them manually)
    if (paramsRows.length === 1 && !paramsRows[0].key) {
      syncUrlToPathVars();
      suppressParamsSync = false;
      return;
    }
  }

  const qs = qIdx >= 0 ? url.substring(qIdx + 1) : '';
  const newRows = [];
  if (qs) {
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=').map(decodeURIComponent);
      if (k) newRows.push({ key: k, value: v || '', enabled: true });
    }
  }
  if (newRows.length === 0) newRows.push({ key: '', value: '', enabled: false });
  paramsRows.length = 0;
  paramsRows.push(...newRows);
  syncUrlToPathVars();
  renderParamsEditor();
  suppressParamsSync = false;
}

// ---------------------------------------------------------------------------
// Headers tab
// ---------------------------------------------------------------------------
let headersRows = [
  { key: 'Content-Type', value: 'application/json', enabled: true },
  { key: '', value: '', enabled: false },
];

function renderHeadersEditor() {
  renderKeyValueEditor('api-reqtab-headers', headersRows, { onChange: () => {} });
}

// ---------------------------------------------------------------------------
// Auth tab
// ---------------------------------------------------------------------------
let authConfig = { type: 'none', bearer: '', basicUser: '', basicPass: '' };

function renderAuthPanel() {
  const container = document.getElementById('api-reqtab-auth');
  container.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'api-auth-panel';

  const sel = document.createElement('select');
  sel.className = 'api-auth-type-select';
  ['none', 'inherit', 'bearer', 'basic'].forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t === 'none' ? 'No Auth' : t === 'inherit' ? 'Inherit from Collection' : t === 'bearer' ? 'Bearer Token' : 'Basic Auth';
    if (t === authConfig.type) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    authConfig.type = sel.value;
    renderAuthPanel();
    markTabDirtyIfNeeded();
  });
  panel.appendChild(sel);

  const fields = document.createElement('div');
  fields.className = 'api-auth-fields';

  if (authConfig.type === 'bearer') {
    fields.innerHTML = `
      <div class="api-auth-field">
        <label>Token</label>
        <input type="text" value="${esc(authConfig.bearer || '')}" placeholder="{{token}}" />
      </div>`;
    fields.querySelector('input').addEventListener('input', (e) => { authConfig.bearer = e.target.value; markTabDirtyIfNeeded(); });
  } else if (authConfig.type === 'basic') {
    fields.innerHTML = `
      <div class="api-auth-field">
        <label>Username</label>
        <input type="text" value="${esc(authConfig.basicUser || '')}" />
      </div>
      <div class="api-auth-field">
        <label>Password</label>
        <input type="password" value="${esc(authConfig.basicPass || '')}" />
      </div>`;
    const inputs = fields.querySelectorAll('input');
    inputs[0].addEventListener('input', (e) => { authConfig.basicUser = e.target.value; markTabDirtyIfNeeded(); });
    inputs[1].addEventListener('input', (e) => { authConfig.basicPass = e.target.value; markTabDirtyIfNeeded(); });
  } else if (authConfig.type === 'inherit') {
    fields.innerHTML = '<div style="font-size:11px;color:var(--overlay0);padding:4px 0">Auth will be inherited from the parent collection/folder.</div>';
  }

  panel.appendChild(fields);
  container.appendChild(panel);
}

// ---------------------------------------------------------------------------
// Body tab
// ---------------------------------------------------------------------------
let bodyMode = 'none';
let bodyContent = '';
let bodyFormData = [{ key: '', value: '', enabled: false }];

function renderBodyPanel() {
  const container = document.getElementById('api-reqtab-body');
  container.innerHTML = '';

  const modeBar = document.createElement('div');
  modeBar.className = 'api-body-mode-bar';
  const modes = ['none', 'json', 'form-data', 'x-www-form-urlencoded', 'raw'];
  for (const m of modes) {
    const label = document.createElement('label');
    label.className = 'api-body-mode-radio';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'body-mode';
    radio.value = m;
    radio.checked = m === bodyMode;
    radio.addEventListener('change', () => { bodyMode = m; renderBodyPanel(); markTabDirtyIfNeeded(); });
    label.appendChild(radio);
    label.appendChild(document.createTextNode(' ' + m));
    modeBar.appendChild(label);
  }
  container.appendChild(modeBar);

  if (bodyMode === 'json' || bodyMode === 'raw') {
    const textarea = document.createElement('textarea');
    textarea.className = 'api-body-textarea';
    textarea.value = bodyContent;
    textarea.placeholder = bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Raw body content';
    textarea.addEventListener('input', () => { bodyContent = textarea.value; markTabDirtyIfNeeded(); });
    // Tab key inserts spaces
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        bodyContent = textarea.value;
      }
    });
    container.appendChild(textarea);
  } else if (bodyMode === 'form-data' || bodyMode === 'x-www-form-urlencoded') {
    const kvContainer = document.createElement('div');
    kvContainer.id = 'api-body-kv';
    container.appendChild(kvContainer);
    if (bodyMode === 'form-data') {
      renderKeyValueEditor('api-body-kv', bodyFormData, { onChange: () => {}, hasTypeSelect: true });
    } else {
      renderKeyValueEditor('api-body-kv', bodyFormData, { onChange: () => {} });
    }
  }
}

// ---------------------------------------------------------------------------
// Script tabs (Pre-Script and Tests)
// ---------------------------------------------------------------------------
let preScript = '';
let testScript = '';
let preScriptLogs = [];
let testScriptLogs = [];

function renderScriptPanel(tabId) {
  const container = document.getElementById('api-reqtab-' + tabId);
  container.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'api-script-panel';

  const textarea = document.createElement('textarea');
  textarea.className = 'api-script-textarea';
  textarea.value = tabId === 'pre-script' ? preScript : testScript;
  textarea.placeholder = tabId === 'pre-script'
    ? '// Pre-request script\npm.environment.set("timestamp", Date.now());'
    : '// Test script\npm.test("status ok", () => {\n  pm.expect(pm.response.code).to.equal(200);\n});';
  textarea.addEventListener('input', () => {
    if (tabId === 'pre-script') preScript = textarea.value;
    else testScript = textarea.value;
    markTabDirtyIfNeeded();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      if (tabId === 'pre-script') preScript = textarea.value;
      else testScript = textarea.value;
    }
  });
  panel.appendChild(textarea);

  // API reference toggle
  const refToggle = document.createElement('button');
  refToggle.className = 'api-script-ref-toggle';
  refToggle.textContent = 'Show pm API Reference';
  const refBox = document.createElement('div');
  refBox.className = 'api-script-ref';
  refBox.style.display = 'none';
  refBox.innerHTML = `<strong>pm.variables</strong>.get(key) / .set(key, val) — request-scoped
<strong>pm.collectionVariables</strong>.get(key) / .set(key, val) — collection-scoped
<strong>pm.environment</strong>.get(key) / .set(key, val) — persisted to env
<strong>pm.request</strong>.url / .headers / .body — mutate (pre-script only)
<strong>pm.response</strong>.code / .json() / .text() / .headers / .responseTime
<strong>pm.test</strong>(name, fn) — register test assertion
<strong>pm.expect</strong>(val).to.equal / .eql / .be.above / .below / .include / .have.property
<strong>pm.expect</strong>(val).to.be.a("string") / .be.ok / .be.true / .be.null
<strong>console</strong>.log / .warn / .error — captured in output`;
  refToggle.addEventListener('click', () => {
    const vis = refBox.style.display !== 'none';
    refBox.style.display = vis ? 'none' : '';
    refToggle.textContent = vis ? 'Show pm API Reference' : 'Hide pm API Reference';
  });
  panel.appendChild(refToggle);
  panel.appendChild(refBox);

  // Script output
  const logs = tabId === 'pre-script' ? preScriptLogs : testScriptLogs;
  if (logs.length > 0) {
    const output = document.createElement('div');
    output.className = 'api-script-output';
    for (const log of logs) {
      const line = document.createElement('div');
      line.className = 'api-script-log ' + log.level;
      line.textContent = log.text;
      output.appendChild(line);
    }
    panel.appendChild(output);
  }

  container.appendChild(panel);
}

// ---------------------------------------------------------------------------
// Resizable divider
// ---------------------------------------------------------------------------
function initDivider() {
  const divider = document.getElementById('api-divider');
  const reqPanel = document.getElementById('api-request-panel');
  const resPanel = document.getElementById('api-response-panel');

  let startY, startReqH, startResH;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    startY = e.clientY;
    startReqH = reqPanel.offsetHeight;
    startResH = resPanel.offsetHeight;

    function onMove(ev) {
      const dy = ev.clientY - startY;
      const newReqH = Math.max(80, startReqH + dy);
      const newResH = Math.max(60, startResH - dy);
      reqPanel.style.flex = 'none';
      resPanel.style.flex = 'none';
      reqPanel.style.height = newReqH + 'px';
      resPanel.style.height = newResH + 'px';
    }

    function onUp() {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function initSidebarResizer() {
  const resizer = document.getElementById('api-sidebar-resizer');
  const sidebar = document.getElementById('api-sidebar');
  if (!resizer || !sidebar) return;

  let startX, startW;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('dragging');
    startX = e.clientX;
    startW = sidebar.offsetWidth;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const newW = Math.max(180, Math.min(startW + dx, window.innerWidth * 0.5));
      sidebar.style.width = newW + 'px';
    }

    function onUp() {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------------------------------------------------------------------------
// Streaming proxy reader — consumes SSE from /api/proxy when response is NDJSON
// ---------------------------------------------------------------------------
async function readStreamingProxy(proxyRes) {
  const reader = proxyRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let meta = {};
  const lines = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE frames
    const frames = buffer.split('\n\n');
    buffer = frames.pop(); // keep incomplete frame
    for (const frame of frames) {
      const eventMatch = frame.match(/^event: (\w+)/m);
      const dataMatch = frame.match(/^data: (.+)/m);
      if (!eventMatch || !dataMatch) continue;
      const event = eventMatch[1];
      const data = JSON.parse(dataMatch[1]);

      if (event === 'meta') {
        meta = data;
      } else if (event === 'line') {
        lines.push(data);
        // Live-update the response body as lines arrive
        const responseBar = document.getElementById('api-response-bar');
        if (responseBar) {
          responseBar.innerHTML = `<span class="api-status-badge status-${Math.floor((meta.status || 200) / 100)}xx">${meta.status || '...'}</span>`
            + `<span class="api-response-meta">Streaming... ${lines.length} lines</span>`;
        }
      } else if (event === 'done') {
        meta.time = data.time;
        meta.size = data.size;
      } else if (event === 'error') {
        return { error: true, status: 0, body: data, headers: {}, time: 0, size: 0 };
      }
    }
  }

  const body = lines.join('\n');
  return {
    status: meta.status || 200,
    statusText: meta.statusText || '',
    headers: meta.headers || {},
    body,
    time: meta.time || 0,
    size: meta.size || new Blob([body]).size,
  };
}

// ---------------------------------------------------------------------------
// Send Request
// ---------------------------------------------------------------------------
// Gather collection and folder scripts for the current request's ancestry
function getAncestryScripts() {
  const result = { collPreScript: '', collTestScript: '', folderPreScripts: [], folderTestScripts: [], collectionVariables: [] };
  if (currentCollectionPath.length === 0) return result;

  const collId = currentCollectionPath[0];
  const coll = collections.find(c => c.id === collId);
  if (!coll) return result;

  result.collPreScript = coll.preScript || '';
  result.collTestScript = coll.testScript || '';
  result.collectionVariables = coll.variables || [];

  // Walk folder ancestry (outermost to innermost)
  const folderIds = currentCollectionPath.slice(1, -1);
  for (const fid of folderIds) {
    const folder = findFolderById(coll, fid);
    if (folder) {
      if (folder.preScript) result.folderPreScripts.push(folder.preScript);
      if (folder.testScript) result.folderTestScripts.push(folder.testScript);
    }
  }

  return result;
}

async function sendRequest() {
  const sendBtn = document.getElementById('api-send');
  if (sendBtn.classList.contains('sending')) return;
  sendBtn.classList.add('sending');
  sendBtn.textContent = 'Sending...';

  try {
    const method = document.getElementById('api-method').value;
    let url = document.getElementById('api-url').value;

    // Initial headers from the headers editor (will be re-resolved after pre-scripts)
    const headers = {};
    for (const row of headersRows) {
      if (row.enabled !== false && row.key) {
        headers[row.key] = row.value;
      }
    }

    // Build initial body (will be re-resolved after pre-scripts)
    let reqBody = null;
    const hasFiles = bodyMode === 'form-data' && bodyFormData.some(r => r.enabled !== false && r.key && r.type === 'file' && r._file);
    if (bodyMode === 'json' || bodyMode === 'raw') {
      reqBody = bodyContent;
    } else if (bodyMode === 'form-data' || bodyMode === 'x-www-form-urlencoded') {
      // For text-only form-data and x-www-form-urlencoded, build URL-encoded string
      const textRows = bodyFormData.filter(r => r.enabled !== false && r.key && r.type !== 'file');
      const pairs = textRows.map(r => encodeURIComponent(r.key) + '=' + encodeURIComponent(r.value || ''));
      reqBody = pairs.join('&');
      if (bodyMode === 'x-www-form-urlencoded') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    // Build requestData with raw (unresolved) values for pre-scripts
    const requestData = { url: resolveVariables(url), headers, body: reqBody };
    const ancestry = getAncestryScripts();
    let allPreLogs = [];

    // --- Pre-scripts: collection → folders (outermost→innermost) → request ---
    // Pre-scripts run BEFORE variable resolution so they can set variables
    // (e.g. bearer-token) that are used in auth/headers/url.

    // 1. Collection pre-script
    if (ancestry.collPreScript.trim()) {
      const r = await runScript('pre', ancestry.collPreScript, requestData, {}, ancestry.collectionVariables);
      allPreLogs = allPreLogs.concat(r.logs || []);
      applyScriptMutations(r, requestData);
    }

    // 2. Folder pre-scripts (outermost to innermost)
    for (const folderScript of ancestry.folderPreScripts) {
      if (folderScript.trim()) {
        const r = await runScript('pre', folderScript, requestData, {}, ancestry.collectionVariables);
        allPreLogs = allPreLogs.concat(r.logs || []);
        applyScriptMutations(r, requestData);
      }
    }

    // 3. Request pre-script
    if (preScript.trim()) {
      const r = await runScript('pre', preScript, requestData, {}, ancestry.collectionVariables);
      allPreLogs = allPreLogs.concat(r.logs || []);
      applyScriptMutations(r, requestData);
    }

    preScriptLogs = allPreLogs;
    renderScriptPanel('pre-script');

    // --- Post-pre-script variable resolution ---
    // Now that pre-scripts have run (and potentially set collection/env/request vars),
    // re-resolve everything with the updated variable state.

    // Re-resolve URL
    url = resolveVariables(requestData.url || document.getElementById('api-url').value);

    // Replace :param path variables with their values
    for (const pv of pathVarsRows) {
      if (pv.key && pv.enabled !== false) {
        url = url.replace(new RegExp(':' + pv.key + '(?=/|\\?|$)', 'g'), encodeURIComponent(resolveVariables(pv.value || '')));
      }
    }

    // Re-resolve headers (from requestData which may have been mutated by pre-scripts)
    const resolvedHeaders = {};
    for (const [k, v] of Object.entries(requestData.headers || headers)) {
      resolvedHeaders[resolveVariables(k)] = resolveVariables(v);
    }

    // Re-resolve auth (pre-scripts may have set bearer-token, etc.)
    const resolvedAuth = resolveAuth();
    if (resolvedAuth.type === 'bearer' && resolvedAuth.bearer) {
      resolvedHeaders['Authorization'] = 'Bearer ' + resolveVariables(resolvedAuth.bearer);
    } else if (resolvedAuth.type === 'basic') {
      const user = resolveVariables(resolvedAuth.basicUser || '');
      const pass = resolveVariables(resolvedAuth.basicPass || '');
      resolvedHeaders['Authorization'] = 'Basic ' + btoa(user + ':' + pass);
    }

    // Re-resolve body
    reqBody = requestData.body;
    if (typeof reqBody === 'string') {
      reqBody = resolveVariables(reqBody);
    }

    // Send request — direct fetch with FormData for file uploads, proxy for everything else
    let response;
    if (hasFiles) {
      // Route file uploads through server proxy to avoid CORS
      const fd = new FormData();
      // Meta fields for the proxy (prefixed with _target_ to avoid collisions)
      fd.append('_target_url', url);
      fd.append('_target_method', method);
      fd.append('_target_headers', JSON.stringify(resolvedHeaders));
      const reqTimeout = parseInt(document.getElementById('api-timeout').value) || 600000;
      fd.append('_target_timeout', String(reqTimeout));
      // Append form-data fields (files + text)
      for (const row of bodyFormData) {
        if (row.enabled === false || !row.key) continue;
        if (row.type === 'file' && row._file) {
          fd.append(row.key, row._file);
        } else {
          fd.append(row.key, resolveVariables(row.value || ''));
        }
      }
      const proxyRes = await fetch('/api/proxy/upload', { method: 'POST', body: fd });
      response = await proxyRes.json();
    } else {
      const reqTimeout = parseInt(document.getElementById('api-timeout').value) || 600000;
      const proxyRes = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, url, headers: resolvedHeaders, body: reqBody, timeout: reqTimeout, stream: true }),
      });

      const proxyContentType = proxyRes.headers.get('content-type') || '';
      if (proxyContentType.includes('text/event-stream')) {
        // Streaming NDJSON — read SSE events incrementally
        response = await readStreamingProxy(proxyRes);
      } else {
        response = await proxyRes.json();
      }
    }
    currentResponse = response;

    // Log to HTTP console
    const consoleEntry = {
      timestamp: Date.now(),
      request: { method, url, headers: { ...resolvedHeaders }, body: reqBody },
      response: {
        status: response.status,
        statusText: response.statusText || '',
        headers: response.headers || {},
        body: response.body || '',
        time: response.time || 0,
        size: response.size || 0,
        error: response.error || false,
      },
    };
    consoleLog.unshift(consoleEntry);
    if (consoleLog.length > 50) consoleLog.length = 50;

    // --- Test scripts: request → folders (innermost→outermost) → collection ---
    // Update requestData to reflect what was actually sent
    const sentRequestData = { url, headers: resolvedHeaders, body: reqBody };
    let allTestResults = [];
    let allTestLogs = [];

    // 1. Request test script
    if (testScript.trim()) {
      const r = await runScript('test', testScript, sentRequestData, response, ancestry.collectionVariables);
      allTestLogs = allTestLogs.concat(r.logs || []);
      allTestResults = allTestResults.concat(r.testResults || []);
      applyScriptMutations(r, sentRequestData);
    }

    // 2. Folder test scripts (innermost to outermost)
    for (let i = ancestry.folderTestScripts.length - 1; i >= 0; i--) {
      const folderScript = ancestry.folderTestScripts[i];
      if (folderScript.trim()) {
        const r = await runScript('test', folderScript, sentRequestData, response, ancestry.collectionVariables);
        allTestLogs = allTestLogs.concat(r.logs || []);
        allTestResults = allTestResults.concat(r.testResults || []);
        applyScriptMutations(r, sentRequestData);
      }
    }

    // 3. Collection test script
    if (ancestry.collTestScript.trim()) {
      const r = await runScript('test', ancestry.collTestScript, sentRequestData, response, ancestry.collectionVariables);
      allTestLogs = allTestLogs.concat(r.logs || []);
      allTestResults = allTestResults.concat(r.testResults || []);
      applyScriptMutations(r, sentRequestData);
    }

    testScriptLogs = allTestLogs;
    renderScriptPanel('tests');

    // Render response
    renderResponse(response, allTestResults);

    // Save to history
    saveToHistory(method, document.getElementById('api-url').value, response);
  } catch (err) {
    currentResponse = { error: true, status: 0, body: err.message, headers: {}, time: 0, size: 0 };
    consoleLog.unshift({
      timestamp: Date.now(),
      request: { method: document.getElementById('api-method').value, url: document.getElementById('api-url').value, headers: {}, body: null },
      response: { status: 0, statusText: 'Error', headers: {}, body: err.message, time: 0, size: 0, error: true },
    });
    if (consoleLog.length > 50) consoleLog.length = 50;
    renderResponse(currentResponse, []);
  } finally {
    sendBtn.classList.remove('sending');
    sendBtn.textContent = 'Send';
    // Update tab with response state and name
    saveCurrentTabState();
    renderOpenTabs();
  }
}

function applyScriptMutations(result, requestData) {
  if (result.requestMutations) {
    if (result.requestMutations.url) requestData.url = result.requestMutations.url;
    if (result.requestMutations.headers) Object.assign(requestData.headers, result.requestMutations.headers);
    if (result.requestMutations.body) requestData.body = result.requestMutations.body;
  }
  if (result.envUpdates && Object.keys(result.envUpdates).length > 0) {
    applyEnvUpdates(result.envUpdates);
  }
  if (result.varUpdates) requestVariables = result.varUpdates;
  // Apply collection variable updates back to the in-memory collection
  if (result.collectionVarUpdates && Object.keys(result.collectionVarUpdates).length > 0) {
    applyCollectionVarUpdates(result.collectionVarUpdates);
  }
}

function applyCollectionVarUpdates(updates) {
  if (currentCollectionPath.length === 0) return;
  const collId = currentCollectionPath[0];
  const coll = collections.find(c => c.id === collId);
  if (!coll) return;
  if (!coll.variables) coll.variables = [];
  for (const [key, val] of Object.entries(updates)) {
    const existing = coll.variables.find(v => v.key === key);
    if (existing) {
      existing.value = val;
    } else {
      coll.variables.push({ key, value: val, enabled: true });
    }
  }
  saveCollections();
}

async function runScript(type, script, requestData, responseData, collVars) {
  const env = environments[activeEnvIndex];
  const res = await fetch('/api/script/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      script,
      type,
      requestData,
      responseData,
      environment: env ? env.variables : [],
      variables: requestVariables,
      collectionVariables: collVars || [],
      environmentName: env ? env.name : '',
    }),
  });
  return res.json();
}

function applyEnvUpdates(updates) {
  const env = environments[activeEnvIndex];
  if (!env) return;
  for (const [key, val] of Object.entries(updates)) {
    const existing = env.variables.find(v => v.key === key);
    if (existing) {
      existing.value = val;
    } else {
      env.variables.push({ key, value: val, enabled: true });
    }
  }
  saveEnvironments();
}

// ---------------------------------------------------------------------------
// Auth resolution (walk up collection path)
// ---------------------------------------------------------------------------
function resolveAuth() {
  if (authConfig.type !== 'inherit') return authConfig;

  // currentCollectionPath = [collId, folderId1, folderId2, ..., reqId]
  // Walk from innermost folder up to collection root
  if (currentCollectionPath.length > 0) {
    const collId = currentCollectionPath[0];
    const coll = collections.find(c => c.id === collId);
    if (!coll) return { type: 'none' };

    // Folder IDs are everything between collId and reqId
    const folderIds = currentCollectionPath.slice(1, -1);

    // Walk from innermost folder outward (reverse order)
    for (let i = folderIds.length - 1; i >= 0; i--) {
      const folder = findFolderById(coll, folderIds[i]);
      if (folder && folder.auth && folder.auth.type !== 'inherit') return folder.auth;
    }

    // Check collection-level auth
    if (coll.auth && coll.auth.type !== 'inherit' && coll.auth.type !== 'none') return coll.auth;
  }

  return { type: 'none' };
}

// ---------------------------------------------------------------------------
// Render Response
// ---------------------------------------------------------------------------
function renderResponse(response, testResults) {
  const bar = document.getElementById('api-response-bar');
  const tabs = document.getElementById('api-response-tabs');

  // Status bar
  const statusClass = response.error ? 'serr' :
    response.status < 300 ? 's2xx' :
    response.status < 400 ? 's3xx' :
    response.status < 500 ? 's4xx' : 's5xx';

  const statusText = response.error ? 'Error' : `${response.status} ${response.statusText}`;
  const timeText = response.time ? response.time + 'ms' : '';
  const sizeText = response.size ? formatBytes(response.size) : '';

  bar.innerHTML = `
    <span class="api-status-badge ${statusClass}">${esc(statusText)}</span>
    <span class="api-response-meta">${esc(timeText)}</span>
    <span class="api-response-meta">${esc(sizeText)}</span>
  `;

  tabs.style.display = '';

  // Body tab
  const bodyEl = document.getElementById('api-restab-body');
  bodyEl.style.display = '';
  renderResponseBody(bodyEl, response);

  // Headers tab
  const headersEl = document.getElementById('api-restab-headers');
  headersEl.style.display = 'none';
  renderResponseHeaders(headersEl, response);

  // Test Results tab
  const testsEl = document.getElementById('api-restab-test-results');
  testsEl.style.display = 'none';
  renderTestResults(testsEl, testResults);

  // Console tab
  const consoleEl = document.getElementById('api-restab-console');
  consoleEl.style.display = 'none';
  renderConsole(consoleEl);

  // Update console tab label with entry count
  const consoleTab = document.querySelector('.api-response-tabs .api-tab[data-restab="console"]');
  if (consoleLog.length > 0) {
    consoleTab.textContent = `Console (${consoleLog.length})`;
  } else {
    consoleTab.textContent = 'Console';
  }

  // Show body tab by default
  document.querySelectorAll('.api-response-tabs .api-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.api-response-tabs .api-tab[data-restab="body"]').classList.add('active');

  // Update test tab label with pass/fail count
  const testTab = document.querySelector('.api-response-tabs .api-tab[data-restab="test-results"]');
  if (testResults.length > 0) {
    const passed = testResults.filter(t => t.passed).length;
    const total = testResults.length;
    testTab.textContent = `Test Results (${passed}/${total})`;
    testTab.style.color = passed === total ? 'var(--green)' : 'var(--red)';
  } else {
    testTab.textContent = 'Test Results';
    testTab.style.color = '';
  }
}

function renderCollapsibleJson(container, data, indent = 0) {
  if (data === null) {
    container.appendChild(jsonSpan('null', 'json-null'));
    return;
  }
  if (typeof data === 'boolean') {
    container.appendChild(jsonSpan(String(data), 'json-bool'));
    return;
  }
  if (typeof data === 'number') {
    container.appendChild(jsonSpan(String(data), 'json-num'));
    return;
  }
  if (typeof data === 'string') {
    container.appendChild(jsonSpan('"' + escJsonStr(data) + '"', 'json-str'));
    return;
  }

  const isArray = Array.isArray(data);
  const entries = isArray ? data.map((v, i) => [i, v]) : Object.entries(data);
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';

  if (entries.length === 0) {
    container.appendChild(document.createTextNode(open + close));
    return;
  }

  const toggle = document.createElement('span');
  toggle.className = 'json-toggle';
  toggle.textContent = '\u25BE'; // ▾
  container.appendChild(toggle);

  const preview = document.createElement('span');
  preview.className = 'json-preview';
  preview.textContent = open + ' ... ' + close + ' // ' + entries.length + (isArray ? ' items' : ' keys');
  preview.style.display = 'none';
  container.appendChild(preview);

  const openBrace = document.createTextNode(open);
  container.appendChild(openBrace);

  const block = document.createElement('div');
  block.className = 'json-block';
  block.style.marginLeft = '16px';

  entries.forEach(([key, val], i) => {
    const line = document.createElement('div');
    line.className = 'json-line';
    if (!isArray) {
      line.appendChild(jsonSpan('"' + key + '"', 'json-key'));
      line.appendChild(document.createTextNode(': '));
    }
    renderCollapsibleJson(line, val, indent + 1);
    if (i < entries.length - 1) line.appendChild(document.createTextNode(','));
    block.appendChild(line);
  });

  container.appendChild(block);
  const closeBrace = document.createTextNode(close);
  container.appendChild(closeBrace);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = block.style.display === 'none';
    block.style.display = collapsed ? '' : 'none';
    openBrace.textContent = collapsed ? open : '';
    preview.style.display = collapsed ? 'none' : 'inline';
    toggle.textContent = collapsed ? '\u25BE' : '\u25B8'; // ▾ or ▸
    closeBrace.textContent = collapsed ? close : '';
  });
}

function jsonSpan(text, cls) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function escJsonStr(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function renderResponseBody(container, response) {
  container.innerHTML = '';

  const controls = document.createElement('div');
  controls.className = 'api-response-body-controls';

  let viewMode = 'pretty';
  const prettyBtn = document.createElement('button');
  prettyBtn.className = 'btn active';
  prettyBtn.textContent = 'Pretty';
  const rawBtn = document.createElement('button');
  rawBtn.className = 'btn';
  rawBtn.textContent = 'Raw';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(response.body || '');
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });

  controls.appendChild(prettyBtn);
  controls.appendChild(rawBtn);
  controls.appendChild(copyBtn);
  container.appendChild(controls);

  const content = document.createElement('div');
  content.className = 'api-response-body-content';
  container.appendChild(content);

  function render() {
    if (viewMode === 'pretty') {
      try {
        const parsed = JSON.parse(response.body);
        const pre = document.createElement('pre');
        pre.className = 'json-collapsible';
        renderCollapsibleJson(pre, parsed);
        content.innerHTML = '';
        content.appendChild(pre);
      } catch {
        content.textContent = response.body || '';
      }
    } else {
      content.textContent = response.body || '';
    }
  }

  prettyBtn.addEventListener('click', () => {
    viewMode = 'pretty';
    prettyBtn.classList.add('active');
    rawBtn.classList.remove('active');
    render();
  });

  rawBtn.addEventListener('click', () => {
    viewMode = 'raw';
    rawBtn.classList.add('active');
    prettyBtn.classList.remove('active');
    render();
  });

  render();
}

function renderResponseHeaders(container, response) {
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'api-response-headers-list';

  const headers = response.headers || {};
  for (const [key, val] of Object.entries(headers)) {
    const row = document.createElement('div');
    row.className = 'api-response-header-row';
    row.innerHTML = `<span class="api-response-header-key">${esc(key)}</span><span class="api-response-header-val">${esc(val)}</span>`;
    list.appendChild(row);
  }

  if (Object.keys(headers).length === 0) {
    list.innerHTML = '<div style="color:var(--overlay0);font-size:11px;padding:8px">No headers</div>';
  }
  container.appendChild(list);
}

function renderTestResults(container, testResults) {
  container.innerHTML = '';
  if (testResults.length === 0) {
    container.innerHTML = '<div style="color:var(--overlay0);font-size:11px;padding:8px;font-style:italic">No tests were run. Add tests in the Tests tab.</div>';
    return;
  }
  for (const t of testResults) {
    const row = document.createElement('div');
    row.className = 'api-test-result';
    row.innerHTML = `
      <span class="api-test-icon ${t.passed ? 'pass' : 'fail'}">${t.passed ? '\u2713' : '\u2717'}</span>
      <span class="api-test-name">${esc(t.name)}</span>
      ${t.error ? `<span class="api-test-error">${esc(t.error)}</span>` : ''}
    `;
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// HTTP Console (Postman-style request/response log)
// ---------------------------------------------------------------------------
function renderConsole(container) {
  container.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'api-console-toolbar';
  toolbar.innerHTML = `<button class="btn api-console-clear">Clear</button><span class="api-console-count">${consoleLog.length} request${consoleLog.length !== 1 ? 's' : ''}</span>`;
  toolbar.querySelector('.api-console-clear').addEventListener('click', () => {
    consoleLog.length = 0;
    renderConsole(container);
  });
  container.appendChild(toolbar);

  if (consoleLog.length === 0) {
    container.innerHTML += '<div style="padding:12px 8px;color:var(--overlay0);font-size:11px;font-style:italic">No requests logged yet. Send a request to see it here.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'api-console-list';

  for (const entry of consoleLog) {
    const item = document.createElement('details');
    item.className = 'api-console-entry';

    const req = entry.request || {};
    const res = entry.response || {};
    const statusClass = res.error ? 'serr' : res.status < 300 ? 's2xx' : res.status < 400 ? 's3xx' : res.status < 500 ? 's4xx' : 's5xx';
    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleTimeString();

    // Summary row
    const summary = document.createElement('summary');
    summary.className = 'api-console-summary';
    summary.innerHTML = `
      <span class="api-console-time">${esc(timeStr)}</span>
      <span class="api-tree-method ${(req.method || 'GET').toLowerCase()}">${esc((req.method || 'GET').substring(0, 3))}</span>
      <span class="api-status-badge ${statusClass}">${res.error ? 'ERR' : res.status}</span>
      <span class="api-console-url">${esc(req.url || '')}</span>
      <span class="api-console-duration">${res.time ? res.time + 'ms' : ''}</span>
      <span class="api-console-actions">
        <button class="api-console-action-btn" data-action="load" title="Load into Endpoint builder">Load</button>
        <button class="api-console-action-btn" data-action="curl" title="Copy as cURL">cURL</button>
      </span>
    `;

    // Action button handlers
    const loadBtn = summary.querySelector('[data-action="load"]');
    const curlBtn = summary.querySelector('[data-action="curl"]');

    loadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      consoleLoadIntoBuilder(entry);
    });

    curlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const curl = buildCurlCommand(entry.request);
      navigator.clipboard.writeText(curl).then(() => {
        curlBtn.textContent = 'Copied!';
        curlBtn.classList.add('copied');
        setTimeout(() => { curlBtn.textContent = 'cURL'; curlBtn.classList.remove('copied'); }, 1500);
      });
    });

    item.appendChild(summary);

    // Detail body
    const detail = document.createElement('div');
    detail.className = 'api-console-detail';

    // Request section
    let reqHeadersHtml = '';
    if (req.headers && Object.keys(req.headers).length) {
      reqHeadersHtml = Object.entries(req.headers).map(([k, v]) =>
        `<div class="api-console-header"><span class="api-console-hkey">${esc(k)}</span>: <span class="api-console-hval">${esc(v)}</span></div>`
      ).join('');
    } else {
      reqHeadersHtml = '<div class="api-console-empty">No headers</div>';
    }

    let reqBodyHtml = '';
    if (req.body) {
      let displayBody = req.body;
      try { displayBody = JSON.stringify(JSON.parse(req.body), null, 2); } catch {}
      reqBodyHtml = `<pre class="api-console-body-pre">${esc(displayBody)}</pre>`;
    } else {
      reqBodyHtml = '<div class="api-console-empty">No body</div>';
    }

    // Response section
    let resHeadersHtml = '';
    if (res.headers && Object.keys(res.headers).length) {
      resHeadersHtml = Object.entries(res.headers).map(([k, v]) =>
        `<div class="api-console-header"><span class="api-console-hkey">${esc(k)}</span>: <span class="api-console-hval">${esc(v)}</span></div>`
      ).join('');
    } else {
      resHeadersHtml = '<div class="api-console-empty">No headers</div>';
    }

    let resBodyHtml = '';
    if (res.body) {
      let displayBody = typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2);
      try { displayBody = JSON.stringify(JSON.parse(displayBody), null, 2); } catch {}
      const truncated = displayBody.length > 5000;
      if (truncated) displayBody = displayBody.substring(0, 5000) + '\n... (truncated)';
      resBodyHtml = `<pre class="api-console-body-pre">${esc(displayBody)}</pre>`;
    } else {
      resBodyHtml = '<div class="api-console-empty">No body</div>';
    }

    detail.innerHTML = `
      <details class="api-console-section" open>
        <summary class="api-console-section-title">Request Headers</summary>
        <div class="api-console-section-body">${reqHeadersHtml}</div>
      </details>
      <details class="api-console-section">
        <summary class="api-console-section-title">Request Body</summary>
        <div class="api-console-section-body">${reqBodyHtml}</div>
      </details>
      <details class="api-console-section" open>
        <summary class="api-console-section-title">Response Headers</summary>
        <div class="api-console-section-body">${resHeadersHtml}</div>
      </details>
      <details class="api-console-section">
        <summary class="api-console-section-title">Response Body <span class="api-console-size">${res.size ? formatBytes(res.size) : ''}</span></summary>
        <div class="api-console-section-body">${resBodyHtml}</div>
      </details>
    `;

    item.appendChild(detail);
    list.appendChild(item);
  }

  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Console → Builder / cURL helpers
// ---------------------------------------------------------------------------
function consoleLoadIntoBuilder(entry) {
  const req = entry.request || {};
  // Save current tab state
  saveCurrentTabState();

  // Open in current tab if empty, otherwise create a new tab
  const currentTab = openTabs[activeTabIndex];
  const isEmpty = !currentTab.url && !currentTab.requestData;
  if (!isEmpty) {
    const tab = createEmptyTab();
    openTabs.push(tab);
    activeTabIndex = openTabs.length - 1;
  }

  currentCollectionPath = [];
  currentRequestData = null;

  // Populate request bar
  document.getElementById('api-method').value = req.method || 'GET';
  updateMethodColor();
  document.getElementById('api-url').value = req.url || '';

  // Populate headers
  const headerEntries = req.headers ? Object.entries(req.headers) : [];
  headersRows = headerEntries.length > 0
    ? headerEntries.map(([key, value]) => ({ key, value, enabled: true }))
    : [{ key: 'Content-Type', value: 'application/json', enabled: true }];
  headersRows.push({ key: '', value: '', enabled: false });
  renderHeadersEditor();

  // Populate body
  if (req.body) {
    bodyMode = 'raw';
    bodyContent = req.body;
    try { bodyContent = JSON.stringify(JSON.parse(req.body), null, 2); } catch {}
  } else {
    bodyMode = 'none';
    bodyContent = '';
  }
  bodyFormData = [{ key: '', value: '', enabled: false }];
  renderBodyPanel();

  // Populate params from URL
  paramsRows = [{ key: '', value: '', enabled: false }];
  pathVarsRows = [];
  syncUrlToPathVars();
  syncUrlToParams();
  renderParamsEditor();

  // Reset auth and scripts
  authConfig = { type: 'none' };
  renderAuthPanel();
  preScript = '';
  testScript = '';
  preScriptLogs = [];
  testScriptLogs = [];
  renderScriptPanel('pre-script');
  renderScriptPanel('tests');

  // Reset response panel
  currentResponse = null;
  document.getElementById('api-response-bar').innerHTML = '<span class="api-response-placeholder">Hit Send to get a response</span>';
  document.getElementById('api-response-tabs').style.display = 'none';
  ['body', 'headers', 'test-results', 'console'].forEach(t => {
    document.getElementById('api-restab-' + t).style.display = 'none';
  });

  saveCurrentTabState();
  renderOpenTabs();
}

function buildCurlCommand(req) {
  const method = req.method || 'GET';
  const url = req.url || '';
  let parts = [`curl -X ${method}`];

  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      parts.push(`-H '${k}: ${v}'`);
    }
  }

  if (req.body) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    // Escape single quotes in body
    parts.push(`-d '${body.replace(/'/g, "'\\''")}'`);
  }

  parts.push(`'${url}'`);
  return parts.join(' \\\n  ');
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
async function loadCollections() {
  const treeEl = document.getElementById('api-collections-tree');
  treeEl.innerHTML = '<div class="skeleton"><div class="skeleton-row"><div class="skeleton-bar w-lg"></div></div><div class="skeleton-row"><div class="skeleton-bar w-xl"></div></div><div class="skeleton-row"><div class="skeleton-bar w-md"></div></div><div class="skeleton-row"><div class="skeleton-bar w-lg"></div></div></div>';
  try {
    const res = await fetch('/api/collections');
    collections = await res.json();
  } catch { collections = []; }
  renderCollectionsTree();
  updateUrlTooltip();
}

async function saveCollections() {
  await fetch('/api/collections', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collections),
  });
}

function createNewCollection() {
  const name = prompt('Collection name:');
  if (!name) return;
  collections.push({
    id: 'col_' + Date.now(),
    name,
    auth: { type: 'none' },
    variables: [],
    preScript: '',
    testScript: '',
    folders: [],
    requests: [],
  });
  saveCollections();
  renderCollectionsTree();
}

// ---------------------------------------------------------------------------
// Expand/collapse state persistence (localStorage)
// ---------------------------------------------------------------------------
const EXPAND_STORAGE_KEY = 'api-client-expanded';

function loadExpandState() {
  try { return JSON.parse(localStorage.getItem(EXPAND_STORAGE_KEY) || '{}'); } catch { return {}; }
}

function saveExpandState(state) {
  localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(state));
}

function isExpanded(id) {
  const state = loadExpandState();
  return state[id] === true; // default collapsed
}

function setExpanded(id, value) {
  const state = loadExpandState();
  state[id] = value;
  saveExpandState(state);
}

function toggleExpanded(id) {
  setExpanded(id, !isExpanded(id));
}

// Expand the collection/folders containing the active request and scroll to it
function revealActiveEndpointInTree() {
  if (!currentCollectionPath.length) return;
  if (collections.length === 0) {
    // Collections still loading — retry until available
    let attempts = 0;
    const poll = setInterval(() => {
      if (collections.length > 0) { clearInterval(poll); revealActiveEndpointInTree(); }
      else if (++attempts > 50) clearInterval(poll); // give up after 5s
    }, 100);
    return;
  }
  for (const id of currentCollectionPath.slice(0, -1)) {
    setExpanded(id, true);
  }
  renderCollectionsTree();
  scrollToActive('#api-collections-tree .api-tree-item.active', 'api-sidebar-collections');
}

// ---------------------------------------------------------------------------
// Per-user privacy — items with { private: true, owner: "username" }
// are hidden from other users. Owner always sees their own items.
// ---------------------------------------------------------------------------
function isItemVisible(item) {
  if (!item.private) return true;
  if (!currentUsername) return true; // can't filter without identity
  return item.owner === currentUsername;
}

function toggleItemPrivacy(item) {
  if (item.private) {
    delete item.private;
    delete item.owner;
  } else {
    item.private = true;
    item.owner = currentUsername;
  }
  saveCollections();
  renderCollectionsTree();
}

// ---------------------------------------------------------------------------
// Recursive collection tree renderer
// ---------------------------------------------------------------------------
function getCollectionsFilter() {
  const el = document.getElementById('api-collections-filter');
  return el ? el.value.trim().toLowerCase() : '';
}

function nodeMatchesFilter(node, filter) {
  // Check this node's requests
  for (const req of (node.requests || [])) {
    if ((req.name || '').toLowerCase().includes(filter) ||
        (req.url || '').toLowerCase().includes(filter) ||
        (req.method || '').toLowerCase().includes(filter)) return true;
  }
  // Check child folders recursively
  for (const folder of (node.folders || [])) {
    if (folder.name.toLowerCase().includes(filter)) return true;
    if (nodeMatchesFilter(folder, filter)) return true;
  }
  return false;
}

function requestMatchesFilter(req, filter) {
  return (req.name || '').toLowerCase().includes(filter) ||
    (req.url || '').toLowerCase().includes(filter) ||
    (req.method || '').toLowerCase().includes(filter);
}

// ---------------------------------------------------------------------------
// Drag-and-drop state & helpers for collections tree
// ---------------------------------------------------------------------------
let treeDragData = null; // { type: 'request'|'folder', id, sourceCollId, sourceFolderPath }

function findParentNode(coll, folderPath) {
  let node = coll;
  for (const fid of folderPath) {
    node = findFolderById(node, fid);
    if (!node) return null;
  }
  return node;
}

function isFolderDescendant(parentFolder, targetFolderId) {
  if (parentFolder.id === targetFolderId) return true;
  for (const sub of (parentFolder.folders || [])) {
    if (isFolderDescendant(sub, targetFolderId)) return true;
  }
  return false;
}

function moveRequestToTarget(sourceCollId, sourceFolderPath, reqId, targetCollId, targetFolderId, insertIndex) {
  const sourceColl = collections.find(c => c.id === sourceCollId);
  if (!sourceColl) return;
  const sourceParent = findParentNode(sourceColl, sourceFolderPath);
  if (!sourceParent) return;
  const reqIdx = (sourceParent.requests || []).findIndex(r => r.id === reqId);
  if (reqIdx < 0) return;
  const [req] = sourceParent.requests.splice(reqIdx, 1);

  const targetColl = collections.find(c => c.id === targetCollId);
  if (!targetColl) return;
  let targetParent = targetColl;
  if (targetFolderId) {
    targetParent = findFolderById(targetColl, targetFolderId);
    if (!targetParent) { sourceParent.requests.splice(reqIdx, 0, req); return; }
  }
  if (!targetParent.requests) targetParent.requests = [];
  if (insertIndex != null && insertIndex >= 0 && insertIndex <= targetParent.requests.length) {
    targetParent.requests.splice(insertIndex, 0, req);
  } else {
    targetParent.requests.push(req);
  }
  saveCollections();
  renderCollectionsTree();
}

function moveFolderToTarget(sourceCollId, sourceFolderPath, folderId, targetCollId, targetFolderId, insertIndex) {
  // Prevent dropping folder onto itself or its descendants
  const sourceColl = collections.find(c => c.id === sourceCollId);
  if (!sourceColl) return;
  const movingFolder = findFolderById(sourceColl, folderId);
  if (!movingFolder) return;
  if (targetFolderId && isFolderDescendant(movingFolder, targetFolderId)) return;

  const sourceParent = findParentNode(sourceColl, sourceFolderPath);
  if (!sourceParent) return;
  const folderIdx = (sourceParent.folders || []).findIndex(f => f.id === folderId);
  if (folderIdx < 0) return;
  const [folder] = sourceParent.folders.splice(folderIdx, 1);

  const targetColl = collections.find(c => c.id === targetCollId);
  if (!targetColl) return;
  let targetParent = targetColl;
  if (targetFolderId) {
    targetParent = findFolderById(targetColl, targetFolderId);
    if (!targetParent) { sourceParent.folders.splice(folderIdx, 0, folder); return; }
  }
  if (!targetParent.folders) targetParent.folders = [];
  if (insertIndex != null && insertIndex >= 0 && insertIndex <= targetParent.folders.length) {
    targetParent.folders.splice(insertIndex, 0, folder);
  } else {
    targetParent.folders.push(folder);
  }
  saveCollections();
  renderCollectionsTree();
}

function renderCollectionsTree() {
  const container = document.getElementById('api-collections-tree');
  container.innerHTML = '';
  const filter = getCollectionsFilter();

  for (const coll of collections) {
    if (!isItemVisible(coll)) continue;
    if (filter && !coll.name.toLowerCase().includes(filter) && !nodeMatchesFilter(coll, filter)) continue;
    renderCollectionNode(container, coll, 8, filter);
  }
}

function renderCollectionNode(container, coll, indent, filter) {
  const forceExpand = !!filter;
  const expanded = forceExpand || isExpanded(coll.id);

  const collItem = document.createElement('div');
  collItem.className = 'api-tree-item';
  collItem.style.paddingLeft = indent + 'px';
  const privBadge = coll.private ? '<span class="api-tree-private" title="Private — only visible to ' + esc(coll.owner || '?') + '">\u{1F512}</span>' : '';
  collItem.innerHTML = `
    <span class="api-tree-toggle">${expanded ? '\u25BE' : '\u25B8'}</span>
    <span class="api-tree-icon">${ICON_COLLECTION}</span>
    <span class="api-tree-name" style="font-weight:600;color:var(--text)">${esc(coll.name)}</span>
    ${privBadge}
  `;
  collItem.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpanded(coll.id);
    renderCollectionsTree();
  });
  collItem.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCollectionContextMenu(e, coll);
  });
  // Drop target: accept dragged requests/folders into collection root
  collItem.addEventListener('dragover', (e) => {
    if (!treeDragData) return;
    e.preventDefault();
    e.stopPropagation();
    collItem.classList.add('drag-target');
  });
  collItem.addEventListener('dragleave', (e) => {
    collItem.classList.remove('drag-target');
  });
  collItem.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    collItem.classList.remove('drag-target');
    if (!treeDragData) return;
    const d = treeDragData;
    treeDragData = null;
    if (d.type === 'request') {
      moveRequestToTarget(d.sourceCollId, d.sourceFolderPath, d.id, coll.id, null);
    } else if (d.type === 'folder') {
      moveFolderToTarget(d.sourceCollId, d.sourceFolderPath, d.id, coll.id, null);
    }
  });
  container.appendChild(collItem);

  if (!expanded) return;

  renderFolderChildren(container, coll, coll, indent + 16, [], filter);
}

function renderFolderChildren(container, coll, parent, indent, folderPath, filter) {
  // Sub-folders
  for (const folder of (parent.folders || [])) {
    if (!isItemVisible(folder)) continue;
    if (filter && !folder.name.toLowerCase().includes(filter) && !nodeMatchesFilter(folder, filter)) continue;
    renderFolderNode(container, coll, folder, indent, folderPath, filter);
  }
  // Requests at this level
  for (const req of (parent.requests || [])) {
    if (!isItemVisible(req)) continue;
    if (filter && !requestMatchesFilter(req, filter)) continue;
    const reqItem = buildRequestTreeItem(req, indent, coll.id, folderPath);
    container.appendChild(reqItem);
  }
}

function renderFolderNode(container, coll, folder, indent, parentPath, filter) {
  const forceExpand = !!filter;
  const expanded = forceExpand || isExpanded(folder.id);
  const myPath = [...parentPath, folder.id];

  const folderItem = document.createElement('div');
  folderItem.className = 'api-tree-item';
  folderItem.style.paddingLeft = indent + 'px';
  folderItem.draggable = true;
  const folderPrivBadge = folder.private ? '<span class="api-tree-private" title="Private — only visible to ' + esc(folder.owner || '?') + '">\u{1F512}</span>' : '';
  folderItem.innerHTML = `
    <span class="api-tree-toggle">${expanded ? '\u25BE' : '\u25B8'}</span>
    <span class="api-tree-icon">${expanded ? ICON_FOLDER_OPEN : ICON_FOLDER}</span>
    <span class="api-tree-name">${esc(folder.name)}</span>
    ${folderPrivBadge}
  `;
  folderItem.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpanded(folder.id);
    renderCollectionsTree();
  });
  folderItem.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showFolderContextMenu(e, coll, folder);
  });
  // Drag: make folder draggable
  folderItem.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    treeDragData = { type: 'folder', id: folder.id, sourceCollId: coll.id, sourceFolderPath: parentPath };
    folderItem.classList.add('dragging');
  });
  folderItem.addEventListener('dragend', (e) => {
    treeDragData = null;
    folderItem.classList.remove('dragging');
  });
  // Drop target: accept dragged items into this folder or reorder among siblings
  folderItem.addEventListener('dragover', (e) => {
    if (!treeDragData) return;
    // Prevent dropping folder onto itself or descendants
    if (treeDragData.type === 'folder' && treeDragData.id === folder.id) return;
    if (treeDragData.type === 'folder') {
      const sourceColl = collections.find(c => c.id === treeDragData.sourceCollId);
      const movingFolder = sourceColl ? findFolderById(sourceColl, treeDragData.id) : null;
      if (movingFolder && isFolderDescendant(movingFolder, folder.id)) return;
    }
    e.preventDefault();
    e.stopPropagation();
    folderItem.classList.remove('drag-target', 'drag-insert-before', 'drag-insert-after');
    // 3-zone: top 25% = insert before, bottom 25% = insert after, middle = drop into
    const rect = folderItem.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const zone = relY / rect.height;
    if (treeDragData.type === 'folder' && zone < 0.25) {
      folderItem.classList.add('drag-insert-before');
    } else if (treeDragData.type === 'folder' && zone > 0.75) {
      folderItem.classList.add('drag-insert-after');
    } else {
      folderItem.classList.add('drag-target');
    }
  });
  folderItem.addEventListener('dragleave', (e) => {
    folderItem.classList.remove('drag-target', 'drag-insert-before', 'drag-insert-after');
  });
  folderItem.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const insertBefore = folderItem.classList.contains('drag-insert-before');
    const insertAfter = folderItem.classList.contains('drag-insert-after');
    folderItem.classList.remove('drag-target', 'drag-insert-before', 'drag-insert-after');
    if (!treeDragData) return;
    const d = treeDragData;
    treeDragData = null;

    // Reorder folders among siblings (edge zones)
    if (d.type === 'folder' && (insertBefore || insertAfter)) {
      const targetColl = collections.find(c => c.id === coll.id);
      const targetParent = parentPath.length ? findParentNode(targetColl, parentPath) : targetColl;
      if (!targetParent || !targetParent.folders) return;
      let targetIdx = targetParent.folders.findIndex(f => f.id === folder.id);
      const sameContainer = d.sourceCollId === coll.id &&
        JSON.stringify(d.sourceFolderPath) === JSON.stringify(parentPath);
      if (sameContainer) {
        const srcIdx = targetParent.folders.findIndex(f => f.id === d.id);
        if (srcIdx < targetIdx) targetIdx--;
      }
      if (insertAfter) targetIdx++;
      moveFolderToTarget(d.sourceCollId, d.sourceFolderPath, d.id, coll.id,
        parentPath.length ? parentPath[parentPath.length - 1] : null, targetIdx);
      return;
    }

    // Drop into folder (center zone)
    if (d.type === 'request') {
      moveRequestToTarget(d.sourceCollId, d.sourceFolderPath, d.id, coll.id, folder.id);
    } else if (d.type === 'folder') {
      moveFolderToTarget(d.sourceCollId, d.sourceFolderPath, d.id, coll.id, folder.id);
    }
  });
  container.appendChild(folderItem);

  if (!expanded) return;

  renderFolderChildren(container, coll, folder, indent + 16, myPath, filter);
}

function buildRequestTreeItem(req, indent, collId, folderPath) {
  const item = document.createElement('div');
  item.className = 'api-tree-item';
  const isActive = currentCollectionPath.length >= 2 &&
    currentCollectionPath[currentCollectionPath.length - 1] === req.id;
  if (isActive) item.classList.add('active');
  item.style.paddingLeft = indent + 'px';
  item.draggable = true;
  const reqPrivBadge = req.private ? '<span class="api-tree-private" title="Private — only visible to ' + esc(req.owner || '?') + '">\u{1F512}</span>' : '';
  item.innerHTML = `
    <span class="api-tree-method ${(req.method || 'GET').toLowerCase()}">${(req.method || 'GET').substring(0, 3)}</span>
    <span class="api-tree-name">${esc(req.name || req.url || 'Untitled')}</span>
    ${reqPrivBadge}
  `;
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    loadRequestIntoBuilder(req, collId, folderPath);
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Pass the leaf folderId for context menu operations
    const folderId = folderPath.length > 0 ? folderPath[folderPath.length - 1] : null;
    showRequestContextMenu(e, collId, folderId, req);
  });
  // Drag: make request draggable
  item.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    treeDragData = { type: 'request', id: req.id, sourceCollId: collId, sourceFolderPath: folderPath };
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', (e) => {
    treeDragData = null;
    item.classList.remove('dragging');
  });
  // Drop zone: reorder requests within same container
  item.addEventListener('dragover', (e) => {
    if (!treeDragData || treeDragData.type !== 'request') return;
    if (treeDragData.id === req.id) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    item.classList.remove('drag-insert-before', 'drag-insert-after', 'drag-target');
    item.classList.add(e.clientY < midY ? 'drag-insert-before' : 'drag-insert-after');
  });
  item.addEventListener('dragleave', () => {
    item.classList.remove('drag-insert-before', 'drag-insert-after');
  });
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const insertBefore = item.classList.contains('drag-insert-before');
    item.classList.remove('drag-insert-before', 'drag-insert-after');
    if (!treeDragData || treeDragData.type !== 'request') return;
    const d = treeDragData;
    treeDragData = null;
    // Find the target index for this request in its parent
    const targetColl = collections.find(c => c.id === collId);
    const targetParent = folderPath.length ? findParentNode(targetColl, folderPath) : targetColl;
    if (!targetParent || !targetParent.requests) return;
    let targetIdx = targetParent.requests.findIndex(r => r.id === req.id);
    // If moving within same container, account for the source being removed first
    const sameContainer = d.sourceCollId === collId &&
      JSON.stringify(d.sourceFolderPath) === JSON.stringify(folderPath);
    if (sameContainer) {
      const srcIdx = targetParent.requests.findIndex(r => r.id === d.id);
      if (srcIdx < targetIdx) targetIdx--;
    }
    if (!insertBefore) targetIdx++;
    moveRequestToTarget(d.sourceCollId, d.sourceFolderPath, d.id, collId, folderPath.length ? folderPath[folderPath.length - 1] : null, targetIdx);
  });
  return item;
}

function loadRequestIntoBuilder(req, collId, folderPath) {
  // Check if this request is already open in a tab
  const existingIdx = openTabs.findIndex(t =>
    t.collectionPath && t.collectionPath.length >= 2 &&
    t.collectionPath[t.collectionPath.length - 1] === req.id
  );
  if (existingIdx >= 0) {
    switchToTab(existingIdx);
    return;
  }

  // Save current tab state first
  saveCurrentTabState();

  // Open in current tab if empty, otherwise create a new tab
  const currentTab = openTabs[activeTabIndex];
  const isEmpty = !currentTab.url && !currentTab.requestData;
  if (!isEmpty) {
    const tab = createEmptyTab();
    openTabs.push(tab);
    activeTabIndex = openTabs.length - 1;
  }

  // Load the request into the form
  currentCollectionPath = [collId, ...folderPath, req.id];
  currentRequestData = req;

  document.getElementById('api-method').value = req.method || 'GET';
  updateMethodColor();
  document.getElementById('api-url').value = req.url || '';

  paramsRows = req.params && req.params.length > 0
    ? req.params.map(p => ({ ...p }))
    : [{ key: '', value: '', enabled: false }];
  pathVarsRows = req.pathVars && req.pathVars.length > 0
    ? req.pathVars.map(p => ({ ...p }))
    : [];
  syncUrlToPathVars();
  renderParamsEditor();

  headersRows = req.headers && req.headers.length > 0
    ? req.headers.map(h => ({ ...h }))
    : [{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: '', value: '', enabled: false }];
  renderHeadersEditor();

  authConfig = req.auth ? { ...req.auth } : { type: 'none' };
  renderAuthPanel();

  bodyMode = req.bodyMode || 'none';
  bodyContent = req.bodyContent || '';
  bodyFormData = req.bodyFormData && req.bodyFormData.length > 0
    ? req.bodyFormData.map(f => ({ ...f }))
    : [{ key: '', value: '', enabled: false }];
  renderBodyPanel();

  preScript = req.preScript || '';
  testScript = req.testScript || '';
  preScriptLogs = [];
  testScriptLogs = [];
  renderScriptPanel('pre-script');
  renderScriptPanel('tests');

  currentResponse = null;
  document.getElementById('api-response-bar').innerHTML = '<span class="api-response-placeholder">Hit Send to get a response</span>';
  document.getElementById('api-response-tabs').style.display = 'none';
  ['body', 'headers', 'test-results', 'console'].forEach(t => {
    document.getElementById('api-restab-' + t).style.display = 'none';
  });

  // Refresh Docs tab if visible
  if (isDocsTabActive()) renderDocsPanel();

  // Save to tab and update tab bar
  saveCurrentTabState();
  if (openTabs[activeTabIndex]) openTabs[activeTabIndex]._dirty = false;
  renderOpenTabs();
  renderCollectionsTree();
}

// ---------------------------------------------------------------------------
// Collection/Folder Editor Modal
// ---------------------------------------------------------------------------
let collEditorTarget = null; // { collection, folder? }
let collEditorAuth = { type: 'none' };
let collEditorVariables = [];
let collEditorPreScript = '';
let collEditorTestScript = '';

function openCollectionEditor(coll) {
  collEditorTarget = { collection: coll, folder: null };
  collEditorAuth = coll.auth ? { ...coll.auth } : { type: 'none' };
  collEditorVariables = (coll.variables || []).map(v => ({ ...v }));
  collEditorPreScript = coll.preScript || '';
  collEditorTestScript = coll.testScript || '';
  showCollEditorModal('Edit Collection: ' + (coll.name || 'Untitled'));
}

function openFolderEditor(coll, folder) {
  collEditorTarget = { collection: coll, folder };
  collEditorAuth = folder.auth ? { ...folder.auth } : { type: 'inherit' };
  collEditorVariables = (folder.variables || []).map(v => ({ ...v }));
  collEditorPreScript = folder.preScript || '';
  collEditorTestScript = folder.testScript || '';
  showCollEditorModal('Edit Folder: ' + (folder.name || 'Untitled'));
}

function showCollEditorModal(title) {
  document.getElementById('api-coll-editor-title').textContent = title;
  document.getElementById('api-coll-editor-modal').style.display = '';

  // Reset tab to Auth
  document.querySelectorAll('.api-coll-editor-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.api-coll-editor-tab[data-cedtab="auth"]').classList.add('active');
  document.querySelectorAll('.api-coll-editor-pane').forEach(p => p.style.display = 'none');
  document.getElementById('api-cedtab-auth').style.display = '';

  renderCollEditorAuth();
  renderCollEditorVariables();
  renderCollEditorScript('pre-script');
  renderCollEditorScript('tests');
}

function closeCollEditorModal() {
  document.getElementById('api-coll-editor-modal').style.display = 'none';
  collEditorTarget = null;
}

function saveCollEditor() {
  if (!collEditorTarget) return;
  const target = collEditorTarget.folder || collEditorTarget.collection;
  target.auth = { ...collEditorAuth };
  target.variables = collEditorVariables.filter(v => v.key);
  target.preScript = collEditorPreScript;
  target.testScript = collEditorTestScript;
  saveCollections();
  closeCollEditorModal();
}

// Tab switching
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.api-coll-editor-tab');
  if (!tab) return;
  const tabId = tab.dataset.cedtab;
  document.querySelectorAll('.api-coll-editor-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('.api-coll-editor-pane').forEach(p => p.style.display = 'none');
  document.getElementById('api-cedtab-' + tabId).style.display = '';
});

// Modal buttons
document.addEventListener('click', (e) => {
  if (e.target.id === 'api-coll-editor-close' || e.target.id === 'api-coll-editor-cancel') closeCollEditorModal();
  if (e.target.id === 'api-coll-editor-save') saveCollEditor();
});

// Close on overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'api-coll-editor-modal') closeCollEditorModal();
});

function renderCollEditorAuth() {
  const container = document.getElementById('api-cedtab-auth');
  container.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'api-auth-panel';

  const isFolder = collEditorTarget && collEditorTarget.folder;
  const authTypes = isFolder
    ? ['inherit', 'none', 'bearer', 'basic']
    : ['none', 'bearer', 'basic'];

  const sel = document.createElement('select');
  sel.className = 'api-auth-type-select';
  for (const t of authTypes) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t === 'none' ? 'No Auth' : t === 'inherit' ? 'Inherit from Collection' : t === 'bearer' ? 'Bearer Token' : 'Basic Auth';
    if (t === collEditorAuth.type) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    collEditorAuth.type = sel.value;
    renderCollEditorAuth();
  });
  panel.appendChild(sel);

  const fields = document.createElement('div');
  fields.className = 'api-auth-fields';

  if (collEditorAuth.type === 'bearer') {
    fields.innerHTML = `
      <div class="api-auth-field">
        <label>Token</label>
        <input type="text" value="${esc(collEditorAuth.bearer || '')}" placeholder="{{bearer-token}}" />
      </div>`;
    fields.querySelector('input').addEventListener('input', (e) => { collEditorAuth.bearer = e.target.value; });
  } else if (collEditorAuth.type === 'basic') {
    fields.innerHTML = `
      <div class="api-auth-field">
        <label>Username</label>
        <input type="text" value="${esc(collEditorAuth.basicUser || '')}" />
      </div>
      <div class="api-auth-field">
        <label>Password</label>
        <input type="password" value="${esc(collEditorAuth.basicPass || '')}" />
      </div>`;
    const inputs = fields.querySelectorAll('input');
    inputs[0].addEventListener('input', (e) => { collEditorAuth.basicUser = e.target.value; });
    inputs[1].addEventListener('input', (e) => { collEditorAuth.basicPass = e.target.value; });
  } else if (collEditorAuth.type === 'inherit') {
    fields.innerHTML = '<div style="font-size:11px;color:var(--overlay0);padding:4px 0">Auth will be inherited from the parent collection.</div>';
  }

  panel.appendChild(fields);
  container.appendChild(panel);
}

function renderCollEditorVariables() {
  const container = document.getElementById('api-cedtab-variables');
  container.innerHTML = '';

  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;color:var(--overlay0);margin-bottom:8px';
  desc.textContent = 'Variables defined here are available as {{key}} in all requests within this ' + (collEditorTarget && collEditorTarget.folder ? 'folder' : 'collection') + '.';
  container.appendChild(desc);

  // Ensure at least one empty row
  if (collEditorVariables.length === 0 || collEditorVariables[collEditorVariables.length - 1].key) {
    collEditorVariables.push({ key: '', value: '', enabled: false });
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'api-kv-editor';
  wrapper.id = 'api-ced-vars-editor';

  for (let idx = 0; idx < collEditorVariables.length; idx++) {
    const row = collEditorVariables[idx];
    const div = document.createElement('div');
    div.className = 'api-kv-row';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'api-kv-check';
    check.checked = row.enabled !== false;
    check.addEventListener('change', () => { row.enabled = check.checked; });

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'api-kv-input';
    keyInput.placeholder = 'Key';
    keyInput.value = row.key || '';
    keyInput.addEventListener('input', () => {
      row.key = keyInput.value;
      // Auto-add row
      if (idx === collEditorVariables.length - 1 && keyInput.value) {
        collEditorVariables.push({ key: '', value: '', enabled: false });
        renderCollEditorVariables();
      }
    });

    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'api-kv-input';
    valInput.placeholder = 'Value';
    valInput.value = row.value || '';
    valInput.addEventListener('input', () => { row.value = valInput.value; });

    const delBtn = document.createElement('button');
    delBtn.className = 'api-kv-delete';
    delBtn.textContent = '\u00D7';
    delBtn.addEventListener('click', () => {
      collEditorVariables.splice(idx, 1);
      renderCollEditorVariables();
    });

    div.appendChild(check);
    div.appendChild(keyInput);
    div.appendChild(valInput);
    div.appendChild(delBtn);
    wrapper.appendChild(div);
  }

  container.appendChild(wrapper);
}

function renderCollEditorScript(tabId) {
  const paneId = tabId === 'pre-script' ? 'api-cedtab-pre-script' : 'api-cedtab-tests';
  const container = document.getElementById(paneId);
  container.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'api-script-panel';

  const textarea = document.createElement('textarea');
  textarea.className = 'api-script-textarea';
  textarea.value = tabId === 'pre-script' ? collEditorPreScript : collEditorTestScript;
  textarea.placeholder = tabId === 'pre-script'
    ? '// Collection pre-request script\n// Runs before every request in this collection'
    : '// Collection test script\n// Runs after every request in this collection';
  textarea.addEventListener('input', () => {
    if (tabId === 'pre-script') collEditorPreScript = textarea.value;
    else collEditorTestScript = textarea.value;
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      if (tabId === 'pre-script') collEditorPreScript = textarea.value;
      else collEditorTestScript = textarea.value;
    }
  });
  panel.appendChild(textarea);

  const refToggle = document.createElement('button');
  refToggle.className = 'api-script-ref-toggle';
  refToggle.textContent = 'Show pm API Reference';
  const refBox = document.createElement('div');
  refBox.className = 'api-script-ref';
  refBox.style.display = 'none';
  refBox.innerHTML = `<strong>pm.variables</strong>.get(key) / .set(key, val) — request-scoped
<strong>pm.collectionVariables</strong>.get(key) / .set(key, val) — collection-scoped
<strong>pm.environment</strong>.get(key) / .set(key, val) — persisted to env
<strong>pm.request</strong>.url / .headers / .body — mutate (pre-script only)
<strong>pm.response</strong>.code / .json() / .text() / .headers / .responseTime
<strong>pm.test</strong>(name, fn) — register test assertion
<strong>pm.expect</strong>(val).to.equal / .eql / .be.above / .below / .include / .have.property
<strong>console</strong>.log / .warn / .error — captured in output`;
  refToggle.addEventListener('click', () => {
    const vis = refBox.style.display !== 'none';
    refBox.style.display = vis ? 'none' : '';
    refToggle.textContent = vis ? 'Show pm API Reference' : 'Hide pm API Reference';
  });
  panel.appendChild(refToggle);
  panel.appendChild(refBox);

  container.appendChild(panel);
}

// ---------------------------------------------------------------------------
// Context Menus
// ---------------------------------------------------------------------------
function showTabContextMenu(e, tabIndex) {
  const items = [
    { label: 'Close', action: () => closeTab(tabIndex) },
    { label: 'Close Others', action: () => closeOtherTabs(tabIndex) },
    { label: 'Close All to the Right', action: () => closeTabsToRight(tabIndex) },
  ];
  showContextMenu(e, items);
}

function closeTabsToRight(fromIndex) {
  saveCurrentTabState();
  // Close from rightmost to avoid index shifting issues, skip dirty tabs
  for (let i = openTabs.length - 1; i > fromIndex; i--) {
    if (!openTabs[i]._dirty) {
      openTabs.splice(i, 1);
    }
  }
  if (activeTabIndex >= openTabs.length) {
    activeTabIndex = openTabs.length - 1;
    loadTabState(openTabs[activeTabIndex]);
  }
  renderOpenTabs();
  persistTabs();
}

function closeOtherTabs(keepIndex) {
  saveCurrentTabState();
  const kept = [openTabs[keepIndex]];
  // Also keep any dirty tabs
  for (let i = 0; i < openTabs.length; i++) {
    if (i !== keepIndex && openTabs[i]._dirty) kept.push(openTabs[i]);
  }
  openTabs.length = 0;
  openTabs.push(...kept);
  activeTabIndex = 0;
  loadTabState(openTabs[0]);
  renderOpenTabs();
  persistTabs();
}

function showContextMenu(e, items) {
  const menu = document.getElementById('api-context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'api-context-separator';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'api-context-item' + (item.danger ? ' danger' : '');
    el.textContent = item.label;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      menu.style.display = 'none';
      item.action();
    });
    menu.appendChild(el);
  }
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.style.display = 'block';
}

function showCollectionContextMenu(e, coll) {
  const privacyLabel = coll.private ? '\u{1F513} Make Public' : '\u{1F512} Make Private';
  showContextMenu(e, [
    { label: 'Edit Collection...', action: () => openCollectionEditor(coll) },
    { separator: true },
    { label: 'Add Request', action: () => addRequestToCollection(coll) },
    { label: 'Add Folder', action: () => addFolderToCollection(coll) },
    { separator: true },
    { label: privacyLabel, action: () => toggleItemPrivacy(coll) },
    { label: 'Rename', action: () => renameCollection(coll) },
    { label: 'Delete', danger: true, action: () => deleteCollection(coll) },
  ]);
}

function showFolderContextMenu(e, coll, folder) {
  const privacyLabel = folder.private ? '\u{1F513} Make Public' : '\u{1F512} Make Private';
  showContextMenu(e, [
    { label: 'Edit Folder...', action: () => openFolderEditor(coll, folder) },
    { separator: true },
    { label: 'Add Request', action: () => addRequestToFolder(coll, folder) },
    { label: 'Add Folder', action: () => addSubFolder(folder) },
    { separator: true },
    { label: privacyLabel, action: () => toggleItemPrivacy(folder) },
    { label: 'Rename', action: () => renameFolder(folder) },
    { label: 'Delete', danger: true, action: () => deleteFolder(coll, folder) },
  ]);
}

function showRequestContextMenu(e, collId, folderId, req) {
  const privacyLabel = req.private ? '\u{1F513} Make Public' : '\u{1F512} Make Private';
  showContextMenu(e, [
    { label: 'Duplicate', action: () => duplicateRequest(collId, folderId, req) },
    { label: 'Rename', action: () => renameRequest(req) },
    { separator: true },
    { label: privacyLabel, action: () => toggleItemPrivacy(req) },
    { label: 'Delete', danger: true, action: () => deleteRequest(collId, folderId, req) },
  ]);
}

function addRequestToCollection(coll) {
  const name = prompt('Request name:');
  if (!name) return;
  if (!coll.requests) coll.requests = [];
  coll.requests.push({
    id: 'req_' + Date.now(),
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'inherit' },
    bodyMode: 'none',
    bodyContent: '',
    preScript: '',
    testScript: '',
  });
  saveCollections();
  renderCollectionsTree();
}

function addFolderToCollection(coll) {
  const name = prompt('Folder name:');
  if (!name) return;
  if (!coll.folders) coll.folders = [];
  coll.folders.push({ id: 'fld_' + Date.now(), name, auth: { type: 'inherit' }, variables: [], preScript: '', testScript: '', folders: [], requests: [] });
  saveCollections();
  renderCollectionsTree();
}

function addSubFolder(parentFolder) {
  const name = prompt('Folder name:');
  if (!name) return;
  if (!parentFolder.folders) parentFolder.folders = [];
  parentFolder.folders.push({ id: 'fld_' + Date.now(), name, auth: { type: 'inherit' }, variables: [], preScript: '', testScript: '', folders: [], requests: [] });
  saveCollections();
  renderCollectionsTree();
}

function addRequestToFolder(coll, folder) {
  const name = prompt('Request name:');
  if (!name) return;
  if (!folder.requests) folder.requests = [];
  folder.requests.push({
    id: 'req_' + Date.now(),
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'inherit' },
    bodyMode: 'none',
    bodyContent: '',
    preScript: '',
    testScript: '',
  });
  saveCollections();
  renderCollectionsTree();
}

function renameCollection(coll) {
  const name = prompt('New name:', coll.name);
  if (!name) return;
  coll.name = name;
  saveCollections();
  renderCollectionsTree();
}

function renameFolder(folder) {
  const name = prompt('New name:', folder.name);
  if (!name) return;
  folder.name = name;
  saveCollections();
  renderCollectionsTree();
}

function renameRequest(req) {
  const name = prompt('New name:', req.name);
  if (!name) return;
  req.name = name;
  saveCollections();
  renderCollectionsTree();
}

function deleteCollection(coll) {
  if (!confirm(`Delete collection "${coll.name}" and all its requests?`)) return;
  collections = collections.filter(c => c.id !== coll.id);
  saveCollections();
  renderCollectionsTree();
}

function deleteFolder(coll, folder) {
  if (!confirm(`Delete folder "${folder.name}" and all its contents?`)) return;
  // Recursively search and remove from any level
  function removeFrom(parent) {
    if (!parent.folders) return false;
    const idx = parent.folders.findIndex(f => f.id === folder.id);
    if (idx >= 0) { parent.folders.splice(idx, 1); return true; }
    for (const sub of parent.folders) {
      if (removeFrom(sub)) return true;
    }
    return false;
  }
  removeFrom(coll);
  saveCollections();
  renderCollectionsTree();
}

function deleteRequest(collId, folderId, req) {
  if (!confirm(`Delete request "${req.name}"?`)) return;
  const coll = collections.find(c => c.id === collId);
  if (!coll) return;
  if (folderId) {
    const folder = findFolderById(coll, folderId);
    if (folder) folder.requests = (folder.requests || []).filter(r => r.id !== req.id);
  } else {
    coll.requests = (coll.requests || []).filter(r => r.id !== req.id);
  }
  saveCollections();
  renderCollectionsTree();
}

function duplicateRequest(collId, folderId, req) {
  const coll = collections.find(c => c.id === collId);
  if (!coll) return;
  const dup = JSON.parse(JSON.stringify(req));
  dup.id = 'req_' + Date.now();
  dup.name = req.name + ' (copy)';
  if (folderId) {
    const folder = findFolderById(coll, folderId);
    if (folder) folder.requests.push(dup);
  } else {
    coll.requests.push(dup);
  }
  saveCollections();
  renderCollectionsTree();
}

// ---------------------------------------------------------------------------
// Save (in-place) + Dirty tracking
// ---------------------------------------------------------------------------
function saveCurrentRequest() {
  if (!currentRequestData || currentCollectionPath.length < 2) {
    // Not from a collection — fall through to Save As
    openSaveModal();
    return;
  }
  const collId = currentCollectionPath[0];
  const coll = collections.find(c => c.id === collId);
  if (!coll) { openSaveModal(); return; }
  const existing = findRequestInCollection(coll, currentRequestData.id);
  if (!existing) { openSaveModal(); return; }

  const reqData = gatherCurrentRequest();
  reqData.name = currentRequestData.name;
  reqData.id = currentRequestData.id;
  Object.assign(existing, reqData);
  currentRequestData = existing;
  saveCollections();
  markTabClean();
  renderOpenTabs();
  updateSaveButton();
  renderCollectionsTree();
}

function isTabDirty() {
  // Not from a collection — dirty if there's any content at all
  if (!currentRequestData || currentCollectionPath.length < 2) {
    const url = document.getElementById('api-url').value;
    return !!url;
  }
  // From a collection — compare against saved version
  const current = gatherCurrentRequest();
  const saved = currentRequestData;
  return current.method !== (saved.method || 'GET') ||
    current.url !== (saved.url || '') ||
    JSON.stringify(current.params) !== JSON.stringify(saved.params || []) ||
    JSON.stringify(current.headers) !== JSON.stringify(saved.headers || []) ||
    JSON.stringify(current.auth) !== JSON.stringify(saved.auth || { type: 'none' }) ||
    current.bodyMode !== (saved.bodyMode || 'none') ||
    current.bodyContent !== (saved.bodyContent || '') ||
    JSON.stringify(current.bodyFormData) !== JSON.stringify(saved.bodyFormData || []) ||
    current.preScript !== (saved.preScript || '') ||
    current.testScript !== (saved.testScript || '');
}

function markTabClean() {
  if (openTabs[activeTabIndex]) openTabs[activeTabIndex]._dirty = false;
}

function markTabDirtyIfNeeded() {
  if (openTabs[activeTabIndex]) {
    openTabs[activeTabIndex]._dirty = isTabDirty();
    renderOpenTabs();
    updateSaveButton();
  }
}

function updateSaveButton() {
  const btn = document.getElementById('api-save');
  if (!btn) return;
  const dirty = openTabs[activeTabIndex] && openTabs[activeTabIndex]._dirty;
  btn.classList.toggle('dirty', !!dirty);
}

// ---------------------------------------------------------------------------
// Save As Modal
// ---------------------------------------------------------------------------
let saveTarget = null;

function openSaveModal() {
  document.getElementById('api-save-modal').style.display = '';
  const nameInput = document.getElementById('api-save-name');

  // Default name from current request
  if (currentRequestData) {
    nameInput.value = currentRequestData.name || '';
  } else {
    const url = document.getElementById('api-url').value;
    const method = document.getElementById('api-method').value;
    nameInput.value = method + ' ' + (url.split('?')[0].split('/').pop() || url.substring(0, 40));
  }

  saveTarget = null;
  renderSaveTree();
}

function closeSaveModal() {
  document.getElementById('api-save-modal').style.display = 'none';
}

function renderSaveTree() {
  const tree = document.getElementById('api-save-tree');
  tree.innerHTML = '';

  if (collections.length === 0) {
    tree.innerHTML = '<div style="padding:8px;color:var(--overlay0);font-size:11px">No collections yet. Create one first.</div>';
    return;
  }

  function addSaveTreeFolders(parent, collId, indent) {
    for (const folder of (parent.folders || [])) {
      const fItem = document.createElement('div');
      fItem.className = 'api-save-tree-item';
      fItem.style.paddingLeft = indent + 'px';
      fItem.textContent = '\u{1F4C1} ' + folder.name;
      fItem.addEventListener('click', () => {
        tree.querySelectorAll('.api-save-tree-item').forEach(el => el.classList.remove('selected'));
        fItem.classList.add('selected');
        saveTarget = { collectionId: collId, folderId: folder.id };
      });
      tree.appendChild(fItem);
      addSaveTreeFolders(folder, collId, indent + 16);
    }
  }

  for (const coll of collections) {
    const collItem = document.createElement('div');
    collItem.className = 'api-save-tree-item';
    collItem.textContent = '\u{1F4E6} ' + coll.name;
    collItem.addEventListener('click', () => {
      tree.querySelectorAll('.api-save-tree-item').forEach(el => el.classList.remove('selected'));
      collItem.classList.add('selected');
      saveTarget = { collectionId: coll.id, folderId: null };
    });
    tree.appendChild(collItem);
    addSaveTreeFolders(coll, coll.id, 24);
  }
}

function confirmSave() {
  const name = document.getElementById('api-save-name').value.trim();
  if (!name) return alert('Please enter a request name.');
  if (!saveTarget) return alert('Please select a collection or folder to save to.');

  const reqData = gatherCurrentRequest();
  reqData.name = name;

  const coll = collections.find(c => c.id === saveTarget.collectionId);
  if (!coll) return;

  // If we're updating an existing request
  if (currentRequestData) {
    const existing = findRequestInCollection(coll, currentRequestData.id);
    if (existing) {
      Object.assign(existing, reqData);
      existing.id = currentRequestData.id;
      saveCollections();
      closeSaveModal();
      renderCollectionsTree();
      return;
    }
  }

  // New request
  reqData.id = 'req_' + Date.now();

  if (saveTarget.folderId) {
    const folder = findFolderById(coll, saveTarget.folderId);
    if (folder) {
      if (!folder.requests) folder.requests = [];
      folder.requests.push(reqData);
    }
  } else {
    if (!coll.requests) coll.requests = [];
    coll.requests.push(reqData);
  }

  currentRequestData = reqData;
  currentCollectionPath = saveTarget.folderId
    ? [saveTarget.collectionId, saveTarget.folderId, reqData.id]
    : [saveTarget.collectionId, reqData.id];

  saveCollections();
  closeSaveModal();
  renderCollectionsTree();
}

function gatherCurrentRequest() {
  return {
    method: document.getElementById('api-method').value,
    url: document.getElementById('api-url').value,
    params: paramsRows.filter(r => r.key),
    pathVars: pathVarsRows.filter(r => r.key),
    headers: headersRows.filter(r => r.key),
    auth: { ...authConfig },
    bodyMode,
    bodyContent,
    bodyFormData: bodyFormData.filter(r => r.key).map(r => {
      const clean = { key: r.key, value: r.value, enabled: r.enabled };
      if (r.type) clean.type = r.type;
      if (r.description) clean.description = r.description;
      return clean;
    }),
    preScript,
    testScript,
  };
}

function findFolderById(parent, folderId) {
  for (const folder of (parent.folders || [])) {
    if (folder.id === folderId) return folder;
    const nested = findFolderById(folder, folderId);
    if (nested) return nested;
  }
  return null;
}

function findRequestInCollection(coll, reqId) {
  function searchNode(node) {
    const inReqs = (node.requests || []).find(r => r.id === reqId);
    if (inReqs) return inReqs;
    for (const folder of (node.folders || [])) {
      const found = searchNode(folder);
      if (found) return found;
    }
    return null;
  }
  return searchNode(coll);
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------
async function loadEnvironments() {
  try {
    const res = await fetch('/api/environments');
    environments = await res.json();
  } catch { environments = [{ name: 'Local', variables: [{ key: 'baseUrl', value: 'http://localhost:3000', enabled: true }] }]; }
  renderEnvSelector();
  updateUrlTooltip();
}

async function saveEnvironments() {
  await fetch('/api/environments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(environments),
  });
  renderEnvSelector();
  updateUrlTooltip();
}

function renderEnvSelector() {
  const sel = document.getElementById('api-env-select');
  sel.innerHTML = '';
  environments.forEach((env, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = env.name;
    if (i === activeEnvIndex) opt.selected = true;
    sel.appendChild(opt);
  });
}

let envManagerSelectedIndex = 0;

function openEnvManager() {
  document.getElementById('api-env-modal').style.display = '';
  envManagerSelectedIndex = 0;
  renderEnvManagerList();
  renderEnvManagerEditor();
}

function closeEnvManager() {
  document.getElementById('api-env-modal').style.display = 'none';
  saveEnvironments();

}

function renderEnvManagerList() {
  const list = document.getElementById('api-env-list');
  list.innerHTML = '';
  environments.forEach((env, i) => {
    const item = document.createElement('div');
    item.className = 'api-env-list-item' + (i === envManagerSelectedIndex ? ' active' : '');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = env.name;
    item.appendChild(nameSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'api-env-delete-btn';
    delBtn.innerHTML = '&times;';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (environments.length <= 1) return;
      if (!confirm(`Delete environment "${env.name}"?`)) return;
      environments.splice(i, 1);
      if (activeEnvIndex >= environments.length) activeEnvIndex = 0;
      if (envManagerSelectedIndex >= environments.length) envManagerSelectedIndex = 0;
      renderEnvManagerList();
      renderEnvManagerEditor();
    });
    item.appendChild(delBtn);

    item.addEventListener('click', () => {
      envManagerSelectedIndex = i;
      renderEnvManagerList();
      renderEnvManagerEditor();
    });
    list.appendChild(item);
  });
}

function renderEnvManagerEditor() {
  const panel = document.getElementById('api-env-editor');
  panel.innerHTML = '';

  const env = environments[envManagerSelectedIndex];
  if (!env) return;

  const nameLabel = document.createElement('h4');
  nameLabel.textContent = env.name;
  nameLabel.style.cursor = 'pointer';
  nameLabel.title = 'Click to rename';
  nameLabel.addEventListener('click', () => {
    const newName = prompt('Environment name:', env.name);
    if (newName) {
      env.name = newName;
      renderEnvManagerList();
      renderEnvManagerEditor();
    }
  });
  panel.appendChild(nameLabel);

  // Ensure empty row at end
  if (!env.variables) env.variables = [];
  const hasEmpty = env.variables.some(v => !v.key && !v.value);
  if (!hasEmpty) env.variables.push({ key: '', value: '', enabled: false });

  const kvContainer = document.createElement('div');
  kvContainer.id = 'api-env-kv-editor';
  panel.appendChild(kvContainer);

  renderKeyValueEditor('api-env-kv-editor', env.variables, {
    onChange: () => {
      // Clean up empty rows except last
      const nonEmpty = env.variables.filter(v => v.key || v.value);
      env.variables.length = 0;
      env.variables.push(...nonEmpty, { key: '', value: '', enabled: false });
    },
  });
}

function addEnvironment() {
  const name = prompt('Environment name:');
  if (!name) return;
  environments.push({ name, variables: [{ key: 'baseUrl', value: '', enabled: true }] });
  envManagerSelectedIndex = environments.length - 1;
  renderEnvManagerList();
  renderEnvManagerEditor();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    requestHistory = await res.json();
  } catch { requestHistory = []; }
}

async function saveToHistory(method, url, response) {
  const entry = {
    method,
    url,
    status: response.status,
    time: response.time,
    error: response.error || false,
  };
  requestHistory.unshift({ ...entry, timestamp: Date.now() });
  if (requestHistory.length > 200) requestHistory.length = 200;

  await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

function renderHistory() {
  const container = document.getElementById('api-history-list');
  container.innerHTML = '';

  if (requestHistory.length === 0) {
    container.innerHTML = '<div style="padding:12px 8px;color:var(--overlay0);font-size:11px;font-style:italic">No history yet</div>';
    return;
  }

  // Group by date
  const groups = {};
  for (const entry of requestHistory) {
    const date = new Date(entry.timestamp).toLocaleDateString();
    if (!groups[date]) groups[date] = [];
    groups[date].push(entry);
  }

  for (const [date, entries] of Object.entries(groups)) {
    const header = document.createElement('div');
    header.className = 'api-history-group-header';
    header.textContent = date;
    container.appendChild(header);

    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'api-history-item';

      const methodBadge = document.createElement('span');
      methodBadge.className = 'api-tree-method ' + (entry.method || 'GET').toLowerCase();
      methodBadge.textContent = (entry.method || 'GET').substring(0, 3);

      const urlSpan = document.createElement('span');
      urlSpan.className = 'api-history-url';
      // Shorten URL: remove protocol, show path
      let shortUrl = entry.url || '';
      try {
        const u = new URL(shortUrl.replace(/\{\{.*?\}\}/g, 'x'));
        shortUrl = u.pathname + u.search;
      } catch {
        shortUrl = shortUrl.split('?')[0].split('/').slice(-2).join('/');
      }
      urlSpan.textContent = shortUrl;

      const statusSpan = document.createElement('span');
      statusSpan.className = 'api-history-status';
      if (entry.error) {
        statusSpan.classList.add('serr');
        statusSpan.textContent = 'ERR';
      } else {
        const sc = entry.status < 300 ? 's2xx' : entry.status < 500 ? 's4xx' : 's5xx';
        statusSpan.classList.add(sc);
        statusSpan.textContent = entry.status;
      }

      const timeSpan = document.createElement('span');
      timeSpan.className = 'api-history-time';
      timeSpan.textContent = entry.time ? entry.time + 'ms' : '';

      item.appendChild(methodBadge);
      item.appendChild(urlSpan);
      item.appendChild(statusSpan);
      item.appendChild(timeSpan);

      item.addEventListener('click', () => {
        // Load history item into current tab
        document.getElementById('api-method').value = entry.method || 'GET';
        updateMethodColor();
        document.getElementById('api-url').value = entry.url || '';
        syncUrlToParams();

        currentCollectionPath = [];
        currentRequestData = null;
        saveCurrentTabState();
        renderOpenTabs();
        renderCollectionsTree();
      });

      container.appendChild(item);
    }
  }
}

// ---------------------------------------------------------------------------
// Browse API (Swagger spec)
// ---------------------------------------------------------------------------
async function loadSwaggerSpec() {
  const container = document.getElementById('api-browse-list');
  container.innerHTML = '<div style="padding:12px 8px;color:var(--overlay0);font-size:11px">Loading endpoints...</div>';

  try {
    const res = await fetch('/api/swagger');
    if (!res.ok) throw new Error(`${res.status}`);
    swaggerSpec = await res.json();
    renderBrowseList();
  } catch (err) {
    container.innerHTML = `<div style="padding:12px 8px;color:var(--overlay0);font-size:11px">
      Could not load Swagger spec. Is your API server running?<br>${esc(err.message)}
    </div>`;
  }
}

function renderBrowseList() {
  const container = document.getElementById('api-browse-list');
  container.innerHTML = '';
  if (!swaggerSpec || !swaggerSpec.paths) return;

  const filter = (document.getElementById('api-browse-filter').value || '').toLowerCase().trim();
  const tagGroups = {};

  for (const [path, methods] of Object.entries(swaggerSpec.paths)) {
    for (const [method, endpoint] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const summary = endpoint.summary || '';
      if (filter && !(path + ' ' + summary + ' ' + method).toLowerCase().includes(filter)) continue;
      const tag = (endpoint.tags || ['Untagged'])[0];
      if (!tagGroups[tag]) tagGroups[tag] = [];
      tagGroups[tag].push({ method, path, summary, endpoint });
    }
  }

  const sortedTags = Object.keys(tagGroups).sort();
  if (sortedTags.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:var(--overlay0);font-size:11px">No endpoints match filter.</div>';
    return;
  }

  for (const tag of sortedTags) {
    const tagHeader = document.createElement('div');
    tagHeader.className = 'api-browse-tag';
    const toggle = document.createElement('span');
    toggle.className = 'api-browse-tag-toggle';
    toggle.textContent = '\u25B8';
    tagHeader.appendChild(toggle);
    tagHeader.appendChild(document.createTextNode(tag + ' (' + tagGroups[tag].length + ')'));
    container.appendChild(tagHeader);

    const epContainer = document.createElement('div');
    epContainer.style.display = 'none';

    tagHeader.addEventListener('click', () => {
      const vis = epContainer.style.display !== 'none';
      epContainer.style.display = vis ? 'none' : '';
      toggle.textContent = vis ? '\u25B8' : '\u25BE';
    });

    for (const ep of tagGroups[tag]) {
      const epEl = document.createElement('div');
      epEl.className = 'api-browse-endpoint';
      epEl.innerHTML = `
        <span class="api-tree-method ${ep.method}">${ep.method.toUpperCase().substring(0, 3)}</span>
        <span class="api-browse-path">${esc(ep.path)}</span>
      `;
      epEl.title = ep.summary || '';
      epEl.addEventListener('click', () => {
        populateFromEndpoint(ep);
      });
      epContainer.appendChild(epEl);
    }

    container.appendChild(epContainer);

    // Auto-expand if filter is active
    if (filter) {
      epContainer.style.display = '';
      toggle.textContent = '\u25BE';
    }
  }
}

function populateFromEndpoint(ep) {
  // Save current tab and open in new tab if current isn't empty
  saveCurrentTabState();
  const currentTab = openTabs[activeTabIndex];
  const isEmpty = !currentTab.url && !currentTab.requestData;
  if (!isEmpty) {
    const tab = createEmptyTab();
    openTabs.push(tab);
    activeTabIndex = openTabs.length - 1;
  }

  document.getElementById('api-method').value = ep.method.toUpperCase();
  updateMethodColor();

  let urlPath = ep.path.replace(/\{(\w+)\}/g, '{{$1}}');
  document.getElementById('api-url').value = '{{baseUrl}}' + urlPath;

  const queryParams = (ep.endpoint.parameters || []).filter(p => p.in === 'query');
  paramsRows = queryParams.length > 0
    ? queryParams.map(p => ({ key: p.name, value: '', enabled: true, description: p.description || '' }))
    : [{ key: '', value: '', enabled: false }];
  pathVarsRows = [];
  syncUrlToPathVars();
  renderParamsEditor();

  headersRows = [
    { key: 'Content-Type', value: 'application/json', enabled: true },
    { key: '', value: '', enabled: false },
  ];
  renderHeadersEditor();

  authConfig = { type: 'inherit' };
  renderAuthPanel();

  const reqBody = ep.endpoint.requestBody?.content?.['application/json']?.schema;
  if (reqBody) {
    bodyMode = 'json';
    try {
      bodyContent = JSON.stringify(buildSchemaExample(reqBody, swaggerSpec), null, 2);
    } catch { bodyContent = '{}'; }
  } else {
    bodyMode = 'none';
    bodyContent = '';
  }
  renderBodyPanel();

  preScript = '';
  testScript = '';
  renderScriptPanel('pre-script');
  renderScriptPanel('tests');

  currentCollectionPath = [];
  currentRequestData = null;
  currentResponse = null;

  document.getElementById('api-response-bar').innerHTML = '<span class="api-response-placeholder">Hit Send to get a response</span>';
  document.getElementById('api-response-tabs').style.display = 'none';

  saveCurrentTabState();
  renderOpenTabs();
  renderCollectionsTree();

  // Switch to collections sidebar
  document.querySelectorAll('.api-sidebar-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.api-sidebar-tab[data-sidebar="collections"]').classList.add('active');
  document.querySelectorAll('.api-sidebar-content').forEach(el => el.style.display = 'none');
  document.getElementById('api-sidebar-collections').style.display = '';
}

function buildSchemaExample(schema, spec, depth) {
  depth = depth || 0;
  if (depth > 5) return {};
  if (schema.$ref) {
    const refPath = schema.$ref.replace('#/', '').split('/');
    let resolved = spec;
    for (const seg of refPath) resolved = resolved?.[seg];
    if (resolved) return buildSchemaExample(resolved, spec, depth + 1);
    return {};
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    for (const [key, val] of Object.entries(schema.properties || {})) {
      obj[key] = buildSchemaExample(val, spec, depth + 1);
    }
    return obj;
  }
  if (schema.type === 'array') {
    if (schema.items) return [buildSchemaExample(schema.items, spec, depth + 1)];
    return [];
  }
  if (schema.type === 'string') return schema.enum?.[0] || 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return null;
}

// ---------------------------------------------------------------------------
// Import menu (choice between OpenAPI and Postman)
// ---------------------------------------------------------------------------
function showImportMenu(e) {
  showContextMenu(e, [
    { label: 'From OpenAPI / Swagger', action: () => importFromOpenAPI() },
    { label: 'From Postman Collection', action: () => openPostmanModal() },
    { label: 'From Postman Environment', action: () => openPostmanEnvImport() },
  ]);
}

// ---------------------------------------------------------------------------
// Postman Collection Import
// ---------------------------------------------------------------------------
let postmanModalMode = 'collection'; // 'collection' or 'environment'

function openPostmanModal() {
  postmanModalMode = 'collection';
  document.getElementById('api-postman-modal').style.display = '';
  document.getElementById('api-postman-json').value = '';
  document.getElementById('api-postman-error').style.display = 'none';
  document.getElementById('api-postman-file').value = '';
}

function closePostmanModal() {
  document.getElementById('api-postman-modal').style.display = 'none';
  // Reset to collection mode for next open
  postmanModalMode = 'collection';
  const modal = document.getElementById('api-postman-modal');
  modal.querySelector('.api-modal-header h3').textContent = 'Import Postman Collection';
  modal.querySelector('p').textContent = 'Paste the contents of a Postman Collection v2.1 export (JSON), or drag & drop the file below.';
  document.getElementById('api-postman-drop-zone').querySelector('input').multiple = false;
}

function readPostmanFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('api-postman-json').value = e.target.result;
  };
  reader.readAsText(file);
}

async function doPostmanImport() {
  const jsonText = document.getElementById('api-postman-json').value.trim();
  const errorEl = document.getElementById('api-postman-error');
  errorEl.style.display = 'none';

  if (!jsonText) {
    errorEl.textContent = 'Please paste a Postman collection JSON or drop a file.';
    errorEl.style.display = '';
    return;
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    errorEl.textContent = 'Invalid JSON: ' + e.message;
    errorEl.style.display = '';
    return;
  }

  if (!data.info) {
    errorEl.textContent = 'This doesn\'t look like a Postman collection — missing "info" field.';
    errorEl.style.display = '';
    return;
  }

  try {
    const res = await fetch('/api/collections/import-postman', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonText,
    });
    const result = await res.json();
    if (result.error) {
      errorEl.textContent = 'Import failed: ' + result.error;
      errorEl.style.display = '';
      return;
    }

    closePostmanModal();
    await loadCollections();
    alert(`Imported "${result.name}" — ${result._totalRequests || 0} requests in ${(result.folders || []).length} folders`);
  } catch (err) {
    errorEl.textContent = 'Import failed: ' + err.message;
    errorEl.style.display = '';
  }
}

// ---------------------------------------------------------------------------
// Postman Environment Import
// ---------------------------------------------------------------------------
function openPostmanEnvImport() {
  postmanModalMode = 'environment';
  const modal = document.getElementById('api-postman-modal');
  modal.style.display = '';
  document.getElementById('api-postman-json').value = '';
  document.getElementById('api-postman-error').style.display = 'none';
  document.getElementById('api-postman-file').value = '';
  modal.querySelector('.api-modal-header h3').textContent = 'Import Postman Environments';
  modal.querySelector('p').textContent = 'Drop one or more Postman environment .json files below, or paste a single environment JSON.';
  document.getElementById('api-postman-drop-zone').querySelector('input').multiple = true;
}

async function importEnvFiles(files) {
  const errorEl = document.getElementById('api-postman-error');
  errorEl.style.display = 'none';
  const results = [];
  const errors = [];

  for (const file of files) {
    try {
      const text = await readFileAsText(file);
      const data = JSON.parse(text);
      if (!data.name) {
        errors.push(`${file.name}: missing "name" field`);
        continue;
      }
      const res = await fetch('/api/environments/import-postman', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const result = await res.json();
      if (result.error) {
        errors.push(`${file.name}: ${result.error}`);
      } else {
        results.push(`${result.name} (${result.variableCount} vars)`);
      }
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }

  if (results.length > 0) {
    await loadEnvironments();
    activeEnvIndex = environments.length - 1;
    renderEnvSelector();
  
  }

  if (errors.length > 0) {
    errorEl.textContent = errors.join('\n');
    errorEl.style.whiteSpace = 'pre-wrap';
    errorEl.style.display = '';
  }

  if (results.length > 0) {
    closePostmanModal();
    alert(`Imported ${results.length} environment${results.length > 1 ? 's' : ''}:\n${results.join('\n')}`);
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

async function doPostmanEnvImport() {
  const jsonText = document.getElementById('api-postman-json').value.trim();
  const errorEl = document.getElementById('api-postman-error');
  errorEl.style.display = 'none';

  if (!jsonText) {
    errorEl.textContent = 'Please paste a Postman environment JSON or drop a file.';
    errorEl.style.display = '';
    return;
  }

  let data;
  try { data = JSON.parse(jsonText); } catch (e) {
    errorEl.textContent = 'Invalid JSON: ' + e.message;
    errorEl.style.display = '';
    return;
  }

  if (!data.name) {
    errorEl.textContent = 'This doesn\'t look like a Postman environment — missing "name" field.';
    errorEl.style.display = '';
    return;
  }

  try {
    const res = await fetch('/api/environments/import-postman', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonText,
    });
    const result = await res.json();
    if (result.error) {
      errorEl.textContent = 'Import failed: ' + result.error;
      errorEl.style.display = '';
      return;
    }

    closePostmanModal();
    await loadEnvironments();
    activeEnvIndex = environments.length - 1;
    renderEnvSelector();
  
    alert(`Imported environment "${result.name}" with ${result.variableCount} variables`);
  } catch (err) {
    errorEl.textContent = 'Import failed: ' + err.message;
    errorEl.style.display = '';
  }
}

// ---------------------------------------------------------------------------
// Import from OpenAPI
// ---------------------------------------------------------------------------
async function importFromOpenAPI() {
  if (!swaggerSpec) {
    await loadSwaggerSpec();
    if (!swaggerSpec) return alert('Could not load OpenAPI spec. Is the API running?');
  }
  importAllAsCollection();
}

async function importAllAsCollection() {
  if (!swaggerSpec) {
    await loadSwaggerSpec();
    if (!swaggerSpec) return alert('Could not load OpenAPI spec.');
  }

  try {
    const res = await fetch('/api/collections/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swaggerSpec),
    });
    const coll = await res.json();
    if (coll.error) return alert('Import failed: ' + coll.error);

    // Reload collections
    await loadCollections();
    alert(`Imported "${coll.name}" with ${(coll.folders || []).length} folders`);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function esc(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = String(str);
  return el.innerHTML;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
