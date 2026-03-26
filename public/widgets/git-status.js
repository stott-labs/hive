/* Widget: git-status */

WIDGET_REGISTRY['git-status'] = {
  title: 'Repositories',
  icon: '\uD83D\uDCCB',
  defaultSize: { w: 6, h: 4 },
  minW: 3,
  minH: 2,

  init(contentEl, socket, config) {
    contentEl.innerHTML = `
      <div class="git-table" id="widget-git-table">
        <div class="git-row git-header-row">
          <span class="git-col-repo">Repo</span>
          <span class="git-col-branch">Branch</span>
          <span class="git-col-status">Status</span>
          <span class="git-col-sync">Sync</span>
        </div>
      </div>
    `;
    const table = contentEl.querySelector('#widget-git-table');

    this._handler = (repos) => {
      const rows = table.querySelectorAll('.git-data-row');
      rows.forEach(r => r.remove());

      const hiddenRepos = typeof getHiddenRepos === 'function' ? getHiddenRepos() : new Set();
      const visible = repos.filter(r => !hiddenRepos.has(r.repo));

      for (const r of visible) {
        const row = document.createElement('div');
        row.className = 'git-row git-data-row' + (r.clean && !r.behind ? ' dim' : '');

        let branchClass = 'branch-feature';
        if (r.branch === 'main' || r.branch === 'master') branchClass = 'branch-main';
        else if (r.branch === 'development') branchClass = 'branch-development';
        else if (r.branch === '???' || r.branch === '(detached)') branchClass = 'branch-unknown';

        let statusHtml;
        if (r.changedFiles === -1) {
          statusHtml = '<span class="status-error">? error</span>';
        } else if (r.clean) {
          statusHtml = '<span class="status-clean">&#10004; clean</span>';
        } else {
          statusHtml = `<span class="status-dirty git-changes-link" data-repo="${esc(r.repo)}" title="Click to view changes">&#9679; ${r.changedFiles} changed</span>`;
        }

        let syncHtml = '';
        if (r.behind > 0) {
          syncHtml = `<span class="git-behind" title="${r.behind} commit(s) behind origin">&darr;${r.behind}</span>`;
        }
        if (r.ahead > 0) {
          syncHtml += `<span class="git-ahead" title="${r.ahead} commit(s) ahead of origin">&uarr;${r.ahead}</span>`;
        }
        if (r.behind > 0) {
          syncHtml += `<button class="btn git-pull-btn" data-repo="${esc(r.repo)}" title="Pull from origin">Pull</button>`;
        }
        if (!r.behind && !r.ahead && (r.behind !== undefined)) {
          syncHtml = '<span class="git-synced">&#10004;</span>';
        }

        row.innerHTML =
          `<span class="git-col-repo">${esc(r.repo)}</span>` +
          `<span class="git-col-branch"><button class="branch-switcher ${branchClass}" data-repo="${esc(r.repo)}" data-branch="${esc(r.branch)}" title="Switch branch">${esc(r.branch)} &#9662;</button></span>` +
          `<span class="git-col-status">${statusHtml}</span>` +
          `<span class="git-col-sync">${syncHtml}</span>` +
          `<span class="git-col-hide"><button class="git-hide-btn" title="Hide ${esc(r.repo)} (manage in Settings)">&#x1F441;</button></span>`;

        row.querySelector('.git-hide-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (typeof toggleHiddenRepo === 'function') await toggleHiddenRepo(r.repo);
          this._handler(repos);
        });

        row.querySelector('.branch-switcher').addEventListener('click', async (e) => {
          e.stopPropagation();
          await _showBranchDropdown(e.currentTarget, r.repo, r.branch);
        });

        table.appendChild(row);
      }
    };

    socket.on('git-status', this._handler);
  },

  refresh(socket) {
    socket.emit('refresh', 'git');
  },

  destroy(socket) {
    if (this._handler) socket.off('git-status', this._handler);
  },
};
