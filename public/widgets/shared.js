/* Widget: shared — WIDGET_REGISTRY init + shared helpers */

window.WIDGET_REGISTRY = {};

// ---------------------------------------------------------------------------
// Helper: skeleton loading placeholder
// ---------------------------------------------------------------------------
function skeletonRows(count = 4, pattern = 'list') {
  let rows = '';
  for (let i = 0; i < count; i++) {
    if (pattern === 'list') {
      rows += `<div class="skeleton-row"><div class="skeleton-circle"></div><div class="skeleton-bar w-lg"></div><div class="skeleton-bar w-sm"></div></div>`;
    } else if (pattern === 'table') {
      rows += `<div class="skeleton-row"><div class="skeleton-bar w-md"></div><div class="skeleton-bar w-xl"></div><div class="skeleton-bar w-sm"></div></div>`;
    } else if (pattern === 'card') {
      rows += `<div class="skeleton-row"><div class="skeleton-bar w-full"></div></div>`;
    }
  }
  return `<div class="skeleton">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// Helper: create widget chrome wrapper
// ---------------------------------------------------------------------------
function createWidgetChrome(title, icon) {
  const wrap = document.createElement('div');
  wrap.className = 'widget-chrome';
  wrap.innerHTML = `
    <div class="widget-header">
      <span class="widget-drag-handle">${icon || '\u2630'}</span>
      <span class="widget-title">${title}</span>
      <div class="widget-controls">
        <button class="widget-btn widget-refresh" title="Refresh">\u21BB</button>
        <button class="widget-btn widget-popout" title="Pop Out">\u29C9</button>
        <button class="widget-btn widget-close" title="Remove">\u2715</button>
      </div>
    </div>
    <div class="widget-body"></div>
  `;
  return wrap;
}

// ---------------------------------------------------------------------------
// Branch switcher dropdown (shared by git-status widget rows)
// ---------------------------------------------------------------------------
let _branchModalInited = false;

function _closeBranchModal() {
  document.getElementById('branch-picker-modal').style.display = 'none';
}

function _initBranchModal() {
  if (_branchModalInited) return;
  _branchModalInited = true;
  const modal = document.getElementById('branch-picker-modal');
  document.getElementById('branch-picker-close').addEventListener('click', _closeBranchModal);
  modal.addEventListener('click', e => { if (e.target === modal) _closeBranchModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _closeBranchModal(); });
}

async function _showBranchDropdown(btn, repo, currentBranch) {
  _initBranchModal();
  const modal  = document.getElementById('branch-picker-modal');
  const search = document.getElementById('branch-picker-search');
  const list   = document.getElementById('branch-picker-list');

  document.getElementById('branch-picker-title').textContent = `Switch Branch — ${repo}`;
  search.value = '';
  list.innerHTML = '<div class="branch-dropdown-loading">Loading…</div>';
  modal.style.display = '';
  search.focus();

  try {
    const resp = await fetch(`/api/repos/${encodeURIComponent(repo)}/branches`);
    if (!resp.ok) throw new Error('Failed to load branches');
    const { branches } = await resp.json();

    // Prioritise main / development / current at top, then rest alphabetically
    const priority = ['main', 'master', 'development'];
    const top  = priority.filter(b => branches.includes(b));
    const rest = branches.filter(b => !priority.includes(b));
    const ordered = [...new Set([...top, currentBranch, ...rest])];

    function renderList(filter) {
      const q = filter.trim().toLowerCase();
      const filtered = q ? ordered.filter(b => b.toLowerCase().includes(q)) : ordered;
      list.innerHTML = '';
      if (!filtered.length) {
        list.innerHTML = '<div class="branch-dropdown-loading">No branches match</div>';
        return;
      }
      for (const b of filtered) {
        const item = document.createElement('button');
        item.className = 'branch-dropdown-item' + (b === currentBranch ? ' active' : '');
        let dot = '<span class="branch-dot branch-dot-feature"></span>';
        if (b === 'main' || b === 'master') dot = '<span class="branch-dot branch-dot-main"></span>';
        else if (b === 'development')       dot = '<span class="branch-dot branch-dot-development"></span>';
        item.innerHTML = `${dot}${esc(b)}`;
        item.addEventListener('click', async () => {
          _closeBranchModal();
          if (b === currentBranch) return;
          btn.textContent = `${b} ▾`;
          btn.disabled = true;
          try {
            const r = await fetch(`/api/repos/${encodeURIComponent(repo)}/checkout`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ branch: b }),
            });
            const data = await r.json();
            if (!r.ok) {
              showToast(`Checkout failed: ${data.error}`, 'error');
              btn.innerHTML = `${esc(currentBranch)} &#9662;`;
            } else {
              showToast(`Switched to ${b}`, 'success');
            }
          } catch {
            showToast('Checkout failed', 'error');
            btn.innerHTML = `${esc(currentBranch)} &#9662;`;
          }
          btn.disabled = false;
        });
        list.appendChild(item);
      }
    }

    renderList('');
    search.oninput = () => renderList(search.value);

  } catch {
    list.innerHTML = '<div class="branch-dropdown-loading" style="color:var(--red)">Error loading branches</div>';
  }
}
