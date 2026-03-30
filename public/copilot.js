/* ==========================================================================
   Copilot Chat — GitHub Models API, VS Code Copilot panel emulation
   ========================================================================== */

(function () {
  const STORAGE_CONV   = 'copilot-conversation-v1';
  const STORAGE_MODEL  = 'copilot-model';
  const DEFAULT_MODEL  = 'gpt-4o';

  let messages       = [];     // full conversation history sent to API
  let displayMsgs    = [];     // parallel array: {role, contentHtml, rawText}
  let currentModel   = localStorage.getItem(STORAGE_MODEL) || DEFAULT_MODEL;
  let allModels      = [];
  let isStreaming    = false;
  let abortCtrl      = null;
  let attachments    = [];     // [{id, label, content}]
  let lastSentText   = '';     // for Up-arrow recall

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  async function initCopilot() {
    initPanel();
    await loadStatus();
    restoreConversation();
    wireEvents();
    renderMessages();
  }
  window.initCopilot = initCopilot;

  // ---------------------------------------------------------------------------
  // Panel: resize + collapse toggle
  // ---------------------------------------------------------------------------
  function initPanel() {
    const panel       = document.getElementById('copilot-panel');
    const handle      = document.getElementById('copilot-resize-handle');
    const toggleBtn   = document.getElementById('copilot-toggle-btn');
    const logoBtn     = document.getElementById('copilot-logo-btn');
    if (!panel) return;

    const STORAGE_WIDTH     = 'copilot-panel-width';
    const STORAGE_COLLAPSED = 'copilot-panel-collapsed';
    const MIN_WIDTH = 350;

    function syncToggleBtn(collapsed) {
      toggleBtn?.classList.toggle('active', !collapsed);
    }

    function setCollapsed(collapsed) {
      panel.classList.toggle('collapsed', collapsed);
      localStorage.setItem(STORAGE_COLLAPSED, collapsed);
      syncToggleBtn(collapsed);
    }

    // Restore saved state
    const savedWidth = parseInt(localStorage.getItem(STORAGE_WIDTH), 10);
    if (savedWidth >= MIN_WIDTH) panel.style.width = savedWidth + 'px';
    else panel.style.width = '400px';
    const startCollapsed = localStorage.getItem(STORAGE_COLLAPSED) === 'true';
    setCollapsed(startCollapsed);

    // Header toggle button and logo both toggle collapse
    toggleBtn?.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
    logoBtn?.addEventListener('click', () => setCollapsed(true));

    // Resize by dragging
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    handle?.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = startX - e.clientX;
      const newWidth = startWidth + delta;
      if (newWidth < MIN_WIDTH) {
        // Snap to collapsed as soon as we go below min
        panel.style.width = MIN_WIDTH + 'px';
        setCollapsed(true);
      } else {
        panel.style.width = Math.min(800, newWidth) + 'px';
        setCollapsed(false);
      }
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!panel.classList.contains('collapsed')) {
        localStorage.setItem(STORAGE_WIDTH, panel.offsetWidth);
      }
    });
  }

  async function loadStatus() {
    try {
      const resp = await fetch('/api/copilot/status');
      const { configured, models } = await resp.json();
      allModels = models || [];
      renderModelSelect();
      if (!configured) showUnconfigured();
    } catch {
      allModels = [];
      renderModelSelect();
    }
  }

  function showUnconfigured() {
    const msgs = document.getElementById('copilot-messages');
    if (!msgs) return;
    msgs.innerHTML = `
      <div class="copilot-setup">
        <svg width="32" height="32" viewBox="0 0 16 16" fill="var(--subtext0)"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        <p class="copilot-setup-title">GitHub token not configured</p>
        <p class="copilot-setup-body">Add your GitHub Personal Access Token to <code>.env</code>:</p>
        <pre class="copilot-setup-code">GITHUB_TOKEN=ghp_your_token_here</pre>
        <p class="copilot-setup-body" style="font-size:11px;color:var(--overlay0)">
          A classic PAT with no extra scopes is enough for GitHub Models.<br>
          Restart the dashboard after adding it.
        </p>
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Model selector
  // ---------------------------------------------------------------------------
  function renderModelSelect() {
    const sel = document.getElementById('copilot-model-select');
    if (!sel) return;
    sel.innerHTML = '';

    // Group models
    const groups = {};
    for (const m of allModels) {
      if (!groups[m.group]) groups[m.group] = [];
      groups[m.group].push(m);
    }

    for (const [group, models] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = group;
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        opt.selected = m.id === currentModel;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }

    // If saved model not in list, default to first
    if (!allModels.find(m => m.id === currentModel) && allModels.length) {
      currentModel = allModels[0].id;
      sel.value = currentModel;
    }

  }

  // ---------------------------------------------------------------------------
  // Conversation persistence
  // ---------------------------------------------------------------------------
  function saveConversation() {
    try {
      localStorage.setItem(STORAGE_CONV, JSON.stringify({ messages, displayMsgs }));
    } catch { /* storage full */ }
  }

  function restoreConversation() {
    try {
      const saved = localStorage.getItem(STORAGE_CONV);
      if (!saved) return;
      const { messages: m, displayMsgs: d } = JSON.parse(saved);
      messages = m || [];
      displayMsgs = d || [];
    } catch {
      messages = [];
      displayMsgs = [];
    }
  }

  function newChat() {
    if (isStreaming) stopStreaming();
    messages = [];
    displayMsgs = [];
    attachments = [];
    saveConversation();
    renderMessages();
    renderAttachments();
    document.getElementById('copilot-input')?.focus();
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------
  async function attachFile() {
    // Read the currently open file from the Repo viewer
    const tabs = repoTabs;
    const activeIdx = activeRepoTab;
    if (!tabs || activeIdx == null || activeIdx < 0 || !tabs[activeIdx]) {
      showToast('No file open in Repo viewer', 'error');
      return;
    }
    const tab = tabs[activeIdx];
    const content = tab.model ? tab.model.getValue() : tab.content;
    if (!content) { showToast('File is empty', 'error'); return; }

    const id = 'file-' + Date.now();
    const label = tab.path.split('/').pop();
    const lines = content.split('\n').length;
    const preview = content.length > 8000 ? content.slice(0, 8000) + '\n…(truncated)' : content;

    attachments.push({
      id, label,
      content: `\`\`\`${getExt(tab.path)}\n// ${tab.repo}/${tab.path}\n${preview}\n\`\`\``,
    });
    renderAttachments();
  }

  async function attachGit() {
    try {
      const reposResp = await fetch('/api/repo/list');
      if (!reposResp.ok) throw new Error('Failed to fetch repo list');
      const allRepos = await reposResp.json();
      const hiddenRepos = typeof getHiddenRepos === 'function' ? getHiddenRepos() : new Set();
      const repos = allRepos.filter(r => !hiddenRepos.has(r));

      const results = await Promise.all(
        repos.map(repo =>
          fetch(`/api/repos/${encodeURIComponent(repo)}/changed-files`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      );

      const lines = [];
      for (const data of results) {
        if (!data || !data.files?.length) continue;
        lines.push(`**${data.repo}** (${data.branch}):`);
        for (const f of data.files.slice(0, 20)) {
          lines.push(`  ${f.status.padEnd(2)} ${f.file}`);
        }
      }
      if (!lines.length) { showToast('No uncommitted changes found', 'info'); return; }
      const id = 'git-' + Date.now();
      attachments.push({ id, label: 'Git status', content: lines.join('\n') });
      renderAttachments();
    } catch (err) {
      showToast('Failed to fetch git status', 'error');
    }
  }

  function attachDocs() {
    const tabs = typeof docTabs !== 'undefined' ? docTabs : [];
    const open = tabs.filter(t => t && (t.raw || t.content));
    if (!open.length) { showToast('No docs open in Docs viewer', 'error'); return; }

    const parts = open.map(t => {
      const text = (t.raw || t.content || '').trim();
      const preview = text.length > 6000 ? text.slice(0, 6000) + '\n…(truncated)' : text;
      return `### ${t.path}\n${preview}`;
    });

    const id = 'docs-' + Date.now();
    const label = open.length === 1
      ? open[0].path.split('/').pop()
      : `Docs (${open.length} open)`;
    attachments.push({ id, label, content: parts.join('\n\n---\n\n') });
    renderAttachments();
  }

  async function attachDb() {
    const query = document.getElementById('db-editor')?.value?.trim();
    const connId = document.getElementById('db-conn-select')?.value
                || localStorage.getItem('db-selected-connection')
                || '';

    // Fetch schema
    let schemaText = '';
    try {
      const url = '/api/db/schema' + (connId ? `?connectionId=${encodeURIComponent(connId)}` : '');
      const resp = await fetch(url);
      if (resp.ok) {
        const schemas = await resp.json();
        const lines = [];
        let tableCount = 0;
        const SCHEMA_CHAR_LIMIT = 10000;
        let schemaChars = 0;
        outer: for (const [schemaName, groups] of Object.entries(schemas)) {
          const allTables = [...(groups.tables || []), ...(groups.views || [])];
          for (const t of allTables) {
            const cols = (t.columns || []).map(c => {
              let desc = `${c.name} ${c.type}`;
              if (c.isPk) desc += ' PK';
              if (c.fk) desc += ` FK→${c.fk.refTable}.${c.fk.refColumn}`;
              if (!c.nullable) desc += ' NOT NULL';
              return desc;
            }).join(', ');
            const tag = t.type === 'view' ? 'VIEW' : t.type === 'matview' ? 'MATVIEW' : 'TABLE';
            const line = `${schemaName}.${t.name} [${tag}] (${cols})`;
            schemaChars += line.length + 1;
            if (schemaChars > SCHEMA_CHAR_LIMIT) { lines.push(`…(${Object.values(schemas).flatMap(g => [...(g.tables||[]),...(g.views||[])]).length - tableCount} more tables truncated)`); break outer; }
            lines.push(line);
            tableCount++;
          }
        }
        schemaText = lines.join('\n');
      }
    } catch { /* schema unavailable */ }

    const parts = [];
    if (query) parts.push(`**Current query:**\n\`\`\`sql\n${query}\n\`\`\``);
    if (schemaText) parts.push(`**Database schema:**\n\`\`\`\n${schemaText}\n\`\`\``);

    if (!parts.length) { showToast('No DB query or schema available', 'error'); return; }

    const id = 'db-' + Date.now();
    const label = query ? 'DB query + schema' : 'DB schema';
    attachments.push({ id, label, content: parts.join('\n\n') });
    renderAttachments();
  }

  async function attachEndpoint() {
    const method  = document.getElementById('api-method')?.value || '';
    const url     = document.getElementById('api-url')?.value?.trim() || '';

    if (!method && !url) { showToast('No endpoint open in API client', 'error'); return; }

    const parts = [`**Endpoint:** \`${method} ${url}\``];

    // Enabled headers (skip internal/empty)
    const hdrs = (typeof headersRows !== 'undefined' ? headersRows : [])
      .filter(r => r.enabled && r.key)
      .map(r => `  ${r.key}: ${r.value}`);
    if (hdrs.length) parts.push(`**Request headers:**\n${hdrs.join('\n')}`);

    // Body
    const mode = typeof bodyMode !== 'undefined' ? bodyMode : 'none';
    const body = typeof bodyContent !== 'undefined' ? bodyContent : '';
    if (mode !== 'none' && body) {
      const lang = mode === 'json' ? 'json' : mode === 'xml' ? 'xml' : '';
      parts.push(`**Request body (${mode}):**\n\`\`\`${lang}\n${body.slice(0, 4000)}${body.length > 4000 ? '\n…(truncated)' : ''}\n\`\`\``);
    }

    // Last response
    const resp = typeof currentResponse !== 'undefined' ? currentResponse : null;
    if (resp) {
      parts.push(`**Last response:** \`${resp.status}\` (${resp.time ?? '?'}ms, ${resp.size ?? '?'} bytes)`);
      if (resp.body) {
        const preview = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body, null, 2);
        const ct = (resp.headers?.['content-type'] || '');
        const lang = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : '';
        parts.push(`**Response body:**\n\`\`\`${lang}\n${preview.slice(0, 4000)}${preview.length > 4000 ? '\n…(truncated)' : ''}\n\`\`\``);
      }
    }

    const id = 'endpoint-' + Date.now();
    const label = `${method} ${url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40) || url}`;
    attachments.push({ id, label, content: parts.join('\n\n') });
    renderAttachments();
  }

  async function attachSentry() {
    try {
      const projects = (window.DASH_CONFIG?.sentryProjects) || [];
      if (!projects.length) { showToast('No Sentry projects configured', 'error'); return; }
      const lines = ['**Recent Sentry Issues:**'];
      for (const proj of projects) {
        const resp = await fetch(`/api/sentry/issues?project=${encodeURIComponent(proj)}`);
        if (!resp.ok) continue;
        const issues = await resp.json();
        for (const i of issues.slice(0, 10)) {
          lines.push(`- [${i.shortId}] ${i.level.toUpperCase()}: ${i.title} (${i.count}x, ${relTime(i.lastSeen)})`);
        }
      }
      if (lines.length <= 1) { showToast('No unresolved Sentry issues', 'info'); return; }
      const id = 'sentry-' + Date.now();
      attachments.push({ id, label: `Sentry (${lines.length - 1})`, content: lines.join('\n') });
      renderAttachments();
    } catch (err) {
      showToast('Failed to fetch Sentry issues', 'error');
    }
  }

  function removeAttachment(id) {
    attachments = attachments.filter(a => a.id !== id);
    renderAttachments();
  }

  function renderAttachments() {
    const wrap = document.getElementById('copilot-attachments');
    if (!wrap) return;
    if (!attachments.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    else {
      wrap.style.display = 'flex';
      wrap.innerHTML = '';
      for (const att of attachments) {
        const chip = document.createElement('div');
        chip.className = 'copilot-att-chip';
        chip.innerHTML = `<span class="copilot-att-label">${esc(att.label)}</span><button class="copilot-att-remove" data-id="${esc(att.id)}">&times;</button>`;
        chip.querySelector('button').addEventListener('click', () => removeAttachment(att.id));
        wrap.appendChild(chip);
      }
    }

    // Update per-button count badges
    const typeCounts = {};
    for (const att of attachments) {
      const type = att.id.replace(/-\d+$/, ''); // e.g. 'file', 'git', 'docs'
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }
    const btnMap = {
      file: 'copilot-attach-file', git: 'copilot-attach-git',
      docs: 'copilot-attach-docs', sentry: 'copilot-attach-sentry',
      endpoint: 'copilot-attach-endpoint', db: 'copilot-attach-db',
    };
    for (const [type, btnId] of Object.entries(btnMap)) {
      const btn = document.getElementById(btnId);
      if (!btn) continue;
      let badge = btn.querySelector('.copilot-btn-badge');
      const count = typeCounts[type] || 0;
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'copilot-btn-badge';
          btn.appendChild(badge);
        }
        badge.textContent = count;
      } else if (badge) {
        badge.remove();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Send message + stream response
  // ---------------------------------------------------------------------------
  async function sendMessage() {
    const input = document.getElementById('copilot-input');
    const userText = input?.value.trim();
    if (!userText || isStreaming) return;

    input.value = '';
    autoResizeTextarea(input);

    lastSentText = userText;

    // Build user content — inline attachments as context block before the question
    let fullContent = userText;
    if (attachments.length) {
      const ctx = attachments.map(a => `**[${a.label}]**\n${a.content}`).join('\n\n---\n\n');
      fullContent = ctx + '\n\n---\n\n' + userText;
      // Don't clear attachments — keep chips visible for follow-up questions
    }

    // System message (sent only once, at conversation start)
    const apiMessages = [...messages];
    if (!apiMessages.length) {
      // Auto-include active Repo viewer file as implicit context (like VS Code Copilot)
      let fileContext = '';
      const repoTab = (typeof repoTabs !== 'undefined' && typeof activeRepoTab !== 'undefined')
        ? repoTabs[activeRepoTab] : null;
      if (repoTab) {
        const content = repoTab.model ? repoTab.model.getValue() : repoTab.content;
        if (content) {
          const preview = content.length > 8000 ? content.slice(0, 8000) + '\n…(truncated)' : content;
          fileContext = `\n\nThe user currently has this file open in the editor:\n\`${repoTab.repo}/${repoTab.path}\`\n\`\`\`${getExt(repoTab.path)}\n${preview}\n\`\`\``;
        }
      }
      apiMessages.unshift({
        role: 'system',
        content: `You are a helpful AI coding assistant embedded in a developer dashboard for the Montra.io platform team. The codebase is split across multiple repos: ${(window.DASH_CONFIG?.repos || []).join(', ') || 'montra-via-api, montra-via-web, montra-via-db'}. Be concise and practical. Format code with markdown fenced code blocks including the language.${fileContext}`,
      });
    }
    apiMessages.push({ role: 'user', content: fullContent });
    messages.push({ role: 'user', content: fullContent });
    displayMsgs.push({ role: 'user', rawText: userText });

    renderMessages();
    scrollToBottom();

    // Placeholder assistant bubble
    const assistantIdx = displayMsgs.length;
    displayMsgs.push({ role: 'assistant', rawText: '', streaming: true });
    messages.push({ role: 'assistant', content: '' });
    renderMessages();
    scrollToBottom();

    isStreaming = true;
    abortCtrl = new AbortController();
    updateSendBtn();

    let accumulated = '';
    let sseBuffer = '';

    try {
      const resp = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, model: currentModel }),
        signal: abortCtrl.signal,
      });

      if (!resp.ok) {
        const { error } = await resp.json().catch(() => ({}));
        throw new Error(error || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              displayMsgs[assistantIdx].rawText = accumulated;
              updateStreamingBubble(assistantIdx, accumulated);
            }
          } catch { /* malformed chunk */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        displayMsgs[assistantIdx].rawText = `*Error: ${err.message}*`;
        displayMsgs[assistantIdx].streaming = false;
      }
    }

    messages[messages.length - 1].content = accumulated;
    displayMsgs[assistantIdx].rawText = accumulated;
    displayMsgs[assistantIdx].streaming = false;
    isStreaming = false;
    abortCtrl = null;
    updateSendBtn();

    // Final render to replace streaming bubble with fully rendered markdown
    renderMessages();
    scrollToBottom();
    saveConversation();
  }

  function stopStreaming() {
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    isStreaming = false;
    updateSendBtn();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderMessages() {
    const container = document.getElementById('copilot-messages');
    if (!container) return;

    if (!displayMsgs.length) {
      container.innerHTML = `
        <div class="copilot-welcome">
          <svg width="40" height="40" viewBox="0 0 16 16" fill="var(--surface2)"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          <p>Ask anything about the codebase.<br>Use <strong>File</strong>, <strong>Git</strong>, or <strong>Sentry</strong> to attach context.</p>
        </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = 0; i < displayMsgs.length; i++) {
      frag.appendChild(buildBubble(displayMsgs[i], i));
    }
    container.innerHTML = '';
    container.appendChild(frag);
  }

  function buildBubble(msg, idx) {
    const wrap = document.createElement('div');
    wrap.className = `copilot-msg copilot-msg-${msg.role}`;
    wrap.dataset.idx = idx;

    const avatar = document.createElement('div');
    avatar.className = 'copilot-avatar';
    avatar.textContent = msg.role === 'user' ? 'Y' : '';
    if (msg.role === 'assistant') {
      avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
    }

    const content = document.createElement('div');
    content.className = 'copilot-msg-content';

    if (msg.role === 'user') {
      content.textContent = msg.rawText;
    } else if (msg.streaming) {
      content.innerHTML = renderMarkdown(msg.rawText) + '<span class="copilot-cursor"></span>';
    } else {
      content.innerHTML = renderMarkdown(msg.rawText || '*No response*');
    }

    wrap.appendChild(avatar);
    wrap.appendChild(content);

    // Add copy buttons to code blocks after insertion
    requestAnimationFrame(() => addCodeBlockCopyBtns(content));

    return wrap;
  }

  function updateStreamingBubble(idx, text) {
    const container = document.getElementById('copilot-messages');
    const el = container?.querySelector(`.copilot-msg[data-idx="${idx}"] .copilot-msg-content`);
    if (!el) return;
    el.innerHTML = renderMarkdown(text) + '<span class="copilot-cursor"></span>';
    addCodeBlockCopyBtns(el);
    scrollToBottom();
  }

  // ---------------------------------------------------------------------------
  // Markdown rendering (uses marked + highlight.js already on page)
  // ---------------------------------------------------------------------------
  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined') return `<pre>${esc(text)}</pre>`;

    try {
      marked.setOptions({
        highlight: (code, lang) => {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return typeof hljs !== 'undefined' ? hljs.highlightAuto(code).value : esc(code);
        },
        breaks: true,
        gfm: true,
      });
      return marked.parse(text);
    } catch {
      return `<pre>${esc(text)}</pre>`;
    }
  }

  function addCodeBlockCopyBtns(container) {
    container.querySelectorAll('pre code').forEach(codeEl => {
      const pre = codeEl.parentElement;
      if (pre.querySelector('.copilot-copy-btn')) return; // already added
      pre.style.position = 'relative';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copilot-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(codeEl.textContent);
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 2000);
        } catch { copyBtn.textContent = 'Failed'; }
      });

      const applyBtn = document.createElement('button');
      applyBtn.className = 'copilot-apply-btn';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', () => {
        if (typeof window.repoApplyCode === 'function') {
          window.repoApplyCode(codeEl.textContent);
          applyBtn.textContent = 'Applied!';
          applyBtn.classList.add('applied');
          setTimeout(() => { applyBtn.textContent = 'Apply'; applyBtn.classList.remove('applied'); }, 2000);
        }
      });

      pre.appendChild(copyBtn);
      pre.appendChild(applyBtn);
    });
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------
  function scrollToBottom() {
    const el = document.getElementById('copilot-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function updateSendBtn() {
    const btn = document.getElementById('copilot-send');
    if (!btn) return;
    if (isStreaming) {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
      btn.title = 'Stop generating';
      btn.classList.add('copilot-send-stop');
    } else {
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
      btn.title = 'Send (Enter)';
      btn.classList.remove('copilot-send-stop');
    }
  }

  function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relTime(d) {
    if (!d) return '';
    const m = Math.floor((Date.now() - new Date(d)) / 60000);
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.floor(m/60) + 'h ago';
    return Math.floor(m/1440) + 'd ago';
  }

  function getExt(path) {
    return path.split('.').pop() || 'text';
  }

  // ---------------------------------------------------------------------------
  // Wire events
  // ---------------------------------------------------------------------------
  function wireEvents() {
    const input  = document.getElementById('copilot-input');
    const send   = document.getElementById('copilot-send');
    const newBtn = document.getElementById('copilot-new-chat');
    const sel    = document.getElementById('copilot-model-select');

    input?.addEventListener('input', () => autoResizeTextarea(input));
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming) stopStreaming();
        else sendMessage();
      }
      if (e.key === 'ArrowUp' && !input.value.trim() && lastSentText) {
        e.preventDefault();
        input.value = lastSentText;
        autoResizeTextarea(input);
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    send?.addEventListener('click', () => {
      if (isStreaming) stopStreaming();
      else sendMessage();
    });
    newBtn?.addEventListener('click', newChat);
    sel?.addEventListener('change', () => {
      currentModel = sel.value;
      localStorage.setItem(STORAGE_MODEL, currentModel);
    });

    document.getElementById('copilot-attach-file')?.addEventListener('click', attachFile);
    document.getElementById('copilot-attach-git')?.addEventListener('click', attachGit);
    document.getElementById('copilot-attach-docs')?.addEventListener('click', attachDocs);
    document.getElementById('copilot-attach-sentry')?.addEventListener('click', attachSentry);
    document.getElementById('copilot-attach-endpoint')?.addEventListener('click', attachEndpoint);
    document.getElementById('copilot-attach-db')?.addEventListener('click', attachDb);
  }
  // Public API: inject selected code from another panel (e.g. Ctrl+I in repo editor)
  window.copilotInjectCode = function(label, content) {
    // Expand panel if collapsed
    const panel = document.getElementById('copilot-panel');
    if (panel?.classList.contains('collapsed')) {
      panel.classList.remove('collapsed');
      localStorage.setItem('copilot-panel-collapsed', 'false');
      document.getElementById('copilot-toggle-btn')?.classList.add('active');
      const savedW = parseInt(localStorage.getItem('copilot-panel-width'), 10);
      if (savedW >= 350) panel.style.width = savedW + 'px';
    }

    // Add as attachment
    attachments.push({ id: 'sel-' + Date.now(), label, content });
    renderAttachments();

    // Focus input so user can type their instruction
    document.getElementById('copilot-input')?.focus();
  };

  // Auto-init on load — panel is always present, not tab-gated
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCopilot);
  } else {
    initCopilot();
  }
})();
