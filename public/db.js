/* ==========================================================================
   Database Explorer — Client
   ========================================================================== */

// eslint-disable-next-line no-unused-vars
function initDatabase() {
  if (!document.getElementById('db-editor')) return; // DB tab not present

  const STORAGE_KEY_SQL = 'db-editor-sql';
  const STORAGE_KEY_HISTORY = 'db-history';
  const STORAGE_KEY_EXPANDED = 'db-tree-expanded';
  const STORAGE_KEY_CONN = 'db-selected-connection';
  const MAX_HISTORY = 50;

  // DOM refs
  const tree = document.getElementById('db-tree');
  const searchInput = document.getElementById('db-search-input');
  const editor = document.getElementById('db-editor');
  const executeBtn = document.getElementById('db-execute');
  const writeModeCheck = document.getElementById('db-write-mode');
  const writeModeLabel = document.getElementById('db-write-mode-label');
  const queryTimeEl = document.getElementById('db-query-time');
  const resultsInfo = document.getElementById('db-results-info');
  const resultsWrap = document.getElementById('db-results-wrap');
  const errorEl = document.getElementById('db-error');
  const exportBtn = document.getElementById('db-export');
  const addRowBtn = document.getElementById('db-add-row');
  const statusDot = document.getElementById('db-status-dot');
  const statusText = document.getElementById('db-status-text');
  const historyList = document.getElementById('db-history-list');
  const connSelect = document.getElementById('db-conn-select');
  const connGear = document.getElementById('db-conn-gear');
  const connModal = document.getElementById('db-conn-modal');
  const connModalClose = document.getElementById('db-conn-modal-close');
  const connList = document.getElementById('db-conn-list');
  const connEditorPanel = document.getElementById('db-conn-editor');
  // connAddBtn removed — connections are env-sourced and read-only
  const toastContainer = document.getElementById('db-toast-container');

  let schemaData = null;
  let lastResult = null;
  let lastSQL = '';
  let sortCol = -1;
  let sortAsc = true;
  let sourceTable = null; // { schema, table, pkColumns } when editable
  let connections = []; // local cache (passwords masked)
  let selectedConnId = localStorage.getItem(STORAGE_KEY_CONN) || '';
  let editingConnId = null;

  // ---------------------------------------------------------------------------
  // Query tabs
  // ---------------------------------------------------------------------------
  let dbTabs = [];       // [{ id, label, sql, result, lastSQL, sourceTable, queryTime }]
  let activeDbTabId = null;
  let _dbTabDragSrc = null;
  let dbTabSeq = 0;
  let _onDbTabSwitched = null; // Set after scripts section initializes
  const tabBar = document.getElementById('db-query-tab-bar');

  function newDbTab(label = 'Query', sql = '', opts = {}) {
    const id = ++dbTabSeq;
    dbTabs.push({ id, label, sql, result: null, lastSQL: '', sourceTable: null, queryTime: '', scriptPath: opts.scriptPath || null, tableSource: opts.tableSource || null });
    switchDbTab(id);
    return id;
  }

  function saveActiveDbTabState() {
    const tab = dbTabs.find(t => t.id === activeDbTabId);
    if (!tab) return;
    tab.sql = editor.value;
    tab.result = lastResult;
    tab.lastSQL = lastSQL;
    tab.sourceTable = sourceTable;
    tab.queryTime = queryTimeEl.textContent;
  }

  function switchDbTab(id) {
    saveActiveDbTabState();
    activeDbTabId = id;
    const tab = dbTabs.find(t => t.id === id);
    if (!tab) return;

    editor.value = tab.sql;
    localStorage.setItem(STORAGE_KEY_SQL, tab.sql);
    lastResult = tab.result;
    lastSQL = tab.lastSQL;
    sourceTable = tab.sourceTable;
    queryTimeEl.textContent = tab.queryTime || '';
    sortCol = -1; sortAsc = true;

    if (tab.result && tab.result.columns?.length) {
      renderResults(tab.result);
      resultsInfo.textContent = `${tab.result.rows.length} row${tab.result.rows.length !== 1 ? 's' : ''} returned`;
      exportBtn.style.display = '';
    } else {
      resultsWrap.innerHTML = '<div class="db-results-placeholder">Run a query to see results</div>';
      resultsInfo.textContent = 'Run a query to see results';
      exportBtn.style.display = 'none';
    }
    errorEl.style.display = 'none';
    updateAddRowVisibility();
    renderDbTabBar();

    if (_onDbTabSwitched) _onDbTabSwitched(tab);
  }

  function closeDbTab(id) {
    const idx = dbTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    dbTabs.splice(idx, 1);
    if (dbTabs.length === 0) {
      newDbTab();
      return;
    }
    if (activeDbTabId === id) {
      const next = dbTabs[Math.min(idx, dbTabs.length - 1)];
      activeDbTabId = null; // force restore
      switchDbTab(next.id);
    } else {
      renderDbTabBar();
    }
  }

  function renderDbTabBar() {
    if (!tabBar) return;
    tabBar.innerHTML = '';
    for (const tab of dbTabs) {
      const el = document.createElement('button');
      el.className = 'db-query-tab' + (tab.id === activeDbTabId ? ' active' : '');
      el.innerHTML = `<span class="db-query-tab-label">${esc(tab.label)}</span><span class="db-query-tab-close" title="Close">×</span>`;
      el.addEventListener('click', e => {
        if (e.target.closest('.db-query-tab-close')) { closeDbTab(tab.id); return; }
        switchDbTab(tab.id);
      });
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        const myId = tab.id;
        if (typeof showContextMenu === 'function') {
          showContextMenu(e, [
            { label: 'Close',              action: () => closeDbTab(myId) },
            { label: 'Close Others',       action: () => { dbTabs = [dbTabs.find(t => t.id === myId)]; activeDbTabId = null; switchDbTab(myId); } },
            { label: 'Close to the Right', action: () => { const i = dbTabs.findIndex(t => t.id === myId); dbTabs.splice(i + 1); if (!dbTabs.find(t => t.id === activeDbTabId)) switchDbTab(myId); else renderDbTabBar(); } },
            { label: 'Close All',          action: () => { dbTabs = []; newDbTab(); } },
          ]);
        }
      });

      // Drag-and-drop reordering
      const tabIdx = dbTabs.indexOf(tab);
      el.draggable = true;
      el.addEventListener('dragstart', e => {
        _dbTabDragSrc = tabIdx;
        el.classList.add('tab-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        tabBar.querySelectorAll('.db-query-tab').forEach(t => t.classList.remove('tab-dragging', 'tab-drag-over'));
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tabBar.querySelectorAll('.db-query-tab').forEach(t => t.classList.remove('tab-drag-over'));
        if (tabIdx !== _dbTabDragSrc) el.classList.add('tab-drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('tab-drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        if (_dbTabDragSrc === null || _dbTabDragSrc === tabIdx) return;
        const moved = dbTabs.splice(_dbTabDragSrc, 1)[0];
        dbTabs.splice(tabIdx, 0, moved);
        _dbTabDragSrc = null;
        renderDbTabBar();
      });

      tabBar.appendChild(el);
    }
    // + new tab button
    const addBtn = document.createElement('button');
    addBtn.className = 'db-query-tab-add';
    addBtn.title = 'New query tab';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => newDbTab());
    tabBar.appendChild(addBtn);
  }

  // Initialise with one tab, restoring saved SQL
  const saved = localStorage.getItem(STORAGE_KEY_SQL);
  newDbTab('Query 1', saved || '');

  // Persist editor on change (save to active tab)
  editor.addEventListener('input', () => {
    const tab = dbTabs.find(t => t.id === activeDbTabId);
    if (tab) tab.sql = editor.value;
    localStorage.setItem(STORAGE_KEY_SQL, editor.value);
  });

  // Write mode styling
  writeModeCheck.addEventListener('change', () => {
    writeModeLabel.classList.toggle('active', writeModeCheck.checked);
    // Re-render results to show/hide edit affordances
    if (lastResult && lastResult.columns && lastResult.columns.length > 0) {
      renderResults(lastResult);
    }
    updateAddRowVisibility();
  });

  // ---------------------------------------------------------------------------
  // Sidebar tabs
  // ---------------------------------------------------------------------------
  document.querySelectorAll('.db-sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.db-sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.dbsidebar;
      document.getElementById('db-sidebar-schema').style.display = target === 'schema' ? '' : 'none';
      document.getElementById('db-sidebar-history').style.display = target === 'history' ? '' : 'none';
      if (target === 'history') renderHistory();
    });
  });

  // ---------------------------------------------------------------------------
  // Connection helpers
  // ---------------------------------------------------------------------------
  function connParam() {
    return selectedConnId ? `?connectionId=${encodeURIComponent(selectedConnId)}` : '';
  }

  function connQueryParam() {
    return selectedConnId ? `connectionId=${encodeURIComponent(selectedConnId)}` : '';
  }

  // ---------------------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------------------
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `db-toast db-toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ---------------------------------------------------------------------------
  // Status check
  // ---------------------------------------------------------------------------
  async function checkStatus() {
    try {
      const res = await fetch('/api/db/status' + connParam());
      const data = await res.json();
      const conn = connections.find(c => c.id === selectedConnId) || connections[0];
      if (data.connected) {
        statusDot.className = 'db-status-dot connected';
        if (conn && conn.color) statusDot.style.background = conn.color;
        else statusDot.style.background = '';
        statusText.textContent = `${data.database}@${data.host}`;
        statusText.title = data.version || '';
      } else {
        statusDot.className = 'db-status-dot disconnected';
        statusDot.style.background = '';
        statusText.textContent = data.error || 'Disconnected';
      }
    } catch {
      statusDot.className = 'db-status-dot disconnected';
      statusDot.style.background = '';
      statusText.textContent = 'Server unreachable';
    }
  }

  // ---------------------------------------------------------------------------
  // Connection list (dropdown)
  // ---------------------------------------------------------------------------
  async function loadConnections() {
    try {
      const res = await fetch('/api/db/connections');
      connections = await res.json();
    } catch {
      connections = [];
    }
    renderConnDropdown();
  }

  function renderConnDropdown() {
    connSelect.innerHTML = '';
    for (const c of connections) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === selectedConnId) opt.selected = true;
      connSelect.appendChild(opt);
    }
    // If no selection matches, select first
    if (connections.length > 0 && !connections.find(c => c.id === selectedConnId)) {
      selectedConnId = connections[0].id;
      connSelect.value = selectedConnId;
      localStorage.setItem(STORAGE_KEY_CONN, selectedConnId);
    }
  }

  connSelect.addEventListener('change', () => {
    selectedConnId = connSelect.value;
    localStorage.setItem(STORAGE_KEY_CONN, selectedConnId);
    // Reload schema + status for new connection
    checkStatus();
    loadSchema();
  });

  // ---------------------------------------------------------------------------
  // Connection Manager Modal
  // ---------------------------------------------------------------------------
  connGear.addEventListener('click', () => {
    connModal.style.display = 'flex';
    renderConnManager();
  });

  connModalClose.addEventListener('click', () => {
    connModal.style.display = 'none';
  });

  connModal.addEventListener('click', (e) => {
    if (e.target === connModal) connModal.style.display = 'none';
  });

  function renderConnManager() {
    connList.innerHTML = '';
    for (const c of connections) {
      const item = document.createElement('div');
      item.className = 'api-env-list-item' + (c.id === editingConnId ? ' active' : '');
      item.innerHTML = `
        <span class="db-conn-dot" style="background:${esc(c.color || '#89b4fa')}"></span>
        <span class="api-env-list-name">${esc(c.name)}</span>
      `;
      item.addEventListener('click', () => {
        editingConnId = c.id;
        renderConnManager();
      });
      connList.appendChild(item);
    }

    // Editor panel
    const conn = connections.find(c => c.id === editingConnId);
    if (!conn) {
      connEditorPanel.innerHTML = '<div style="padding:16px;color:var(--overlay0)">Select a connection to edit</div>';
      return;
    }

    const envPrefix = conn.envPrefix || 'DB';
    connEditorPanel.innerHTML = `
      <div class="db-conn-form">
        <div class="db-conn-env-source">Source: ${esc(envPrefix)}_*</div>
        <label class="db-conn-label">Name</label>
        <input class="db-conn-input" id="dbc-name" value="${esc(conn.name)}" readonly />
        <label class="db-conn-label">Host</label>
        <input class="db-conn-input" id="dbc-host" value="${esc(conn.host)}" readonly />
        <div class="db-conn-row">
          <div class="db-conn-field">
            <label class="db-conn-label">Port</label>
            <input class="db-conn-input" id="dbc-port" type="number" value="${conn.port}" readonly />
          </div>
          <div class="db-conn-field">
            <label class="db-conn-label">Database</label>
            <input class="db-conn-input" id="dbc-database" value="${esc(conn.database)}" readonly />
          </div>
        </div>
        <label class="db-conn-label">User</label>
        <input class="db-conn-input" id="dbc-user" value="${esc(conn.user)}" readonly />
        <label class="db-conn-label">Password</label>
        <div class="db-conn-pw-wrap">
          <input class="db-conn-input" id="dbc-password" type="password" value="${esc(conn.password)}" readonly />
          <button class="btn db-conn-pw-toggle" id="dbc-pw-toggle" type="button">Show</button>
        </div>
        <div class="db-conn-row" style="align-items:center">
          <label class="db-conn-checkbox-label">
            <input type="checkbox" id="dbc-ssl" ${conn.ssl ? 'checked' : ''} disabled /> SSL
          </label>
          <div class="db-conn-field" style="flex:0">
            <label class="db-conn-label">Color</label>
            <input type="color" id="dbc-color" value="${conn.color || '#89b4fa'}" class="db-conn-color" disabled />
          </div>
        </div>
        <div class="db-conn-actions">
          <button class="btn db-btn-test" id="dbc-test">Test Connection</button>
          <span class="db-conn-test-result" id="dbc-test-result"></span>
        </div>
      </div>
    `;

    // Password toggle
    const pwInput = document.getElementById('dbc-password');
    document.getElementById('dbc-pw-toggle').addEventListener('click', () => {
      const isPassword = pwInput.type === 'password';
      pwInput.type = isPassword ? 'text' : 'password';
      document.getElementById('dbc-pw-toggle').textContent = isPassword ? 'Hide' : 'Show';
    });

    // Test connection
    document.getElementById('dbc-test').addEventListener('click', async () => {
      const resultEl = document.getElementById('dbc-test-result');
      resultEl.textContent = 'Testing...';
      resultEl.className = 'db-conn-test-result';
      try {
        const res = await fetch('/api/db/connections/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: conn.host, port: conn.port, user: conn.user,
            password: conn.password,
            database: conn.database, ssl: conn.ssl,
            connectionId: conn.id,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          resultEl.textContent = 'Connected!';
          resultEl.className = 'db-conn-test-result success';
        } else {
          resultEl.textContent = data.error || 'Failed';
          resultEl.className = 'db-conn-test-result error';
        }
      } catch (err) {
        resultEl.textContent = err.message;
        resultEl.className = 'db-conn-test-result error';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Schema tree
  // ---------------------------------------------------------------------------
  async function loadSchema() {
    try {
      const res = await fetch('/api/db/schema' + connParam());
      if (!res.ok) throw new Error('Failed to load schema');
      schemaData = await res.json();
      renderTree();
    } catch (err) {
      tree.innerHTML = `<div class="db-tree-error">${esc(err.message)}</div>`;
    }
  }

  function getExpandedState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_EXPANDED) || '{}'); } catch { return {}; }
  }

  function saveExpandedState(state) {
    localStorage.setItem(STORAGE_KEY_EXPANDED, JSON.stringify(state));
  }

  function renderTree(filter) {
    if (!schemaData) return;
    const expanded = getExpandedState();
    const filterLower = (filter || '').toLowerCase();
    tree.innerHTML = '';

    for (const [schemaName, groups] of Object.entries(schemaData)) {
      const allItems = [
        ...groups.tables.map(t => ({ ...t, group: 'Tables' })),
        ...groups.views.map(v => ({ ...v, group: 'Views' })),
      ];

      // Filter
      const filtered = filterLower
        ? allItems.filter(t => t.name.toLowerCase().includes(filterLower))
        : allItems;

      if (filtered.length === 0) continue;

      // Schema node
      const schemaNode = document.createElement('div');
      schemaNode.className = 'db-tree-schema';
      const schemaKey = `s:${schemaName}`;
      const schemaOpen = expanded[schemaKey] !== false; // default open

      schemaNode.innerHTML = `<div class="db-tree-item db-tree-schema-item">
        <span class="db-tree-arrow ${schemaOpen ? 'open' : ''}">\u25B6</span>
        <span class="db-tree-icon">\uD83D\uDDC4</span>
        <span class="db-tree-label">${esc(schemaName)}</span>
      </div>`;

      const schemaChildren = document.createElement('div');
      schemaChildren.className = 'db-tree-children';
      schemaChildren.style.display = schemaOpen ? '' : 'none';

      // Group by Tables / Views
      const grouped = {};
      for (const item of filtered) {
        if (!grouped[item.group]) grouped[item.group] = [];
        grouped[item.group].push(item);
      }

      for (const [groupName, items] of Object.entries(grouped)) {
        const groupKey = `g:${schemaName}.${groupName}`;
        const groupOpen = expanded[groupKey] !== false;

        const groupNode = document.createElement('div');
        groupNode.className = 'db-tree-group';
        groupNode.innerHTML = `<div class="db-tree-item db-tree-group-item">
          <span class="db-tree-arrow ${groupOpen ? 'open' : ''}">\u25B6</span>
          <span class="db-tree-icon">${groupName === 'Tables' ? '\uD83D\uDDC3' : '\uD83D\uDC41'}</span>
          <span class="db-tree-label">${groupName}</span>
          <span class="db-tree-count">${items.length}</span>
        </div>`;

        const groupChildren = document.createElement('div');
        groupChildren.className = 'db-tree-children';
        groupChildren.style.display = groupOpen ? '' : 'none';

        for (const item of items) {
          const tableKey = `t:${schemaName}.${item.name}`;
          const tableOpen = expanded[tableKey] === true; // default closed

          const tableNode = document.createElement('div');
          tableNode.className = 'db-tree-table';

          const hasColumns = item.columns && item.columns.length > 0;
          tableNode.innerHTML = `<div class="db-tree-item db-tree-table-item" data-schema="${esc(schemaName)}" data-table="${esc(item.name)}">
            ${hasColumns ? `<span class="db-tree-arrow ${tableOpen ? 'open' : ''}">\u25B6</span>` : '<span class="db-tree-arrow-spacer"></span>'}
            <span class="db-tree-label db-tree-table-name">${esc(item.name)}</span>
          </div>`;

          if (hasColumns) {
            const colChildren = document.createElement('div');
            colChildren.className = 'db-tree-children';
            colChildren.style.display = tableOpen ? '' : 'none';

            for (const col of item.columns) {
              const colNode = document.createElement('div');
              colNode.className = 'db-tree-item db-tree-col-item';
              let badges = '';
              if (col.isPk) badges += '<span class="db-badge db-badge-pk">PK</span>';
              if (col.fk) badges += `<span class="db-badge db-badge-fk" title="FK \u2192 ${esc(col.fk.refTable)}.${esc(col.fk.refColumn)}">FK</span>`;
              colNode.innerHTML = `<span class="db-tree-arrow-spacer"></span>
                <span class="db-tree-col-name">${esc(col.name)}</span>
                <span class="db-tree-col-type">${esc(col.type)}${col.nullable ? '' : ' NOT NULL'}</span>
                ${badges}`;
              colChildren.appendChild(colNode);
            }

            tableNode.appendChild(colChildren);
          }

          groupChildren.appendChild(tableNode);
        }

        groupNode.appendChild(groupChildren);
        schemaChildren.appendChild(groupNode);
      }

      schemaNode.appendChild(schemaChildren);
      tree.appendChild(schemaNode);
    }

    // Attach toggle listeners
    tree.querySelectorAll('.db-tree-arrow').forEach(arrow => {
      arrow.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = arrow.closest('.db-tree-item');
        const children = item.nextElementSibling || item.parentElement.querySelector('.db-tree-children');
        if (!children || children === item) return;

        const parent = item.parentElement;
        const childDiv = parent.querySelector(':scope > .db-tree-children');
        if (!childDiv) return;

        const isOpen = arrow.classList.toggle('open');
        childDiv.style.display = isOpen ? '' : 'none';

        // Save state
        const state = getExpandedState();
        const key = getNodeKey(item);
        if (key) { state[key] = isOpen; saveExpandedState(state); }
      });
    });

    // Click table → open in a new query tab (or switch if already open)
    tree.querySelectorAll('.db-tree-table-item').forEach(item => {
      item.addEventListener('click', () => {
        const schema = item.dataset.schema;
        const table = item.dataset.table;
        if (!schema || !table) return;
        const sql = `SELECT * FROM "${schema}"."${table}" LIMIT 100;`;
        const label = table;
        // Reuse existing tab for this table if one exists
        const existing = dbTabs.find(t => t.label === label && t.sql.startsWith(`SELECT * FROM "${schema}"."${table}"`));
        if (existing) { switchDbTab(existing.id); return; }
        newDbTab(label, sql, { tableSource: { schema, table } });
        editor.focus();
      });
    });
  }

  function getNodeKey(item) {
    if (item.classList.contains('db-tree-schema-item')) {
      const label = item.querySelector('.db-tree-label').textContent;
      return `s:${label}`;
    }
    if (item.classList.contains('db-tree-group-item')) {
      const schemaItem = item.closest('.db-tree-schema');
      const schemaLabel = schemaItem?.querySelector('.db-tree-schema-item .db-tree-label')?.textContent || '';
      const groupLabel = item.querySelector('.db-tree-label').textContent;
      return `g:${schemaLabel}.${groupLabel}`;
    }
    if (item.classList.contains('db-tree-table-item')) {
      return `t:${item.dataset.schema}.${item.dataset.table}`;
    }
    return null;
  }

  // Search filter
  searchInput.addEventListener('input', () => {
    renderTree(searchInput.value);
  });

  // ---------------------------------------------------------------------------
  // Source table detection (for inline editing)
  // ---------------------------------------------------------------------------
  function detectSourceTable(sql) {
    // Match SELECT * FROM "schema"."table" or SELECT * FROM schema.table
    const m = sql.match(/^\s*SELECT\s+\*\s+FROM\s+"?(\w+)"?\."?(\w+)"?\s*/i);
    if (!m) return null;
    const [, schema, table] = m;
    if (!schemaData || !schemaData[schema]) return null;
    const allTables = [...(schemaData[schema].tables || []), ...(schemaData[schema].views || [])];
    const found = allTables.find(t => t.name === table);
    if (!found || !found.columns) return null;
    const pkColumns = found.columns.filter(c => c.isPk).map(c => c.name);
    if (pkColumns.length === 0) return null;
    return { schema, table, pkColumns, columns: found.columns };
  }

  // ---------------------------------------------------------------------------
  // SQL literal helper
  // ---------------------------------------------------------------------------
  function pgLiteral(val) {
    if (val === null || val === undefined || val === '') return 'NULL';
    if (typeof val === 'number' || (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val) && val !== '')) {
      return String(val);
    }
    // Escape single quotes by doubling
    return "'" + String(val).replace(/'/g, "''") + "'";
  }

  // ---------------------------------------------------------------------------
  // Query execution
  // ---------------------------------------------------------------------------
  async function executeQuery(sql, opts = {}) {
    if (!sql) {
      // Use selected text if any, otherwise full editor content
      const sel = editor.value.substring(editor.selectionStart, editor.selectionEnd).trim();
      if (sel) {
        sql = sel;
      } else {
        sql = editor.value.trim();
        // Confirm before running multi-line scripts with no selection
        if (sql && sql.includes('\n') && !opts.silent) {
          if (!confirm('No text selected — execute the entire editor contents?')) return;
        }
      }
    }
    if (!sql) return;

    const writeMode = opts.writeMode !== undefined ? opts.writeMode : writeModeCheck.checked;
    const silent = opts.silent || false;

    if (!silent) {
      errorEl.style.display = 'none';
      resultsWrap.innerHTML = '<div class="db-results-placeholder">Executing...</div>';
      queryTimeEl.textContent = '';
      exportBtn.style.display = 'none';
      addRowBtn.style.display = 'none';
    }

    try {
      const qp = connQueryParam();
      const url = '/api/db/query' + (qp ? '?' + qp : '');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, writeMode }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (!silent) showError(data.error || 'Query failed');
        return null;
      }

      if (!silent) {
        lastResult = data;
        lastSQL = sql;
        sortCol = -1;
        sortAsc = true;
        queryTimeEl.textContent = `${data.time}ms`;
        // Persist result on active tab so switching back restores it
        const activeTab = dbTabs.find(t => t.id === activeDbTabId);
        if (activeTab) { activeTab.result = data; activeTab.lastSQL = sql; activeTab.queryTime = `${data.time}ms`; }

        // Detect source table
        sourceTable = detectSourceTable(sql);

        if (data.columns && data.columns.length > 0) {
          renderResults(data);
          resultsInfo.textContent = `${data.rows.length} row${data.rows.length !== 1 ? 's' : ''} returned (${data.command || 'SELECT'})`;
          exportBtn.style.display = '';
          updateAddRowVisibility();
        } else {
          resultsWrap.innerHTML = `<div class="db-results-placeholder">${data.command || 'OK'}: ${data.rowCount} row${data.rowCount !== 1 ? 's' : ''} affected</div>`;
          resultsInfo.textContent = `${data.rowCount} row(s) affected`;
        }

        addHistory(sql, data.time, data.rows?.length);
      }

      return data;
    } catch (err) {
      if (!silent) showError(err.message);
      return null;
    }
  }

  function updateAddRowVisibility() {
    addRowBtn.style.display = (sourceTable && writeModeCheck.checked) ? '' : 'none';
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
    resultsWrap.innerHTML = '';
    resultsInfo.textContent = 'Error';
  }

  executeBtn.addEventListener('click', () => executeQuery());
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executeQuery();
    }
    // Tab inserts spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = editor.selectionStart;
      editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(editor.selectionEnd);
      editor.selectionStart = editor.selectionEnd = start + 2;
    }
  });

  // ---------------------------------------------------------------------------
  // Results table (with inline editing)
  // ---------------------------------------------------------------------------
  function renderResults(data) {
    const rows = sortCol >= 0 ? sortRows(data.rows, data.columns[sortCol], sortAsc) : data.rows;
    const table = document.createElement('table');
    table.className = 'db-results-table';
    const editable = sourceTable && writeModeCheck.checked;

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    if (editable) {
      const thAct = document.createElement('th');
      thAct.className = 'db-results-th db-th-actions';
      thAct.textContent = '';
      headerRow.appendChild(thAct);
    }
    data.columns.forEach((col, i) => {
      const th = document.createElement('th');
      th.textContent = col;
      th.className = 'db-results-th';
      if (i === sortCol) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
      th.addEventListener('click', () => {
        if (sortCol === i) sortAsc = !sortAsc;
        else { sortCol = i; sortAsc = true; }
        renderResults(data);
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');

      // Actions column (delete)
      if (editable) {
        const tdAct = document.createElement('td');
        tdAct.className = 'db-cell-actions';
        const delBtn = document.createElement('button');
        delBtn.className = 'db-row-delete-btn';
        delBtn.title = 'Delete row';
        delBtn.innerHTML = '&times;';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRow(row);
        });
        tdAct.appendChild(delBtn);
        tr.appendChild(tdAct);
      }

      for (const col of data.columns) {
        const td = document.createElement('td');
        const val = row[col];
        if (val === null || val === undefined) {
          td.innerHTML = '<span class="db-null">NULL</span>';
        } else if (typeof val === 'object') {
          td.textContent = JSON.stringify(val);
          td.className = 'db-cell-truncate';
          td.title = JSON.stringify(val, null, 2);
        } else {
          const str = String(val);
          if (str.length > 120) {
            td.textContent = str.slice(0, 120) + '...';
            td.className = 'db-cell-truncate';
            td.title = str;
          } else {
            td.textContent = str;
          }
        }

        // Make editable
        if (editable) {
          td.classList.add('db-cell-editable');
          td.dataset.col = col;
          td.dataset.origVal = val === null || val === undefined ? '\x00NULL\x00' : String(val);
          td.addEventListener('click', () => startCellEdit(td, row, col));
        }

        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    resultsWrap.innerHTML = '';
    resultsWrap.appendChild(table);
  }

  // ---------------------------------------------------------------------------
  // Inline cell editing
  // ---------------------------------------------------------------------------
  function startCellEdit(td, row, col) {
    if (td.querySelector('input')) return; // already editing

    const origVal = td.dataset.origVal === '\x00NULL\x00' ? '' : td.dataset.origVal;
    const input = document.createElement('input');
    input.className = 'db-cell-edit-input';
    input.value = origVal;
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    function commit() {
      const newVal = input.value;
      const oldVal = td.dataset.origVal === '\x00NULL\x00' ? null : td.dataset.origVal;
      if (newVal === (oldVal || '')) {
        // No change — restore display
        cancelEdit();
        return;
      }
      const actualNewVal = newVal === '' ? null : newVal;
      updateCell(row, col, actualNewVal, td);
    }

    function cancelEdit() {
      // Re-render the original value
      const val = td.dataset.origVal === '\x00NULL\x00' ? null : td.dataset.origVal;
      if (val === null) {
        td.innerHTML = '<span class="db-null">NULL</span>';
      } else {
        td.textContent = String(val).length > 120 ? String(val).slice(0, 120) + '...' : String(val);
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });

    input.addEventListener('blur', () => {
      // Small delay to allow click events to fire first
      setTimeout(() => {
        if (td.querySelector('input') === input) commit();
      }, 50);
    });
  }

  async function updateCell(row, col, newVal, td) {
    if (!sourceTable) return;
    const { schema, table, pkColumns } = sourceTable;

    // Build WHERE clause from PK columns
    const whereParts = pkColumns.map(pk => `"${pk}" = ${pgLiteral(row[pk])}`);
    const sql = `UPDATE "${schema}"."${table}" SET "${col}" = ${pgLiteral(newVal)} WHERE ${whereParts.join(' AND ')};`;

    showToast(sql, 'info');

    const result = await executeQuery(sql, { writeMode: true, silent: true });
    if (result) {
      // Re-run the original query to refresh data
      await executeQuery(lastSQL);
    } else {
      showToast('Update failed', 'error');
      // Restore the cell
      if (td) {
        const val = td.dataset.origVal === '\x00NULL\x00' ? null : td.dataset.origVal;
        if (val === null) td.innerHTML = '<span class="db-null">NULL</span>';
        else td.textContent = String(val);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Add Row
  // ---------------------------------------------------------------------------
  addRowBtn.addEventListener('click', () => {
    if (!sourceTable || !lastResult) return;
    const { columns } = lastResult;
    const tableEl = resultsWrap.querySelector('.db-results-table');
    if (!tableEl) return;
    const tbody = tableEl.querySelector('tbody');

    const tr = document.createElement('tr');
    tr.className = 'db-add-row-tr';

    // Actions cell with save/cancel
    if (sourceTable && writeModeCheck.checked) {
      const tdAct = document.createElement('td');
      tdAct.className = 'db-cell-actions';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'db-row-save-btn';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => saveNewRow(tr, columns));
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'db-row-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => tr.remove());
      tdAct.appendChild(saveBtn);
      tdAct.appendChild(cancelBtn);
      tr.appendChild(tdAct);
    }

    for (const col of columns) {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'db-cell-edit-input';
      input.placeholder = col;
      input.dataset.col = col;
      td.appendChild(input);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
    // Focus first input
    const firstInput = tr.querySelector('input');
    if (firstInput) firstInput.focus();
  });

  async function saveNewRow(tr, columns) {
    if (!sourceTable) return;
    const { schema, table } = sourceTable;

    const values = {};
    const inputs = tr.querySelectorAll('input[data-col]');
    for (const input of inputs) {
      const col = input.dataset.col;
      const val = input.value;
      if (val !== '') values[col] = val;
    }

    const cols = Object.keys(values);
    if (cols.length === 0) {
      showToast('No values entered', 'error');
      return;
    }

    const colList = cols.map(c => `"${c}"`).join(', ');
    const valList = cols.map(c => pgLiteral(values[c])).join(', ');
    const sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${valList});`;

    showToast(sql, 'info');

    const result = await executeQuery(sql, { writeMode: true, silent: true });
    if (result) {
      await executeQuery(lastSQL);
    } else {
      showToast('Insert failed', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Delete Row
  // ---------------------------------------------------------------------------
  async function deleteRow(row) {
    if (!sourceTable) return;
    const { schema, table, pkColumns } = sourceTable;

    const pkDesc = pkColumns.map(pk => `${pk}=${row[pk]}`).join(', ');
    if (!confirm(`Delete row where ${pkDesc}?`)) return;

    const whereParts = pkColumns.map(pk => `"${pk}" = ${pgLiteral(row[pk])}`);
    const sql = `DELETE FROM "${schema}"."${table}" WHERE ${whereParts.join(' AND ')};`;

    showToast(sql, 'info');

    const result = await executeQuery(sql, { writeMode: true, silent: true });
    if (result) {
      await executeQuery(lastSQL);
    } else {
      showToast('Delete failed', 'error');
    }
  }

  function sortRows(rows, colName, asc) {
    return [...rows].sort((a, b) => {
      const va = a[colName], vb = b[colName];
      if (va === null || va === undefined) return asc ? 1 : -1;
      if (vb === null || vb === undefined) return asc ? -1 : 1;
      if (typeof va === 'number' && typeof vb === 'number') return asc ? va - vb : vb - va;
      return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }

  // ---------------------------------------------------------------------------
  // Export CSV
  // ---------------------------------------------------------------------------
  exportBtn.addEventListener('click', () => {
    if (!lastResult || !lastResult.columns) return;
    const { columns, rows } = lastResult;
    const csvRows = [columns.map(c => `"${c.replace(/"/g, '""')}"`).join(',')];
    for (const row of rows) {
      csvRows.push(columns.map(c => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `"${s.replace(/"/g, '""')}"`;
      }).join(','));
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `query-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]'); } catch { return []; }
  }

  function addHistory(sql, time, rowCount) {
    const history = getHistory();
    history.unshift({ sql, time, rowCount, ts: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));
  }

  function renderHistory() {
    const history = getHistory();
    historyList.innerHTML = '';
    if (history.length === 0) {
      historyList.innerHTML = '<div class="db-history-empty">No queries yet</div>';
      return;
    }
    for (const entry of history) {
      const item = document.createElement('div');
      item.className = 'db-history-item';
      const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const preview = entry.sql.length > 80 ? entry.sql.slice(0, 80) + '...' : entry.sql;
      item.innerHTML = `<div class="db-history-meta">
        <span class="db-history-time">${time}</span>
        <span class="db-history-stats">${entry.time}ms / ${entry.rowCount ?? '?'} rows</span>
      </div>
      <div class="db-history-sql">${esc(preview)}</div>`;
      item.addEventListener('click', () => {
        editor.value = entry.sql;
        localStorage.setItem(STORAGE_KEY_SQL, entry.sql);
        // Switch back to schema tab
        document.querySelectorAll('.db-sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.db-sidebar-tab[data-dbsidebar="schema"]').classList.add('active');
        document.getElementById('db-sidebar-schema').style.display = '';
        document.getElementById('db-sidebar-history').style.display = 'none';
        editor.focus();
      });
      historyList.appendChild(item);
    }
  }

  // ---------------------------------------------------------------------------
  // Resizers
  // ---------------------------------------------------------------------------
  // Sidebar resizer (horizontal)
  initResizer(
    document.getElementById('db-sidebar-resizer'),
    document.getElementById('db-sidebar'),
    'horizontal',
    180, 500
  );

  // Editor/Results divider (vertical)
  initResizer(
    document.getElementById('db-divider'),
    document.getElementById('db-editor-panel'),
    'vertical',
    80, 600
  );

  function initResizer(handle, target, direction, min, max) {
    if (!handle || !target) return;
    let startPos, startSize;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      startPos = direction === 'horizontal' ? e.clientX : e.clientY;
      startSize = direction === 'horizontal' ? target.offsetWidth : target.offsetHeight;

      function onMove(ev) {
        const delta = (direction === 'horizontal' ? ev.clientX : ev.clientY) - startPos;
        const newSize = Math.min(max, Math.max(min, startSize + delta));
        if (direction === 'horizontal') {
          target.style.width = newSize + 'px';
        } else {
          target.style.height = newSize + 'px';
        }
      }

      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Scripts browser
  // ---------------------------------------------------------------------------
  const scriptsTree = document.getElementById('db-scripts-tree');
  const scriptsNewFileBtn = document.getElementById('db-scripts-new-file');
  const scriptsNewFolderBtn = document.getElementById('db-scripts-new-folder');
  const scriptBreadcrumb = document.getElementById('db-script-breadcrumb');
  const STORAGE_KEY_SCRIPTS_EXP = 'db-scripts-expanded';
  const STORAGE_KEY_ACTIVE_SCRIPT = 'db-active-script';

  let activeScriptPath = localStorage.getItem(STORAGE_KEY_ACTIVE_SCRIPT) || null;
  let scriptsExpanded = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY_SCRIPTS_EXP) || '[]'));

  // Seed the active tab with the restored activeScriptPath (loaded from localStorage)
  const _initTab = dbTabs.find(t => t.id === activeDbTabId);
  if (_initTab && activeScriptPath) _initTab.scriptPath = activeScriptPath;

  // Register the tab-switch hook now that scripts variables are initialized
  _onDbTabSwitched = function(tab) {
    // Scripts tree — update highlight + breadcrumb
    activeScriptPath = tab.scriptPath || null;
    localStorage.setItem(STORAGE_KEY_ACTIVE_SCRIPT, activeScriptPath || '');
    scriptBreadcrumb.textContent = activeScriptPath || '';
    scriptBreadcrumb.title = activeScriptPath || '';
    if (activeScriptPath) {
      const parts = activeScriptPath.split('/');
      for (let i = 1; i < parts.length; i++) scriptsExpanded.add(parts.slice(0, i).join('/'));
      saveScriptsExpanded();
      loadScripts().then(() => scrollToActive('#db-scripts-tree .db-script-item.active', 'db-scripts-tree'));
    } else {
      loadScripts();
    }

    // Schema tree — highlight + scroll to active table
    tree.querySelectorAll('.db-tree-table-item').forEach(el => el.classList.remove('active'));
    if (tab.tableSource) {
      const { schema, table } = tab.tableSource;
      const tableEl = tree.querySelector(`.db-tree-table-item[data-schema="${schema}"][data-table="${table}"]`);
      if (tableEl) {
        tableEl.classList.add('active');
        scrollToActive('.db-tree-table-item.active', 'db-tree');
      }
    }
  };

  function saveScriptsExpanded() {
    localStorage.setItem(STORAGE_KEY_SCRIPTS_EXP, JSON.stringify([...scriptsExpanded]));
  }

  async function loadScripts() {
    try {
      const res = await fetch('/api/db/scripts/tree');
      const tree = await res.json();
      renderScriptsTree(tree);
    } catch {
      scriptsTree.innerHTML = '<div style="padding:8px;color:var(--overlay0);font-size:11px">No scripts</div>';
    }
  }

  function renderScriptsTree(items, depth = 0) {
    if (depth === 0) scriptsTree.innerHTML = '';
    const container = depth === 0 ? scriptsTree : document.createDocumentFragment();

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'db-script-item' + (item.type === 'file' && item.path === activeScriptPath ? ' active' : '');
      el.style.paddingLeft = (12 + depth * 16) + 'px';

      if (item.type === 'dir') {
        const isOpen = scriptsExpanded.has(item.path);
        el.innerHTML = `<span class="db-script-arrow ${isOpen ? 'open' : ''}">\u25B6</span><span class="db-script-icon">\uD83D\uDCC1</span><span class="db-script-name">${esc(item.name)}</span>`;

        el.addEventListener('click', (e) => {
          if (el.classList.contains('db-script-dragging')) return;
          e.stopPropagation();
          if (scriptsExpanded.has(item.path)) scriptsExpanded.delete(item.path);
          else scriptsExpanded.add(item.path);
          saveScriptsExpanded();
          loadScripts();
        });

        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showScriptsContextMenu(e.clientX, e.clientY, item);
        });

        attachScriptDragEvents(el, item);
        container.appendChild(el);

        if (isOpen && item.children) {
          const childContainer = document.createElement('div');
          childContainer.className = 'db-scripts-children';
          const childFrag = document.createDocumentFragment();
          renderScriptsTreeItems(item.children, depth + 1, childFrag);
          childContainer.appendChild(childFrag);
          container.appendChild(childContainer);
        }
      } else {
        el.innerHTML = `<span class="db-script-arrow" style="visibility:hidden">\u25B6</span><span class="db-script-icon" style="color:var(--blue)">\uD83D\uDCC4</span><span class="db-script-name">${esc(item.name)}</span>`;

        el.addEventListener('click', () => { if (!el.classList.contains('db-script-dragging')) openScript(item.path); });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showScriptsContextMenu(e.clientX, e.clientY, item);
        });

        attachScriptDragEvents(el, item);
        container.appendChild(el);
      }
    }

    if (depth === 0 && items.length === 0) {
      scriptsTree.innerHTML = '<div style="padding:8px;color:var(--overlay0);font-size:11px">No scripts yet</div>';
    }
  }

  function renderScriptsTreeItems(items, depth, container) {
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'db-script-item' + (item.type === 'file' && item.path === activeScriptPath ? ' active' : '');
      el.style.paddingLeft = (12 + depth * 16) + 'px';

      if (item.type === 'dir') {
        const isOpen = scriptsExpanded.has(item.path);
        el.innerHTML = `<span class="db-script-arrow ${isOpen ? 'open' : ''}">\u25B6</span><span class="db-script-icon">\uD83D\uDCC1</span><span class="db-script-name">${esc(item.name)}</span>`;

        el.addEventListener('click', (e) => {
          if (el.classList.contains('db-script-dragging')) return;
          e.stopPropagation();
          if (scriptsExpanded.has(item.path)) scriptsExpanded.delete(item.path);
          else scriptsExpanded.add(item.path);
          saveScriptsExpanded();
          loadScripts();
        });

        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showScriptsContextMenu(e.clientX, e.clientY, item);
        });

        attachScriptDragEvents(el, item);
        container.appendChild(el);

        if (isOpen && item.children) {
          renderScriptsTreeItems(item.children, depth + 1, container);
        }
      } else {
        el.innerHTML = `<span class="db-script-arrow" style="visibility:hidden">\u25B6</span><span class="db-script-icon" style="color:var(--blue)">\uD83D\uDCC4</span><span class="db-script-name">${esc(item.name)}</span>`;

        el.addEventListener('click', () => { if (!el.classList.contains('db-script-dragging')) openScript(item.path); });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showScriptsContextMenu(e.clientX, e.clientY, item);
        });

        attachScriptDragEvents(el, item);
        container.appendChild(el);
      }
    }
  }

  async function openScript(path) {
    try {
      // Reuse existing tab if this script is already open
      const existing = dbTabs.find(t => t.scriptPath === path);
      if (existing) { switchDbTab(existing.id); editor.focus(); return; }

      const res = await fetch('/api/db/scripts/file?path=' + encodeURIComponent(path));
      if (!res.ok) throw new Error('Failed to load script');
      const data = await res.json();
      const label = path.split('/').pop();
      newDbTab(label, data.content, { scriptPath: path });
      editor.focus();
    } catch (err) {
      showToast('Failed to load script: ' + err.message, 'error');
    }
  }

  // Expose globally so app.js can trigger reveal on tab switch
  window.revealActiveScriptInTree = function() {
    if (!activeScriptPath) return;
    // Expand every ancestor folder in the path
    const parts = activeScriptPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      scriptsExpanded.add(parts.slice(0, i).join('/'));
    }
    saveScriptsExpanded();
    loadScripts().then(() => {
      scrollToActive('#db-scripts-tree .db-script-item.active', 'db-scripts-tree');
    });
  };

  async function saveActiveScript() {
    if (!activeScriptPath) return;
    try {
      const res = await fetch('/api/db/scripts/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: activeScriptPath, content: editor.value }),
      });
      if (!res.ok) throw new Error('Save failed');
      showToast('Saved ' + activeScriptPath, 'info');
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    }
  }

  // Ctrl+S to save active script
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      if (activeScriptPath) {
        e.preventDefault();
        saveActiveScript();
      }
    }
  });

  // New script
  scriptsNewFileBtn.addEventListener('click', async () => {
    const name = prompt('Script name (e.g. my-query.sql):');
    if (!name) return;
    const safeName = name.endsWith('.sql') ? name : name + '.sql';
    try {
      const res = await fetch('/api/db/scripts/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: safeName, content: '-- ' + safeName + '\n' }),
      });
      if (!res.ok) throw new Error('Create failed');
      await loadScripts();
      openScript(safeName);
    } catch (err) {
      showToast('Failed to create script: ' + err.message, 'error');
    }
  });

  // New folder
  scriptsNewFolderBtn.addEventListener('click', async () => {
    const name = prompt('Folder name:');
    if (!name) return;
    try {
      const res = await fetch('/api/db/scripts/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: name }),
      });
      if (!res.ok) throw new Error('Create failed');
      scriptsExpanded.add(name);
      saveScriptsExpanded();
      await loadScripts();
    } catch (err) {
      showToast('Failed to create folder: ' + err.message, 'error');
    }
  });

  // Import zip
  const scriptsImportBtn = document.getElementById('db-scripts-import-zip');
  const scriptsZipInput = document.getElementById('db-scripts-zip-input');

  scriptsImportBtn.addEventListener('click', () => scriptsZipInput.click());

  scriptsZipInput.addEventListener('change', async () => {
    const file = scriptsZipInput.files[0];
    if (!file) return;
    scriptsZipInput.value = ''; // reset for re-upload

    try {
      showToast('Importing scripts...', 'info');
      const res = await fetch('/api/db/scripts/import-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      showToast(`Imported ${data.imported} script(s)`, 'success');
      await loadScripts();
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
  });

  // Context menu
  let scriptsCtxMenu = null;

  function showScriptsContextMenu(x, y, item) {
    hideScriptsContextMenu();
    const menu = document.createElement('div');
    menu.className = 'db-scripts-ctx-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'db-scripts-ctx-item';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => {
      hideScriptsContextMenu();
      renameScriptItem(item);
    });
    menu.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'db-scripts-ctx-item danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      hideScriptsContextMenu();
      deleteScriptItem(item);
    });
    menu.appendChild(deleteBtn);

    document.body.appendChild(menu);
    scriptsCtxMenu = menu;

    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', hideScriptsContextMenu, { once: true });
    }, 0);
  }

  function hideScriptsContextMenu() {
    if (scriptsCtxMenu) {
      scriptsCtxMenu.remove();
      scriptsCtxMenu = null;
    }
  }

  async function renameScriptItem(item) {
    const newName = prompt('New name:', item.name);
    if (!newName || newName === item.name) return;

    const parentDir = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : '';
    const newPath = parentDir ? parentDir + '/' + newName : newName;

    try {
      const res = await fetch('/api/db/scripts/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: item.path, newPath }),
      });
      if (!res.ok) throw new Error('Rename failed');
      if (activeScriptPath === item.path) {
        activeScriptPath = newPath;
        scriptBreadcrumb.textContent = newPath;
      }
      await loadScripts();
    } catch (err) {
      showToast('Rename failed: ' + err.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop move for script tree items
  // ---------------------------------------------------------------------------
  let _dragSrcPath = null;
  let _dragSrcType = null;

  async function moveScriptItem(srcPath, targetFolderPath) {
    const name = srcPath.split('/').pop();
    const newPath = targetFolderPath ? targetFolderPath + '/' + name : name;
    if (newPath === srcPath) return;
    // Guard: don't drop a folder into itself or a descendant
    if (_dragSrcType === 'dir' && (newPath === srcPath || newPath.startsWith(srcPath + '/'))) return;
    try {
      const res = await fetch('/api/db/scripts/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: srcPath, newPath }),
      });
      if (!res.ok) throw new Error('Move failed');
      // Update active path if the moved file was open
      if (activeScriptPath === srcPath) {
        activeScriptPath = newPath;
        scriptBreadcrumb.textContent = newPath;
        localStorage.setItem(STORAGE_KEY_ACTIVE_SCRIPT, newPath);
      } else if (activeScriptPath && activeScriptPath.startsWith(srcPath + '/')) {
        const updated = newPath + activeScriptPath.slice(srcPath.length);
        activeScriptPath = updated;
        scriptBreadcrumb.textContent = updated;
        localStorage.setItem(STORAGE_KEY_ACTIVE_SCRIPT, updated);
      }
      // Expand the destination folder so the moved item is visible
      if (targetFolderPath) {
        scriptsExpanded.add(targetFolderPath);
        saveScriptsExpanded();
      }
      await loadScripts();
    } catch (err) {
      showToast('Move failed: ' + err.message, 'error');
    }
  }

  function attachScriptDragEvents(el, item) {
    el.draggable = true;
    el.dataset.scriptPath = item.path;
    el.dataset.scriptType = item.type;

    el.addEventListener('dragstart', (e) => {
      _dragSrcPath = item.path;
      _dragSrcType = item.type;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.path);
      el.classList.add('db-script-dragging');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('db-script-dragging');
      scriptsTree.querySelectorAll('.db-script-drag-over').forEach(x => x.classList.remove('db-script-drag-over'));
      scriptsTree.classList.remove('db-script-drag-over');
    });

    // Only folders (and the root container) accept drops
    if (item.type === 'dir') {
      el.addEventListener('dragover', (e) => {
        if (!_dragSrcPath || _dragSrcPath === item.path) return;
        // Prevent dropping into own descendant
        if (_dragSrcType === 'dir' && item.path.startsWith(_dragSrcPath + '/')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        scriptsTree.querySelectorAll('.db-script-drag-over').forEach(x => x.classList.remove('db-script-drag-over'));
        scriptsTree.classList.remove('db-script-drag-over');
        el.classList.add('db-script-drag-over');
      });

      el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget)) el.classList.remove('db-script-drag-over');
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('db-script-drag-over');
        if (_dragSrcPath && _dragSrcPath !== item.path) moveScriptItem(_dragSrcPath, item.path);
        _dragSrcPath = null;
      });
    }
  }

  // Root drop — moves item to top level
  scriptsTree.addEventListener('dragover', (e) => {
    if (!_dragSrcPath) return;
    // Only show root drop when not hovering a folder item
    if (e.target.closest('.db-script-item[data-script-type="dir"]')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    scriptsTree.querySelectorAll('.db-script-drag-over').forEach(x => x.classList.remove('db-script-drag-over'));
    scriptsTree.classList.add('db-script-drag-over');
  });

  scriptsTree.addEventListener('dragleave', (e) => {
    if (!scriptsTree.contains(e.relatedTarget)) scriptsTree.classList.remove('db-script-drag-over');
  });

  scriptsTree.addEventListener('drop', (e) => {
    if (e.target.closest('.db-script-item[data-script-type="dir"]')) return;
    e.preventDefault();
    scriptsTree.classList.remove('db-script-drag-over');
    if (_dragSrcPath) moveScriptItem(_dragSrcPath, '');
    _dragSrcPath = null;
  });

  async function deleteScriptItem(item) {
    const label = item.type === 'dir' ? 'folder' : 'script';
    if (!confirm(`Delete ${label} "${item.name}"?`)) return;

    try {
      const res = await fetch('/api/db/scripts/file?path=' + encodeURIComponent(item.path), { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      if (activeScriptPath === item.path) {
        activeScriptPath = null;
        scriptBreadcrumb.textContent = '';
      }
      await loadScripts();
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }

  // Scripts pane resizer (vertical — schema top, scripts bottom)
  {
    const handle = document.getElementById('db-scripts-resizer');
    const schemaPane = document.getElementById('db-schema-pane');
    if (handle && schemaPane) {
      let startY, startH;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        handle.classList.add('dragging');
        startY = e.clientY;
        startH = schemaPane.offsetHeight;
        function onMove(ev) {
          const delta = ev.clientY - startY;
          const newH = Math.max(80, startH + delta);
          schemaPane.style.flex = 'none';
          schemaPane.style.height = newH + 'px';
        }
        function onUp() {
          handle.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  loadConnections().then(() => {
    checkStatus();
    loadSchema();
    loadScripts();
  });
}
