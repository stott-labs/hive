/* Widget: ado */

WIDGET_REGISTRY['ado'] = {
  title: 'Azure DevOps',
  icon: '\uD83D\uDCCB',
  settingsKey: 'ado',
  defaultSize: { w: 4, h: 6 },
  minW: 3,
  minH: 3,

  _defaultGroups: [
    { label: 'Active', states: ['Active'], targetState: 'Active', limit: 20 },
    { label: 'In Design', states: ['In Design'], targetState: 'In Design', limit: 15 },
    { label: 'Pending', states: ['Pending', 'Requested'], targetState: 'Pending', limit: 15 },
    { label: 'Backlog', states: ['New'], targetState: 'New', limit: 30 },
  ],

  _getOrderedGroups() {
    try {
      const saved = JSON.parse(localStorage.getItem('ado-kanban-col-order'));
      if (Array.isArray(saved) && saved.length === this._defaultGroups.length) {
        return saved.map(ts => this._defaultGroups.find(g => g.targetState === ts)).filter(Boolean);
      }
    } catch {}
    return this._defaultGroups;
  },

  _saveColOrder(groups) {
    localStorage.setItem('ado-kanban-col-order', JSON.stringify(groups.map(g => g.targetState)));
  },

  init(contentEl, socket, config) {
    contentEl.innerHTML = `
      <div class="section-title-row" style="margin-bottom:4px">
        <div class="ado-filter-bar" id="widget-ado-filter-bar"></div>
        <button class="ado-view-toggle" id="widget-ado-view-toggle" title="Toggle Kanban / List view">&#9776;</button>
      </div>
      <div class="ado-search-row" id="widget-ado-search-row">
        <input type="text" class="ado-search-input" id="widget-ado-search" placeholder="Search by title or #ID…" autocomplete="off">
        <button class="ado-create-btn ado-create-bug" id="widget-ado-add-bug" title="Create a new Bug">&#128027; Bug</button>
        <button class="ado-create-btn ado-create-story" id="widget-ado-add-story" title="Create a new User Story">&#128640; Story</button>
      </div>
      <div class="panel-body" id="widget-ado-content">
        ${skeletonRows(5, 'table')}
      </div>
    `;

    this._userFilter = localStorage.getItem('ado-user-filter') || 'all';
    this._viewMode = localStorage.getItem('ado-view-mode') || 'list';
    this._cachedItems = [];
    this._searchQuery = '';

    contentEl.querySelector('#widget-ado-view-toggle').addEventListener('click', () => {
      this._viewMode = this._viewMode === 'list' ? 'kanban' : 'list';
      localStorage.setItem('ado-view-mode', this._viewMode);
      this._render(contentEl);
    });

    const searchInput = contentEl.querySelector('#widget-ado-search');
    searchInput.addEventListener('input', () => {
      this._searchQuery = searchInput.value.trim().toLowerCase();
      this._render(contentEl);
    });

    contentEl.querySelector('#widget-ado-add-bug').addEventListener('click', () => this._showCreateModal(contentEl, 'Bug'));
    contentEl.querySelector('#widget-ado-add-story').addEventListener('click', () => this._showCreateModal(contentEl, 'User Story'));

    this._interval = setInterval(() => this._load(contentEl), 60000);
    this._load(contentEl);
  },

  async _load(contentEl) {
    const el = contentEl.querySelector('#widget-ado-content');
    const filterBar = contentEl.querySelector('#widget-ado-filter-bar');
    if (!el) return;

    try {
      const statusRes = await fetch('/api/ado/status');
      const statusData = await statusRes.json();

      if (!statusData.configured) {
        el.innerHTML = `<div class="ado-setup">
          <p>ADO integration requires configuration.</p>
          <p>Set <code>ado</code> in <code>dashboard.config.json</code> and <code>ADO_PAT</code> in your environment.</p>
        </div>`;
        return;
      }

      const adoUsers = (window.DASH_CONFIG || {}).adoUsers || [];

      let wiUrl = '/api/ado/work-items';
      if (this._userFilter !== 'all') {
        wiUrl += '?assignedTo=' + encodeURIComponent(this._userFilter);
      }

      // Render filter chips
      if (filterBar) {
        let filterHtml = `<button class="ado-filter-chip${this._userFilter === 'all' ? ' active' : ''}" data-ado-filter="all">All</button>`;
        for (const user of adoUsers) {
          filterHtml += `<button class="ado-filter-chip${this._userFilter === user ? ' active' : ''}" data-ado-filter="${esc(user)}">${esc(user.split(' ')[0])}</button>`;
        }
        filterBar.innerHTML = filterHtml;
        filterBar.querySelectorAll('.ado-filter-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            this._userFilter = chip.dataset.adoFilter;
            localStorage.setItem('ado-user-filter', this._userFilter);
            this._load(contentEl);
          });
        });
      }

      const itemsRes = await fetch(wiUrl);
      let items = await itemsRes.json();

      if (this._userFilter !== 'all' && Array.isArray(items)) {
        items = items.filter(wi => (wi.assignedTo || '').includes(this._userFilter));
      }

      this._cachedItems = Array.isArray(items) ? items : [];
      this._render(contentEl);
    } catch (err) {
      const el = contentEl.querySelector('#widget-ado-content');
      if (el) el.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  _render(contentEl) {
    const el = contentEl.querySelector('#widget-ado-content');
    if (!el) return;

    const toggleBtn = contentEl.querySelector('#widget-ado-view-toggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = this._viewMode === 'kanban' ? '&#9776;' : '&#9638;&#9638;&#9638;';
      toggleBtn.title = this._viewMode === 'kanban' ? 'Switch to List view' : 'Switch to Kanban view';
    }

    if (this._viewMode === 'kanban') {
      this._renderKanban(el);
    } else {
      this._renderList(el);
    }
  },

  _renderList(el) {
    const items = this._filteredItems();
    const DASH = window.DASH_CONFIG || {};

    let html = '';
    if (items.length > 0) {
      for (const group of this._defaultGroups) {
        const groupItems = items
          .filter(wi => group.states.includes(wi.state))
          .sort((a, b) => (b.createdDate || b.id) > (a.createdDate || a.id) ? 1 : -1);
        if (groupItems.length === 0) continue;

        html += `<div class="ado-wi-group">`;
        html += `<div class="ado-wi-group-header">${esc(group.label)} <span class="ado-wi-group-count">${groupItems.length}</span></div>`;
        html += '<ul class="ado-wi-list">';
        for (const wi of groupItems.slice(0, group.limit)) {
          html += this._renderWiItem(wi, DASH);
        }
        if (groupItems.length > group.limit) {
          html += `<li class="ado-wi-more">+${groupItems.length - group.limit} more</li>`;
        }
        html += '</ul></div>';
      }
    }

    el.innerHTML = html || '<span class="panel-loading">No data</span>';
  },

  _filteredItems() {
    const q = this._searchQuery;
    if (!q) return this._cachedItems;
    return this._cachedItems.filter(wi =>
      (wi.title || '').toLowerCase().includes(q) ||
      String(wi.id).includes(q)
    );
  },

  _renderKanban(el) {
    const items = this._filteredItems();
    const DASH = window.DASH_CONFIG || {};
    const orderedGroups = this._getOrderedGroups();

    let html = '<div class="ado-kanban">';
    for (const group of orderedGroups) {
      const groupItems = items
        .filter(wi => group.states.includes(wi.state))
        .sort((a, b) => (b.createdDate || b.id) > (a.createdDate || a.id) ? 1 : -1);
      html += `<div class="ado-kanban-col" data-target-state="${esc(group.targetState)}">
        <div class="ado-kanban-col-header" data-col-state="${esc(group.targetState)}">
          <span class="ado-kanban-col-drag">&#8942;&#8942;</span>
          <span class="ado-kanban-col-title">${esc(group.label)}</span>
          <span class="ado-wi-group-count">${groupItems.length}</span>
        </div>
        <div class="ado-kanban-col-body" data-target-state="${esc(group.targetState)}">`;
      for (const wi of groupItems.slice(0, group.limit)) {
        html += `<div class="ado-kanban-card" draggable="true" data-wi-id="${wi.id}" data-wi-state="${esc(wi.state)}">
          <div class="ado-kanban-card-top">
            <span class="ado-wi-type ${esc(wi.type || '')}">${esc(wi.type || '')}</span>
            <span class="ado-wi-id">${DASH.adoOrg ? `<a href="https://dev.azure.com/${DASH.adoOrg}/${encodeURIComponent(DASH.adoProject || '')}/_workitems/edit/${wi.id}" target="_blank">#${wi.id}</a>` : `#${wi.id}`}</span>
          </div>
          <div class="ado-kanban-card-title" title="${esc(wi.title || '')}">${esc(wi.title || '')}</div>
          ${wi.assignedTo ? `<div class="ado-kanban-card-assignee">${esc(wi.assignedTo.split(' ')[0])}</div>` : ''}
        </div>`;
      }
      if (groupItems.length > group.limit) {
        html += `<div class="ado-kanban-more">+${groupItems.length - group.limit} more</div>`;
      }
      html += `</div></div>`;
    }
    html += '</div>';

    el.innerHTML = html;

    // Wire up drag-and-drop
    this._wireKanbanDnD(el);
  },

  _wireKanbanDnD(el) {
    let dragType = null; // 'card' or 'col'
    let draggedCardId = null;
    let draggedCol = null;

    // --- Card drag ---
    el.querySelectorAll('.ado-kanban-card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        dragType = 'card';
        draggedCardId = card.dataset.wiId;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'card');
      });
      card.addEventListener('dragend', () => {
        dragType = null;
        draggedCardId = null;
        card.classList.remove('dragging');
        el.querySelectorAll('.ado-kanban-col-body.drag-over').forEach(c => c.classList.remove('drag-over'));
      });
    });

    el.querySelectorAll('.ado-kanban-col-body').forEach(colBody => {
      colBody.addEventListener('dragover', (e) => {
        if (dragType !== 'card') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        colBody.classList.add('drag-over');
      });
      colBody.addEventListener('dragleave', (e) => {
        if (!colBody.contains(e.relatedTarget)) {
          colBody.classList.remove('drag-over');
        }
      });
      colBody.addEventListener('drop', async (e) => {
        if (dragType !== 'card') return;
        e.preventDefault();
        colBody.classList.remove('drag-over');
        if (!draggedCardId) return;

        const targetState = colBody.dataset.targetState;
        const card = el.querySelector(`.ado-kanban-card[data-wi-id="${draggedCardId}"]`);
        if (!card || card.dataset.wiState === targetState) return;

        const oldState = card.dataset.wiState;
        card.dataset.wiState = targetState;
        card.classList.add('ado-kanban-updating');
        colBody.appendChild(card);
        this._updateKanbanCounts(el);

        try {
          const resp = await fetch(`/api/ado/work-items/${draggedCardId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: targetState }),
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${resp.status}`);
          }
          card.classList.remove('ado-kanban-updating');
          const cached = this._cachedItems.find(wi => String(wi.id) === String(draggedCardId));
          if (cached) cached.state = targetState;
        } catch (err) {
          card.dataset.wiState = oldState;
          card.classList.remove('ado-kanban-updating');
          const origCol = el.querySelector(`.ado-kanban-col-body[data-target-state="${oldState}"]`);
          if (origCol) origCol.appendChild(card);
          this._updateKanbanCounts(el);
          // Show page-level error toast
          const title = card.querySelector('.ado-kanban-card-title')?.textContent || `#${draggedCardId}`;
          showToast(`Failed to move "${title}" to ${targetState}: ${err.message}`, 'error');
          console.error('Failed to update work item state:', err);
        }
      });
    });

    // --- Column reorder via pointer events (avoids GridStack native drag conflict) ---
    const kanban = el.querySelector('.ado-kanban');
    const self = this;

    el.querySelectorAll('.ado-kanban-col-drag').forEach(handle => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const col = handle.closest('.ado-kanban-col');
        if (!col) return;

        col.classList.add('ado-kanban-col-dragging');
        const cols = () => [...kanban.querySelectorAll('.ado-kanban-col')];
        let lastDropTarget = null;

        function onMove(ev) {
          ev.preventDefault();
          // Clear previous indicators
          cols().forEach(c => {
            c.classList.remove('ado-kanban-col-drop-before');
            c.classList.remove('ado-kanban-col-drop-after');
          });

          // Find which column the pointer is over
          for (const c of cols()) {
            if (c === col) continue;
            const rect = c.getBoundingClientRect();
            if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
              const midX = rect.left + rect.width / 2;
              if (ev.clientX < midX) {
                c.classList.add('ado-kanban-col-drop-before');
              } else {
                c.classList.add('ado-kanban-col-drop-after');
              }
              lastDropTarget = { el: c, before: ev.clientX < midX };
              return;
            }
          }
          lastDropTarget = null;
        }

        function onUp(ev) {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          col.classList.remove('ado-kanban-col-dragging');
          cols().forEach(c => {
            c.classList.remove('ado-kanban-col-drop-before');
            c.classList.remove('ado-kanban-col-drop-after');
          });

          if (lastDropTarget && lastDropTarget.el !== col) {
            if (lastDropTarget.before) {
              kanban.insertBefore(col, lastDropTarget.el);
            } else {
              kanban.insertBefore(col, lastDropTarget.el.nextSibling);
            }
            // Save new order
            const newOrder = cols().map(c => c.dataset.targetState);
            const groups = newOrder.map(ts => self._defaultGroups.find(g => g.targetState === ts)).filter(Boolean);
            self._saveColOrder(groups);
          }
        }

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    });
  },

  _updateKanbanCounts(el) {
    for (const group of this._defaultGroups) {
      const col = el.querySelector(`.ado-kanban-col[data-target-state="${group.targetState}"]`);
      if (!col) continue;
      const count = col.querySelectorAll('.ado-kanban-card').length;
      const badge = col.querySelector('.ado-wi-group-count');
      if (badge) badge.textContent = count;
    }
  },

  _renderWiItem(wi, DASH) {
    const isBug = (wi.type || '').toLowerCase() === 'bug';
    const skillCmd = isBug ? 'create-bug' : (wi.type || '').toLowerCase() === 'feature' ? 'create-feature' : 'create-story';
    return `<li class="ado-wi-item">
      <span class="ado-wi-type ${esc(wi.type || '')}">${esc(wi.type || '')}</span>
      <span class="ado-wi-id">${DASH.adoOrg ? `<a href="https://dev.azure.com/${DASH.adoOrg}/${encodeURIComponent(DASH.adoProject || '')}/_workitems/edit/${wi.id}" target="_blank">#${wi.id}</a>` : `#${wi.id}`}</span>
      <span class="ado-wi-title" title="${esc(wi.title || '')}">${esc(wi.title || '')}</span>
      <button class="ado-wi-action" data-cmd="/${skillCmd} ${wi.id}" title="Copy /${skillCmd} ${wi.id} to clipboard">${isBug ? '&#128027;' : '&#128640;'}</button>
      <span class="ado-wi-state">${esc(wi.state || '')}</span>
    </li>`;
  },

  _showCreateModal(contentEl, type) {
    const existing = document.getElementById('ado-create-modal');
    if (existing) existing.remove();

    const isBug = type === 'Bug';
    const overlay = document.createElement('div');
    overlay.id = 'ado-create-modal';
    overlay.className = 'ado-modal-overlay';
    overlay.innerHTML = `
      <div class="ado-modal">
        <div class="ado-modal-header">
          <span>${isBug ? '&#128027;' : '&#128640;'} New ${esc(type)}</span>
          <button class="ado-modal-close" id="ado-modal-close">&#10005;</button>
        </div>
        <div class="ado-modal-body">
          <label class="ado-modal-label">Title <span class="ado-modal-required">*</span></label>
          <input type="text" class="ado-modal-input" id="ado-modal-title" placeholder="${isBug ? 'Short description of the bug' : 'User story title'}" autocomplete="off">
          <label class="ado-modal-label" style="margin-top:10px">${isBug ? 'Repro Steps' : 'Description'} <span class="ado-modal-optional">(optional)</span></label>
          <textarea class="ado-modal-textarea" id="ado-modal-desc" rows="4" placeholder="${isBug ? 'Steps to reproduce…' : 'As a user, I want to…'}"></textarea>
        </div>
        <div class="ado-modal-footer">
          <button class="ado-modal-btn ado-modal-cancel" id="ado-modal-cancel">Cancel</button>
          <button class="ado-modal-btn ado-modal-submit" id="ado-modal-submit">${isBug ? '&#128027;' : '&#128640;'} Create ${esc(type)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#ado-modal-close').addEventListener('click', close);
    overlay.querySelector('#ado-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const titleInput = overlay.querySelector('#ado-modal-title');
    titleInput.focus();

    overlay.querySelector('#ado-modal-submit').addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.classList.add('ado-modal-input-error'); titleInput.focus(); return; }
      titleInput.classList.remove('ado-modal-input-error');

      const submitBtn = overlay.querySelector('#ado-modal-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';

      try {
        const resp = await fetch('/api/ado/work-items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            title,
            description: overlay.querySelector('#ado-modal-desc').value.trim() || undefined,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        close();
        const skillCmd = isBug ? `create-bug` : `create-story`;
        const DASH = window.DASH_CONFIG || {};
        const wiUrl = DASH.adoOrg
          ? `https://dev.azure.com/${DASH.adoOrg}/${encodeURIComponent(DASH.adoProject || '')}/_workitems/edit/${data.id}`
          : null;
        const msg = `${isBug ? '🐛' : '🚀'} ${type} #${data.id} created — run /${skillCmd} ${data.id} in Claude Code to create a branch`;
        showToast(msg, 'success', 8000);

        this._load(contentEl);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `${isBug ? '&#128027;' : '&#128640;'} Create ${esc(type)}`;
        showToast(`Failed to create ${type}: ${err.message}`, 'error');
      }
    });
  },

  refresh() {
    const contentEl = document.querySelector('[gs-id="ado"] .widget-body');
    if (contentEl) this._load(contentEl);
  },

  destroy() {
    if (this._interval) clearInterval(this._interval);
  },
};
