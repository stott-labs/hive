/* ==========================================================================
   Settings Page — edit dashboard.config.json from the browser
   ========================================================================== */

let _settingsConfig = null;
let _settingsDirty = false;
let _settingsContainer = null;

// Section definitions — order and metadata for rendering
const SETTINGS_SECTIONS = [
  {
    key: 'general',
    title: 'General',
    icon: '\u2699',
    description: 'Dashboard name, title, and base project paths',
    fields: [
      { key: 'name', label: 'Project Name', type: 'text', placeholder: 'My Project' },
      { key: 'title', label: 'Dashboard Title', type: 'text', placeholder: 'Dev Dashboard' },
      { key: 'projectsDir', label: 'Projects Directory', type: 'text', placeholder: 'C:\\Users\\you\\Projects', help: 'Absolute path to the folder containing all your repos' },
      { key: 'logDir', label: 'Log Directory', type: 'text', placeholder: '.devdash/logs', help: 'Relative to home directory' },
    ],
  },
  {
    key: 'dataPaths',
    title: 'Data Directories',
    icon: '\uD83D\uDCC2',
    description: 'Where shared and private data files are stored.',
    fields: [
      { key: 'dataDir', label: 'Shared Data Directory', type: 'text', placeholder: '../hivemind/data', help: 'Shared collections, environments, metrics. Relative to projects directory or absolute.' },
      { key: 'privateDataDir', label: 'Private Data Directory', type: 'text', placeholder: '~/.config/hive/data', help: 'Personal collections, request history. Never shared.' },
      { key: 'docsDir', label: 'Docs Directory', type: 'text', placeholder: '../montra-docs/docs', help: 'Markdown docs source. Relative to projects directory or absolute.' },
    ],
  },
  {
    key: 'repos',
    title: 'Repositories',
    icon: '\uD83D\uDCC1',
    description: 'Git repos to monitor. Simple string or [displayName, dir, branchDefault] tuple.',
    type: 'string-list',
    configKey: 'repos',
    discover: true,
  },
  {
    key: 'services',
    title: 'Services',
    icon: '\uD83D\uDDA5\uFE0F',
    description: 'Dev servers to monitor and control (web, API, etc.)',
    type: 'keyed-objects',
    configKey: 'services',
    objectFields: [
      { key: 'label', label: 'Label', type: 'text', placeholder: 'Web (Vite)' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '8080' },
      { key: 'startCmd', label: 'Start Command', type: 'text', placeholder: 'npm run dev' },
      { key: 'repoDir', label: 'Repo Directory', type: 'text', placeholder: 'my-web' },
    ],
  },
  {
    key: 'dbMigrations',
    title: 'DB Migrations',
    icon: '\uD83D\uDDC3\uFE0F',
    description: 'Database migration repo for the DB Migrations widget',
    fields: [
      { key: 'dbRepo', label: 'DB Repo Directory', type: 'text', placeholder: 'my-db', help: 'Repo directory containing database migrations (relative to projects directory)' },
    ],
  },
  {
    key: 'externalMonitors',
    title: 'External Monitors',
    icon: '\uD83C\uDF10',
    description: 'External services to health-check (HTTP or StatusPage)',
    type: 'object-list',
    configKey: 'externalMonitors',
    objectFields: [
      { key: 'key', label: 'Key', type: 'text', placeholder: 'my-app-dev' },
      { key: 'label', label: 'Label', type: 'text', placeholder: 'My App (Dev)' },
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://...' },
      { key: 'type', label: 'Type', type: 'select', options: ['http', 'statuspage'] },
      { key: 'interval', label: 'Interval (sec)', type: 'number', placeholder: '30' },
      { key: 'alarm', label: 'Alarm', type: 'select', options: ['on', 'off'], help: 'Audible alarm when this service is down. Visual status always shown.' },
    ],
  },
  {
    key: 'ado',
    title: 'Azure DevOps',
    icon: '\uD83D\uDCCB',
    description: 'ADO integration settings',
    envVars: [
      { envKey: 'ADO_PAT', label: 'Personal Access Token (ADO_PAT)', testEndpoint: '/api/ado/test' },
    ],
    fields: [
      { key: 'ado.org', label: 'Organization', type: 'text', placeholder: 'my-org' },
      { key: 'ado.project', label: 'Project', type: 'text', placeholder: 'my-project' },
      { key: 'ado.team', label: 'Team', type: 'text', placeholder: 'DevTeam' },
    ],
    extraLists: [
      { key: 'ado.users',         label: 'Users',            adoSource: '/api/ado/team-members',    placeholder: 'Display Name' },
      { key: 'ado.prRepos',       label: 'PR Repos',         adoSource: '/api/ado/project-repos',   placeholder: 'repo-name' },
      { key: 'ado.workItemTypes', label: 'Work Item Types',  adoSource: '/api/ado/work-item-types', placeholder: 'Bug' },
      { key: 'ado.activeStates',  label: 'Active States',    adoSource: '/api/ado/work-item-states', placeholder: 'Active' },
      { key: 'ado.pipelineIds',   label: 'Pipelines',        adoSource: '/api/ado/pipeline-list',   placeholder: '' },
    ],
  },
  {
    key: 'sentry',
    title: 'Sentry',
    icon: '\uD83D\uDC1B',
    description: 'Sentry integration',
    envVars: [
      { envKey: 'SENTRY_AUTH_TOKEN', label: 'Auth Token (SENTRY_AUTH_TOKEN)', testEndpoint: '/api/sentry/test' },
    ],
    fields: [
      { key: 'sentry.org', label: 'Organization', type: 'text', placeholder: 'my-org' },
    ],
    extraLists: [
      { key: 'sentry.projects', label: 'Projects', placeholder: 'project-slug' },
    ],
  },
  {
    key: 'github',
    title: 'GitHub',
    icon: '\uD83D\uDC19',
    description: 'GitHub integration. Set org to enable member/repo pickers.',
    envVars: [
      { envKey: 'GITHUB_TOKEN', label: 'GitHub Token (GITHUB_TOKEN)', testEndpoint: '/api/github/test' },
    ],
    fields: [
      { key: 'github.org', label: 'Organization(s)', type: 'text', placeholder: 'my-org, another-org', help: 'Comma-separated list of GitHub organizations' },
    ],
    extraLists: [
      { key: 'github.users',      label: 'Users (filter PRs by)',  adoSource: '/api/github/org-members', placeholder: 'github-username' },
      { key: 'github.prRepos',    label: 'PR Repos',               adoSource: '/api/github/org-repos',   placeholder: 'owner/repo' },
      { key: 'github.watchRepos', label: 'Actions Watch Repos',    adoSource: '/api/github/org-repos',   placeholder: 'owner/repo' },
    ],
  },
  {
    key: 'bookmarks',
    title: 'Bookmarks',
    icon: '\uD83D\uDD16',
    description: 'Quick-access links in the header dropdown',
    type: 'object-list',
    configKey: 'bookmarks',
    objectFields: [
      { key: 'label', label: 'Label', type: 'text', placeholder: 'Swagger UI' },
      { key: 'url', label: 'URL', type: 'text', placeholder: 'http://localhost:7600/swagger' },
    ],
  },
  {
    key: 'cliTools',
    title: 'CLI Tools',
    icon: '\u2318',
    description: 'Custom CLI commands available in the CLI Tools widget',
    fields: [
      { key: 'cliRepo', label: 'CLI Repo Directory', type: 'text', placeholder: 'my-cli', help: 'Repo directory containing CLI scripts (relative to projects directory)' },
    ],
    type: 'object-list',
    configKey: 'cliTools',
    objectFields: [
      { key: 'id', label: 'ID', type: 'text', placeholder: 'sync-users' },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'Sync Users' },
      { key: 'desc', label: 'Description', type: 'text', placeholder: 'Run user sync job' },
      { key: 'category', label: 'Category', type: 'text', placeholder: 'Jobs' },
      { key: 'cmd', label: 'Command', type: 'text', placeholder: 'node' },
      { key: 'args', label: 'Args (comma-sep)', type: 'text', placeholder: 'scripts/sync.js' },
    ],
  },
  {
    key: 'quickActions',
    title: 'Quick Actions',
    icon: '\u26A1',
    description: 'Shortcut commands available from the bookmarks dropdown',
    type: 'keyed-objects',
    configKey: 'quickActions',
    objectFields: [
      { key: 'repoDir', label: 'Repo Directory', type: 'text', placeholder: 'my-api' },
      { key: 'cmd', label: 'Command', type: 'text', placeholder: 'jest' },
      { key: 'args', label: 'Args (comma-sep)', type: 'text', placeholder: '--passWithNoTests' },
    ],
  },
  {
    key: 'releases',
    title: 'Releases',
    icon: '\uD83D\uDE80',
    description: 'Where to find release notes',
    fields: [
      { key: 'releases.repoDir', label: 'Repo Directory', type: 'text', placeholder: 'my-web' },
      { key: 'releases.path', label: 'Releases JSON Path', type: 'text', placeholder: 'public/docs/release-notes/releases.json' },
    ],
  },
  {
    key: 'terminal',
    title: 'Terminal',
    icon: '\u{1F4BB}',
    description: 'Terminal emulator for launching services. "auto" detects your platform.',
    fields: [
      {
        key: 'terminal.emulator', label: 'Terminal Emulator', type: 'select',
        options: ['auto', 'windows-terminal', 'macos-terminal', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'tmux', 'xterm'],
        help: '"auto" detects Windows Terminal, macOS Terminal, or the best available Linux terminal',
      },
      { key: 'terminal.shellPath', label: 'Shell Path', type: 'text', placeholder: 'auto-detected (e.g. /bin/bash, C:\\Program Files\\Git\\bin\\bash.exe)', help: 'Leave blank to auto-detect' },
      { key: 'terminal.splitPanes', label: 'Group in Split Panes', type: 'toggle', help: 'Open services in split panes within a single tab (where supported)' },
    ],
  },
  {
    key: 'envDiff',
    title: 'Env Diff',
    icon: '\uD83D\uDD0D',
    description: 'Environment files to compare across environments',
    type: 'keyed-objects',
    configKey: 'envDiff',
    objectFields: [
      { key: 'repoDir', label: 'Repo Directory', type: 'text', placeholder: 'my-api' },
      { key: 'path', label: 'File Path', type: 'text', placeholder: '.env' },
    ],
  },
];

function _esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ---------------------------------------------------------------------------
// Deep get/set by dotted path
// ---------------------------------------------------------------------------
function deepGet(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : ''), obj);
}

function deepSet(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function _wireAdoCheckboxes(optionsEl, listPath, onDirty) {
  optionsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = [...optionsEl.querySelectorAll('input[type="checkbox"]:checked')]
        .map(c => c.dataset.value);
      deepSet(_settingsConfig, listPath, checked);
      if (typeof onDirty === 'function') onDirty();
    });
  });
}

// ---------------------------------------------------------------------------
// Init — called lazily when Settings tab is first opened
// ---------------------------------------------------------------------------
async function initSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;

  container.innerHTML = '<span class="panel-loading">Loading configuration...</span>';

  try {
    const res = await fetch('/api/config/full');
    _settingsConfig = await res.json();
    _settingsDirty = false;
    renderSettings(container);
  } catch (err) {
    container.innerHTML = `<span class="panel-loading">Error loading config: ${_esc(err.message)}</span>`;
  }
}

function renderSettings(container) {
  let html = '';
  html += '<div class="settings-toolbar">';
  html += '<button class="btn settings-save-btn" id="settings-save-btn" disabled>Save All Changes</button>';
  html += '<span class="settings-status" id="settings-status"></span>';
  html += '<button class="btn settings-reload-btn" id="settings-reload-btn">Reload from Disk</button>';
  html += '<button class="btn settings-collapse-btn" id="settings-collapse-all">Collapse All</button>';
  html += '</div>';

  for (const section of SETTINGS_SECTIONS) {
    html += `<details class="settings-section" open>`;
    html += `<summary class="settings-section-header">`;
    html += `<span class="settings-section-icon">${section.icon || ''}</span>`;
    html += `<span class="settings-section-title">${_esc(section.title)}</span>`;
    html += `<span class="settings-section-desc">${_esc(section.description || '')}</span>`;
    html += `</summary>`;
    html += `<div class="settings-section-body" data-section="${section.key}">`;
    html += renderSectionBody(section);
    html += `</div></details>`;
  }

  container.innerHTML = html;
  _settingsContainer = container;
  wireSettingsEvents(container);
}

function renderSectionBody(section) {
  let html = '';

  // Environment variables (tokens/secrets stored in .env, not config)
  if (section.envVars) {
    html += '<div class="settings-env-vars">';
    for (const ev of section.envVars) {
      html += `<div class="settings-field settings-env-field" data-env-key="${_esc(ev.envKey)}">`;
      html += `<label class="settings-label">${_esc(ev.label)}</label>`;
      html += `<div class="settings-env-row">`;
      html += `<input type="password" class="settings-input settings-env-input" data-env-key="${_esc(ev.envKey)}" placeholder="Enter token..." autocomplete="off">`;
      html += `<button class="btn settings-env-toggle-vis" data-env-key="${_esc(ev.envKey)}" title="Show/hide value">\uD83D\uDC41</button>`;
      html += `<span class="settings-env-status" data-env-status="${_esc(ev.envKey)}"></span>`;
      html += `<button class="btn settings-env-save" data-env-key="${_esc(ev.envKey)}">Save</button>`;
      if (ev.testEndpoint) {
        html += `<button class="btn settings-env-test" data-test-endpoint="${_esc(ev.testEndpoint)}" data-env-key="${_esc(ev.envKey)}">Test</button>`;
      }
      html += `</div>`;
      html += `<span class="settings-env-test-result" data-test-result="${_esc(ev.envKey)}"></span>`;
      html += `<span class="settings-help">Stored in .env file (never committed to git)</span>`;
      html += `</div>`;
    }
    html += '</div>';
  }

  // Simple fields
  if (section.fields) {
    html += '<div class="settings-fields">';
    for (const f of section.fields) {
      const val = deepGet(_settingsConfig, f.key);
      html += `<div class="settings-field">`;
      html += `<label class="settings-label">${_esc(f.label)}</label>`;
      if (f.type === 'select') {
        html += `<select class="settings-input" data-path="${f.key}">`;
        for (const opt of (f.options || [])) {
          html += `<option value="${_esc(opt)}"${(val || '') === opt ? ' selected' : ''}>${_esc(opt)}</option>`;
        }
        html += `</select>`;
      } else if (f.type === 'toggle') {
        html += `<label class="settings-toggle"><input type="checkbox" class="settings-checkbox" data-path="${f.key}"${val !== false ? ' checked' : ''}><span class="settings-toggle-label">${val !== false ? 'Enabled' : 'Disabled'}</span></label>`;
      } else {
        html += `<input type="${f.type || 'text'}" class="settings-input" data-path="${f.key}" value="${_esc(String(val || ''))}" placeholder="${_esc(f.placeholder || '')}">`;
      }
      if (f.help) html += `<span class="settings-help">${_esc(f.help)}</span>`;
      html += `</div>`;
    }
    html += '</div>';
  }

  // Extra lists (arrays of strings within nested objects, e.g. ado.users)
  if (section.extraLists) {
    for (const list of section.extraLists) {
      const items = deepGet(_settingsConfig, list.key) || [];
      if (list.adoSource && section.key === 'github' && !deepGet(_settingsConfig, 'github.org')) continue;
      if (list.adoSource) {
        // ADO-backed picker: checkboxes populated by fetching from ADO
        html += `<div class="settings-list-block settings-ado-picker" data-list-path="${list.key}" data-ado-source="${_esc(list.adoSource)}">`;
        html += `<div class="settings-ado-picker-header">`;
        html += `<label class="settings-label">${_esc(list.label)}</label>`;
        html += `<button class="btn settings-ado-fetch-btn" data-list-path="${_esc(list.key)}" data-source="${_esc(list.adoSource)}">↻ Fetch</button>`;
        html += `</div>`;
        html += `<div class="settings-ado-options" data-list-path="${_esc(list.key)}">`;
        // Show current values as pre-checked items
        for (const item of items) {
          html += `<label class="settings-ado-option"><input type="checkbox" checked data-value="${_esc(String(item))}"> ${_esc(String(item))}</label>`;
        }
        html += `</div></div>`;
      } else {
        // Standard chip list
        html += `<div class="settings-list-block" data-list-path="${list.key}">`;
        html += `<label class="settings-label">${_esc(list.label)}</label>`;
        html += `<div class="settings-chip-list">`;
        for (const item of items) {
          html += `<span class="settings-chip">${_esc(String(item))}<button class="settings-chip-remove" data-value="${_esc(String(item))}">\u00D7</button></span>`;
        }
        html += `<input type="text" class="settings-chip-input" placeholder="${_esc(list.placeholder || 'Add...')}" data-list-path="${list.key}">`;
        html += `</div></div>`;
      }
    }
  }

  // String list (repos)
  if (section.type === 'string-list') {
    const items = _settingsConfig[section.configKey] || [];
    html += '<div class="settings-string-list" data-config-key="' + section.configKey + '">';
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const display = Array.isArray(item) ? item.join(', ') : String(item);
      html += `<div class="settings-list-row">`;
      html += `<input type="text" class="settings-input settings-list-item" data-index="${i}" value="${_esc(display)}">`;
      html += `<button class="btn settings-row-remove" data-index="${i}" title="Remove">\u2715</button>`;
      html += `</div>`;
    }
    html += `<button class="btn settings-row-add" data-config-key="${section.configKey}">+ Add</button>`;
    html += '</div>';

    if (section.discover) {
      html += `<div class="repo-discover-panel">`;
      html += `<div class="repo-discover-header">`;
      html += `<span class="settings-label">Discover from ADO &amp; GitHub</span>`;
      html += `<button class="btn repo-discover-scan-btn">↻ Scan</button>`;
      html += `<div class="repo-disc-search" style="display:none">`;
      html += `<svg class="repo-disc-search-icon" viewBox="0 0 16 16" width="14" height="14"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="10" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      html += `<input type="text" class="settings-input repo-disc-search-input" placeholder="Filter repos…">`;
      html += `<button class="repo-disc-search-clear" title="Clear" style="display:none">✕</button>`;
      html += `</div>`;
      html += `</div>`;
      html += `<div class="repo-discover-results"></div>`;
      html += `</div>`;
    }
  }

  // Global alarm toggle — shown at top of External Monitors section
  if (section.key === 'externalMonitors') {
    const on = typeof window.getAlarmEnabled === 'function' ? window.getAlarmEnabled() : true;
    const notifyOn = typeof window.getClaudeNotifyEnabled === 'function' ? window.getClaudeNotifyEnabled() : true;
    html += `
      <div class="settings-alarm-toggle-row">
        <div class="settings-alarm-toggle-text">
          <span class="settings-alarm-toggle-label">Alarm Sound</span>
          <span class="settings-alarm-toggle-desc">When enabled, an audible alarm fires if a service stays down for 3+ minutes. Visual status (red/down) is always shown regardless.</span>
        </div>
        <label class="settings-big-toggle">
          <input type="checkbox" id="settings-alarm-enabled" ${on ? 'checked' : ''}>
          <span class="settings-big-toggle-track"><span class="settings-big-toggle-thumb"></span></span>
          <span class="settings-big-toggle-state">${on ? 'On' : 'Off'}</span>
        </label>
      </div>
      <div class="settings-alarm-toggle-row">
        <div class="settings-alarm-toggle-text">
          <span class="settings-alarm-toggle-label">Claude Notification Sound</span>
          <span class="settings-alarm-toggle-desc">Plays a chime through the dashboard when Claude Code finishes working and is waiting for your input or a permission decision.</span>
        </div>
        <label class="settings-big-toggle">
          <input type="checkbox" id="settings-claude-notify-enabled" ${notifyOn ? 'checked' : ''}>
          <span class="settings-big-toggle-track"><span class="settings-big-toggle-thumb"></span></span>
          <span class="settings-big-toggle-state">${notifyOn ? 'On' : 'Off'}</span>
        </label>
      </div>`;
  }

  // Object list (externalMonitors, bookmarks, cliTools)
  if (section.type === 'object-list') {
    const items = _settingsConfig[section.configKey] || [];
    html += `<div class="settings-object-list" data-config-key="${section.configKey}">`;
    for (let i = 0; i < items.length; i++) {
      html += renderObjectRow(section, items[i], i);
    }
    html += `<button class="btn settings-row-add" data-config-key="${section.configKey}">+ Add</button>`;
    html += '</div>';
  }

  // Keyed objects (services, quickActions, envDiff)
  if (section.type === 'keyed-objects') {
    const obj = _settingsConfig[section.configKey] || {};
    html += `<div class="settings-keyed-objects" data-config-key="${section.configKey}">`;
    for (const [key, val] of Object.entries(obj)) {
      if (val == null) continue;
      html += renderKeyedObjectRow(section, key, val);
    }
    html += `<div class="settings-keyed-add-row">`;
    html += `<input type="text" class="settings-input settings-new-key" placeholder="New key..." data-config-key="${section.configKey}">`;
    html += `<button class="btn settings-row-add-keyed" data-config-key="${section.configKey}">+ Add</button>`;
    html += `</div>`;
    html += '</div>';
  }

  return html;
}

function renderObjectRow(section, item, index) {
  let html = `<div class="settings-object-row" data-index="${index}">`;
  html += '<div class="settings-object-fields">';
  for (const f of section.objectFields) {
    const val = item[f.key] || '';
    const displayVal = Array.isArray(val) ? val.join(', ') : String(val);
    html += `<div class="settings-field settings-field-inline">`;
    html += `<label class="settings-label-sm">${_esc(f.label)}</label>`;
    if (f.type === 'select') {
      html += `<select class="settings-input settings-obj-field" data-field="${f.key}">`;
      for (const opt of (f.options || [])) {
        html += `<option value="${_esc(opt)}"${val === opt ? ' selected' : ''}>${_esc(opt)}</option>`;
      }
      html += `</select>`;
    } else {
      html += `<input type="${f.type || 'text'}" class="settings-input settings-obj-field" data-field="${f.key}" value="${_esc(displayVal)}" placeholder="${_esc(f.placeholder || '')}">`;
    }
    html += `</div>`;
  }
  html += '</div>';
  html += `<button class="btn settings-row-remove" data-index="${index}" title="Remove">\u2715</button>`;
  html += '</div>';
  return html;
}

function renderKeyedObjectRow(section, key, val) {
  let html = `<div class="settings-keyed-row" data-key="${_esc(key)}">`;
  html += `<div class="settings-keyed-header">`;
  html += `<span class="settings-keyed-key">${_esc(key)}</span>`;
  html += `<button class="btn settings-row-remove-keyed" data-key="${_esc(key)}" title="Remove">\u2715</button>`;
  html += `</div>`;
  html += '<div class="settings-object-fields">';
  for (const f of section.objectFields) {
    const fieldVal = val[f.key] || '';
    const displayVal = Array.isArray(fieldVal) ? fieldVal.join(', ') : String(fieldVal);
    html += `<div class="settings-field settings-field-inline">`;
    html += `<label class="settings-label-sm">${_esc(f.label)}</label>`;
    if (f.type === 'select') {
      html += `<select class="settings-input settings-keyed-field" data-field="${f.key}">`;
      for (const opt of (f.options || [])) {
        html += `<option value="${_esc(opt)}"${fieldVal === opt ? ' selected' : ''}>${_esc(opt)}</option>`;
      }
      html += `</select>`;
    } else {
      html += `<input type="${f.type || 'text'}" class="settings-input settings-keyed-field" data-field="${f.key}" value="${_esc(displayVal)}" placeholder="${_esc(f.placeholder || '')}">`;
    }
    html += `</div>`;
  }
  html += '</div></div>';
  return html;
}

// ---------------------------------------------------------------------------
// Wire events
// ---------------------------------------------------------------------------
function wireSettingsEvents(container) {
  const saveBtn = container.querySelector('#settings-save-btn');
  const reloadBtn = container.querySelector('#settings-reload-btn');
  const statusEl = container.querySelector('#settings-status');
  const collapseBtn = container.querySelector('#settings-collapse-all');

  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      const sections = container.querySelectorAll('details.settings-section');
      const allClosed = [...sections].every(d => !d.open);
      sections.forEach(d => d.open = allClosed);
      collapseBtn.textContent = allClosed ? 'Collapse All' : 'Expand All';
    });
  }

  function markDirty() {
    _settingsDirty = true;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save All Changes *';
    statusEl.textContent = 'Unsaved changes';
    statusEl.className = 'settings-status dirty';
  }

  // Global alarm toggle (not a config field — stored in localStorage)
  const alarmToggle = container.querySelector('#settings-alarm-enabled');
  if (alarmToggle) {
    alarmToggle.addEventListener('change', () => {
      if (typeof window.setAlarmEnabled === 'function') window.setAlarmEnabled(alarmToggle.checked);
      const stateEl = alarmToggle.closest('.settings-big-toggle')?.querySelector('.settings-big-toggle-state');
      if (stateEl) stateEl.textContent = alarmToggle.checked ? 'On' : 'Off';
    });
  }

  // Claude notification sound toggle (not a config field — stored in localStorage)
  const claudeNotifyToggle = container.querySelector('#settings-claude-notify-enabled');
  if (claudeNotifyToggle) {
    claudeNotifyToggle.addEventListener('change', () => {
      if (typeof window.setClaudeNotifyEnabled === 'function') window.setClaudeNotifyEnabled(claudeNotifyToggle.checked);
      const stateEl = claudeNotifyToggle.closest('.settings-big-toggle')?.querySelector('.settings-big-toggle-state');
      if (stateEl) stateEl.textContent = claudeNotifyToggle.checked ? 'On' : 'Off';
    });
  }

  // Simple field inputs (text, number)
  container.querySelectorAll('.settings-input[data-path]').forEach(input => {
    const evt = input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(evt, () => {
      const val = input.type === 'number' ? (parseInt(input.value, 10) || 0) : input.value;
      deepSet(_settingsConfig, input.dataset.path, val);
      markDirty();
    });
  });

  // Toggle (checkbox) fields
  container.querySelectorAll('.settings-checkbox[data-path]').forEach(cb => {
    cb.addEventListener('change', () => {
      deepSet(_settingsConfig, cb.dataset.path, cb.checked);
      const label = cb.parentElement.querySelector('.settings-toggle-label');
      if (label) label.textContent = cb.checked ? 'Enabled' : 'Disabled';
      markDirty();
    });
  });

  // Chip list — add on Enter
  container.querySelectorAll('.settings-chip-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      e.preventDefault();
      const path = input.dataset.listPath;
      const arr = deepGet(_settingsConfig, path) || [];
      arr.push(input.value.trim());
      deepSet(_settingsConfig, path, arr);
      input.value = '';
      markDirty();
      renderSettings(container);
    });
  });

  // Chip remove
  container.querySelectorAll('.settings-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.settings-list-block');
      const path = block.dataset.listPath;
      const arr = deepGet(_settingsConfig, path) || [];
      const val = btn.dataset.value;
      const idx = arr.indexOf(val);
      if (idx !== -1) arr.splice(idx, 1);
      deepSet(_settingsConfig, path, arr);
      markDirty();
      renderSettings(container);
    });
  });

  // ADO picker — fetch button
  container.querySelectorAll('.settings-ado-fetch-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const listPath = btn.dataset.listPath;
      const source   = btn.dataset.source;
      const optionsEl = container.querySelector(`.settings-ado-options[data-list-path="${listPath}"]`);
      btn.disabled = true;
      btn.textContent = '↻ Loading…';
      try {
        const res = await fetch(source);
        if (!res.ok) throw new Error(await res.text());
        const available = await res.json();
        const currentList = deepGet(_settingsConfig, listPath) || [];
        // Support both plain strings and {label, value} objects
        const isLabeled = available.length > 0 && typeof available[0] === 'object';
        const currentSet = new Set(currentList.map(s => String(s).toLowerCase()));
        let html = '';
        if (isLabeled) {
          // Label/value mode — value stored, label displayed
          const availableValues = new Set(available.map(item => String(item.value)));
          const notInAdo = currentList.filter(item => !availableValues.has(String(item)));
          if (notInAdo.length) {
            html += notInAdo.map(item =>
              `<label class="settings-ado-option">
                <input type="checkbox" checked data-value="${_esc(String(item))}">
                ${_esc(String(item))} <span class="settings-ado-orphan-badge">⚠ not found</span>
              </label>`
            ).join('');
          }
          html += available.map(item =>
            `<label class="settings-ado-option">
              <input type="checkbox" ${currentSet.has(String(item.value).toLowerCase()) ? 'checked' : ''} data-value="${_esc(String(item.value))}">
              ${_esc(item.label)}
            </label>`
          ).join('');
        } else {
          // Plain string mode (existing behaviour)
          const availableLower = new Map(available.map(item => [item.toLowerCase(), item]));
          const notInAdo = currentList.filter(item => !availableLower.has(String(item).toLowerCase()));
          if (notInAdo.length) {
            html += notInAdo.map(item =>
              `<label class="settings-ado-option">
                <input type="checkbox" checked data-value="${_esc(item)}">
                ${_esc(item)} <span class="settings-ado-orphan-badge">⚠ not in ADO</span>
              </label>`
            ).join('');
          }
          html += available.map(item =>
            `<label class="settings-ado-option">
              <input type="checkbox" ${currentSet.has(item.toLowerCase()) ? 'checked' : ''} data-value="${_esc(item)}">
              ${_esc(item)}
            </label>`
          ).join('');
        }
        optionsEl.innerHTML = html;
        _wireAdoCheckboxes(optionsEl, listPath, markDirty);
      } catch (err) {
        optionsEl.innerHTML = `<span class="settings-ado-error">Failed: ${_esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '↻ Fetch';
      }
    });
  });

  // ADO picker — wire already-rendered checkboxes (current config items shown on load)
  container.querySelectorAll('.settings-ado-options').forEach(optionsEl => {
    _wireAdoCheckboxes(optionsEl, optionsEl.dataset.listPath, markDirty);
  });

  // String list item edits
  container.querySelectorAll('.settings-list-item').forEach(input => {
    input.addEventListener('input', () => {
      const listEl = input.closest('.settings-string-list');
      const configKey = listEl.dataset.configKey;
      const idx = parseInt(input.dataset.index, 10);
      const val = input.value;
      // If contains comma, treat as tuple
      if (val.includes(',')) {
        _settingsConfig[configKey][idx] = val.split(',').map(s => s.trim());
      } else {
        _settingsConfig[configKey][idx] = val;
      }
      markDirty();
    });
  });

  // String list remove
  container.querySelectorAll('.settings-string-list .settings-row-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const listEl = btn.closest('.settings-string-list');
      const configKey = listEl.dataset.configKey;
      const idx = parseInt(btn.dataset.index, 10);
      _settingsConfig[configKey].splice(idx, 1);
      markDirty();
      renderSettings(container);
    });
  });

  // String list add
  container.querySelectorAll('.settings-string-list .settings-row-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const configKey = btn.dataset.configKey;
      if (!_settingsConfig[configKey]) _settingsConfig[configKey] = [];
      _settingsConfig[configKey].push('');
      markDirty();
      renderSettings(container);
    });
  });

  // Object list field edits
  container.querySelectorAll('.settings-object-list .settings-obj-field').forEach(input => {
    input.addEventListener('input', () => {
      const row = input.closest('.settings-object-row');
      const listEl = row.closest('.settings-object-list');
      const configKey = listEl.dataset.configKey;
      const idx = parseInt(row.dataset.index, 10);
      const field = input.dataset.field;
      let val = input.value;
      // Handle comma-separated arrays (for args fields)
      if (field === 'args' && val.includes(',')) {
        val = val.split(',').map(s => s.trim());
      }
      _settingsConfig[configKey][idx][field] = val;
      markDirty();
    });
  });
  container.querySelectorAll('.settings-object-list .settings-obj-field[data-field]').forEach(select => {
    if (select.tagName === 'SELECT') {
      select.addEventListener('change', () => {
        const row = select.closest('.settings-object-row');
        const listEl = row.closest('.settings-object-list');
        const configKey = listEl.dataset.configKey;
        const idx = parseInt(row.dataset.index, 10);
        _settingsConfig[configKey][idx][select.dataset.field] = select.value;
        markDirty();
      });
    }
  });

  // Object list remove
  container.querySelectorAll('.settings-object-list .settings-row-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const listEl = btn.closest('.settings-object-list');
      const configKey = listEl.dataset.configKey;
      const idx = parseInt(btn.dataset.index, 10);
      _settingsConfig[configKey].splice(idx, 1);
      markDirty();
      renderSettings(container);
    });
  });

  // Object list add
  container.querySelectorAll('.settings-object-list .settings-row-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const configKey = btn.dataset.configKey;
      if (!_settingsConfig[configKey]) _settingsConfig[configKey] = [];
      const section = SETTINGS_SECTIONS.find(s => s.configKey === configKey);
      const newItem = {};
      for (const f of section.objectFields) newItem[f.key] = '';
      _settingsConfig[configKey].push(newItem);
      markDirty();
      renderSettings(container);
    });
  });

  // Keyed object field edits
  container.querySelectorAll('.settings-keyed-objects .settings-keyed-field').forEach(input => {
    const handler = () => {
      const row = input.closest('.settings-keyed-row');
      const listEl = row.closest('.settings-keyed-objects');
      const configKey = listEl.dataset.configKey;
      const key = row.dataset.key;
      const field = input.dataset.field;
      let val = input.value;
      if (field === 'args' && val.includes(',')) {
        val = val.split(',').map(s => s.trim());
      } else if (field === 'port') {
        val = parseInt(val, 10) || 0;
      }
      if (_settingsConfig[configKey] && _settingsConfig[configKey][key]) {
        _settingsConfig[configKey][key][field] = val;
      }
      markDirty();
    };
    input.addEventListener('input', handler);
    if (input.tagName === 'SELECT') input.addEventListener('change', handler);
  });

  // Keyed object remove
  container.querySelectorAll('.settings-row-remove-keyed').forEach(btn => {
    btn.addEventListener('click', () => {
      const listEl = btn.closest('.settings-keyed-objects');
      const configKey = listEl.dataset.configKey;
      const key = btn.dataset.key;
      delete _settingsConfig[configKey][key];
      markDirty();
      renderSettings(container);
    });
  });

  // Keyed object add
  container.querySelectorAll('.settings-row-add-keyed').forEach(btn => {
    btn.addEventListener('click', () => {
      const configKey = btn.dataset.configKey;
      const input = btn.parentElement.querySelector('.settings-new-key');
      const newKey = input.value.trim();
      if (!newKey) return;
      if (!_settingsConfig[configKey]) _settingsConfig[configKey] = {};
      if (_settingsConfig[configKey][newKey]) {
        alert(`Key "${newKey}" already exists`);
        return;
      }
      const section = SETTINGS_SECTIONS.find(s => s.configKey === configKey);
      const newItem = {};
      for (const f of section.objectFields) newItem[f.key] = '';
      _settingsConfig[configKey][newKey] = newItem;
      input.value = '';
      markDirty();
      renderSettings(container);
    });
  });

  // Save
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    statusEl.textContent = '';
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_settingsConfig),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      _settingsDirty = false;
      saveBtn.textContent = 'Save All Changes';
      statusEl.textContent = data.message || 'Saved!';
      statusEl.className = 'settings-status saved';
      setTimeout(() => {
        if (!_settingsDirty) { statusEl.textContent = ''; statusEl.className = 'settings-status'; }
      }, 5000);
      // Refresh repo dropdown so newly added repos appear immediately
      if (typeof window.refreshRepoList === 'function') window.refreshRepoList();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save All Changes *';
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'settings-status error';
    }
  });

  // Reload
  reloadBtn.addEventListener('click', async () => {
    if (_settingsDirty && !confirm('Discard unsaved changes?')) return;
    await initSettings();
  });

  // Repo discovery
  wireRepoDiscovery(container, markDirty);

  // Render the local-only Visibility section
  renderVisibilitySection(container);

  // Environment variable fields — load status and wire save/test/toggle buttons
  loadEnvStatus(container);

  // Save button
  container.querySelectorAll('.settings-env-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.envKey;
      const input = container.querySelector(`.settings-env-input[data-env-key="${key}"]`);
      if (!input || !input.value.trim()) return;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/env', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: input.value.trim() }),
        });
        if (!res.ok) throw new Error('Failed to save');
        input.value = '';
        input.type = 'password';
        input.placeholder = 'Updated — saved to .env';
        loadEnvStatus(container);
      } catch (err) {
        btn.textContent = 'Error';
      } finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Save'; }, 1500);
      }
    });
  });

  // Show/hide toggle
  container.querySelectorAll('.settings-env-toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = container.querySelector(`.settings-env-input[data-env-key="${btn.dataset.envKey}"]`);
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.classList.toggle('active', isPassword);
    });
  });

  // Test connection button
  container.querySelectorAll('.settings-env-test').forEach(btn => {
    btn.addEventListener('click', async () => {
      const endpoint = btn.dataset.testEndpoint;
      const key = btn.dataset.envKey;
      const resultEl = container.querySelector(`[data-test-result="${key}"]`);
      btn.disabled = true;
      btn.textContent = 'Testing...';
      if (resultEl) resultEl.innerHTML = '';
      try {
        const res = await fetch(endpoint);
        const data = await res.json();
        if (data.ok) {
          if (resultEl) resultEl.innerHTML = `<span class="env-test-pass">\u2705 ${_esc(data.message)}</span>`;
        } else {
          if (resultEl) resultEl.innerHTML = `<span class="env-test-fail">\u274C ${_esc(data.error)}</span>`;
        }
      } catch (err) {
        if (resultEl) resultEl.innerHTML = `<span class="env-test-fail">\u274C ${_esc(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });
  });
}

async function loadEnvStatus(container) {
  try {
    const res = await fetch('/api/env');
    const data = await res.json();
    for (const [key, info] of Object.entries(data)) {
      const statusEl = container.querySelector(`[data-env-status="${key}"]`);
      if (statusEl) {
        if (info.set) {
          statusEl.innerHTML = `<span class="env-set">\u2705 Set (${_esc(info.masked)})</span>`;
        } else {
          statusEl.innerHTML = `<span class="env-unset">\u26A0 Not set</span>`;
        }
      }
      const input = container.querySelector(`.settings-env-input[data-env-key="${key}"]`);
      if (input && info.set) {
        input.placeholder = 'Token is set — enter new value to update';
      }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Repo Discovery
// ---------------------------------------------------------------------------
function wireRepoDiscovery(container, markDirty) {
  const scanBtn = container.querySelector('.repo-discover-scan-btn');
  if (!scanBtn) return;
  const resultsEl = container.querySelector('.repo-discover-results');
  const searchWrap = container.querySelector('.repo-disc-search');
  const searchInput = container.querySelector('.repo-disc-search-input');
  const searchClear = container.querySelector('.repo-disc-search-clear');

  // Filter discovered repo rows by search text
  function filterRows() {
    const q = (searchInput.value || '').toLowerCase();
    searchClear.style.display = q ? 'block' : 'none';
    resultsEl.querySelectorAll('.repo-disc-row').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      const show = !q || name.includes(q);
      row.style.display = show ? '' : 'none';
      // Also hide/show the clone panel that follows this row
      const panel = resultsEl.querySelector(`.repo-disc-clone-panel[data-name="${row.dataset.name}"]`);
      if (panel && !show) panel.style.display = 'none';
    });
  }
  searchInput.addEventListener('input', filterRows);
  searchClear.addEventListener('click', () => { searchInput.value = ''; filterRows(); searchInput.focus(); });

  function addToConfig(repoName, rowEl) {
    if (!_settingsConfig.repos) _settingsConfig.repos = [];
    if (!_settingsConfig.repos.includes(repoName)) {
      _settingsConfig.repos.push(repoName);
      markDirty();
    }
    rowEl.querySelector('.repo-disc-actions').innerHTML = `<span class="repo-disc-tracked">✓ tracked</span>`;
  }

  function renderDiscoveryResults(repos, baseDir) {
    if (!repos.length) {
      resultsEl.innerHTML = '<div class="repo-disc-empty">No repos found. Make sure ADO or GitHub is configured.</div>';
      return;
    }

    const tracked = new Set(((_settingsConfig.repos || []).map(r => (Array.isArray(r) ? r[1] : r).toLowerCase())));
    let html = '';
    for (const r of repos) {
      const isTracked = tracked.has(r.name.toLowerCase()) || (r.fullName && tracked.has(r.fullName.toLowerCase()));
      const sourceClass = r.source === 'ado' ? 'repo-disc-badge-ado' : 'repo-disc-badge-gh';
      const sourceLabel = r.source === 'ado' ? 'ADO' : 'GH';
      const statusClass = r.found ? 'repo-disc-found' : 'repo-disc-missing';
      const statusIcon = r.found ? '●' : '○';
      const pathDisplay = r.found ? r.localPath : 'not found locally';

      let actions = '';
      if (isTracked) {
        actions = `<span class="repo-disc-tracked">✓ tracked</span>`;
      } else if (r.found) {
        actions = `<button class="btn repo-disc-add" data-name="${_esc(r.name)}">+ Add</button>`;
      } else {
        actions = `<button class="btn repo-disc-clone-toggle">Clone ▾</button>`;
      }

      html += `<div class="repo-disc-row" data-name="${_esc(r.name)}" data-source="${_esc(r.source)}" data-clone-url="${_esc(r.cloneUrl || '')}" data-local-path="${_esc(r.localPath || '')}" data-found="${r.found}">
        <span class="repo-disc-status ${statusClass}" title="${r.found ? 'Found locally' : 'Not found locally'}">${statusIcon}</span>
        <span class="repo-disc-name">${_esc(r.name)}</span>
        <span class="repo-disc-badge ${sourceClass}">${sourceLabel}</span>
        <span class="repo-disc-path">${_esc(pathDisplay)}</span>
        <div class="repo-disc-actions">${actions}</div>
      </div>`;

      if (!r.found && !isTracked) {
        const suggestedPath = r.localPath || '';
        const folderName = baseDir && suggestedPath.startsWith(baseDir + '/')
          ? suggestedPath.slice(baseDir.length + 1)
          : suggestedPath.split('/').pop() || r.name;
        html += `<div class="repo-disc-clone-panel" data-name="${_esc(r.name)}" data-basedir="${_esc(baseDir)}" style="display:none">
          <div class="repo-disc-clone-inputs">
            <span class="repo-disc-clone-basedir">${_esc(baseDir)}/</span>
            <input type="text" class="settings-input repo-disc-clone-folder" value="${_esc(folderName)}">
            <button class="btn repo-disc-clone-go">Clone</button>
          </div>
          <pre class="repo-disc-clone-output" style="display:none"></pre>
        </div>`;
      }
    }
    resultsEl.innerHTML = html;

    // Show search filter when more than 1 repo
    searchWrap.style.display = repos.length > 1 ? 'flex' : 'none';
    searchInput.value = '';
    searchClear.style.display = 'none';

    // Wire Add buttons
    resultsEl.querySelectorAll('.repo-disc-add').forEach(btn => {
      btn.addEventListener('click', () => {
        const rowEl = btn.closest('.repo-disc-row');
        addToConfig(btn.dataset.name, rowEl);
      });
    });

    // Wire Clone toggle buttons
    resultsEl.querySelectorAll('.repo-disc-clone-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const rowEl = btn.closest('.repo-disc-row');
        const name = rowEl.dataset.name;
        const panel = resultsEl.querySelector(`.repo-disc-clone-panel[data-name="${name}"]`);
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    });

    // Wire Clone go buttons
    resultsEl.querySelectorAll('.repo-disc-clone-go').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = btn.closest('.repo-disc-clone-panel');
        const name = panel.dataset.name;
        const rowEl = resultsEl.querySelector(`.repo-disc-row[data-name="${name}"]`);
        const source = rowEl?.dataset.source;
        const cloneUrl = rowEl?.dataset.cloneUrl;
        const baseDir = panel.dataset.basedir || '';
        const folder = panel.querySelector('.repo-disc-clone-folder').value.trim();
        const clonePath = baseDir ? baseDir + '/' + folder : folder;
        const outputEl = panel.querySelector('.repo-disc-clone-output');

        if (!folder || !clonePath) return;

        btn.disabled = true;
        btn.textContent = 'Cloning…';
        outputEl.textContent = '';
        outputEl.style.display = 'block';

        const sock = typeof socket !== 'undefined' ? socket : window._socket;
        if (!sock) {
          outputEl.textContent = 'Error: no socket connection';
          btn.disabled = false;
          btn.textContent = 'Clone';
          return;
        }

        const onOutput = ({ repoName, text }) => {
          if (repoName === name) outputEl.textContent += text;
        };
        const onDone = ({ repoName, success, clonePath: donePath }) => {
          if (repoName !== name) return;
          sock.off('repo:clone:output', onOutput);
          sock.off('repo:clone:done', onDone);
          btn.disabled = false;
          btn.textContent = 'Clone';
          if (success) {
            outputEl.textContent += '\n✅ Done!\n';
            // Update the row to show found + Add button
            if (rowEl) {
              rowEl.dataset.found = 'true';
              rowEl.querySelector('.repo-disc-status').textContent = '●';
              rowEl.querySelector('.repo-disc-status').className = 'repo-disc-status repo-disc-found';
              rowEl.querySelector('.repo-disc-path').textContent = donePath || clonePath;
              rowEl.querySelector('.repo-disc-actions').innerHTML = `<button class="btn repo-disc-add" data-name="${_esc(name)}">+ Add</button>`;
              rowEl.querySelector('.repo-disc-add').addEventListener('click', () => addToConfig(name, rowEl));
            }
          } else {
            outputEl.textContent += '\n❌ Clone failed.\n';
          }
        };

        sock.on('repo:clone:output', onOutput);
        sock.on('repo:clone:done', onDone);
        sock.emit('repo:clone', { source, cloneUrl, clonePath, repoName: name });
      });
    });
  }

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = '↻ Scanning…';
    resultsEl.innerHTML = '<div class="repo-disc-empty">Scanning ADO and GitHub…</div>';
    try {
      const res = await fetch('/api/repos/discover');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      // Support both new { baseDir, repos } and legacy array format
      const repos = Array.isArray(data) ? data : (data.repos || []);
      const baseDir = data.baseDir || '';
      renderDiscoveryResults(repos, baseDir);
    } catch (err) {
      resultsEl.innerHTML = `<div class="repo-disc-empty" style="color:var(--red)">Error: ${_esc(err.message)}</div>`;
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = '↻ Scan';
    }
  });
}

// ---------------------------------------------------------------------------
// Visibility section — per-user, stored in ~/.montra/dashboard-user-prefs.json
// ---------------------------------------------------------------------------
async function renderVisibilitySection(container) {
  let section = container.querySelector('#settings-visibility-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'settings-visibility-section';
    container.appendChild(section);
  }

  const allRepos    = (window.DASH_CONFIG?.repos || []).map(r => Array.isArray(r) ? r[0] : r);
  const allServices = window.DASH_CONFIG?.externalMonitors || [];

  let res;
  try {
    res = await fetch('/api/user-prefs');
    res = res.ok ? await res.json() : {};
  } catch { res = {}; }

  const hiddenRepos    = new Set(res.hiddenRepos    || []);
  const hiddenServices = new Set(res.hiddenServices || []);

  let html = `
    <details class="settings-section" open>
      <summary class="settings-section-header">
        <span class="settings-section-icon">&#x1F441;</span>
        <span class="settings-section-title">Visibility</span>
        <span class="settings-section-desc">Local only &mdash; not synced to dashboard.config.json</span>
      </summary>
      <div class="settings-section-body">
        <p class="settings-visibility-note">Hidden items are yours alone &mdash; teammates still see everything. Stored in <code>~/.montra/dashboard-user-prefs.json</code>.</p>
  `;

  if (allRepos.length) {
    html += '<div class="settings-visibility-group"><div class="settings-visibility-group-label">Repos</div>';
    for (const r of allRepos) {
      const hidden = hiddenRepos.has(r);
      html += `
        <label class="settings-visibility-row">
          <input type="checkbox" class="vis-repo-toggle" data-name="${_esc(r)}" ${hidden ? '' : 'checked'}>
          <span class="vis-item-name">${_esc(r)}</span>
          ${hidden ? '<span class="vis-hidden-badge">hidden</span>' : ''}
        </label>`;
    }
    html += '</div>';
  }

  if (allServices.length) {
    html += '<div class="settings-visibility-group"><div class="settings-visibility-group-label">External Services</div>';
    for (const s of allServices) {
      const hidden = hiddenServices.has(s.key);
      html += `
        <label class="settings-visibility-row">
          <input type="checkbox" class="vis-service-toggle" data-key="${_esc(s.key)}" ${hidden ? '' : 'checked'}>
          <span class="vis-item-name">${_esc(s.label)}</span>
          ${hidden ? '<span class="vis-hidden-badge">hidden</span>' : ''}
        </label>`;
    }
    html += '</div>';
  }

  html += '</div></details>';
  section.innerHTML = html;

  section.querySelectorAll('.vis-repo-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      if (typeof toggleHiddenRepo === 'function') await toggleHiddenRepo(cb.dataset.name);
      renderVisibilitySection(container);
    });
  });

  section.querySelectorAll('.vis-service-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      if (typeof toggleHiddenService === 'function') await toggleHiddenService(cb.dataset.key);
      renderVisibilitySection(container);
    });
  });
}
