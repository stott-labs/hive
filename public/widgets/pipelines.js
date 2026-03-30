/* Widget: pipelines */

WIDGET_REGISTRY['pipelines'] = {
  title: 'Pipelines',
  icon: '\uD83D\uDE80',
  defaultSize: { w: 6, h: 4 },
  minW: 4, minH: 2,

  init(contentEl) {
    this._contentEl = contentEl;
    contentEl.innerHTML = `
      <div class="pipeline-list" id="pipeline-list">${skeletonRows(3, 'list')}</div>`;
    this._interval = setInterval(() => this._load(contentEl), 30 * 1000);
    this._load(contentEl);
  },

  async _load(contentEl) {
    const list = contentEl.querySelector('#pipeline-list');
    if (!list) return;
    try {
      const res = await fetch('/api/ado/pipelines');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pipelines = await res.json();
      this._render(list, pipelines);
    } catch (err) {
      list.innerHTML = `<span class="panel-loading">Error: ${esc(err.message)}</span>`;
    }
  },

  _render(list, pipelines) {
    if (!pipelines.length) {
      list.innerHTML = '<span class="panel-loading">No pipelines — configure ADO in Settings</span>';
      return;
    }

    list.innerHTML = pipelines.map(p => {
      const r = p.latestRun;
      if (!r) return `
        <div class="pipeline-row">
          <span class="pipeline-name">${esc(p.name)}</span>
          <span class="pipeline-status ps-unknown">no runs</span>
        </div>`;

      const status = r.status;
      const statusClass = {
        succeeded: 'ps-succeeded',
        failed:    'ps-failed',
        running:   'ps-running',
        inProgress:'ps-running',
        waiting:   'ps-waiting',
        queued:    'ps-queued',
      }[status] || 'ps-unknown';

      const statusLabel = {
        succeeded: '✓ succeeded',
        failed:    '✗ failed',
        running:   '● running',
        inProgress:'● running',
        waiting:   '◐ waiting',
        queued:    '○ queued',
      }[status] || status;

      const duration = r.startTime && r.finishTime
        ? _fmtDuration(new Date(r.finishTime) - new Date(r.startTime))
        : r.startTime ? _timeAgo(r.startTime) : '';

      // Real ADO: approvalId from approvals API; drone: approval obj on run
      const needsApproval = status === 'waiting' || r.approvalId;
      const approveBtn = needsApproval
        ? `<button class="btn pipeline-approve-btn"
             data-pipeline="${p.id}"
             data-run="${r.id}"
             data-approval="${r.approvalId || ''}"
             title="Approve deployment">Approve</button>`
        : '';

      return `
        <div class="pipeline-row">
          <span class="pipeline-name">${esc(p.name)}</span>
          <span class="pipeline-status ${statusClass}">${statusLabel}</span>
          <span class="pipeline-meta">#${esc(r.runNumber)} · ${esc(r.triggeredBy)}</span>
          <span class="pipeline-duration">${esc(duration)}</span>
          <span class="pipeline-actions">
            ${approveBtn}
            <button class="btn pipeline-run-btn" data-pipeline="${p.id}" title="Trigger new run">▶ Run</button>
          </span>
        </div>`;
    }).join('');

    list.querySelectorAll('.pipeline-approve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '…';
        try {
          // Real ADO: use approvalId with the approvals PATCH endpoint
          // Drone: fall back to run-level approve endpoint
          const url = btn.dataset.approval
            ? `/api/ado/pipelines/approvals/${btn.dataset.approval}`
            : `/api/ado/pipelines/${btn.dataset.pipeline}/runs/${btn.dataset.run}/approve`;
          await fetch(url, { method: 'POST' });
          this._load(this._contentEl);
        } catch { btn.disabled = false; btn.textContent = 'Approve'; }
      });
    });

    list.querySelectorAll('.pipeline-run-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await fetch(`/api/ado/pipelines/${btn.dataset.pipeline}/runs`, { method: 'POST' });
          setTimeout(() => this._load(this._contentEl), 500);
        } catch { btn.disabled = false; btn.textContent = '▶ Run'; }
      });
    });
  },

  refresh(_, contentEl) { this._load(contentEl || this._contentEl); },
  destroy() { if (this._interval) clearInterval(this._interval); },
};

function _fmtDuration(ms) {
  if (ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

function _timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
