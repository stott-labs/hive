/* Widget: test-runner */

WIDGET_REGISTRY['test-runner'] = {
  title: 'Test Runner',
  icon: '\uD83E\uDDEA',
  defaultSize: { w: 6, h: 6 },
  minW: 4,
  minH: 4,

  // Strip all ANSI escape sequences from text
  _stripAnsi: (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),

  // Extract structured failure info from vitest/jest output
  _extractFailures(text) {
    const clean = this._stripAnsi(text);
    const failures = [];
    const lines = clean.split('\n');

    // Strategy 1: Parse FAIL blocks (vitest verbose format)
    // Lines like: "FAIL  src/path/to/file.test.ts > describe > test name"
    // Followed by error details
    let currentFile = null;
    let currentTest = null;
    let currentError = [];
    let inError = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Vitest FAIL line: " × src/path/file.test.ts > describe > test name 5ms"
      // or: " FAIL  src/path/file.test.ts"
      const failMatch = trimmed.match(/^[×✗]\s+(.+?\.(?:test|spec)\.[tj]sx?)\s*>\s*(.+?)(?:\s+\d+ms)?$/);
      if (failMatch) {
        // Save previous failure
        if (currentFile && currentTest) {
          failures.push({ file: currentFile, test: currentTest, error: currentError.join('\n').trim() });
        }
        currentFile = failMatch[1];
        currentTest = failMatch[2];
        currentError = [];
        inError = true;
        continue;
      }

      // Vitest summary FAIL line: "FAIL  src/path/file.test.ts > describe > test"
      const failLine = trimmed.match(/^FAIL\s+(.+?\.(?:test|spec)\.[tj]sx?)(?:\s*>\s*(.+))?/);
      if (failLine) {
        if (currentFile && currentTest) {
          failures.push({ file: currentFile, test: currentTest, error: currentError.join('\n').trim() });
        }
        currentFile = failLine[1];
        currentTest = failLine[2] || '';
        currentError = [];
        inError = true;
        continue;
      }

      // Error context lines (Expected, Received, AssertionError, stack traces)
      if (inError) {
        if (trimmed.startsWith('Expected') || trimmed.startsWith('Received') ||
            trimmed.startsWith('- ') || trimmed.startsWith('+ ') ||
            trimmed.startsWith('Error') || trimmed.startsWith('Assertion') ||
            trimmed.startsWith('TypeError') || trimmed.startsWith('ReferenceError') ||
            trimmed.startsWith('at ') || trimmed.startsWith('›') ||
            (trimmed && currentError.length < 20)) {
          currentError.push(line);
        }
        // End of error block on empty line or next test
        if (!trimmed && currentError.length > 2) {
          inError = false;
        }
      }
    }
    // Push last one
    if (currentFile && currentTest) {
      failures.push({ file: currentFile, test: currentTest, error: currentError.join('\n').trim() });
    }

    // Fallback: if structured parsing found nothing, look for "Failed Tests" summary
    if (failures.length === 0) {
      const failedFiles = [];
      for (const line of lines) {
        const m = line.trim().match(/^FAIL\s+(.+?\.(?:test|spec)\.[tj]sx?)/);
        if (m && !failedFiles.includes(m[1])) failedFiles.push(m[1]);
      }
      for (const f of failedFiles) {
        failures.push({ file: f, test: '(see test output)', error: '' });
      }
    }

    return failures;
  },

  // Build a Claude-ready prompt from failures
  _buildFixPrompt(failures) {
    const repo = this._repo;
    let prompt = `Fix ${failures.length} failing test${failures.length === 1 ? '' : 's'} in ${repo}:\n\n`;

    // Group by file
    const byFile = {};
    for (const f of failures) {
      if (!byFile[f.file]) byFile[f.file] = [];
      byFile[f.file].push(f);
    }

    for (const [file, tests] of Object.entries(byFile)) {
      prompt += `## ${file}\n`;
      for (const t of tests) {
        prompt += `- **${t.test}**\n`;
        if (t.error) {
          // Trim error to first 10 lines to keep prompt manageable
          const errorLines = t.error.split('\n').slice(0, 10).join('\n');
          prompt += '```\n' + errorLines + '\n```\n';
        }
      }
      prompt += '\n';
    }

    prompt += `Read each failing test file, understand what it's testing, and fix the failures. `;
    prompt += `If the test expectations are wrong (testing outdated behavior), update the tests. `;
    prompt += `If the source code has a bug that the test correctly catches, fix the source code.`;

    return prompt;
  },

  // Filter log to only show failures, errors, and context lines.
  // Removes lines that are passing tests (✓ / √ / ✔ / PASS prefix).
  _filterFailures(text) {
    const lines = text.split('\n');
    const out = [];
    let keepBlock = false; // track whether we're inside a failing block
    for (const line of lines) {
      const trimmed = line.trim();
      // Always keep: empty lines, separators, suite headers, fail markers, errors, summaries
      if (!trimmed ||
          trimmed.startsWith('---') ||
          trimmed.startsWith('FAIL') ||
          trimmed.startsWith('●') ||
          trimmed.startsWith('✕') || trimmed.startsWith('✗') || trimmed.startsWith('×') ||
          trimmed.startsWith('Expected') || trimmed.startsWith('Received') ||
          trimmed.startsWith('at ') || trimmed.startsWith('Error') ||
          trimmed.startsWith('Test Suites:') || trimmed.startsWith('Tests:') ||
          trimmed.startsWith('Snapshots:') || trimmed.startsWith('Time:') ||
          trimmed.startsWith('Ran all') ||
          /^\d+ (failed|passing|pending)/.test(trimmed) ||
          /FAILED|BROKEN|ERROR/.test(trimmed)) {
        out.push(line);
        keepBlock = true;
      }
      // Skip passing test lines
      else if (/^\s*[✓√✔]\s/.test(line) || trimmed.startsWith('PASS')) {
        keepBlock = false;
        continue;
      }
      // Keep context if we're in a failing block (indented expect/received/diff lines)
      else if (keepBlock && (line.startsWith('    ') || line.startsWith('\t'))) {
        out.push(line);
      }
      // Keep describe/context headers
      else if (/^\s{0,4}\S/.test(line) && !line.match(/^\s*[✓√✔]\s/)) {
        out.push(line);
        keepBlock = false;
      }
    }
    return out.join('\n');
  },

  init(contentEl, socket) {
    this._el = contentEl;
    this._socket = socket;
    this._log = '';
    this._running = false;
    this._timerId = null;
    this._failsOnly = localStorage.getItem('test-runner-fails-only') === 'true';
    const repoList = (window.DASH_CONFIG?.repos || []).map(r => Array.isArray(r) ? r[0] : r);
    this._repo = localStorage.getItem('test-runner-repo') || repoList[0] || 'montra-via-api';
    this._pattern = localStorage.getItem('test-runner-pattern') || '';
    this._lastResult = null;

    this._onOutput = ({ text }) => {
      this._log += text;
      // Hard cap — only keep the last 100KB
      if (this._log.length > 100000) this._log = this._log.slice(-80000);
      this._scheduleUpdate();
    };
    this._onDone = ({ success, cancelled }) => {
      this._running = false;
      this._lastResult = cancelled ? null : (success ? 'pass' : 'fail');
      const ts = new Date().toLocaleTimeString();
      const label = cancelled ? 'Cancelled' : (success ? 'PASSED' : 'FAILED');
      this._log += `\n--- ${label} at ${ts} ---\n`;
      if (this._timerId) { clearTimeout(this._timerId); this._timerId = null; }
      this._flushLog();
      this._updateControls();
    };

    socket.on('test-output', this._onOutput);
    socket.on('test-done', this._onDone);
    this._render();
  },

  async _render() {
    const el = this._el;
    let repos = (window.DASH_CONFIG?.repos || []).map(r => Array.isArray(r) ? r[0] : r);

    if (repos.length === 0) {
      try {
        const res = await fetch('/api/config');
        const cfg = await res.json();
        repos = (cfg.repos || []).map(r => Array.isArray(r) ? r[0] : r);
      } catch { /* use empty */ }
    }

    const hiddenRepos = typeof getHiddenRepos === 'function' ? getHiddenRepos() : new Set();
    repos = repos.filter(r => !hiddenRepos.has(r));

    let html = '<div class="test-runner-toolbar">';
    html += '<select class="test-runner-repo">';
    for (const r of repos) {
      html += `<option value="${esc(r)}"${r === this._repo ? ' selected' : ''}>${esc(r)}</option>`;
    }
    html += '</select>';
    html += `<input type="text" class="test-runner-pattern" placeholder="Filter (path pattern or test name)" value="${esc(this._pattern)}" />`;
    html += '<button class="btn btn-start test-runner-run-btn">Run</button>';
    html += '<button class="btn test-runner-stop-btn" style="display:none" title="Stop">Stop</button>';
    html += '<button class="btn test-runner-clear-btn" title="Clear log">\u2715</button>';
    html += `<button class="btn test-runner-filter-btn${this._failsOnly ? ' active' : ''}" title="Show only failures">Failures</button>`;
    html += '<button class="btn test-runner-fix-btn" title="Copy failing tests as a prompt for Claude to fix" style="display:none">Fix with AI</button>';
    html += '</div>';


    html += '<div class="test-runner-status"></div>';
    html += '<pre class="test-runner-log"></pre>';

    el.innerHTML = html;
    if (this._log) this._flushLog();

    // Wire events
    el.querySelector('.test-runner-repo').addEventListener('change', (e) => {
      this._repo = e.target.value;
      localStorage.setItem('test-runner-repo', this._repo);
    });
    el.querySelector('.test-runner-pattern').addEventListener('input', (e) => {
      this._pattern = e.target.value;
      localStorage.setItem('test-runner-pattern', this._pattern);
    });
    el.querySelector('.test-runner-pattern').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._runTests();
    });
    el.querySelector('.test-runner-run-btn').addEventListener('click', () => this._runTests());
    el.querySelector('.test-runner-stop-btn').addEventListener('click', () => this._stopTests());
    el.querySelector('.test-runner-clear-btn').addEventListener('click', () => {
      this._log = '';
      this._lastResult = null;
      this._flushLog();
    });
    el.querySelector('.test-runner-filter-btn').addEventListener('click', (e) => {
      this._failsOnly = !this._failsOnly;
      localStorage.setItem('test-runner-fails-only', this._failsOnly);
      e.target.classList.toggle('active', this._failsOnly);
      this._flushLog();
    });
    el.querySelector('.test-runner-fix-btn').addEventListener('click', () => {
      const failures = this._extractFailures(this._log);
      if (!failures.length) return;
      const prompt = this._buildFixPrompt(failures);
      navigator.clipboard.writeText(prompt).then(() => {
        const btn = this._el.querySelector('.test-runner-fix-btn');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });

    this._updateControls();
  },

  _runTests(suite) {
    if (this._running) return;
    this._running = true;
    this._lastResult = null;
    const ts = new Date().toLocaleTimeString();
    this._log += `\n--- Starting tests at ${ts} ---\n`;
    this._flushLog();
    this._updateControls();
    this._updateStatus('running');

    this._socket.emit('test-run', {
      repo: this._repo,
      pattern: this._pattern || undefined,
      suite: suite || 'all',
    });
  },

  _stopTests() {
    if (!this._running) return;
    this._socket.emit('test-stop');
  },

  // Throttle to 300ms — log viewer doesn't need fast updates
  _scheduleUpdate() {
    if (this._timerId) return;
    this._timerId = setTimeout(() => {
      this._timerId = null;
      this._flushLog();
    }, 300);
  },

  _flushLog() {
    const logEl = this._el.querySelector('.test-runner-log');
    if (!logEl) return;

    // textContent is the fastest possible DOM update — single text node, no parsing
    let clean = this._stripAnsi(this._log);
    if (this._failsOnly) clean = this._filterFailures(clean);
    // Only show last 50K chars to keep the DOM small
    logEl.textContent = clean.length > 50000 ? clean.slice(-50000) : clean;

    // Auto-scroll: set to a huge value (avoids reading scrollHeight)
    const body = this._el.closest('.widget-body');
    if (body) body.scrollTop = 9999999;

    this._updateStatus();
  },

  _updateControls() {
    const runBtn = this._el.querySelector('.test-runner-run-btn');
    const stopBtn = this._el.querySelector('.test-runner-stop-btn');
    const fixBtn = this._el.querySelector('.test-runner-fix-btn');
    if (runBtn) {
      runBtn.style.display = this._running ? 'none' : '';
      runBtn.disabled = this._running;
    }
    if (stopBtn) {
      stopBtn.style.display = this._running ? '' : 'none';
    }
    if (fixBtn) {
      fixBtn.style.display = (!this._running && this._lastResult === 'fail') ? '' : 'none';
    }
  },

  _updateStatus(override) {
    const statusEl = this._el.querySelector('.test-runner-status');
    if (!statusEl) return;
    if (override === 'running') {
      statusEl.textContent = 'Running...';
      statusEl.className = 'test-runner-status running';
      return;
    }
    if (this._lastResult === 'pass') {
      statusEl.textContent = 'All tests passed';
      statusEl.className = 'test-runner-status pass';
    } else if (this._lastResult === 'fail') {
      statusEl.textContent = 'Tests failed';
      statusEl.className = 'test-runner-status fail';
    } else {
      statusEl.textContent = '';
      statusEl.className = 'test-runner-status';
    }
  },

  refresh() { this._render(); },

  destroy(socket) {
    if (this._timerId) clearTimeout(this._timerId);
    if (this._onOutput) socket.off('test-output', this._onOutput);
    if (this._onDone) socket.off('test-done', this._onDone);
    socket.emit('test-stop');
  },
};
