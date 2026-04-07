import { createServer } from 'node:http';
import { createConnection as netConnect } from 'node:net';
import { execSync, execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { join, dirname, relative, normalize, sep, isAbsolute } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, readlinkSync, mkdirSync, writeFileSync, copyFileSync, watch, unlinkSync, renameSync, rmdirSync } from 'node:fs';
import vm from 'node:vm';
import dotenv from 'dotenv';
import express from 'express';
import pg from 'pg';
import { Server as SocketIO } from 'socket.io';
import AdmZip from 'adm-zip';
import multer from 'multer';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load dashboard config — all project-specific values come from this file
// ---------------------------------------------------------------------------
const CONFIG_PATH = join(__dirname, 'dashboard.config.json');
const CONFIG_EXAMPLE_PATH = join(__dirname, 'dashboard.config.example.json');
if (!existsSync(CONFIG_PATH)) {
  if (existsSync(CONFIG_EXAMPLE_PATH)) {
    copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
    console.warn('⚠  dashboard.config.json not found — created from example. Open Settings to configure.');
  } else {
    console.error('ERROR: dashboard.config.json not found. Copy dashboard.config.example.json and customize it.');
    process.exit(1);
  }
}
const _configRaw = readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, '').trim();
let CONFIG = _configRaw ? JSON.parse(_configRaw) : {};

// Load .env from repo root
dotenv.config({ path: join(__dirname, '.env') });
// Capture PORT before loading API .env (which may define its own PORT)
const PORT = parseInt(process.env.PORT || CONFIG.port || '3333', 10);
// Load API .env for DB credentials only — restore PORT so API's value doesn't hijack the dashboard
const apiRepoDir = CONFIG.services?.api?.repoDir;
if (apiRepoDir) {
  dotenv.config({ path: join(__dirname, '..', apiRepoDir, '.env'), override: false });
}
process.env.PORT = String(PORT); // ensure dashboard port wins
const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Base path resolution — reads from config, falls back to auto-detect
// ---------------------------------------------------------------------------
function resolveBasePath() {
  const candidates = [
    // Prefer explicit projectsDir from config (set by setup)
    CONFIG.projectsDir,
    // Legacy basePaths format
    isWindows ? CONFIG.basePaths?.windows : CONFIG.basePaths?.mac,
    // Fallback: parent of the hive directory
    join(__dirname, '..'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  console.error('ERROR: Cannot locate project directories. Check projectsDir in dashboard.config.json');
  process.exit(1);
}

const BASE_DIR = resolveBasePath();

// ---------------------------------------------------------------------------
// Repo list — from config
// ---------------------------------------------------------------------------
// Resolve a path alias to an absolute directory.
// If the alias is already absolute (e.g. "D:\\repos\\x"), use it directly.
// Otherwise join it under BASE_DIR.
function resolveRepoPath(alias) {
  return isAbsolute(alias) ? alias : join(BASE_DIR, alias);
}

function buildReposResolved(defs) {
  return (defs || []).map(def => {
    if (typeof def === 'string') return { name: def, dir: def };
    const [displayName, ...aliases] = def;
    const found = aliases.find(a => existsSync(join(resolveRepoPath(a), '.git')));
    return { name: displayName, dir: found || aliases[0] };
  });
}

let REPOS_RESOLVED = buildReposResolved(CONFIG.repos);
let REPOS = REPOS_RESOLVED.map(r => r.name);

function repoDir(name) {
  const entry = REPOS_RESOLVED.find(r => r.name === name);
  return entry ? resolveRepoPath(entry.dir) : resolveRepoPath(name);
}

// ---------------------------------------------------------------------------
// Log file definitions — passive tail of log files written by wrapper scripts
// ---------------------------------------------------------------------------
const LOG_DIR = join(homedir(), CONFIG.logDir || '.devdash/logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const LOG_DEFS = {};
for (const [key, svc] of Object.entries(CONFIG.services || {})) {
  if (!svc) continue;
  LOG_DEFS[key] = {
    label: `${svc.label} :${svc.port}`,
    file: join(LOG_DIR, `${key}.log`),
    port: svc.port,
  };
}

// ---------------------------------------------------------------------------
// Passive log file tailer — uses fs.watch (OS-native, zero CPU when idle)
// ---------------------------------------------------------------------------
const logState = new Map(); // key → { buffer, offset, watcher, status }
const MAX_BUFFER = 1000;

for (const key of Object.keys(LOG_DEFS)) {
  logState.set(key, { buffer: [], offset: 0, watcher: null, status: 'unknown' });
}

function pushLine(key, stream, text) {
  const state = logState.get(key);
  if (!state) return;
  const entry = { service: key, stream, text, ts: Date.now() };
  state.buffer.push(entry);
  if (state.buffer.length > MAX_BUFFER) state.buffer.shift();
  io.emit('log', entry);
}

function setStatus(key, status) {
  const state = logState.get(key);
  if (!state) return;
  state.status = status;
  io.emit('service-status', { key, status });
}

// Tail a log file: read new bytes appended since last read
function tailLogFile(key) {
  const def = LOG_DEFS[key];
  const state = logState.get(key);
  if (!def || !state || !existsSync(def.file)) return;

  const stat = statSync(def.file);
  if (stat.size < state.offset) {
    // File was truncated (e.g. service restarted) — reset to read from beginning
    state.offset = 0;
  }
  if (stat.size <= state.offset) return; // no new data

  const stream = createReadStream(def.file, { start: state.offset, encoding: 'utf-8' });
  let chunks = '';
  stream.on('data', (chunk) => { chunks += chunk; });
  stream.on('end', () => {
    state.offset = stat.size;
    if (chunks) {
      pushLine(key, 'stdout', chunks);
    }
  });
  stream.on('error', () => {}); // ignore read errors
}

// Initial read of existing log content + start watching
function initLogWatcher(key) {
  const def = LOG_DEFS[key];
  const state = logState.get(key);
  if (!def || !state) return;

  // Read existing content on startup
  if (existsSync(def.file)) {
    try {
      const content = readFileSync(def.file, 'utf-8');
      if (content) {
        // Load last ~200 lines into buffer
        const lines = content.split('\n').slice(-200).join('\n');
        pushLine(key, 'stdout', lines + (lines.endsWith('\n') ? '' : '\n'));
      }
      state.offset = statSync(def.file).size;
    } catch { /* ignore */ }
  }

  // Watch for changes — fs.watch uses OS kernel notifications, zero CPU
  try {
    state.watcher = watch(def.file, { persistent: false }, () => {
      tailLogFile(key);
    });
  } catch {
    // File may not exist yet — watch the directory instead
    try {
      const dirWatcher = watch(LOG_DIR, { persistent: false }, (_, filename) => {
        if (filename === def.file.split(/[/\\]/).pop()) {
          // File appeared — switch to file watcher
          dirWatcher.close();
          state.offset = 0;
          initLogWatcher(key);
        }
      });
    } catch { /* ignore */ }
  }
}

// Check log file freshness to determine status (called on-demand, not on a timer)
function checkLogStatus(key) {
  const def = LOG_DEFS[key];
  const state = logState.get(key);
  if (!def || !state) return;

  if (!existsSync(def.file)) {
    setStatus(key, 'no-log');
    return;
  }

  try {
    const stat = statSync(def.file);
    const age = Date.now() - stat.mtimeMs;
    // If log was written to in the last 30 seconds, consider it active
    setStatus(key, age < 30000 ? 'active' : 'stale');
  } catch {
    setStatus(key, 'unknown');
  }
}

// ---------------------------------------------------------------------------
// Git status polling
// ---------------------------------------------------------------------------
let gitStatusCache = [];

// Cached behind/ahead counts (updated by slower fetchRemoteStatus cycle)
const syncCache = {}; // repo → { behind, ahead }

function runGitCmd(args, cwd, opts = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => { proc.kill(); resolve(''); }, 5000);
    proc.on('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf-8');
      resolve(opts.trimOutput === false ? raw.trimEnd() : raw.trim());
    });
    proc.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

async function pollGitStatus() {
  const results = [];

  // Run all repos in parallel — non-blocking
  const tasks = REPOS.map(async (repo) => {
    const dir = repoDir(repo);
    const gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) return null;

    try {
      const [branch, porcelain] = await Promise.all([
        runGitCmd(['branch', '--show-current'], dir),
        runGitCmd(['status', '--porcelain'], dir),
      ]);

      const changedFiles = porcelain ? porcelain.split('\n').length : 0;
      const sync = syncCache[repo] || { behind: 0, ahead: 0 };

      return { repo, branch: branch || '(detached)', clean: changedFiles === 0, changedFiles, behind: sync.behind, ahead: sync.ahead };
    } catch {
      return { repo, branch: '???', clean: false, changedFiles: -1 };
    }
  });

  const settled = await Promise.all(tasks);
  for (const r of settled) if (r) results.push(r);

  gitStatusCache = results;
  io.emit('git-status', results);
}

// Separate slower cycle: git fetch + behind/ahead (runs every 60s, async)
async function fetchRemoteStatus() {
  for (const repo of REPOS) {
    const dir = repoDir(repo);
    if (!existsSync(join(dir, '.git'))) continue;

    try {
      const branch = await runGitCmd(['branch', '--show-current'], dir);
      if (!branch) continue;

      // Fetch the current branch's remote tracking ref
      await new Promise((resolve, reject) => {
        const proc = spawn('git', ['fetch', 'origin', branch, '--quiet'], {
          cwd: dir,
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 15000,
        });
        proc.on('close', resolve);
        proc.on('error', reject);
      });

      const counts = await runGitCmd(['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`], dir);
      const parts = counts.split(/\s+/);
      syncCache[repo] = { ahead: parseInt(parts[0]) || 0, behind: parseInt(parts[1]) || 0 };
    } catch {
      // Keep previous cache on failure — branch may not have a remote tracking ref
    }
  }
}

// ---------------------------------------------------------------------------
// External service status monitoring
// ---------------------------------------------------------------------------
const EXTERNAL_MONITORS = CONFIG.externalMonitors || [];

let externalStatusCache = [];

async function checkMonitorOnce(monitor) {
  const start = Date.now();
  const res = await fetch(monitor.url, {
    signal: AbortSignal.timeout(10000),
    redirect: 'follow',
  });
  const responseTime = Date.now() - start;

  if (monitor.type === 'statuspage') {
    const json = await res.json();
    const indicator = json.status?.indicator || 'unknown';
    const description = json.status?.description || '';
    const statusMap = { none: 'operational', minor: 'degraded', major: 'down', critical: 'down' };
    return {
      key: monitor.key, label: monitor.label, url: monitor.url,
      status: statusMap[indicator] || 'unknown',
      statusCode: res.status, responseTime, description, lastChecked: Date.now(),
    };
  }

  const status = res.status < 400 ? 'operational' : 'degraded';
  return {
    key: monitor.key, label: monitor.label, url: monitor.url,
    status, statusCode: res.status, responseTime,
    description: res.statusText, lastChecked: Date.now(),
  };
}

async function checkMonitor(monitor) {
  try {
    return await checkMonitorOnce(monitor);
  } catch (_firstErr) {
    // Retry once after 3s before marking unreachable
    await new Promise((r) => setTimeout(r, 3000));
    try {
      return await checkMonitorOnce(monitor);
    } catch (err) {
      return {
        key: monitor.key, label: monitor.label, url: monitor.url,
        status: 'unreachable', statusCode: null,
        responseTime: null,
        description: err.message, lastChecked: Date.now(),
      };
    }
  }
}

async function pollMonitor(monitor) {
  const result = await checkMonitor(monitor);
  result.interval = parseInt(monitor.interval) || 30;
  result.alarm = monitor.alarm !== 'off'; // default on unless explicitly 'off'
  const idx = externalStatusCache.findIndex(r => r.key === monitor.key);
  if (idx >= 0) externalStatusCache[idx] = result;
  else externalStatusCache.push(result);
  io.emit('external-status', [...externalStatusCache]);
}

// Poll all monitors immediately (used for manual refresh)
async function pollExternalStatus() {
  await Promise.all(EXTERNAL_MONITORS.map(m => pollMonitor(m)));
}

function startMonitorPolling() {
  EXTERNAL_MONITORS.forEach((monitor, i) => {
    const intervalMs = Math.max(5000, (parseInt(monitor.interval) || 30) * 1000);
    // Stagger startup so they don't all fire at once
    setTimeout(() => {
      pollMonitor(monitor);
      setInterval(() => pollMonitor(monitor), intervalMs);
    }, 6000 + i * 1500);
  });
}

// ---------------------------------------------------------------------------
// Claude Usage (OAuth usage endpoint + local session stats)
// ---------------------------------------------------------------------------
let claudeUsageCache = null;
let claudeUsageBackoff = 0; // number of consecutive 429s

function getClaudeOAuthToken() {
  try {
    // 1. Try flat file (Windows / older Claude Code versions)
    const home = isWindows ? process.env.USERPROFILE : homedir();
    const credPath = join(home, '.claude', '.credentials.json');
    let creds = null;
    if (existsSync(credPath)) {
      creds = JSON.parse(readFileSync(credPath, 'utf8'));
    }
    // 2. On macOS, try the system keychain (newer Claude Code stores creds here)
    if (!creds && process.platform === 'darwin') {
      try {
        const raw = execSync(
          'security find-generic-password -s "Claude Code-credentials" -w',
          { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        if (raw) creds = JSON.parse(raw);
      } catch { /* not in keychain */ }
    }
    if (!creds) return null;
    const oauth = creds.claudeAiOauth;
    if (!oauth || !oauth.accessToken) return null;
    // Check if token is expired
    if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
    return oauth.accessToken;
  } catch { return null; }
}

async function fetchClaudeUsage() {
  const result = { usage: null, sessionStats: null, rateLimited: false, backoffMins: 0 };

  // 1. Fetch usage limits via OAuth endpoint (same data as Claude app Settings > Usage)
  const token = getClaudeOAuthToken();
  if (token) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
      clearTimeout(timeout);

      if (res.ok) {
        result.usage = await res.json();
        claudeUsageBackoff = 0; // reset on success
      } else if (res.status === 429) {
        claudeUsageBackoff = Math.min(claudeUsageBackoff + 1, 5);
        const waitMins = Math.pow(2, claudeUsageBackoff);
        console.error(`Claude usage rate-limited (429), backing off ${waitMins}m`);
        result.rateLimited = true;
        result.backoffMins = waitMins;
        // Preserve last known usage data so UI isn't blank
        if (claudeUsageCache?.usage) result.usage = claudeUsageCache.usage;
      } else {
        console.error('Claude usage fetch returned', res.status);
      }
    } catch (err) {
      console.error('Claude usage fetch failed:', err.message);
    }
  }

  // 2. Read local Claude session stats from stats-cache.json
  try {
    const home = isWindows ? process.env.USERPROFILE : homedir();
    const statsPath = join(home, '.claude', 'stats-cache.json');
    if (existsSync(statsPath)) {
      const raw = JSON.parse(readFileSync(statsPath, 'utf8'));
      if (raw.dailyActivity && Array.isArray(raw.dailyActivity)) {
        const recent = raw.dailyActivity.slice(-7);
        const totals = recent.reduce((acc, d) => ({
          messages: acc.messages + (d.messageCount || 0),
          sessions: acc.sessions + (d.sessionCount || 0),
          toolCalls: acc.toolCalls + (d.toolCallCount || 0),
        }), { messages: 0, sessions: 0, toolCalls: 0 });

        result.sessionStats = {
          last7Days: totals,
          today: raw.dailyActivity.find(d => d.date === new Date().toISOString().slice(0, 10)) || null,
          recentDays: recent,
        };
      }
    }
  } catch (err) {
    console.error('Claude stats read failed:', err.message);
  }

  // Always update cache & emit — even on 429 with no data, so the client
  // can show the rate-limit banner while preserving any cached bars
  if (result.usage || result.sessionStats || result.rateLimited) {
    claudeUsageCache = result;
  }
  if (claudeUsageCache) {
    io.emit('claude-usage', claudeUsageCache);
  }
}

// ---------------------------------------------------------------------------
// Express + Socket.IO
// ---------------------------------------------------------------------------
const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer);

app.use(express.json({ limit: '50mb' }));
// Allow cross-origin requests from dev servers (Vite on :8080)
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Public config endpoint — exposes non-sensitive config to the frontend
// ---------------------------------------------------------------------------
// Current user identity (for per-user privacy in collections)
app.get('/api/user', (_req, res) => {
  try {
    const info = userInfo();
    res.json({ username: info.username });
  } catch {
    res.json({ username: 'unknown' });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    name: CONFIG.name || 'Dev Dashboard',
    title: CONFIG.title || 'Dev Dashboard',
    bookmarks: CONFIG.bookmarks || [],
    adoOrg: getAdoOrg(),
    adoProject: getAdoProject(),
    adoUsers: CONFIG.ado?.users || [],
    adoConfigured: isAdoConfigured(),
    sentryProjects: CONFIG.sentry?.projects || [],
    sentryConfigured: !!(getSentryOrg() && getSentryToken()),
    githubConfigured: isGithubConfigured(),
    githubUsers: CONFIG.github?.users || [],
    services: Object.fromEntries(
      Object.entries(CONFIG.services || {}).filter(([, v]) => v != null).map(([k, v]) => [k, { label: v.label, port: v.port }])
    ),
    cliTools: CONFIG.cliTools || [],
    repos: REPOS,
    externalMonitors: CONFIG.externalMonitors || [],
    dataDir: getDataDir(),
    apiDir: getApiDir(),
    privateDataDir: getPrivateDataDir(),
    docsDir: getDocsDir(),
  });
});

// ---------------------------------------------------------------------------
// Settings — full config CRUD
// ---------------------------------------------------------------------------
app.get('/api/config/full', (_req, res) => {
  res.json(CONFIG);
});

// ---------------------------------------------------------------------------
// User-defined dashboard templates — persisted to user-templates.json
// ---------------------------------------------------------------------------
const USER_TEMPLATES_PATH = join(__dirname, 'user-templates.json');
function readUserTemplates() {
  try {
    if (existsSync(USER_TEMPLATES_PATH)) return JSON.parse(readFileSync(USER_TEMPLATES_PATH, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}
function writeUserTemplates(data) {
  writeFileSync(USER_TEMPLATES_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

app.get('/api/templates', (_req, res) => {
  res.json(readUserTemplates());
});

app.put('/api/templates/:name', express.json(), (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const grid = req.body?.grid;
    if (!Array.isArray(grid)) return res.status(400).json({ error: 'grid array required' });
    const templates = readUserTemplates();
    templates[name] = { grid, savedAt: new Date().toISOString() };
    writeUserTemplates(templates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    const templates = readUserTemplates();
    if (!templates[name]) return res.status(404).json({ error: 'Not found' });
    delete templates[name];
    writeUserTemplates(templates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', express.json(), (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Invalid config object' });
    }
    // Write to disk
    writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2) + '\n', 'utf-8');
    // Update in-memory config
    Object.keys(CONFIG).forEach(k => delete CONFIG[k]);
    Object.assign(CONFIG, newConfig);
    // Rebuild repo list so changes take effect without a restart
    REPOS_RESOLVED = buildReposResolved(CONFIG.repos);
    REPOS = REPOS_RESOLVED.map(r => r.name);
    res.json({ ok: true, message: 'Config saved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config/section/:section', express.json(), (req, res) => {
  try {
    const { section } = req.params;
    const value = req.body.value;
    if (value === undefined) {
      return res.status(400).json({ error: 'Missing value' });
    }
    CONFIG[section] = value;
    writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + '\n', 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Environment variables — read/write .env file for integration tokens
// ---------------------------------------------------------------------------
const ENV_PATH = join(__dirname, '.env');
const MANAGED_ENV_KEYS = ['SENTRY_AUTH_TOKEN', 'ADO_PAT', 'GITHUB_TOKEN'];

function readEnvFile() {
  if (!existsSync(ENV_PATH)) return {};
  const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  const vars = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

function writeEnvFile(vars) {
  // Preserve comments and structure, update/add managed keys
  let lines = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  }
  const written = new Set();
  // Update existing lines
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    if (key in vars) {
      lines[i] = `${key}=${vars[key]}`;
      written.add(key);
    }
  }
  // Append new keys
  for (const [key, val] of Object.entries(vars)) {
    if (!written.has(key)) {
      lines.push(`${key}=${val}`);
    }
  }
  // Ensure trailing newline
  const content = lines.join('\n').replace(/\n*$/, '\n');
  writeFileSync(ENV_PATH, content, 'utf-8');
}

// GET: return which managed keys are set (never expose values)
app.get('/api/env', (_req, res) => {
  const vars = readEnvFile();
  const status = {};
  for (const key of MANAGED_ENV_KEYS) {
    const val = vars[key] || '';
    status[key] = { set: val.length > 0, masked: val ? val.slice(0, 4) + '...' : '' };
  }
  res.json(status);
});

// PUT: update one or more env vars, then reload into process.env
app.put('/api/env', express.json(), (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Expected object with key/value pairs' });
    }
    // Only allow managed keys
    const filtered = {};
    for (const [key, val] of Object.entries(updates)) {
      if (MANAGED_ENV_KEYS.includes(key) && typeof val === 'string') {
        filtered[key] = val;
      }
    }
    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: 'No valid env vars to update' });
    }
    writeEnvFile(filtered);
    // Reload into process.env so integrations pick up changes immediately
    for (const [key, val] of Object.entries(filtered)) {
      process.env[key] = val;
    }
    res.json({ ok: true, updated: Object.keys(filtered) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API Client — data layer helpers
// ---------------------------------------------------------------------------
function resolveDataDir(configured, fallback) {
  if (configured) {
    if (configured.startsWith('~')) configured = join(homedir(), configured.slice(1));
    return isAbsolute(configured) ? configured : join(BASE_DIR, configured);
  }
  return fallback;
}

function getDataDir() { return resolveDataDir(CONFIG.dataDir, join(__dirname, 'data')); }
function getPrivateDataDir() { return resolveDataDir(CONFIG.privateDataDir, join(homedir(), '.config', 'hive', 'data')); }
function getApiDir() { return join(getDataDir(), 'api'); }
function getPrivateApiDir() { return join(getPrivateDataDir(), 'api'); }
const SEED_DIR = join(__dirname, 'data'); // seed files always from hive install

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonFile(filename, defaultValue, dir = getDataDir()) {
  ensureDir(dir);
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) {
    writeFileSync(filepath, JSON.stringify(defaultValue, null, 2), 'utf-8');
    return defaultValue;
  }
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

function writeJsonFile(filename, data, dir = getDataDir()) {
  ensureDir(dir);
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
}

const DEFAULT_ENVIRONMENTS = [
  { name: 'Demo', variables: [
    { key: 'baseUrl', value: 'https://httpbin.org', enabled: true },
  ]},
];

// ---------------------------------------------------------------------------
// Data migration: fix auth "none" → "inherit" for imported Postman collections
// In Postman, folders/requests with { type: "noauth" } or missing auth mean
// "inherit from parent", but our earlier importer mapped them all to "none".
// ---------------------------------------------------------------------------
(function migrateAuthInherit() {
  const collections = readJsonFile('collections.json', [], getApiDir());
  let changed = false;

  function fixAuth(node, isRoot) {
    if (!isRoot && node.auth && node.auth.type === 'none') {
      node.auth = { type: 'inherit' };
      changed = true;
    }
    for (const f of (node.folders || [])) fixAuth(f, false);
    for (const r of (node.requests || [])) fixAuth(r, false);
  }

  for (const coll of collections) fixAuth(coll, true);
  if (changed) writeJsonFile('collections.json', collections, getApiDir());
})();

// ---------------------------------------------------------------------------
// Data migration: seed variables/preScript/testScript on collections & folders
// Existing imported collections may lack these fields.
// ---------------------------------------------------------------------------
(function migrateCollectionScriptsAndVars() {
  const collections = readJsonFile('collections.json', [], getApiDir());
  let changed = false;

  function seedFields(node) {
    if (!Array.isArray(node.variables)) { node.variables = []; changed = true; }
    if (typeof node.preScript !== 'string') { node.preScript = ''; changed = true; }
    if (typeof node.testScript !== 'string') { node.testScript = ''; changed = true; }
    for (const f of (node.folders || [])) seedFields(f);
  }

  for (const coll of collections) seedFields(coll);
  if (changed) writeJsonFile('collections.json', collections, getApiDir());
})();

// ---------------------------------------------------------------------------
// Git: pull a repo
// ---------------------------------------------------------------------------
app.post('/api/repos/pull', express.json(), (req, res) => {
  const repo = req.body && req.body.repo;
  if (!repo || !REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const dir = repoDir(repo);
  if (!existsSync(join(dir, '.git'))) return res.status(404).json({ error: 'repo not found' });

  // Remove stale index.lock if present (left behind by a crashed git process)
  const lockFile = join(dir, '.git', 'index.lock');
  if (existsSync(lockFile)) {
    try { unlinkSync(lockFile); } catch { /* ignore if already gone */ }
  }

  // SSH post-quantum warning lines — not errors, just noise
  const SSH_WARN = /^\*\* (WARNING|This session|The server)/;

  try {
    const output = execSync('git pull', { cwd: dir, timeout: 30000, encoding: 'utf-8' });
    pollGitStatus();
    fetchRemoteStatus();
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    const raw = (err.stderr || err.stdout || err.message || 'unknown error').toString();
    const msg = raw.split('\n').filter(l => !SSH_WARN.test(l.trim())).join('\n').trim();
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Git: changed files detail for a repo
// ---------------------------------------------------------------------------
app.get('/api/repos/:repo/changed-files', async (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const dir = repoDir(repo);
  if (!existsSync(join(dir, '.git'))) return res.status(404).json({ error: 'repo not found' });

  try {
    const rawPorcelain = await runGitCmd(['status', '--porcelain'], dir, { trimOutput: false });
    const files = rawPorcelain ? rawPorcelain.split('\n').filter(Boolean).map(line => {
      const status = line.substring(0, 2).trim();
      const file = line.substring(3).replace(/^"(.*)"$/, '$1');
      let statusLabel = 'modified';
      if (status.includes('A') || status === '??') statusLabel = status === '??' ? 'untracked' : 'added';
      else if (status.includes('D')) statusLabel = 'deleted';
      else if (status.includes('R')) statusLabel = 'renamed';
      else if (status.includes('M')) statusLabel = 'modified';
      return { file, status, statusLabel };
    }) : [];

    const branch = await runGitCmd(['branch', '--show-current'], dir);
    res.json({ repo, branch, files });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to get changed files' });
  }
});

// ---------------------------------------------------------------------------
// Repo Viewer: list repos, browse file tree, read/write files
// ---------------------------------------------------------------------------
const REPO_VIEWER_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage',
  '__pycache__', '.cache', '.turbo', 'out', '.output', '.svelte-kit',
  '.parcel-cache', 'vendor', '.vite',
]);

app.get('/api/repo/list', (_req, res) => {
  res.json(REPOS);
});

app.get('/api/repos/:repo/tree', (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const base = repoDir(repo);
  const subPath = req.query.path || '';
  const targetDir = subPath ? normalize(join(base, subPath)) : base;
  if (!targetDir.startsWith(normalize(base))) return res.status(400).json({ error: 'invalid path' });
  if (!existsSync(targetDir)) return res.status(404).json({ error: 'path not found' });

  try {
    const items = readdirSync(targetDir);
    const entries = [];
    for (const name of items.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      if (REPO_VIEWER_IGNORE.has(name)) continue;
      const fullPath = join(targetDir, name);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }
      const relPath = relative(base, fullPath).replace(/\\/g, '/');
      entries.push({ name, path: relPath, type: stat.isDirectory() ? 'dir' : 'file' });
    }
    // Dirs first, then files
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    // Mark gitignored entries — exit code 1 means none ignored (not an error)
    if (entries.length > 0) {
      try {
        const out = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
          cwd: base,
          input: entries.map(e => e.path).join('\0'),
          encoding: 'utf-8',
          timeout: 3000,
        });
        const ignored = new Set(out.split('\0').filter(Boolean));
        for (const entry of entries) { if (ignored.has(entry.path)) entry.ignored = true; }
      } catch { /* exit 1 = none ignored; other errors ignored silently */ }
    }

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos/:repo/file', (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const base = repoDir(repo);
  const fullPath = normalize(join(base, filePath));
  if (!fullPath.startsWith(normalize(base))) return res.status(400).json({ error: 'invalid path' });
  if (!existsSync(fullPath)) return res.status(404).json({ error: 'file not found' });
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const mtime = statSync(fullPath).mtimeMs;
    res.json({ content, path: filePath, mtime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos/:repo/filemtime', (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const base = repoDir(repo);
  const fullPath = normalize(join(base, filePath));
  if (!fullPath.startsWith(normalize(base))) return res.status(400).json({ error: 'invalid path' });
  if (!existsSync(fullPath)) return res.status(404).json({ error: 'file not found' });
  try {
    res.json({ mtime: statSync(fullPath).mtimeMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/repos/:repo/file', express.json({ limit: '10mb' }), (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const { path: filePath, content } = req.body || {};
  if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const base = repoDir(repo);
  const fullPath = normalize(join(base, filePath));
  if (!fullPath.startsWith(normalize(base))) return res.status(400).json({ error: 'invalid path' });
  try {
    // Create parent directories if needed
    const parentDir = fullPath.split(sep).slice(0, -1).join(sep);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    const mtime = statSync(fullPath).mtimeMs;
    res.json({ ok: true, mtime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/repos/:repo/move', express.json(), (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const base = repoDir(repo);
  const fromFull = normalize(join(base, from));
  const toFull   = normalize(join(base, to));
  if (!fromFull.startsWith(normalize(base)) || !toFull.startsWith(normalize(base))) {
    return res.status(400).json({ error: 'invalid path' });
  }
  if (!existsSync(fromFull)) return res.status(404).json({ error: 'source not found' });
  if (existsSync(toFull))    return res.status(409).json({ error: 'destination already exists' });
  try {
    const toDir = toFull.split(sep).slice(0, -1).join(sep);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
    renameSync(fromFull, toFull);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/repos/:repo/mkdir', express.json(), (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const { path: dirPath } = req.body || {};
  if (!dirPath) return res.status(400).json({ error: 'path required' });
  const base     = repoDir(repo);
  const fullPath = normalize(join(base, dirPath));
  if (!fullPath.startsWith(normalize(base))) return res.status(400).json({ error: 'invalid path' });
  try {
    mkdirSync(fullPath, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/repos/:repo/file', (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const base = repoDir(repo);
  const fullPath = normalize(join(base, filePath));
  if (!fullPath.startsWith(normalize(base))) return res.status(400).json({ error: 'invalid path' });
  if (!existsSync(fullPath)) return res.status(404).json({ error: 'file not found' });
  try {
    unlinkSync(fullPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Branch list + checkout
// ---------------------------------------------------------------------------
app.get('/api/repos/:repo/branches', async (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const dir = repoDir(repo);
  try {
    // Fetch so remote-only branches are visible; ignore errors (offline, no remote, etc.)
    await runGitCmd(['fetch', '--prune'], dir).catch(() => {});

    // Local branches sorted by most recent commit
    const localRaw = await runGitCmd(['branch', '--sort=-committerdate', '--format=%(refname:short)'], dir);
    const local = (localRaw || '').split('\n').map(b => b.trim()).filter(Boolean);

    // Remote branches — strip the remote/ prefix, skip HEAD pointers
    const remoteRaw = await runGitCmd(['branch', '-r', '--sort=-committerdate', '--format=%(refname:short)'], dir);
    const remoteOnly = (remoteRaw || '').split('\n')
      .map(b => b.trim().replace(/^[^/]+\//, ''))
      .filter(b => b && !b.includes('HEAD'));

    // Merge: local first, then any remote-only branches not already local
    const localSet = new Set(local);
    const branches = [...local, ...remoteOnly.filter(b => !localSet.has(b))];

    res.json({ branches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/repos/:repo/checkout', express.json(), async (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const { branch } = req.body || {};
  if (!branch) return res.status(400).json({ error: 'branch required' });
  const dir = repoDir(repo);
  try {
    await runGitCmd(['checkout', branch], dir);
    pollGitStatus();
    fetchRemoteStatus();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err.stderr || err.message || '').toString().trim() });
  }
});

// ---------------------------------------------------------------------------
// Repo Search — ripgrep with grep fallback
// ---------------------------------------------------------------------------
// Flat file list for Quick Open
app.get('/api/repos/:repo/files', async (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const base = repoDir(repo);

  const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.cache']);
  const files = [];

  function walk(dir, rel) {
    if (files.length >= 5000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= 5000) return;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) {
          walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
        }
      } else if (e.isFile()) {
        files.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  }

  try {
    walk(base, '');
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/repos/:repo/search', async (req, res) => {
  const repo = req.params.repo;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  const q       = (req.query.q       || '').trim();
  const include = (req.query.include || '').trim();
  const exclude = (req.query.exclude || '').trim();
  if (!q) return res.json({ results: [] });

  const base = repoDir(repo);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  // Build ignore args — default noise dirs, plus user excludes
  const ignoreArgs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage']
    .flatMap(d => ['-g', `!${d}`]);
  if (include) include.split(',').map(p => p.trim()).filter(Boolean).forEach(p => ignoreArgs.push('-g', p));
  if (exclude) exclude.split(',').map(p => p.trim()).filter(Boolean).forEach(p => ignoreArgs.push('-g', `!${p}`));

  // Try ripgrep first, fall back to grep
  const tryRg = () => execFileAsync('rg', [
    '--json', '-i', '--max-count', '3', '--max-filesize', '1M',
    ...ignoreArgs, q, base
  ], { maxBuffer: 4 * 1024 * 1024 });

  const tryGrep = () => execFileAsync('grep', [
    '-r', '-i', '-n', '--include=*.*', '-l',
    '--exclude-dir=node_modules', '--exclude-dir=.git',
    q, base
  ], { maxBuffer: 2 * 1024 * 1024 });

  try {
    let results = [];

    try {
      const { stdout } = await tryRg();
      // rg --json emits one JSON object per line
      const matches = new Map(); // path → { path, matches: [] }
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'match') {
          const filePath = normalize(obj.data.path.text).replace(normalize(base) + sep, '').replace(/\\/g, '/');
          if (!matches.has(filePath)) matches.set(filePath, { path: filePath, matches: [] });
          const entry = matches.get(filePath);
          if (entry.matches.length < 3) {
            entry.matches.push({
              line: obj.data.line_number,
              text: obj.data.lines.text.trimEnd(),
            });
          }
        }
      }
      results = [...matches.values()].slice(0, 50);
    } catch (rgErr) {
      // ripgrep not available — fall back to grep file list only
      try {
        const { stdout } = await tryGrep();
        results = stdout.split('\n').filter(Boolean).slice(0, 50).map(f => ({
          path: normalize(f).replace(normalize(base) + sep, '').replace(/\\/g, '/'),
          matches: [],
        }));
      } catch {
        // grep also failed (no matches returns exit 1) — empty results is fine
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AI Code Completion (Claude Haiku via Anthropic API)
// ---------------------------------------------------------------------------
app.post('/api/ai/complete', express.json({ limit: '100kb' }), async (req, res) => {
  const authHeaders = process.env.ANTHROPIC_API_KEY ? { 'x-api-key': process.env.ANTHROPIC_API_KEY } : null;
  if (!authHeaders) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured — add it to claude-shared/.env' });

  const { prefix, suffix, language, filename } = req.body || {};
  if (!prefix && prefix !== '') return res.status(400).json({ error: 'prefix required' });

  const prompt = `Complete the code at the cursor. Return ONLY the completion text — no explanation, no markdown fences.
Language: ${language || 'unknown'}${filename ? `\nFile: ${filename}` : ''}

Code before cursor:
${prefix.slice(-3000)}
<CURSOR>${(suffix || '').slice(0, 500)}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders  },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: err });
    }
    const data = await response.json();
    res.json({ completion: data.content?.[0]?.text || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Global Code Search (ripgrep → git grep fallback)
// ---------------------------------------------------------------------------
let rgAvailable = null;
function checkRgAvailable() {
  if (rgAvailable !== null) return rgAvailable;
  try { execSync('rg --version', { stdio: 'ignore', timeout: 2000 }); rgAvailable = true; }
  catch { rgAvailable = false; }
  return rgAvailable;
}

app.get('/api/search', (req, res) => {
  const { q, repos: reposParam, caseSensitive, regex } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

  const targetRepos = reposParam
    ? reposParam.split(',').map(r => r.trim()).filter(r => REPOS.includes(r))
    : REPOS;
  if (targetRepos.length === 0) return res.status(400).json({ error: 'No valid repos specified' });

  const results = [];
  const MAX_TOTAL = 500;
  let truncated = false;
  const isCaseSensitive = caseSensitive === 'true';
  const isRegex = regex === 'true';
  const useRg = checkRgAvailable();

  for (const repo of targetRepos) {
    if (results.length >= MAX_TOTAL) { truncated = true; break; }
    const dir = repoDir(repo);
    if (!existsSync(dir)) continue;

    try {
      let output;
      if (useRg) {
        const args = [
          '--line-number', '--no-heading', '--color', 'never', '--max-filesize', '500K',
          '--glob', '!node_modules', '--glob', '!dist', '--glob', '!build',
          '--glob', '!coverage', '--glob', '!*.min.js', '--glob', '!*.map', '--glob', '!.git',
          isCaseSensitive ? '--case-sensitive' : '--ignore-case',
        ];
        if (!isRegex) args.push('--fixed-strings');
        args.push('--', q, '.');
        output = execFileSync('rg', args, { cwd: dir, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
      } else {
        const args = [
          'grep', '--line-number', '--color=never',
          ...(isCaseSensitive ? [] : ['-i']),
          ...(isRegex ? ['-E'] : ['-F']),
          '-e', q,
          '--',
          '.',
          ':(exclude)node_modules', ':(exclude)dist', ':(exclude)build',
          ':(exclude)coverage', ':(exclude)*.min.js', ':(exclude)*.map',
        ];
        output = execFileSync('git', args, { cwd: dir, timeout: 15000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
      }

      for (const line of output.split('\n').filter(Boolean)) {
        if (results.length >= MAX_TOTAL) { truncated = true; break; }
        // Format: path/to/file:line_number:content
        const firstColon = line.indexOf(':');
        if (firstColon === -1) continue;
        const secondColon = line.indexOf(':', firstColon + 1);
        if (secondColon === -1) continue;
        const filePath = line.slice(0, firstColon);
        const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
        const text = line.slice(secondColon + 1).trim();
        if (!filePath || isNaN(lineNum)) continue;
        results.push({ repo, file: filePath.replace(/\\/g, '/'), line: lineNum, text });
      }
    } catch (err) {
      if (err.status !== 1) console.error(`Search error in ${repo}:`, err.message?.slice(0, 100));
      // exit code 1 = no matches (normal for grep/rg)
    }
  }

  res.json({ results, total: results.length, truncated });
});

// ---------------------------------------------------------------------------
// Git: diff for a specific file in a repo
// ---------------------------------------------------------------------------
app.get('/api/repos/:repo/diff', async (req, res) => {
  const repo = req.params.repo;
  const file = req.query.file;
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  if (!file) return res.status(400).json({ error: 'file parameter required' });
  const dir = repoDir(repo);
  if (!existsSync(join(dir, '.git'))) return res.status(404).json({ error: 'repo not found' });

  try {
    // Try staged diff first, fall back to unstaged, then show full file for untracked
    let diff = await runGitCmd(['diff', '--cached', '--', file], dir);
    if (!diff) {
      diff = await runGitCmd(['diff', '--', file], dir);
    }
    if (!diff) {
      // Untracked file — show the whole content as "new file"
      const filePath = join(dir, file);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8');
        diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split('\n').length} @@\n` +
          content.split('\n').map(l => '+' + l).join('\n');
      }
    }
    res.json({ repo, file, diff: diff || 'No changes' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to get diff' });
  }
});

// ---------------------------------------------------------------------------
// Git: stage, commit, and optionally push
// ---------------------------------------------------------------------------
app.post('/api/repos/:repo/commit', express.json(), async (req, res) => {
  const repo = req.params.repo;
  const { message, files, push: doPush, amend } = req.body || {};
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  if (!message && !amend) return res.status(400).json({ error: 'commit message required' });
  const dir = repoDir(repo);
  if (!existsSync(join(dir, '.git'))) return res.status(404).json({ error: 'repo not found' });

  try {
    // Stage files — specific files or all
    if (files && files.length > 0) {
      for (const f of files) {
        execSync(`git add -- "${f}"`, { cwd: dir, timeout: 10000 });
      }
    } else {
      execSync('git add -A', { cwd: dir, timeout: 10000 });
    }

    // Check if there's anything staged
    const staged = execSync('git diff --cached --name-only', { cwd: dir, timeout: 5000, encoding: 'utf-8' }).trim();
    if (!staged && !amend) return res.status(400).json({ error: 'Nothing staged to commit' });

    // Commit
    const commitMsg = message.replace(/"/g, '\\"');
    const commitArgs = amend ? `git commit --amend -m "${commitMsg}"` : `git commit -m "${commitMsg}"`;
    const commitOutput = execSync(commitArgs, { cwd: dir, timeout: 15000, encoding: 'utf-8' }).trim();

    let pushOutput = null;
    if (doPush) {
      pushOutput = execSync('git push', { cwd: dir, timeout: 30000, encoding: 'utf-8' }).trim();
    }

    // Refresh status
    pollGitStatus();
    fetchRemoteStatus();

    res.json({ ok: true, commitOutput, pushOutput });
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || 'unknown error').toString().trim();
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Git: discard changes for a specific file
// ---------------------------------------------------------------------------
app.post('/api/repos/:repo/discard', express.json(), async (req, res) => {
  const repo = req.params.repo;
  const { file } = req.body || {};
  if (!REPOS.includes(repo)) return res.status(400).json({ error: 'invalid repo' });
  if (!file) return res.status(400).json({ error: 'file parameter required' });
  const dir = repoDir(repo);
  if (!existsSync(join(dir, '.git'))) return res.status(404).json({ error: 'repo not found' });

  try {
    // Check if untracked
    const status = execFileSync('git', ['status', '--porcelain', '--', file], { cwd: dir, timeout: 5000, encoding: 'utf-8' }).trim();
    if (status.startsWith('??')) {
      // Untracked file — delete it
      const filePath = join(dir, file);
      if (existsSync(filePath)) unlinkSync(filePath);
    } else {
      // Tracked file — restore
      execFileSync('git', ['checkout', '--', file], { cwd: dir, timeout: 10000 });
      // Also unstage if staged
      execFileSync('git', ['reset', 'HEAD', '--', file], { cwd: dir, timeout: 10000 });
    }

    pollGitStatus();
    res.json({ ok: true });
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || 'unknown error').toString().trim();
    res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/services — log viewer definitions + running status
// ---------------------------------------------------------------------------
function checkPort(port) {
  return new Promise((resolve) => {
    const sock = netConnect({ port, host: '127.0.0.1' });
    sock.setTimeout(1000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

app.get('/api/services', async (_req, res) => {
  const defs = {};
  for (const [key, def] of Object.entries(LOG_DEFS)) {
    const running = def.port ? await checkPort(def.port) : null;
    defs[key] = { label: def.label, port: def.port || null, running };
  }
  res.json(defs);
});

// ---------------------------------------------------------------------------
// POST /api/services/start — launch a dev service in a terminal split pane
// ---------------------------------------------------------------------------
const SERVICE_TAB_TITLE = `${CONFIG.name || 'Dev'} Services`;
let serviceTabCreated = false;  // tracks if we've opened the first service tab this session

function detectTerminalEmulator() {
  const termConfig = CONFIG.terminal || {};
  if (termConfig.emulator && termConfig.emulator !== 'auto') return termConfig.emulator;

  if (isWindows) return 'windows-terminal';
  if (process.platform === 'darwin') return 'macos-terminal';

  // Linux: detect available terminal emulators
  const linuxTerminals = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
  for (const term of linuxTerminals) {
    try {
      execSync(`which ${term}`, { stdio: 'ignore' });
      return term;
    } catch { /* not found */ }
  }
  return 'xterm'; // ultimate fallback
}

function getShellPath() {
  const termConfig = CONFIG.terminal || {};
  if (termConfig.shellPath) return termConfig.shellPath;
  if (isWindows) return process.env.GIT_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe';
  return process.env.SHELL || '/bin/bash';
}

function useSplitPanes() {
  const termConfig = CONFIG.terminal || {};
  return termConfig.splitPanes !== false; // default true
}

function launchServiceTerminal(key, scriptPath) {
  const emulator = detectTerminalEmulator();
  const splitPanes = useSplitPanes();
  const cleanEnv = { ...process.env };
  delete cleanEnv.PORT; // Don't leak dashboard PORT to child services
  const spawnOpts = { detached: true, stdio: 'ignore', env: cleanEnv };

  // Choose shell based on script type
  const isPowerShell = isWindows && scriptPath.endsWith('.ps1');
  const shell = isPowerShell ? 'powershell.exe' : getShellPath();
  const shellArgs = isPowerShell ? ['-NoExit', '-File'] : [];

  if (emulator === 'windows-terminal') {
    const winScriptPath = scriptPath.replace(/\//g, '\\');
    const cmdArgs = [...shellArgs, winScriptPath];
    if (splitPanes && !serviceTabCreated) {
      spawn('wt.exe', ['-w', '0', 'new-tab', '--title', SERVICE_TAB_TITLE, shell, ...cmdArgs], spawnOpts).unref();
      serviceTabCreated = true;
    } else if (splitPanes) {
      spawn('wt.exe', ['-w', '0', 'split-pane', '--horizontal', '--title', `${CONFIG.name || 'Dev'} ${key}`, shell, ...cmdArgs], spawnOpts).unref();
    } else {
      spawn('wt.exe', ['-w', '0', 'new-tab', '--title', `${CONFIG.name || 'Dev'} ${key}`, shell, ...cmdArgs], spawnOpts).unref();
    }

  } else if (emulator === 'macos-terminal') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "bash '${scriptPath}'"`], spawnOpts).unref();

  } else if (emulator === 'gnome-terminal') {
    if (splitPanes && !serviceTabCreated) {
      spawn('gnome-terminal', ['--tab', '--title', SERVICE_TAB_TITLE, '--', shell, scriptPath], spawnOpts).unref();
      serviceTabCreated = true;
    } else if (splitPanes) {
      // gnome-terminal doesn't support split panes natively, use new tab
      spawn('gnome-terminal', ['--tab', '--title', `${CONFIG.name || 'Dev'} ${key}`, '--', shell, scriptPath], spawnOpts).unref();
    } else {
      spawn('gnome-terminal', ['--', shell, scriptPath], spawnOpts).unref();
    }

  } else if (emulator === 'konsole') {
    if (splitPanes && !serviceTabCreated) {
      spawn('konsole', ['--new-tab', '-p', `tabtitle=${SERVICE_TAB_TITLE}`, '-e', shell, scriptPath], spawnOpts).unref();
      serviceTabCreated = true;
    } else if (splitPanes) {
      spawn('konsole', ['--new-tab', '-p', `tabtitle=${CONFIG.name || 'Dev'} ${key}`, '-e', shell, scriptPath], spawnOpts).unref();
    } else {
      spawn('konsole', ['-e', shell, scriptPath], spawnOpts).unref();
    }

  } else if (emulator === 'tmux') {
    const sessionName = (CONFIG.name || 'dev').toLowerCase().replace(/[^a-z0-9]/g, '-') + '-services';
    if (!serviceTabCreated) {
      // Create new tmux session with the first service
      spawn('tmux', ['new-session', '-d', '-s', sessionName, '-n', key, shell, scriptPath], spawnOpts).unref();
      serviceTabCreated = true;
    } else if (splitPanes) {
      // Split the existing window
      spawn('tmux', ['split-window', '-h', '-t', sessionName, shell, scriptPath], spawnOpts).unref();
    } else {
      // New window in same session
      spawn('tmux', ['new-window', '-t', sessionName, '-n', key, shell, scriptPath], spawnOpts).unref();
    }

  } else {
    // Fallback: xterm, xfce4-terminal, or any generic X terminal
    spawn(emulator, ['-e', shell, scriptPath], spawnOpts).unref();
  }
}

function resolveRunScript(key) {
  if (isWindows) {
    const ps1 = join(__dirname, `run-${key}.ps1`);
    if (existsSync(ps1)) return ps1;
  }
  const sh = join(__dirname, `run-${key}.sh`);
  return existsSync(sh) ? sh : null;
}

app.post('/api/services/start', express.json(), async (req, res) => {
  const key = req.body && req.body.key;
  const def = LOG_DEFS[key];
  if (!key || !def) return res.status(400).json({ error: 'invalid service key' });

  // Check if already running
  if (def.port && await checkPort(def.port)) {
    return res.json({ ok: true, already: true });
  }

  const scriptPath = resolveRunScript(key);
  if (!scriptPath) {
    return res.status(404).json({ error: `run-${key}.ps1 / run-${key}.sh not found` });
  }

  try {
    launchServiceTerminal(key, scriptPath);
    res.json({ ok: true, already: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/services/stop — kill a running service by its port
// ---------------------------------------------------------------------------
function findPidByPort(port) {
  try {
    if (isWindows) {
      const out = execSync(`netstat -ano 2>NUL | findstr ":${port} " | findstr "LISTENING"`, { encoding: 'utf-8', timeout: 5000 });
      const lines = out.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      const parts = lines[0].trim().split(/\s+/);
      return parts[parts.length - 1] || null;
    } else {
      const out = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 });
      return out.trim() || null;
    }
  } catch {
    return null;
  }
}

function killByPort(port) {
  const pid = findPidByPort(port);
  if (!pid) return { killed: false, reason: 'no process found on port' };
  try {
    if (isWindows) {
      execSync(`taskkill /T /F /PID ${pid}`, { encoding: 'utf-8', timeout: 10000 });
    } else {
      execSync(`kill -TERM ${pid}`, { encoding: 'utf-8', timeout: 5000 });
    }
    return { killed: true, pid };
  } catch (err) {
    return { killed: false, reason: err.message, pid };
  }
}

app.post('/api/services/stop', express.json(), async (req, res) => {
  const key = req.body && req.body.key;
  const def = LOG_DEFS[key];
  if (!key || !def) return res.status(400).json({ error: 'invalid service key' });
  if (!def.port) return res.status(400).json({ error: 'service has no port defined' });

  const running = await checkPort(def.port);
  if (!running) return res.json({ ok: true, already: true });

  const result = killByPort(def.port);
  if (result.killed) {
    // Emit updated status immediately
    io.emit('service-running', { key, running: false });
    res.json({ ok: true, pid: result.pid });
  } else {
    res.status(500).json({ error: result.reason, pid: result.pid });
  }
});

// ---------------------------------------------------------------------------
// POST /api/services/restart — stop then start a service
// ---------------------------------------------------------------------------
app.post('/api/services/restart', express.json(), async (req, res) => {
  const key = req.body && req.body.key;
  const def = LOG_DEFS[key];
  if (!key || !def) return res.status(400).json({ error: 'invalid service key' });

  // Stop if running
  if (def.port && await checkPort(def.port)) {
    const stopResult = killByPort(def.port);
    if (!stopResult.killed) {
      return res.status(500).json({ error: `Failed to stop: ${stopResult.reason}` });
    }
    io.emit('service-running', { key, running: false });
    // Wait for port to free up
    let attempts = 0;
    while (attempts < 20 && await checkPort(def.port)) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
    if (await checkPort(def.port)) {
      return res.status(500).json({ error: 'Port did not free up after stop' });
    }
  }

  // Start
  const scriptPath = resolveRunScript(key);
  if (!scriptPath) {
    return res.status(404).json({ error: `run-${key}.ps1 / run-${key}.sh not found` });
  }

  try {
    launchServiceTerminal(key, scriptPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/web-event — receive route/dialog events from the web dev plugin
// ---------------------------------------------------------------------------
app.post('/api/web-event', express.json(), (req, res) => {
  const { type, ts, eventId } = req.body || {};
  if (!type || !ts) return res.status(400).json({ error: 'missing type or ts' });

  let text;
  if (type === 'route') {
    const title = req.body.title ? ` (${req.body.title})` : '';
    text = `[route] ${req.body.from || '/'} → ${req.body.to || '/'}${title}`;
  } else if (type === 'dialog') {
    text = `[dialog] ${req.body.title || '(untitled)'}`;
  } else if (type === 'api-call') {
    text = `  ↳ ${req.body.method || 'GET'} ${req.body.url || ''}`;
  } else {
    text = `[${type}] ${JSON.stringify(req.body)}`;
  }

  // Route/dialog events go to the web panel; api-call events go to the api panel
  // so clicking a route in web highlights the matching api-calls in api
  const service = type === 'api-call' ? 'api' : 'web';
  const entry = { service, stream: 'event', text, ts, eventType: type, eventId };
  const state = logState.get(service);
  if (state) {
    state.buffer.push(entry);
    if (state.buffer.length > MAX_BUFFER) state.buffer.shift();
  }
  io.emit('log', entry);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Phase 3: GET /api/releases — latest 20 releases from releases.json
// ---------------------------------------------------------------------------
app.get('/api/releases', (_req, res) => {
  try {
    const relCfg = CONFIG.releases || {};
    const releasesPath = relCfg.repoDir
      ? join(BASE_DIR, relCfg.repoDir, relCfg.path || 'releases.json')
      : join(BASE_DIR, 'releases.json');
    if (!existsSync(releasesPath)) {
      return res.json([]);
    }
    const data = JSON.parse(readFileSync(releasesPath, 'utf-8'));
    const releases = Array.isArray(data) ? data.slice(0, 20) : [];
    res.json(releases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 4: GET /api/env-diff — env key presence matrix (never values)
// ---------------------------------------------------------------------------
app.get('/api/env-diff', (_req, res) => {
  const envDiffCfg = CONFIG.envDiff || {};
  const envFiles = {};
  for (const [name, def] of Object.entries(envDiffCfg)) {
    if (!def.path) continue;
    envFiles[name] = def.repoDir
      ? join(BASE_DIR, def.repoDir, def.path)
      : join(BASE_DIR, def.path);
  }

  const envKeys = {};
  const envNames = Object.keys(envFiles);
  const available = {};

  for (const [name, filepath] of Object.entries(envFiles)) {
    available[name] = existsSync(filepath);
    if (!available[name]) continue;

    try {
      const content = readFileSync(filepath, 'utf-8');
      const keys = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .map(line => line.split('=')[0].trim());

      for (const key of keys) {
        if (!envKeys[key]) envKeys[key] = {};
        envKeys[key][name] = true;
      }
    } catch {
      // skip unreadable files
    }
  }

  // Build presence matrix
  const matrix = Object.entries(envKeys)
    .map(([key, presence]) => {
      const row = { key };
      for (const name of envNames) {
        row[name] = !!presence[name];
      }
      // Flag as mismatch if not present in all available envs
      const availableNames = envNames.filter(n => available[n]);
      row.mismatch = availableNames.some(n => !presence[n]);
      return row;
    })
    .sort((a, b) => {
      // Mismatches first, then alphabetical
      if (a.mismatch !== b.mismatch) return a.mismatch ? -1 : 1;
      return a.key.localeCompare(b.key);
    });

  res.json({ envNames, available, matrix });
});

// ---------------------------------------------------------------------------
// Phase 5: GET /api/migrations/status — knex migrate:status
// ---------------------------------------------------------------------------
app.get('/api/migrations/status', (req, res) => {
  const env = ['local', 'dev', 'prod'].includes(req.query.env) ? req.query.env : 'local';
  const dbDir = repoDir(CONFIG.dbRepo || 'db');
  if (!existsSync(dbDir)) {
    return res.status(404).json({ error: 'DB repo not configured. Set "dbRepo" in dashboard.config.json' });
  }

  try {
    const cmd = isWindows
      ? `cmd /c npx knex migrate:status --env ${env}`
      : `npx knex migrate:status --env ${env}`;
    const output = execSync(cmd, {
      cwd: dbDir,
      timeout: 15000,
      encoding: 'utf-8',
    });
    // Parse output to count run/pending
    const lines = output.trim().split('\n');
    let run = 0;
    let pending = 0;
    for (const line of lines) {
      if (line.includes('[X]')) run++;
      else if (line.includes('[ ]')) pending++;
    }
    res.json({ run, pending, output, env });
  } catch (err) {
    res.json({ run: 0, pending: 0, output: err.message, error: true, env });
  }
});

// ---------------------------------------------------------------------------
// Phase 6: ADO Integration endpoints
// ---------------------------------------------------------------------------
function getAdoOrg() { return CONFIG.ado?.org || ''; }
function getAdoProject() { return CONFIG.ado?.project || ''; }
const ADO_BASE_URL = CONFIG.adoBaseUrl || 'https://dev.azure.com';
function getAdoTeam() { return CONFIG.ado?.team || ''; }

function getAdoPat() {
  return process.env.ADO_PAT || '';
}

function adoHeaders() {
  const pat = getAdoPat();
  return {
    'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

async function adoFetch(url, opts = {}) {
  const pat = getAdoPat();
  if (!pat) throw new Error('ADO_PAT not configured');

  const res = await fetch(url, {
    ...opts,
    headers: { ...adoHeaders(), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error(`ADO API returned non-JSON response (${ct || 'no content-type'})`);
  return res.json();
}

function isAdoConfigured() {
  return !!(getAdoOrg() && getAdoProject() && getAdoPat());
}

app.get('/api/ado/status', (_req, res) => {
  res.json({ configured: isAdoConfigured() });
});

app.get('/api/ado/test', async (_req, res) => {
  if (!getAdoPat()) return res.json({ ok: false, error: 'ADO_PAT not set' });
  if (!getAdoOrg()) return res.json({ ok: false, error: 'ADO organization not configured' });
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/_apis/projects?$top=1&api-version=7.1`;
    await adoFetch(url);
    res.json({ ok: true, message: `Connected to ${getAdoOrg()}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/ado/sprint', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const teamId = getAdoTeam();
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/${encodeURIComponent(teamId)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`;
    const data = await adoFetch(url);
    const iteration = data.value?.[0];
    if (!iteration) return res.json({ name: 'No active sprint', startDate: null, endDate: null });
    res.json({
      name: iteration.name,
      path: iteration.path,
      startDate: iteration.attributes?.startDate,
      endDate: iteration.attributes?.finishDate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/work-items', async (req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const assignedTo = req.query.assignedTo; // comma-separated display names
    let assignedClause = '';
    if (assignedTo) {
      const names = assignedTo.split(',').map(n => n.trim()).filter(Boolean).map(n => n.replace(/'/g, "''"));
      if (names.length === 1) {
        assignedClause = `AND [System.AssignedTo] = '${names[0]}'`;
      } else if (names.length > 1) {
        assignedClause = `AND [System.AssignedTo] IN (${names.map(n => `'${n}'`).join(', ')})`;
      }
    }
    const workItemTypes = CONFIG.ado?.workItemTypes || ['Bug', 'User Story', 'Feature'];
    const activeStates = CONFIG.ado?.activeStates || ['Active', 'New', 'In Design', 'Pending', 'Requested'];
    const wiql = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo]
        FROM workitems
        WHERE [System.TeamProject] = '${getAdoProject().replace(/'/g, "''")}'
          AND [System.WorkItemType] IN (${workItemTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')})
          AND [System.State] IN (${activeStates.map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})
          ${assignedClause}
        ORDER BY [System.WorkItemType], [System.State], [System.CreatedDate] DESC`
    };

    const wiqlUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/wiql?api-version=7.1`;
    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST',
      headers: adoHeaders(),
      body: JSON.stringify(wiql),
      signal: AbortSignal.timeout(10000),
    });
    if (!wiqlRes.ok) throw new Error(`WIQL ${wiqlRes.status}`);
    const wiqlData = await wiqlRes.json();

    const ids = (wiqlData.workItems || []).map(wi => wi.id).slice(0, 200);
    if (ids.length === 0) return res.json([]);

    // Batch fetch in chunks of 200 (ADO limit)
    const batchUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.CreatedDate&api-version=7.1`;
    const batchData = await adoFetch(batchUrl);

    const items = (batchData.value || []).map(wi => ({
      id: wi.id,
      title: wi.fields['System.Title'],
      state: wi.fields['System.State'],
      type: wi.fields['System.WorkItemType'],
      assignedTo: wi.fields['System.AssignedTo']?.displayName || '',
      createdDate: wi.fields['System.CreatedDate'] || null,
    }));

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/ado/work-items/:id', async (req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const { id } = req.params;
    const { state } = req.body;
    if (!state) return res.status(400).json({ error: 'state is required' });

    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitems/${id}?api-version=7.1`;
    const patchBody = [{ op: 'replace', path: '/fields/System.State', value: state }];
    const patchRes = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...adoHeaders(),
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(patchBody),
      signal: AbortSignal.timeout(10000),
    });
    if (!patchRes.ok) {
      const errBody = await patchRes.text();
      let msg = `ADO ${patchRes.status}`;
      try {
        const parsed = JSON.parse(errBody);
        msg = parsed.customProperties?.ErrorMessage || parsed.message || msg;
      } catch {}
      throw new Error(msg);
    }
    const updated = await patchRes.json();
    res.json({
      id: updated.id,
      state: updated.fields['System.State'],
      title: updated.fields['System.Title'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ado/work-items', async (req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const { type, title, description } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'type and title are required' });
    const allowedTypes = ['Bug', 'User Story', 'Feature', 'Task'];
    if (!allowedTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${allowedTypes.join(', ')}` });

    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`;
    const patchBody = [
      { op: 'add', path: '/fields/System.Title', value: title },
      { op: 'add', path: '/fields/System.State', value: 'Active' },
      { op: 'add', path: '/fields/Custom.UIChangeRequired', value: 'No' },
    ];
    if (description) {
      const field = type === 'Bug' ? '/fields/Microsoft.VSTS.TCM.ReproSteps' : '/fields/System.Description';
      patchBody.push({ op: 'add', path: field, value: description });
    }

    const createRes = await fetch(url, {
      method: 'POST',
      headers: { ...adoHeaders(), 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patchBody),
      signal: AbortSignal.timeout(10000),
    });
    if (!createRes.ok) {
      const errBody = await createRes.text();
      let msg = `ADO ${createRes.status}`;
      try { const p = JSON.parse(errBody); msg = p.customProperties?.ErrorMessage || p.message || msg; } catch {}
      throw new Error(msg);
    }
    const created = await createRes.json();
    res.json({
      id: created.id,
      title: created.fields['System.Title'],
      type: created.fields['System.WorkItemType'],
      state: created.fields['System.State'],
      url: created._links?.html?.href || `https://dev.azure.com/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_workitems/edit/${created.id}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/team-members', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    // WIQL: fetch work item IDs (no ORDER BY so we get a natural diverse sample),
    // then batch-fetch AssignedTo to collect all unique assignees
    const pat = getAdoPat();
    const authHeader = `Basic ${Buffer.from(':' + pat).toString('base64')}`;
    const wiqlUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/wiql?$top=2000&api-version=7.1`;
    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${getAdoProject()}' AND [System.AssignedTo] <> ''` }),
      signal: AbortSignal.timeout(20000),
    });
    if (!wiqlRes.ok) throw new Error(`WIQL ${wiqlRes.status}: ${wiqlRes.statusText}`);
    const wiqlData = await wiqlRes.json();
    const allIds = (wiqlData.workItems || []).map(w => w.id);
    if (!allIds.length) return res.json([]);
    // Batch-fetch in chunks of 200 to get AssignedTo display names
    const batchUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitemsbatch?api-version=7.1`;
    const names = new Set();
    for (let i = 0; i < allIds.length; i += 200) {
      const ids = allIds.slice(i, i + 200);
      const batchRes = await fetch(batchUrl, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, fields: ['System.AssignedTo'] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!batchRes.ok) break;
      const batchData = await batchRes.json();
      for (const item of (batchData.value || [])) {
        const assigned = item.fields?.['System.AssignedTo'];
        const name = typeof assigned === 'object' ? assigned?.displayName : assigned;
        if (name && !name.startsWith('[')) names.add(name);
      }
    }
    res.json([...names].sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/project-repos', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories?api-version=7.1`;
    const data = await adoFetch(url);
    const repos = (data.value || []).map(r => r.name).sort();
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/work-item-types', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitemtypes?api-version=7.1`;
    const data = await adoFetch(url);
    const types = (data.value || []).map(t => t.name).sort();
    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/work-item-states', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const typesUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitemtypes?api-version=7.1`;
    const typesData = await adoFetch(typesUrl);
    const typeNames = (typesData.value || []).map(t => t.name);
    const stateArrays = await Promise.all(typeNames.map(async (type) => {
      try {
        const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=7.1`;
        const data = await adoFetch(url);
        return (data.value || []).map(s => s.name);
      } catch { return []; }
    }));
    const allStates = [...new Set(stateArrays.flat())].sort();
    res.json(allStates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/prs', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const repos = CONFIG.ado?.prRepos || [];
    const allPrs = [];

    for (const repo of repos) {
      try {
        const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories/${repo}/pullrequests?searchCriteria.status=active&api-version=7.1`;
        const data = await adoFetch(url);
        for (const pr of (data.value || [])) {
          allPrs.push({
            id: pr.pullRequestId,
            title: pr.title,
            repo,
            createdBy: pr.createdBy?.displayName || '',
            sourceBranch: pr.sourceRefName?.replace('refs/heads/', ''),
            targetBranch: pr.targetRefName?.replace('refs/heads/', ''),
            url: `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_git/${repo}/pullrequest/${pr.pullRequestId}`,
            updatedAt: pr.lastMergeSourceCommit?.author?.date || pr.creationDate || null,
          });
        }
      } catch {
        // skip repos that fail
      }
    }

    res.json(allPrs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/repo-activity', async (_req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  const repos = CONFIG.ado?.prRepos || [];
  try {
    const results = await Promise.all(repos.map(async (repo) => {
      try {
        // Get default branch name from repo metadata
        const repoMeta = await adoFetch(`${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories/${repo}?api-version=7.1`);
        const defaultBranch = (repoMeta.defaultBranch || 'refs/heads/main').replace('refs/heads/', '');
        // Get latest commit on default branch
        const statsUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories/${repo}/stats/branches?name=${encodeURIComponent(defaultBranch)}&api-version=7.1`;
        const stats = await adoFetch(statsUrl);
        return {
          repo,
          defaultBranch,
          pushedAt: stats.commit?.author?.date || stats.commit?.committer?.date || null,
        };
      } catch { return { repo, defaultBranch: 'main', pushedAt: null }; }
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pipeline / Build Status
// ---------------------------------------------------------------------------

// List all pipelines as {label, value} for the Settings picker
app.get('/api/ado/pipeline-list', async (_req, res) => {
  if (!isAdoConfigured()) return res.json([]);
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/pipelines?api-version=7.1`;
    const data = await adoFetch(url);
    const pipelines = (data.value || []).map(p => ({
      label: p.folder && p.folder !== '\\' ? `${p.folder.replace(/^\\/, '')} / ${p.name}` : p.name,
      value: p.id,
    }));
    res.json(pipelines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ado/pipelines', async (_req, res) => {
  if (!isAdoConfigured()) return res.json([]);
  try {
    const base = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}`;

    // Fetch pipeline list + pending approvals in parallel
    const [listData, approvalsData] = await Promise.all([
      adoFetch(`${base}/_apis/pipelines?api-version=7.1`),
      adoFetch(`${base}/_apis/pipelines/approvals?api-version=7.1-preview.1`).catch(() => ({ value: [] })),
    ]);

    // Build approvalId map: runId → approvalId
    const approvalsByRun = {};
    for (const a of (approvalsData.value || [])) {
      if (a.status === 'pending' && a.pipeline?.id) {
        approvalsByRun[a.pipeline.id] = a.id;
      }
    }

    // Filter to configured pipeline IDs if set (coerce strings → numbers for saved settings)
    const allowedIds = CONFIG.ado?.pipelineIds?.map(Number);
    let pipelines = listData.value || [];
    if (allowedIds?.length) pipelines = pipelines.filter(p => allowedIds.includes(p.id));

    const results = await Promise.all(pipelines.map(async (p) => {
      try {
        const runsData = await adoFetch(`${base}/_apis/pipelines/${p.id}/runs?$top=1&api-version=7.1`);
        const r = (runsData.value || [])[0] || null;
        if (!r) return { id: p.id, name: p.name, folder: p.folder, latestRun: null };

        // Normalise status: real ADO uses state+result, drone adds a status field
        let status = r.status; // drone
        if (!status) {
          if (r.state === 'completed') status = r.result || 'succeeded';
          else if (r.state === 'inProgress') status = 'running';
          else status = r.state || 'unknown';
        }

        return {
          id: p.id, name: p.name, folder: p.folder,
          latestRun: {
            id: r.id,
            runNumber: r.name,
            status,
            startTime: r.startTime || r.createdDate,
            finishTime: r.finishTime || r.finishedDate,
            triggeredBy: r.triggeredBy?.displayName || r.requestedFor?.displayName || '',
            // approvalId present → real ADO approval gate; approval obj → drone
            approvalId: approvalsByRun[r.id] || null,
            approval: r.approval || null,
          },
        };
      } catch {
        return { id: p.id, name: p.name, folder: p.folder, latestRun: null };
      }
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a new pipeline run
app.post('/api/ado/pipelines/:id/runs', async (req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/pipelines/${req.params.id}/runs?api-version=7.1`;
    const data = await adoFetch(url, { method: 'POST', body: JSON.stringify(req.body || {}), headers: { 'Content-Type': 'application/json' } });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve via real ADO approvals API (PATCH with approvalId)
app.post('/api/ado/pipelines/approvals/:approvalId', async (req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/pipelines/approvals?api-version=7.1-preview.1`;
    const data = await adoFetch(url, {
      method: 'PATCH',
      body: JSON.stringify([{ approvalId: req.params.approvalId, status: 'approved', comment: req.body?.comment || '' }]),
      headers: { 'Content-Type': 'application/json' },
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve via drone-style run endpoint (POST to runs/:runId/approve)
app.post('/api/ado/pipelines/:id/runs/:runId/approve', async (req, res) => {
  if (!isAdoConfigured()) return res.status(404).json({ error: 'ADO not configured' });
  try {
    const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/pipelines/${req.params.id}/runs/${req.params.runId}/approve?api-version=7.1`;
    const data = await adoFetch(url, { method: 'POST', body: JSON.stringify(req.body || {}), headers: { 'Content-Type': 'application/json' } });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Activity Feed — unified event stream across all sources
// ---------------------------------------------------------------------------

app.get('/api/activity', async (_req, res) => {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000); // 48h window
  const events = [];

  const push = (source, timestamp, text, url = null, level = 'info', repo = null) => {
    const ts = new Date(timestamp);
    if (isNaN(ts) || ts < cutoff) return;
    const ev = { source, timestamp: ts.toISOString(), text, url, level };
    if (repo) ev.repo = repo;
    events.push(ev);
  };

  await Promise.all([

    // ── Git commits ────────────────────────────────────────────────────────
    (async () => {
      try {
        const since = new Date(cutoff).toISOString();
        const all = (await Promise.all(
          REPOS_RESOLVED.map(r => gitLogRepo(r, [`--after=${since}`, 'HEAD']))
        )).flat();
        // Group commits by author+repo within 10-minute windows
        const groups = new Map();
        for (const c of all) {
          const bucket = Math.floor(new Date(c.date) / (10 * 60 * 1000));
          const key = `${c.repo}|${c.author}|${bucket}`;
          if (!groups.has(key)) groups.set(key, { ...c, count: 0, latest: c.date });
          const g = groups.get(key);
          g.count++;
          if (new Date(c.date) > new Date(g.latest)) { g.latest = c.date; g.message = c.message; }
        }
        for (const g of groups.values()) {
          const what = g.count === 1 ? `"${g.message}"` : `${g.count} commits`;
          push('git', g.latest, `${g.author} pushed ${what} to ${g.repo}`, null, 'info', g.repo);
        }
      } catch { /* skip */ }
    })(),

    // ── ADO work items changed recently ────────────────────────────────────
    (async () => {
      if (!isAdoConfigured()) return;
      try {
        const project = getAdoProject().replace(/'/g, "''");
        const wiql = { query: `SELECT [System.Id],[System.Title],[System.State],[System.WorkItemType],[System.AssignedTo],[System.ChangedDate],[System.CreatedDate] FROM workitems WHERE [System.TeamProject]='${project}' AND [System.ChangedDate]>=@today-2 ORDER BY [System.ChangedDate] DESC` };
        const wiqlUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/wiql?api-version=7.1`;
        const wiqlRes = await fetch(wiqlUrl, { method: 'POST', headers: adoHeaders(), body: JSON.stringify(wiql), signal: AbortSignal.timeout(10000) });
        if (!wiqlRes.ok) return;
        const wiqlData = await wiqlRes.json();
        const ids = (wiqlData.workItems || []).map(w => w.id).slice(0, 50);
        if (!ids.length) return;
        const batchUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.AssignedTo,System.ChangedDate,System.CreatedDate&api-version=7.1`;
        const batch = await adoFetch(batchUrl);
        for (const wi of (batch.value || [])) {
          const f = wi.fields;
          const who = f['System.AssignedTo']?.displayName || 'Someone';
          const isNew = f['System.CreatedDate'] === f['System.ChangedDate'];
          const title = f['System.Title'];
          const type = f['System.WorkItemType'];
          const state = f['System.State'];
          const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_workitems/edit/${wi.id}`;
          const text = isNew
            ? `New ${type.toLowerCase()}: "${title}" assigned to ${who}`
            : `${who} updated "${title}" → ${state}`;
          push('ado', f['System.ChangedDate'], text, url, 'info', type);
        }
      } catch { /* skip */ }
    })(),

    // ── ADO PRs ────────────────────────────────────────────────────────────
    (async () => {
      if (!isAdoConfigured()) return;
      try {
        const repos = CONFIG.ado?.prRepos || [];
        for (const repo of repos) {
          try {
            const url = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories/${repo}/pullrequests?searchCriteria.status=active&api-version=7.1`;
            const data = await adoFetch(url);
            for (const pr of (data.value || [])) {
              const who = pr.createdBy?.displayName || '';
              const src = pr.sourceRefName?.replace('refs/heads/', '') || '';
              const tgt = pr.targetRefName?.replace('refs/heads/', '') || '';
              const prUrl = `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_git/${repo}/pullrequest/${pr.pullRequestId}`;
              push('ado', pr.creationDate, `${who} opened PR: "${pr.title}" (${src} → ${tgt})`, prUrl, 'info', repo);
            }
          } catch { /* skip repo */ }
        }
      } catch { /* skip */ }
    })(),

    // ── Sentry issues ──────────────────────────────────────────────────────
    (async () => {
      if (!getSentryOrg() || !getSentryToken()) return;
      try {
        const projects = CONFIG.sentry?.projects || [];
        for (const project of projects) {
          try {
            const url = `${SENTRY_BASE_URL}/api/0/projects/${getSentryOrg()}/${project}/issues/?query=is:unresolved&sort=date&limit=20`;
            const data = await sentryFetch(url);
            for (const issue of (Array.isArray(data) ? data : [])) {
              const level = issue.level === 'fatal' || issue.level === 'error' ? 'error' : 'warning';
              push('sentry', issue.lastSeen, `${issue.level.toUpperCase()}: ${issue.title}`, issue.permalink, level, project);
            }
          } catch { /* skip project */ }
        }
      } catch { /* skip */ }
    })(),

    // ── GitHub PRs ─────────────────────────────────────────────────────────
    (async () => {
      if (!isGithubConfigured()) return;
      try {
        const prRepos = CONFIG.github?.prRepos || [];
        const users = new Set((CONFIG.github?.users || []).map(u => u.toLowerCase()));
        for (const fullName of prRepos) {
          try {
            const data = await githubFetch(`${GITHUB_API}/repos/${fullName}/pulls?state=all&sort=updated&per_page=20`);
            for (const pr of (Array.isArray(data) ? data : [])) {
              const login = (pr.user?.login || '').toLowerCase();
              if (users.size > 0 && !users.has(login)) continue;
              const merged = pr.merged_at;
              const ts = merged || pr.created_at;
              const action = merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'opened';
              const repoName = fullName.split('/').pop();
              push('github', ts, `${pr.user?.login} ${action} PR #${pr.number}: "${pr.title}"`, pr.html_url, merged ? 'success' : 'info', repoName);
            }
          } catch { /* skip repo */ }
        }
      } catch { /* skip */ }
    })(),

    // ── GitHub Actions runs ────────────────────────────────────────────────
    (async () => {
      if (!isGithubConfigured()) return;
      try {
        const watchRepos = CONFIG.github?.watchRepos || [];
        for (const fullName of watchRepos) {
          try {
            const data = await githubFetch(`${GITHUB_API}/repos/${fullName}/actions/runs?per_page=10`);
            for (const run of (data.workflow_runs || [])) {
              if (run.status !== 'completed') continue;
              const ok = run.conclusion === 'success';
              const repoShort = fullName.split('/').pop();
              push('github', run.updated_at,
                `${run.name} ${ok ? 'passed' : 'failed'} on ${repoShort}/${run.head_branch}`,
                run.html_url, ok ? 'success' : 'error', repoShort);
            }
          } catch { /* skip repo */ }
        }
      } catch { /* skip */ }
    })(),

  ]);

  events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(events.slice(0, 60));
});

// ---------------------------------------------------------------------------
// Unified Commit History & Contributions
// ---------------------------------------------------------------------------
const COMMIT_FORMAT = '%H\x1f%h\x1f%an\x1f%aI\x1f%s';

async function gitLogRepo({ name, dir }, args) {
  const cwd = repoDir(name);
  if (!existsSync(join(cwd, '.git'))) return [];
  try {
    const out = execFileSync('git', ['log', '--no-merges', `--format=${COMMIT_FORMAT}`, ...args], {
      cwd, encoding: 'utf-8', timeout: 6000,
    });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [hash, shortHash, author, date, ...rest] = line.split('\x1f');
      return { repo: name, hash, shortHash, author, date, message: rest.join('\x1f') };
    });
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Claude Skills overview
// ---------------------------------------------------------------------------
const CLAUDE_SHARED_ROOT = join(__dirname, '..', '..');
const SHARED_SKILLS_DIR  = join(CLAUDE_SHARED_ROOT, '.claude', 'skills');
const USER_SKILLS_DIR    = join(homedir(), '.claude', 'skills');

function parseSkillFrontmatter(skillDir) {
  try {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
    const m = md.match(/^---\n([\s\S]*?)\n---/);
    if (m) {
      const desc = (m[1].match(/^description:\s*(.+)$/m) || [])[1] || '';
      return { description: desc.replace(/^["']|["']$/g, '').trim() };
    }
  } catch { /* missing or unreadable */ }
  return { description: '' };
}

function readSkillsDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(dir, e.name, 'SKILL.md')))
    .map(e => ({ name: e.name, ...parseSkillFrontmatter(join(dir, e.name)) }));
}

// Returns the symlink/junction target path, or null if not a symlink
function getJunctionTarget(fullPath) {
  try {
    const lst = lstatSync(fullPath, { throwIfNoEntry: false });
    if (!lst || !lst.isSymbolicLink()) return null;
    return readlinkSync(fullPath);
  } catch { return null; }
}

app.get('/api/claude/skills', (req, res) => {
  // 1. Shared skills (source of truth)
  const sharedSkills = readSkillsDir(SHARED_SKILLS_DIR).map(s => {
    const linkPath = join(USER_SKILLS_DIR, s.name);
    let linkStatus = 'unlinked';
    if (existsSync(linkPath)) {
      const target = getJunctionTarget(linkPath);
      if (target) {
        const normalTarget = target.toLowerCase().replace(/\\/g, '/');
        const normalShared = join(SHARED_SKILLS_DIR, s.name).toLowerCase().replace(/\\/g, '/');
        linkStatus = normalTarget.includes(s.name) || normalTarget === normalShared ? 'linked' : 'other';
      } else {
        linkStatus = 'directory'; // exists but not a junction
      }
    }
    return { ...s, linkStatus, path: join(SHARED_SKILLS_DIR, s.name) };
  });

  // 2. Personal skills — in ~/.claude/skills but NOT junctions pointing to claude-shared
  const personalSkills = [];
  const staleJunctions = [];
  if (existsSync(USER_SKILLS_DIR)) {
    for (const entry of readdirSync(USER_SKILLS_DIR, { withFileTypes: true })) {
      const fullPath = join(USER_SKILLS_DIR, entry.name);
      const target = getJunctionTarget(fullPath);
      const normalShared = SHARED_SKILLS_DIR.toLowerCase().replace(/\\/g, '/');
      if (target) {
        const normalTarget = (typeof target === 'string' ? target : fullPath).toLowerCase().replace(/\\/g, '/');
        if (normalTarget.includes(normalShared.split('/').slice(-3).join('/'))) {
          // Points to claude-shared — check if skill still exists there
          if (!existsSync(join(SHARED_SKILLS_DIR, entry.name))) {
            staleJunctions.push({ name: entry.name, linkTarget: typeof target === 'string' ? target : fullPath });
          }
          continue; // skip — handled in sharedSkills
        }
      }
      // Not a junction to claude-shared, or a plain directory
      if (existsSync(join(fullPath, 'SKILL.md'))) {
        personalSkills.push({ name: entry.name, path: fullPath, ...parseSkillFrontmatter(fullPath) });
      }
    }
  }

  // 3. Per-repo skills
  const repoSkills = {};
  for (const repo of REPOS_RESOLVED) {
    const dir = join(resolveRepoPath(repo.dir), '.claude', 'skills');
    const skills = readSkillsDir(dir).map(s => ({ ...s, path: join(dir, s.name) }));
    if (skills.length > 0) repoSkills[repo.name] = skills;
  }

  // 4. CLAUDE.md files — global, per-repo, and walk-up ancestors
  const claudeMds = [];
  const seenPaths = new Set();

  function addClaudeMd(filePath, label) {
    const norm = filePath.toLowerCase().replace(/\\/g, '/');
    if (seenPaths.has(norm)) return;
    seenPaths.add(norm);
    const exists = existsSync(filePath);
    let preview = '';
    if (exists) {
      try {
        const lines = readFileSync(filePath, 'utf-8').split('\n');
        preview = lines.find(l => l.trim() && !l.startsWith('#'))?.trim().slice(0, 80) || lines[0]?.trim().slice(0, 80) || '';
      } catch { /* ignore */ }
    }
    claudeMds.push({ label, path: filePath, exists, preview });
  }

  // Global
  addClaudeMd(join(homedir(), '.claude', 'CLAUDE.md'), 'Global (~/.claude/CLAUDE.md)');

  // Walk-up from each repo — collect ancestor dirs (deduplicated), closest first
  const ancestorDirs = new Set();
  for (const repo of REPOS_RESOLVED) {
    const repoPath = resolveRepoPath(repo.dir);
    // Project-level
    addClaudeMd(join(repoPath, 'CLAUDE.md'), `Project: ${repo.name}`);
    // Walk up from parent
    let cur = join(repoPath, '..');
    const root = isWindows ? cur.split(/[\\/]/)[0] + '\\' : '/';
    for (let i = 0; i < 6; i++) {
      const norm = cur.toLowerCase().replace(/\\/g, '/');
      if (!ancestorDirs.has(norm)) {
        ancestorDirs.add(norm);
        addClaudeMd(join(cur, 'CLAUDE.md'), `Ancestor: ${cur}`);
      }
      const parent = join(cur, '..');
      if (parent === cur || cur === root) break;
      cur = parent;
    }
  }

  res.json({ shared: sharedSkills, personal: personalSkills, stale: staleJunctions, repos: repoSkills, claudeMds });
});

// Read a skill's SKILL.md content (path passed as base64-encoded query param)
app.get('/api/claude/skill', (req, res) => {
  try {
    const skillPath = Buffer.from(req.query.p || '', 'base64').toString('utf-8');
    const mdPath = join(skillPath, 'SKILL.md');
    if (!mdPath.includes('.claude') && !mdPath.includes('skills')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!existsSync(mdPath)) return res.status(404).json({ error: 'Not found' });
    res.json({ content: readFileSync(mdPath, 'utf-8'), path: mdPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write a skill's SKILL.md content
app.put('/api/claude/skill', express.json({ limit: '500kb' }), (req, res) => {
  try {
    const skillPath = Buffer.from(req.body?.p || '', 'base64').toString('utf-8');
    const mdPath = join(skillPath, 'SKILL.md');
    if (!mdPath.includes('.claude') && !mdPath.includes('skills')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!existsSync(skillPath)) return res.status(404).json({ error: 'Skill directory not found' });
    writeFileSync(mdPath, req.body.content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read/write a CLAUDE.md file by its full path (base64-encoded)
app.get('/api/claude/claudemd', (req, res) => {
  try {
    const filePath = Buffer.from(req.query.p || '', 'base64').toString('utf-8');
    if (!filePath.endsWith('CLAUDE.md')) return res.status(403).json({ error: 'Forbidden' });
    if (!existsSync(filePath)) {
      return res.json({ content: '', path: filePath, exists: false });
    }
    res.json({ content: readFileSync(filePath, 'utf-8'), path: filePath, exists: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/claude/claudemd', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const filePath = Buffer.from(req.body?.p || '', 'base64').toString('utf-8');
    if (!filePath.endsWith('CLAUDE.md')) return res.status(403).json({ error: 'Forbidden' });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, req.body.content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run setup script to sync junctions
app.post('/api/claude/sync', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();

  const scriptPath = isWindows
    ? join(CLAUDE_SHARED_ROOT, 'setup.ps1')
    : join(CLAUDE_SHARED_ROOT, 'setup.sh');
  const cmd  = isWindows ? 'powershell.exe' : 'bash';
  const args = isWindows ? ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] : [scriptPath];

  const proc = spawn(cmd, args, { cwd: CLAUDE_SHARED_ROOT, env: process.env });
  proc.stdout.on('data', d => res.write(d.toString()));
  proc.stderr.on('data', d => res.write(d.toString()));
  proc.on('close', code => {
    res.write(`\n[exit ${code}]`);
    res.end();
  });
  proc.on('error', err => { res.write(`\nERROR: ${err.message}`); res.end(); });
});

app.get('/api/commits', async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 60, 300);
  const author = req.query.author || '';
  const args   = [`-n${limit}`];
  if (author) args.push(`--author=${author}`);
  args.push('HEAD');
  try {
    const all = (await Promise.all(REPOS_RESOLVED.map(r => gitLogRepo(r, args))))
      .flat()
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/commits/contributions', async (req, res) => {
  const days   = Math.min(parseInt(req.query.days) || 365, 365);
  const author = req.query.author || '';
  const since  = new Date(); since.setDate(since.getDate() - days);
  const args   = [`--format=%aI`, `--after=${since.toISOString().split('T')[0]}`];
  if (author) args.push(`--author=${author}`);
  args.push('HEAD');
  try {
    const entries = (await Promise.all(REPOS_RESOLVED.map(async r => {
      const cwd = repoDir(r.name);
      if (!existsSync(join(cwd, '.git'))) return [];
      try {
        const out = execFileSync('git', ['log', '--no-merges', ...args], { cwd, encoding: 'utf-8', timeout: 6000 });
        return out.trim().split('\n').filter(Boolean).map(d => ({ repo: r.name, day: d.split('T')[0] }));
      } catch { return []; }
    }))).flat();

    const byDay = {};
    for (const { repo, day } of entries) {
      if (!byDay[day]) byDay[day] = { total: 0, repos: {} };
      byDay[day].total++;
      byDay[day].repos[repo] = (byDay[day].repos[repo] || 0) + 1;
    }
    res.json(byDay);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GitHub contribution calendar (GraphQL) — returns { "YYYY-MM-DD": count }
app.get('/api/github/contributions', async (req, res) => {
  const days  = Math.min(parseInt(req.query.days) || 365, 365);
  const token = getGithubToken();
  if (!token) return res.json({});

  const to   = new Date();
  const from = new Date(); from.setDate(from.getDate() - days);

  try {
    // Resolve authenticated login
    const userRes = await fetch(`${GITHUB_API}/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!userRes.ok) return res.json({});
    const { login } = await userRes.json();

    const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){
        contributionsCollection(from:$from,to:$to){
          contributionCalendar{
            weeks{ contributionDays{ date contributionCount } }
          }
        }
      }
    }`;
    const gqlRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { login, from: from.toISOString(), to: to.toISOString() } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!gqlRes.ok) return res.json({});
    const gql = await gqlRes.json();

    const byDay = {};
    const weeks = gql.data?.user?.contributionsCollection?.contributionCalendar?.weeks || [];
    for (const week of weeks) {
      for (const day of week.contributionDays) {
        if (day.contributionCount > 0) byDay[day.date] = day.contributionCount;
      }
    }
    res.json(byDay);
  } catch (err) { res.json({}); }
});

// ADO commit contributions — returns { "YYYY-MM-DD": count }
app.get('/api/ado/contributions', async (req, res) => {
  const days   = Math.min(parseInt(req.query.days) || 365, 365);
  const author = req.query.author || '';
  if (!isAdoConfigured()) return res.json({});

  const authHeader = 'Basic ' + Buffer.from(':' + getAdoPat()).toString('base64');
  const since = new Date(); since.setDate(since.getDate() - days);
  const fromDate = since.toISOString();

  try {
    // Get repo list — use configured prRepos first, fall back to all project repos
    let repoNames = CONFIG.ado?.prRepos || [];
    if (!repoNames.length) {
      const r = await fetch(
        `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories?api-version=7.1`,
        { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(10000) }
      );
      if (r.ok) repoNames = ((await r.json()).value || []).map(r => r.name);
    }

    const byDay = {};
    await Promise.all(repoNames.map(async repoName => {
      const params = new URLSearchParams({ 'searchCriteria.fromDate': fromDate, '$top': '1000', 'api-version': '7.1' });
      if (author) params.set('searchCriteria.author', author);
      try {
        const r = await fetch(
          `${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories/${encodeURIComponent(repoName)}/commits?${params}`,
          { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(10000) }
        );
        if (!r.ok) return;
        for (const commit of ((await r.json()).value || [])) {
          const day = (commit.author?.date || commit.committer?.date || '').split('T')[0];
          if (day) byDay[day] = (byDay[day] || 0) + 1;
        }
      } catch { /* skip repo */ }
    }));
    res.json(byDay);
  } catch (err) { res.json({}); }
});

// ---------------------------------------------------------------------------
// Repo Discovery & Clone
// ---------------------------------------------------------------------------
app.get('/api/repos/discover', async (_req, res) => {
  try {
    const trackedSet = new Set(
      (CONFIG.repos || []).map(r => (Array.isArray(r) ? r[1] : r).toLowerCase())
    );

    function findLocalPath(name) {
      const variations = [name, name.toLowerCase(), name.replace(/\s+/g, '-').toLowerCase(), name.replace(/\s+/g, '_').toLowerCase()];
      for (const v of variations) {
        const p = join(BASE_DIR, v);
        if (existsSync(join(p, '.git'))) return p;
      }
      return null;
    }
    function suggestPath(name) {
      return join(BASE_DIR, name.replace(/\s+/g, '-').toLowerCase());
    }

    const results = [];

    // ADO repos
    if (isAdoConfigured()) {
      try {
        const data = await adoFetch(`${ADO_BASE_URL}/${getAdoOrg()}/${encodeURIComponent(getAdoProject())}/_apis/git/repositories?api-version=7.1`);
        for (const r of (data.value || [])) {
          const localPath = findLocalPath(r.name);
          results.push({
            name: r.name, source: 'ado', cloneUrl: r.remoteUrl,
            localPath: localPath || suggestPath(r.name),
            found: !!localPath,
            tracked: trackedSet.has(r.name.toLowerCase()),
          });
        }
      } catch { /* ADO unavailable */ }
    }

    // GitHub repos — /user/repos covers personal private repos + org repos the token can access.
    // /orgs/{org}/repos is additionally queried if org is configured (catches org-only repos).
    if (isGithubConfigured()) {
      const ghSeen = new Set(); // deduplicate by full_name across both calls

      function addGhRepo(r) {
        if (ghSeen.has(r.full_name)) return;
        ghSeen.add(r.full_name);
        // Skip if the same folder name already came from ADO
        if (results.some(x => x.name.toLowerCase() === r.name.toLowerCase() && x.source === 'ado')) return;
        const localPath = findLocalPath(r.name);
        results.push({
          name: r.name, fullName: r.full_name, source: 'github', cloneUrl: r.clone_url,
          localPath: localPath || suggestPath(r.name),
          found: !!localPath,
          tracked: trackedSet.has(r.name.toLowerCase()) || trackedSet.has(r.full_name.toLowerCase()),
        });
      }

      const repoToken = getGithubRepoToken();

      // Personal + accessible repos (includes private personal repos)
      try {
        const data = await githubFetch(`${GITHUB_API}/user/repos?per_page=100&type=all&sort=full_name`, repoToken);
        for (const r of (Array.isArray(data) ? data : [])) addGhRepo(r);
      } catch { /* GitHub unavailable */ }

      // Org repos (if org configured — may surface org repos not returned by /user/repos)
      for (const org of getGithubOrgs()) {
        try {
          const data = await githubFetch(`${GITHUB_API}/orgs/${org}/repos?per_page=100&type=all&sort=full_name`, repoToken);
          for (const r of (Array.isArray(data) ? data : [])) addGhRepo(r);
        } catch { /* org unavailable */ }
      }
    }

    results.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ baseDir: BASE_DIR, repos: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 7: GitHub Integration
// ---------------------------------------------------------------------------
function getGithubOrgs() {
  const raw = CONFIG.github?.org || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
const GITHUB_API = 'https://api.github.com';

function getGithubToken() {
  return process.env.GITHUB_TOKEN || '';
}

// GITHUB_REPO_TOKEN is a PAT with `repo` scope for listing/cloning repos.
// Falls back to GITHUB_TOKEN if not set (works if the main token has repo scope).
function getGithubRepoToken() {
  return process.env.GITHUB_REPO_TOKEN || process.env.GITHUB_TOKEN || '';
}

function isGithubConfigured() {
  return !!getGithubToken();
}

async function githubFetch(url, token) {
  token = token || getGithubToken();
  if (!token) throw new Error('GITHUB_TOKEN not configured');
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  return res.json();
}

app.get('/api/github/status', (_req, res) => {
  res.json({ configured: isGithubConfigured() });
});

app.get('/api/github/test', async (_req, res) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.json({ ok: false, error: 'GITHUB_TOKEN not set' });
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${r.statusText}`);
    const user = await r.json();
    res.json({ ok: true, message: `Authenticated as ${user.login}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/github/prs', async (_req, res) => {
  if (!isGithubConfigured()) return res.status(404).json({ error: 'GitHub not configured' });
  try {
    const prRepos = CONFIG.github?.prRepos || [];
    const users = new Set((CONFIG.github?.users || []).map(u => u.toLowerCase()));
    const allPrs = [];

    await Promise.all(prRepos.map(async (fullName) => {
      try {
        const data = await githubFetch(`${GITHUB_API}/repos/${fullName}/pulls?state=open&per_page=50`);
        for (const pr of (Array.isArray(data) ? data : [])) {
          const authorLogin = (pr.user?.login || '').toLowerCase();
          const reviewerLogins = (pr.requested_reviewers || []).map(r => r.login.toLowerCase());
          const relevant = users.size === 0
            || users.has(authorLogin)
            || reviewerLogins.some(r => users.has(r));
          if (!relevant) continue;
          allPrs.push({
            id: pr.number,
            title: pr.title,
            repo: fullName,
            author: pr.user?.login || '',
            requestedReviewers: (pr.requested_reviewers || []).map(r => r.login),
            sourceBranch: pr.head?.ref || '',
            targetBranch: pr.base?.ref || '',
            url: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            draft: pr.draft || false,
          });
        }
      } catch { /* skip individual repo failures */ }
    }));

    allPrs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(allPrs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/repo-activity', async (_req, res) => {
  if (!isGithubConfigured()) return res.status(404).json({ error: 'GitHub not configured' });
  const repoToken = getGithubRepoToken();
  const repos = [...new Set([...(CONFIG.github?.prRepos || []), ...(CONFIG.github?.watchRepos || [])])];
  try {
    const results = await Promise.all(repos.map(async (fullName) => {
      try {
        const data = await githubFetch(`${GITHUB_API}/repos/${fullName}`, repoToken);
        return { repo: fullName, pushedAt: data.pushed_at, defaultBranch: data.default_branch };
      } catch { return { repo: fullName, pushedAt: null, defaultBranch: 'main' }; }
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/actions', async (_req, res) => {
  if (!isGithubConfigured()) return res.status(404).json({ error: 'GitHub not configured' });
  try {
    const watchRepos = CONFIG.github?.watchRepos || [];
    const results = [];

    await Promise.all(watchRepos.map(async (fullName) => {
      try {
        const data = await githubFetch(`${GITHUB_API}/repos/${fullName}/actions/runs?per_page=5`);
        const runs = data.workflow_runs || [];
        if (!runs.length) return;
        const latest = runs[0];
        results.push({
          repo: fullName,
          name: latest.name,
          status: latest.status,
          conclusion: latest.conclusion,
          url: latest.html_url,
          branch: latest.head_branch,
          createdAt: latest.created_at,
        });
      } catch { /* skip individual repo failures */ }
    }));

    results.sort((a, b) => a.repo.localeCompare(b.repo));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/org-members', async (_req, res) => {
  if (!isGithubConfigured()) return res.status(404).json({ error: 'GitHub not configured' });
  const orgs = getGithubOrgs();
  if (!orgs.length) return res.status(400).json({ error: 'github.org not configured' });
  try {
    const all = new Set();
    const errors = [];
    for (const org of orgs) {
      try {
        const data = await githubFetch(`${GITHUB_API}/orgs/${org}/members?per_page=100`);
        for (const m of (Array.isArray(data) ? data : [])) all.add(m.login);
      } catch (err) { errors.push(`${org}: ${err.message}`); }
    }
    if (all.size === 0 && errors.length) return res.status(500).json({ error: errors.join('; ') });
    res.json([...all].sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/org-repos', async (_req, res) => {
  if (!isGithubConfigured()) return res.status(404).json({ error: 'GitHub not configured' });
  const orgs = getGithubOrgs();
  if (!orgs.length) return res.status(400).json({ error: 'github.org not configured' });
  const repoToken = getGithubRepoToken();
  const orgSet = new Set(orgs.map(o => o.toLowerCase()));
  try {
    const all = new Set();
    const errors = [];
    for (const org of orgs) {
      try {
        const data = await githubFetch(`${GITHUB_API}/orgs/${org}/repos?per_page=100&type=all&sort=full_name`, repoToken);
        for (const r of (Array.isArray(data) ? data : [])) all.add(r.full_name);
      } catch (err) { errors.push(`${org}: ${err.message}`); }
    }
    // Also query /user/repos to catch private repos the token can access but the org
    // endpoint won't return (e.g. fine-grained PATs or limited-scope tokens).
    try {
      const userData = await githubFetch(`${GITHUB_API}/user/repos?per_page=100&type=all&sort=full_name`, repoToken);
      for (const r of (Array.isArray(userData) ? userData : [])) {
        if (orgSet.has((r.owner?.login || '').toLowerCase())) all.add(r.full_name);
      }
    } catch (_) { /* best-effort */ }
    if (all.size === 0 && errors.length) return res.status(500).json({ error: errors.join('; ') });
    res.json([...all].sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sentry Integration
// ---------------------------------------------------------------------------
function getSentryOrg() { return CONFIG.sentry?.org || ''; }
const SENTRY_BASE_URL = CONFIG.sentryBaseUrl || 'https://sentry.io';

function getSentryToken() {
  return process.env.SENTRY_AUTH_TOKEN || '';
}

async function sentryFetch(url) {
  const token = getSentryToken();
  if (!token) throw new Error('SENTRY_AUTH_TOKEN not configured');

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Sentry API ${res.status}: ${res.statusText}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error(`Sentry API returned non-JSON response (${ct || 'no content-type'})`);
  return res.json();
}

app.get('/api/sentry/status', (_req, res) => {
  const token = getSentryToken();
  res.json({ configured: !!token });
});

app.get('/api/sentry/test', async (_req, res) => {
  if (!getSentryToken()) return res.json({ ok: false, error: 'SENTRY_AUTH_TOKEN not set' });
  if (!getSentryOrg()) return res.json({ ok: false, error: 'Sentry organization not configured' });
  try {
    const url = `${SENTRY_BASE_URL}/api/0/organizations/${getSentryOrg()}/`;
    await sentryFetch(url);
    res.json({ ok: true, message: `Connected to ${getSentryOrg()}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/sentry/issues', async (req, res) => {
  if (!getSentryOrg() || !getSentryToken()) return res.status(404).json({ error: 'Sentry not configured' });
  try {
    const sentryProjects = CONFIG.sentry?.projects || [];
    const project = req.query.project || sentryProjects[0] || '';
    if (!project) return res.status(400).json({ error: 'No Sentry project specified. Configure sentry.projects in dashboard.config.json' });
    if (sentryProjects.length > 0 && !sentryProjects.includes(project)) {
      return res.status(400).json({ error: `Invalid project. Use one of: ${sentryProjects.join(', ')}` });
    }

    const url = `${SENTRY_BASE_URL}/api/0/projects/${getSentryOrg()}/${project}/issues/?query=is:unresolved&sort=date&limit=25`;
    const data = await sentryFetch(url);

    const issues = (Array.isArray(data) ? data : []).map(issue => ({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit || '',
      level: issue.level || 'error',
      count: parseInt(issue.count, 10) || 0,
      userCount: issue.userCount || 0,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      permalink: issue.permalink,
    }));

    res.json(issues);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Copilot Chat (GitHub Models API — OpenAI-compatible)
// ---------------------------------------------------------------------------
const COPILOT_MODELS = [
  { id: 'gpt-4o',                            label: 'GPT-4o',           group: 'OpenAI'    },
  { id: 'gpt-4o-mini',                       label: 'GPT-4o mini',      group: 'OpenAI'    },
  { id: 'o1-mini',                           label: 'o1-mini',          group: 'OpenAI'    },
  { id: 'Meta-Llama-3.1-70B-Instruct',       label: 'Llama 3.1 70B',    group: 'Meta'      },
  { id: 'Mistral-large',                     label: 'Mistral Large',    group: 'Mistral'   },
  { id: 'Phi-3.5-mini-instruct',             label: 'Phi-3.5 mini',     group: 'Microsoft' },
];

app.get('/api/copilot/status', (_req, res) => {
  res.json({ configured: !!process.env.GITHUB_TOKEN, models: COPILOT_MODELS });
});

app.post('/api/copilot/chat', express.json({ limit: '4mb' }), async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(503).json({ error: 'GITHUB_TOKEN not configured in .env' });

  const { messages: rawMessages, model = 'gpt-4o-mini' } = req.body || {};
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // GitHub Models free tier caps ALL models at 8000 input tokens.
  // 4 chars ≈ 1 token; reserve ~2000 tokens for the response → ~24000 char budget.
  const charBudget = 24000;

  let messages = rawMessages;
  while (messages.length > 2 && JSON.stringify(messages).length > charBudget) {
    // Drop the oldest non-system message pair to make room
    const systemMsg = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages.slice(systemMsg.length);
    messages = [...systemMsg, ...rest.slice(2)]; // drop oldest user+assistant pair
  }
  // Hard truncate individual message content if still over budget (e.g. huge single attachment)
  const serialized = JSON.stringify(messages);
  if (serialized.length > charBudget) {
    messages = messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' && m.content.length > 4000
        ? m.content.slice(0, 4000) + '\n…(truncated to fit model context)'
        : m.content,
    }));
  }

  try {
    const upstream = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: 4096 }),
      signal: AbortSignal.timeout(60000),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// Sentry: issue detail + stack frames
// ---------------------------------------------------------------------------

// Strip common deployment path prefixes to get a repo-relative file path
function sentryResolvePath(filename, absPath) {
  const STRIP_PREFIXES = [
    '/home/site/wwwroot/',   // Azure App Service
    '/usr/src/app/',         // Docker convention
    '/app/',                 // Docker short
    'app:///../',            // Electron-style bundler
    'app:///',
    'webpack:///src/',       // webpack with source maps
    'webpack:///./src/',
    'webpack:///./node_modules/', // stop webpack node_modules
    'webpack:///',
  ];
  const JUNK = ['<anonymous>', '<unknown>', 'node:', 'async ', '('];

  for (const raw of [absPath, filename].filter(Boolean)) {
    if (JUNK.some(j => raw.startsWith(j)) || raw.includes('node_modules')) continue;
    for (const prefix of STRIP_PREFIXES) {
      if (raw.startsWith(prefix)) {
        const rel = raw.slice(prefix.length);
        if (rel && !rel.startsWith('/') && rel.includes('/')) return rel;
      }
    }
    // If it already looks like a relative src path (starts with src/, lib/, etc.)
    if (/^(src|lib|app|server|client|shared|common|modules?)\//i.test(raw)) return raw;
  }
  return null;
}

// Map a Sentry project slug to the local repo name
function sentryProjectToRepo(project) {
  const map = CONFIG.sentry?.projectRepoMap || {};
  if (map[project]) return map[project];
  // Built-in conventions
  if (project === 'via-api') return 'montra-via-api';
  if (project === 'via-ui')  return 'montra-via-web';
  // Fallback: find a repo whose name contains the project slug
  return REPOS.find(r => r.includes(project)) || null;
}

app.get('/api/sentry/issue/:id', async (req, res) => {
  if (!getSentryOrg() || !getSentryToken()) return res.status(404).json({ error: 'Sentry not configured' });
  try {
    const { id } = req.params;
    const [issue, event] = await Promise.all([
      sentryFetch(`${SENTRY_BASE_URL}/api/0/issues/${id}/`),
      sentryFetch(`${SENTRY_BASE_URL}/api/0/issues/${id}/events/latest/?full=true`),
    ]);

    const project = issue.project?.slug || '';
    const repo = sentryProjectToRepo(project);

    // Extract exception frames from the event's entries array
    const excEntry = (event.entries || []).find(e => e.type === 'exception');
    const exceptions = excEntry?.data?.values || [];

    const groups = []; // [{ type, value, frames: [...] }]

    for (const exc of exceptions) {
      const rawFrames = exc.stacktrace?.frames || [];
      const frames = [];
      // frames are innermost-last — reverse for display (most recent first)
      for (const f of rawFrames.slice().reverse()) {
        const resolvedPath = sentryResolvePath(f.filename, f.absPath);
        const lineNo = f.lineno ? parseInt(f.lineno, 10) : null;
        const navigable = !!(resolvedPath && repo && !f.filename?.includes('node_modules'));
        frames.push({
          filename: f.filename || '',
          absPath: f.absPath || '',
          resolvedPath,
          repo: navigable ? repo : null,
          function: f.function || null,
          lineno: lineNo || null,
          colno: f.colno || null,
          inApp: !!f.inApp,
          navigable,
          context: (f.context || []).map(([ln, code]) => ({ ln, code })),
          module: f.module || null,
        });
      }
      groups.push({ type: exc.type || '', value: exc.value || '', frames });
    }

    res.json({
      id: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit || '',
      level: issue.level || 'error',
      status: issue.status || '',
      count: parseInt(issue.count, 10) || 0,
      userCount: issue.userCount || 0,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      permalink: issue.permalink,
      project,
      repo,
      groups,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// User preferences — per-user, stored in the private data directory
// (not in dashboard.config.json which is shared across the team)
// ---------------------------------------------------------------------------
const USER_PREFS_LEGACY_PATH = join(homedir(), '.montra', 'dashboard-user-prefs.json');
function getUserPrefsPath() { return join(getPrivateDataDir(), 'user-prefs.json'); }

function readUserPrefs() {
  const path = getUserPrefsPath();
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  // Migrate from legacy location on first access
  if (existsSync(USER_PREFS_LEGACY_PATH)) {
    const data = JSON.parse(readFileSync(USER_PREFS_LEGACY_PATH, 'utf-8'));
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
    return data;
  }
  return {};
}

app.get('/api/user-prefs', (_req, res) => {
  try { res.json(readUserPrefs()); } catch { res.json({}); }
});

app.put('/api/user-prefs', (req, res) => {
  try {
    const path = getUserPrefsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 8: Docs browser endpoints
// ---------------------------------------------------------------------------
function getDocsDir() { return resolveDataDir(CONFIG.docsDir, join(getDataDir(), 'docs')); }
const DOCS_SKIP = new Set(CONFIG.docsSkipDirs || ['.git', 'node_modules', '.obsidian', '.trash']);
let docsTreeCache = null;
let docsTreeCacheTime = 0;
const DOCS_CACHE_TTL = 60000; // 60s

function scanDocsTree(dir, depth = 0) {
  const entries = [];
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }

  // Sort: directories first, _Index.md first among files
  items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    if (a.name === '_Index.md') return -1;
    if (b.name === '_Index.md') return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    if (DOCS_SKIP.has(item.name)) continue;
    if (item.name.startsWith('.')) continue;

    const fullPath = join(dir, item.name);
    const relPath = relative(getDocsDir(), fullPath).replace(/\\/g, '/');

    if (item.isDirectory()) {
      const children = scanDocsTree(fullPath, depth + 1);
      entries.push({ name: item.name, path: relPath, type: 'dir', depth, children });
    } else if (item.name.endsWith('.md')) {
      entries.push({ name: item.name, path: relPath, type: 'file', depth });
    }
  }

  return entries;
}

app.get('/api/docs/tree', (_req, res) => {
  if (!existsSync(getDocsDir())) {
    return res.json([]);
  }

  const now = Date.now();
  if (docsTreeCache && (now - docsTreeCacheTime) < DOCS_CACHE_TTL) {
    return res.json(docsTreeCache);
  }

  docsTreeCache = scanDocsTree(getDocsDir());
  docsTreeCacheTime = now;
  res.json(docsTreeCache);
});

app.get('/api/docs/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  // Path traversal protection
  const resolved = normalize(join(getDocsDir(), filePath));
  if (!resolved.startsWith(getDocsDir() + sep) && resolved !== getDocsDir()) {
    return res.status(403).json({ error: 'access denied' });
  }

  if (!existsSync(resolved)) {
    return res.status(404).json({ error: 'file not found' });
  }

  try {
    const raw = readFileSync(resolved, 'utf-8');

    // Parse frontmatter
    let frontmatter = {};
    let content = raw;
    if (raw.startsWith('---')) {
      const end = raw.indexOf('---', 3);
      if (end !== -1) {
        const fmBlock = raw.substring(3, end).trim();
        content = raw.substring(end + 3).trim();
        // Simple YAML-like parsing for key: value pairs
        for (const line of fmBlock.split('\n')) {
          const colon = line.indexOf(':');
          if (colon > 0) {
            const key = line.substring(0, colon).trim();
            const val = line.substring(colon + 1).trim();
            frontmatter[key] = val;
          }
        }
      }
    }

    res.json({ path: filePath, frontmatter, content, rawContent: raw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve image/asset files from the docs vault
app.get('/api/docs/asset', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const resolved = normalize(join(getDocsDir(), filePath));
  if (!resolved.startsWith(getDocsDir() + sep) && resolved !== getDocsDir()) {
    return res.status(403).json({ error: 'access denied' });
  }

  if (existsSync(resolved)) {
    return res.sendFile(resolved);
  }

  // Fallback: search for the filename in nearby assets directories
  const fileName = filePath.split('/').pop();
  const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
  const searchPaths = [
    join(getDocsDir(), dirPath, 'assets', fileName),   // assets/ subfolder
    join(getDocsDir(), 'assets', fileName),              // vault root assets/
  ];
  for (const candidate of searchPaths) {
    const norm = normalize(candidate);
    if (norm.startsWith(getDocsDir()) && existsSync(norm)) {
      return res.sendFile(norm);
    }
  }

  res.status(404).json({ error: 'file not found' });
});

app.get('/api/docs/search', (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  if (!query || query.length < 2) return res.json([]);
  if (!existsSync(getDocsDir())) return res.json([]);

  const results = [];
  const MAX_RESULTS = 50;

  function searchDir(dir) {
    if (results.length >= MAX_RESULTS) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (results.length >= MAX_RESULTS) return;
      if (DOCS_SKIP.has(item.name) || item.name.startsWith('.')) continue;

      const fullPath = join(dir, item.name);

      if (item.isDirectory()) {
        searchDir(fullPath);
      } else if (item.name.endsWith('.md')) {
        const relPath = relative(getDocsDir(), fullPath).replace(/\\/g, '/');
        const nameMatch = item.name.toLowerCase().includes(query);

        try {
          const content = readFileSync(fullPath, 'utf-8');
          const contentLower = content.toLowerCase();
          const idx = contentLower.indexOf(query);

          if (nameMatch || idx !== -1) {
            let snippet = '';
            if (idx !== -1) {
              const start = Math.max(0, idx - 40);
              const end = Math.min(content.length, idx + query.length + 60);
              snippet = (start > 0 ? '...' : '') + content.substring(start, end).replace(/\n/g, ' ') + (end < content.length ? '...' : '');
            }
            results.push({ path: relPath, name: item.name, snippet, nameMatch });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  searchDir(getDocsDir());
  // Sort: name matches first
  results.sort((a, b) => (b.nameMatch ? 1 : 0) - (a.nameMatch ? 1 : 0));
  res.json(results);
});

// Docs: save file
app.put('/api/docs/file', express.json({ limit: '2mb' }), (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content == null) return res.status(400).json({ error: 'path and content required' });

  const resolved = normalize(join(getDocsDir(), filePath));
  if (!resolved.startsWith(getDocsDir() + sep) && resolved !== getDocsDir()) {
    return res.status(403).json({ error: 'access denied' });
  }

  try {
    writeFileSync(resolved, content, 'utf-8');
    // Bust tree cache
    docsTreeCache = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Docs: refresh (bust cache)
app.post('/api/docs/refresh', (_req, res) => {
  docsTreeCache = null;
  res.json({ ok: true });
});

// Docs: create new file
app.post('/api/docs/new-file', express.json(), (req, res) => {
  const { dir = '', name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const safeName = name.endsWith('.md') ? name : name + '.md';
  const relPath = dir ? `${dir}/${safeName}` : safeName;
  const resolved = normalize(join(getDocsDir(), relPath));
  if (!resolved.startsWith(getDocsDir() + sep) && resolved !== getDocsDir()) {
    return res.status(403).json({ error: 'access denied' });
  }

  if (existsSync(resolved)) {
    return res.status(409).json({ error: 'file already exists' });
  }

  try {
    const parentDir = dirname(resolved);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    writeFileSync(resolved, '---\ntype:\nstatus: active\n---\n', 'utf-8');
    docsTreeCache = null;
    res.json({ ok: true, path: relPath.replace(/\\/g, '/') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Docs: create new folder
app.post('/api/docs/new-folder', express.json(), (req, res) => {
  const { dir = '', name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const relPath = dir ? `${dir}/${name}` : name;
  const resolved = normalize(join(getDocsDir(), relPath));
  if (!resolved.startsWith(getDocsDir() + sep) && resolved !== getDocsDir()) {
    return res.status(403).json({ error: 'access denied' });
  }

  if (existsSync(resolved)) {
    return res.status(409).json({ error: 'folder already exists' });
  }

  try {
    mkdirSync(resolved, { recursive: true });
    docsTreeCache = null;
    res.json({ ok: true, path: relPath.replace(/\\/g, '/') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Docs: git pull
app.post('/api/docs/git/pull', (_req, res) => {
  if (!existsSync(getDocsDir())) return res.status(404).json({ error: 'docs directory not found' });
  try {
    const output = execSync('git pull', { cwd: getDocsDir(), timeout: 30000, encoding: 'utf-8' });
    docsTreeCache = null;
    res.json({ ok: true, output: output.trim() });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

// Docs: git push (add, commit, push)
app.post('/api/docs/git/push', express.json(), (req, res) => {
  if (!existsSync(getDocsDir())) return res.status(404).json({ error: 'docs directory not found' });
  const message = (req.body && req.body.message) || 'Update docs from dashboard';
  try {
    execSync('git add -A', { cwd: getDocsDir(), timeout: 10000 });
    const status = execSync('git status --porcelain', { cwd: getDocsDir(), timeout: 5000, encoding: 'utf-8' }).trim();
    if (!status) return res.json({ ok: true, output: 'Nothing to commit' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: getDocsDir(), timeout: 10000 });
    const output = execSync('git push', { cwd: getDocsDir(), timeout: 30000, encoding: 'utf-8' });
    res.json({ ok: true, output: output.trim() || 'Pushed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

// Docs: git status
app.get('/api/docs/git/status', (_req, res) => {
  if (!existsSync(getDocsDir())) return res.status(404).json({ error: 'docs directory not found' });
  try {
    const status = execSync('git status --porcelain', { cwd: getDocsDir(), timeout: 5000, encoding: 'utf-8' }).trim();
    const branch = execSync('git branch --show-current', { cwd: getDocsDir(), timeout: 5000, encoding: 'utf-8' }).trim();
    // Parse changed file paths (porcelain format: "XY path" or "XY path -> newpath")
    const changedPaths = status ? status.split('\n').map(line => {
      const file = line.slice(3).split(' -> ').pop().trim();
      return file;
    }) : [];
    res.json({ branch, dirty: status.length > 0, files: changedPaths.length, changedPaths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API Client — proxy endpoint
// ---------------------------------------------------------------------------
app.post('/api/proxy', async (req, res) => {
  const { method = 'GET', url, headers = {}, body, timeout = 30000, stream = false } = req.body;
  if (!url) return res.json({ error: true, body: 'URL is required', status: 0, statusText: '', headers: {}, time: 0, size: 0 });

  console.log(`[proxy] ${method} ${url} (timeout=${timeout}, stream=${stream})`);
  const start = Date.now();
  const maxTimeout = 600000; // 10 minutes
  try {
    const fetchOpts = {
      method: method.toUpperCase(),
      headers,
      signal: AbortSignal.timeout(Math.min(timeout, maxTimeout)),
      redirect: 'follow',
    };
    if (body && !['GET', 'HEAD'].includes(fetchOpts.method)) {
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(url, fetchOpts);
    const contentType = response.headers.get('content-type') || '';
    const isNdjson = contentType.includes('application/x-ndjson');

    // Stream mode: pipe NDJSON back as SSE so the client gets incremental updates
    if (stream && isNdjson && response.body) {
      const responseHeaders = {};
      response.headers.forEach((val, key) => { responseHeaders[key] = val; });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial metadata
      res.write(`event: meta\ndata: ${JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        startTime: start,
      })}\n\n`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalSize = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          totalSize += value.byteLength;

          // Split on newlines and send complete NDJSON lines
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line in buffer
          for (const line of lines) {
            if (line.trim()) {
              res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
            }
          }
        }
        // Flush remaining buffer
        if (buffer.trim()) {
          res.write(`event: line\ndata: ${JSON.stringify(buffer)}\n\n`);
        }
      } catch (streamErr) {
        res.write(`event: error\ndata: ${JSON.stringify(streamErr.message)}\n\n`);
      }

      res.write(`event: done\ndata: ${JSON.stringify({ time: Date.now() - start, size: totalSize })}\n\n`);
      res.end();
      return;
    }

    const time = Date.now() - start;
    const responseBody = await response.text();
    const responseHeaders = {};
    response.headers.forEach((val, key) => { responseHeaders[key] = val; });

    res.json({
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      time,
      size: Buffer.byteLength(responseBody, 'utf-8'),
    });
  } catch (err) {
    // Include the underlying cause (e.g. ECONNREFUSED) for better debugging
    const detail = err.cause ? `${err.message}: ${err.cause.message || err.cause.code || err.cause}` : err.message;
    console.error(`[proxy] FAILED ${method} ${url} — ${detail}`);
    res.json({
      error: true,
      status: 0,
      statusText: '',
      headers: {},
      body: detail,
      time: Date.now() - start,
      size: 0,
    });
  }
});

// ---------------------------------------------------------------------------
// API Client — file upload proxy (multipart/form-data forwarding)
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/proxy/upload', upload.any(), async (req, res) => {
  const { _target_url, _target_method = 'POST', _target_headers = '{}', _target_timeout = '600000' } = req.body || {};
  if (!_target_url) return res.json({ error: true, body: 'URL is required', status: 0, statusText: '', headers: {}, time: 0, size: 0 });

  console.log(`[proxy/upload] ${_target_method} ${_target_url} (files=${(req.files || []).length})`);
  const start = Date.now();
  const maxTimeout = 600000;

  try {
    // Rebuild FormData for the outbound request
    const fd = new FormData();
    for (const file of (req.files || [])) {
      const blob = new Blob([file.buffer], { type: file.mimetype });
      fd.append(file.fieldname, blob, file.originalname);
    }
    // Append non-meta text fields
    for (const [key, val] of Object.entries(req.body || {})) {
      if (key.startsWith('_target_')) continue;
      fd.append(key, val);
    }

    // Parse forwarded headers, strip Content-Type so fetch sets multipart boundary
    const fwdHeaders = JSON.parse(_target_headers);
    delete fwdHeaders['Content-Type'];
    delete fwdHeaders['content-type'];

    const fetchOpts = {
      method: _target_method.toUpperCase(),
      headers: fwdHeaders,
      body: fd,
      signal: AbortSignal.timeout(Math.min(parseInt(_target_timeout) || maxTimeout, maxTimeout)),
      redirect: 'follow',
    };

    const response = await fetch(_target_url, fetchOpts);
    const time = Date.now() - start;
    const responseBody = await response.text();
    const responseHeaders = {};
    response.headers.forEach((val, key) => { responseHeaders[key] = val; });

    res.json({
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      time,
      size: Buffer.byteLength(responseBody, 'utf-8'),
    });
  } catch (err) {
    const detail = err.cause ? `${err.message}: ${err.cause.message || err.cause.code || err.cause}` : err.message;
    console.error(`[proxy/upload] FAILED ${_target_method} ${_target_url} — ${detail}`);
    res.json({
      error: true,
      status: 0,
      statusText: '',
      headers: {},
      body: detail,
      time: Date.now() - start,
      size: 0,
    });
  }
});

// ---------------------------------------------------------------------------
// API Client — script runner (pre-request / test scripts)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Lightweight lodash stub (covers _.has, _.get, _.set, _.keys, _.values, etc.)
// ---------------------------------------------------------------------------
function buildLodashStub() {
  const _ = function(val) { return val; };
  _.has = (obj, path) => {
    if (obj == null) return false;
    const keys = Array.isArray(path) ? path : String(path).split('.');
    let cur = obj;
    for (const k of keys) {
      if (cur == null || !Object.prototype.hasOwnProperty.call(cur, k)) return false;
      cur = cur[k];
    }
    return true;
  };
  _.get = (obj, path, defaultVal) => {
    if (obj == null) return defaultVal;
    const keys = Array.isArray(path) ? path : String(path).split('.');
    let cur = obj;
    for (const k of keys) {
      if (cur == null) return defaultVal;
      cur = cur[k];
    }
    return cur === undefined ? defaultVal : cur;
  };
  _.set = (obj, path, val) => {
    const keys = Array.isArray(path) ? path : String(path).split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] == null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = val;
    return obj;
  };
  _.keys = (obj) => Object.keys(obj || {});
  _.values = (obj) => Object.values(obj || {});
  _.isString = (v) => typeof v === 'string';
  _.isNumber = (v) => typeof v === 'number';
  _.isArray = (v) => Array.isArray(v);
  _.isObject = (v) => v != null && typeof v === 'object';
  _.isNil = (v) => v == null;
  _.isEmpty = (v) => {
    if (v == null) return true;
    if (Array.isArray(v) || typeof v === 'string') return v.length === 0;
    return Object.keys(v).length === 0;
  };
  _.pick = (obj, keys) => {
    const result = {};
    for (const k of keys) { if (k in obj) result[k] = obj[k]; }
    return result;
  };
  _.omit = (obj, keys) => {
    const result = { ...obj };
    for (const k of keys) delete result[k];
    return result;
  };
  _.merge = (...args) => Object.assign({}, ...args);
  _.cloneDeep = (v) => JSON.parse(JSON.stringify(v));
  _.uniq = (arr) => [...new Set(arr)];
  _.flatten = (arr) => arr.flat();
  _.compact = (arr) => arr.filter(Boolean);
  _.map = (col, fn) => (Array.isArray(col) ? col : Object.values(col)).map(fn);
  _.filter = (col, fn) => (Array.isArray(col) ? col : Object.values(col)).filter(fn);
  _.find = (col, fn) => (Array.isArray(col) ? col : Object.values(col)).find(fn);
  _.forEach = (col, fn) => { (Array.isArray(col) ? col : Object.entries(col)).forEach(fn); };
  _.includes = (col, val) => {
    if (typeof col === 'string') return col.includes(val);
    if (Array.isArray(col)) return col.includes(val);
    return Object.values(col || {}).includes(val);
  };
  _.trim = (s) => String(s).trim();
  _.toLower = (s) => String(s).toLowerCase();
  _.toUpper = (s) => String(s).toUpperCase();
  return _;
}

// ---------------------------------------------------------------------------
// Lightweight moment() shim for Postman scripts
// ---------------------------------------------------------------------------
function buildMomentShim() {
  function moment(input) {
    const d = input !== undefined ? new Date(input) : new Date();
    const obj = {
      _d: d,
      valueOf() { return d.getTime(); },
      toDate() { return d; },
      toISOString() { return d.toISOString(); },
      unix() { return Math.floor(d.getTime() / 1000); },
      format(fmt) {
        if (!fmt) return d.toISOString();
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        return fmt
          .replace('YYYY', d.getFullYear())
          .replace('MM', pad(d.getMonth() + 1))
          .replace('DD', pad(d.getDate()))
          .replace('HH', pad(d.getHours()))
          .replace('hh', pad(d.getHours() % 12 || 12))
          .replace('mm', pad(d.getMinutes()))
          .replace('ss', pad(d.getSeconds()))
          .replace('SSS', pad(d.getMilliseconds(), 3))
          .replace('A', d.getHours() >= 12 ? 'PM' : 'AM')
          .replace('a', d.getHours() >= 12 ? 'pm' : 'am');
      },
      add(amount, unit) {
        const ms = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
        const u = String(unit).toLowerCase();
        const mult = ms[u] || ms[u[0]] || 1;
        return moment(d.getTime() + amount * mult);
      },
      subtract(amount, unit) { return obj.add(-amount, unit); },
      isBefore(other) { return d.getTime() < moment(other).valueOf(); },
      isAfter(other) { return d.getTime() > moment(other).valueOf(); },
      diff(other, unit) {
        const diffMs = d.getTime() - moment(other).valueOf();
        const divs = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
        const u = String(unit || 'ms').toLowerCase();
        return Math.floor(diffMs / (divs[u] || divs[u[0]] || 1));
      },
      toString() { return d.toISOString(); },
    };
    return obj;
  }
  moment.now = () => Date.now();
  moment.utc = (input) => {
    const m = moment(input);
    // Mark as UTC but keep same API
    return m;
  };
  return moment;
}

app.post('/api/script/run', async (req, res) => {
  const { script = '', type = 'pre', requestData = {}, responseData = {}, environment = [], variables = {}, collectionVariables = [], environmentName = '' } = req.body;
  if (!script.trim()) return res.json({ logs: [], testResults: [], envUpdates: {}, varUpdates: {}, collectionVarUpdates: {}, requestMutations: {} });

  const logs = [];
  const testResults = [];
  const envUpdates = {};
  const varUpdates = { ...variables };
  const collectionVarUpdates = {};

  // Build collection variables lookup
  const collVarLookup = {};
  for (const v of collectionVariables) {
    if (v.enabled !== false) collVarLookup[v.key] = v.value;
  }

  // Build env lookup
  const envLookup = {};
  for (const v of environment) {
    if (v.enabled !== false) envLookup[v.key] = v.value;
  }

  // Queue for pm.sendRequest calls (executed after initial script run)
  const pendingSendRequests = [];

  // Build pm object
  const pm = {
    variables: {
      get(key) { return varUpdates[key]; },
      set(key, val) { varUpdates[key] = val; },
      toObject() { return { ...varUpdates }; },
    },
    environment: {
      name: environmentName,
      get(key) { return envLookup[key]; },
      set(key, val) { envLookup[key] = val; envUpdates[key] = val; },
      toObject() { return { ...envLookup }; },
    },
    collectionVariables: {
      get(key) { return collVarLookup[key]; },
      set(key, val) { collVarLookup[key] = val; collectionVarUpdates[key] = val; },
      toObject() { return { ...collVarLookup }; },
    },
    request: {
      url: requestData.url || '',
      headers: { ...(requestData.headers || {}) },
      body: requestData.body || '',
    },
    response: {
      code: responseData.status || 0,
      status: responseData.statusText || '',
      responseTime: responseData.time || 0,
      headers: responseData.headers || {},
      text() { return responseData.body || ''; },
      json() { try { return JSON.parse(responseData.body || '{}'); } catch { return null; } },
    },
    test(name, fn) {
      try { fn(); testResults.push({ name, passed: true }); }
      catch (e) { testResults.push({ name, passed: false, error: e.message }); }
    },
    expect(val) { return buildExpect(val); },
    sendRequest(reqConfig, callback) {
      pendingSendRequests.push({ config: reqConfig, callback });
    },
  };

  function buildExpect(val) {
    const chain = {
      to: null,
      get not() {
        const neg = buildExpect(val);
        neg._negate = true;
        return neg;
      },
      _negate: false,
    };
    chain.to = chain;
    chain.be = chain;
    chain.have = chain;
    chain.equal = (expected) => {
      const pass = chain._negate ? val !== expected : val === expected;
      if (!pass) throw new Error(`Expected ${JSON.stringify(val)} ${chain._negate ? 'not ' : ''}to equal ${JSON.stringify(expected)}`);
      return chain;
    };
    chain.eql = (expected) => {
      const pass = JSON.stringify(val) === JSON.stringify(expected);
      const result = chain._negate ? !pass : pass;
      if (!result) throw new Error(`Expected deep ${chain._negate ? 'in' : ''}equality`);
      return chain;
    };
    chain.above = (n) => {
      const pass = chain._negate ? val <= n : val > n;
      if (!pass) throw new Error(`Expected ${val} ${chain._negate ? 'not ' : ''}to be above ${n}`);
      return chain;
    };
    chain.below = (n) => {
      const pass = chain._negate ? val >= n : val < n;
      if (!pass) throw new Error(`Expected ${val} ${chain._negate ? 'not ' : ''}to be below ${n}`);
      return chain;
    };
    chain.include = (item) => {
      const has = typeof val === 'string' ? val.includes(item) : Array.isArray(val) ? val.includes(item) : false;
      const pass = chain._negate ? !has : has;
      if (!pass) throw new Error(`Expected ${JSON.stringify(val)} ${chain._negate ? 'not ' : ''}to include ${JSON.stringify(item)}`);
      return chain;
    };
    chain.property = (prop) => {
      const has = val != null && Object.prototype.hasOwnProperty.call(val, prop);
      const pass = chain._negate ? !has : has;
      if (!pass) throw new Error(`Expected object ${chain._negate ? 'not ' : ''}to have property "${prop}"`);
      return chain;
    };
    chain.ok = (() => {
      const pass = chain._negate ? !val : !!val;
      if (!pass) throw new Error(`Expected ${JSON.stringify(val)} ${chain._negate ? 'not ' : ''}to be truthy`);
      return chain;
    });
    chain.true = (() => chain.equal(true));
    chain.false = (() => chain.equal(false));
    chain.null = (() => chain.equal(null));
    chain.a = (expectedType) => {
      const actualType = Array.isArray(val) ? 'array' : typeof val;
      const pass = chain._negate ? actualType !== expectedType : actualType === expectedType;
      if (!pass) throw new Error(`Expected ${JSON.stringify(val)} ${chain._negate ? 'not ' : ''}to be a ${expectedType}`);
      return chain;
    };
    chain.an = chain.a;
    return chain;
  }

  // Allow mutation of request in pre-scripts
  if (type === 'pre') {
    pm.request.url = requestData.url || '';
  }

  // Build require() stub with known modules
  const momentShim = buildMomentShim();
  const moduleStubs = {
    moment: momentShim,
  };
  function sandboxRequire(modName) {
    if (moduleStubs[modName]) return moduleStubs[modName];
    throw new Error(`Module "${modName}" is not available in the script sandbox`);
  }

  const sandbox = {
    pm,
    console: {
      log: (...args) => logs.push({ level: 'log', text: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') }),
      warn: (...args) => logs.push({ level: 'warn', text: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') }),
      error: (...args) => logs.push({ level: 'error', text: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') }),
    },
    require: sandboxRequire,
    _: buildLodashStub(),
    setTimeout: (fn) => fn(), // execute immediately (no real async in sandbox)
    JSON,
    Date,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    btoa: (s) => Buffer.from(s).toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString(),
  };

  try {
    const ctx = vm.createContext(sandbox);
    // Wrap script in a function body so top-level `return` statements work
    const wrappedScript = `(function() {\n${script}\n})()`;
    vm.runInContext(wrappedScript, ctx, { timeout: 5000 });
  } catch (err) {
    logs.push({ level: 'error', text: `Script error: ${err.message}` });
  }

  // Process queued pm.sendRequest calls
  for (const { config, callback } of pendingSendRequests) {
    try {
      const reqUrl = typeof config === 'string' ? config : config.url;
      const reqMethod = (typeof config === 'object' && config.method) ? config.method.toUpperCase() : 'GET';
      const reqHeaders = {};
      if (typeof config === 'object' && config.header) {
        // Postman header format: { 'Content-Type': 'application/json' } or array
        if (Array.isArray(config.header)) {
          for (const h of config.header) {
            if (h.key) reqHeaders[h.key] = h.value;
          }
        } else if (typeof config.header === 'object') {
          Object.assign(reqHeaders, config.header);
        }
      }
      let reqBody = undefined;
      if (typeof config === 'object' && config.body) {
        if (config.body.mode === 'raw') reqBody = config.body.raw;
        else if (typeof config.body === 'string') reqBody = config.body;
      }

      const fetchOpts = { method: reqMethod, headers: reqHeaders, signal: AbortSignal.timeout(15000) };
      if (reqBody && !['GET', 'HEAD'].includes(reqMethod)) fetchOpts.body = reqBody;

      const response = await fetch(reqUrl, fetchOpts);
      const responseBody = await response.text();
      const responseHeaders = {};
      response.headers.forEach((val, key) => { responseHeaders[key] = val; });

      // Build Postman-like response object for the callback
      const pmResponse = {
        code: response.status,
        status: response.statusText,
        headers: responseHeaders,
        text() { return responseBody; },
        json() { try { return JSON.parse(responseBody); } catch { return null; } },
      };

      if (callback) {
        try { callback(null, pmResponse); } catch (cbErr) {
          logs.push({ level: 'error', text: `sendRequest callback error: ${cbErr.message}` });
        }
      }
    } catch (fetchErr) {
      // Provide a fallback response object so scripts accessing res.code don't crash
      const errResponse = {
        code: 0,
        status: fetchErr.message,
        headers: {},
        text() { return fetchErr.message; },
        json() { return null; },
      };
      if (callback) {
        try { callback(fetchErr, errResponse); } catch (cbErr) {
          logs.push({ level: 'error', text: `sendRequest callback error: ${cbErr.message}` });
        }
      }
    }
  }

  res.json({
    logs,
    testResults,
    envUpdates,
    varUpdates,
    collectionVarUpdates,
    requestMutations: type === 'pre' ? { url: pm.request.url, headers: pm.request.headers, body: pm.request.body } : {},
  });
});

// ---------------------------------------------------------------------------
// API Client — collections CRUD
// ---------------------------------------------------------------------------
app.get('/api/collections', (_req, res) => {
  let shared = readJsonFile('collections.json', [], getApiDir());
  let private_ = readJsonFile('collections.json', [], getPrivateApiDir());

  // Seed with demo collection on first run (write to shared)
  if (shared.length === 0 && private_.length === 0) {
    const seedPath = join(SEED_DIR, 'seed-collection.json');
    if (existsSync(seedPath)) {
      try {
        shared = JSON.parse(readFileSync(seedPath, 'utf8'));
        writeJsonFile('collections.json', shared, getApiDir());
      } catch { /* ignore seed errors */ }
    }
  }

  // Merge: private overrides shared when ids collide
  const privateIds = new Set(private_.map(c => c.id));
  const merged = [
    ...shared.filter(c => !privateIds.has(c.id)).map(c => ({ ...c, _source: 'shared' })),
    ...private_.map(c => ({ ...c, _source: 'private' })),
  ];
  res.json(merged);
});

app.put('/api/collections', (req, res) => {
  const target = req.query.target === 'shared' ? getApiDir() : getPrivateApiDir();
  // Strip _source markers before saving
  const cleaned = (Array.isArray(req.body) ? req.body : []).map(({ _source, ...rest }) => rest);
  writeJsonFile('collections.json', cleaned, target);
  res.json({ ok: true });
});

app.post('/api/collections/import', (req, res) => {
  const spec = req.body;
  if (!spec || !spec.paths) return res.status(400).json({ error: 'Invalid OpenAPI spec' });

  const collection = {
    id: 'imp_' + Date.now(),
    name: spec.info?.title || 'Imported API',
    auth: { type: 'bearer', bearer: '' },
    variables: [],
    preScript: '',
    testScript: '',
    folders: [],
    requests: [],
  };

  const tagFolders = {};
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, endpoint] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const tags = endpoint.tags || ['Untagged'];
      const tag = tags[0];

      if (!tagFolders[tag]) {
        tagFolders[tag] = { id: 'fld_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: tag, auth: { type: 'inherit' }, variables: [], preScript: '', testScript: '', folders: [], requests: [] };
        collection.folders.push(tagFolders[tag]);
      }

      // Build example body from schema
      let exampleBody = '';
      const reqBody = endpoint.requestBody?.content?.['application/json']?.schema;
      if (reqBody) {
        try { exampleBody = JSON.stringify(buildSchemaExample(reqBody, spec), null, 2); } catch { /* ignore */ }
      }

      // Build params
      const params = (endpoint.parameters || []).filter(p => p.in === 'query').map(p => ({
        key: p.name, value: '', enabled: true, description: p.description || '',
      }));

      const headers = [];
      const pathParams = (endpoint.parameters || []).filter(p => p.in === 'path');
      let resolvedPath = path;
      for (const pp of pathParams) {
        resolvedPath = resolvedPath.replace(`{${pp.name}}`, `{{${pp.name}}}`);
      }

      tagFolders[tag].requests.push({
        id: 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: endpoint.summary || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: '{{baseUrl}}' + resolvedPath,
        params,
        headers,
        auth: { type: 'inherit' },
        bodyMode: exampleBody ? 'json' : 'none',
        bodyContent: exampleBody,
        preScript: '',
        testScript: '',
      });
    }
  }

  // Append to existing collections (imports go to private by default)
  const target = req.query.target === 'shared' ? getApiDir() : getPrivateApiDir();
  const collections = readJsonFile('collections.json', [], target);
  collections.push(collection);
  writeJsonFile('collections.json', collections, target);
  res.json(collection);
});

// ---------------------------------------------------------------------------
// API Client — import Postman Collection v2.1
// ---------------------------------------------------------------------------
app.post('/api/collections/import-postman', (req, res) => {
  const data = req.body;
  if (!data || !data.info) return res.status(400).json({ error: 'Invalid Postman collection — missing "info" field' });

  const schemaUrl = data.info.schema || '';
  if (!schemaUrl.includes('v2.1') && !schemaUrl.includes('v2.0')) {
    // Still try to parse — be lenient
  }

  function uid() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

  function convertAuth(pmAuth, isRoot) {
    // In Postman: missing/null auth = "inherit from parent"
    // { type: "noauth" } = explicitly "No Auth"
    if (!pmAuth) return isRoot ? { type: 'none' } : { type: 'inherit' };
    const authType = pmAuth.type || 'noauth';
    if (authType === 'bearer') {
      const tokenEntry = (pmAuth.bearer || []).find(e => e.key === 'token');
      return { type: 'bearer', bearer: tokenEntry?.value || '' };
    }
    if (authType === 'basic') {
      const user = (pmAuth.basic || []).find(e => e.key === 'username');
      const pass = (pmAuth.basic || []).find(e => e.key === 'password');
      return { type: 'basic', basicUser: user?.value || '', basicPass: pass?.value || '' };
    }
    if (authType === 'noauth') {
      // Postman "noauth" on folders/requests means "inherit from parent"
      return isRoot ? { type: 'none' } : { type: 'inherit' };
    }
    return isRoot ? { type: 'none' } : { type: 'inherit' };
  }

  function convertUrl(pmUrl) {
    if (typeof pmUrl === 'string') return pmUrl;
    if (!pmUrl) return '';
    const raw = pmUrl.raw || '';
    if (raw) return raw;
    // Build from parts
    const protocol = pmUrl.protocol || 'https';
    const host = Array.isArray(pmUrl.host) ? pmUrl.host.join('.') : (pmUrl.host || '');
    const path = Array.isArray(pmUrl.path) ? '/' + pmUrl.path.join('/') : (pmUrl.path || '');
    let url = protocol + '://' + host + path;
    if (pmUrl.query && pmUrl.query.length > 0) {
      const qs = pmUrl.query.filter(q => !q.disabled).map(q => q.key + '=' + (q.value || '')).join('&');
      if (qs) url += '?' + qs;
    }
    return url;
  }

  function convertParams(pmUrl) {
    if (!pmUrl || typeof pmUrl === 'string') return [];
    return (pmUrl.query || []).map(q => ({
      key: q.key || '', value: q.value || '', enabled: !q.disabled, description: q.description || '',
    }));
  }

  function convertPathVars(pmUrl) {
    if (!pmUrl || typeof pmUrl === 'string') return [];
    return (pmUrl.variable || []).map(v => ({
      key: v.key || '', value: v.value || '', enabled: true, description: v.description || '',
    }));
  }

  function convertHeaders(pmHeaders) {
    if (!Array.isArray(pmHeaders)) return [];
    return pmHeaders.map(h => ({
      key: h.key || '', value: h.value || '', enabled: !h.disabled,
    }));
  }

  function convertBody(pmBody) {
    if (!pmBody) return { bodyMode: 'none', bodyContent: '', bodyFormData: [] };
    const mode = pmBody.mode || 'none';
    if (mode === 'raw') {
      const lang = pmBody.options?.raw?.language || '';
      return {
        bodyMode: lang === 'json' ? 'json' : 'raw',
        bodyContent: pmBody.raw || '',
        bodyFormData: [],
      };
    }
    if (mode === 'urlencoded') {
      return {
        bodyMode: 'x-www-form-urlencoded',
        bodyContent: '',
        bodyFormData: (pmBody.urlencoded || []).map(p => ({
          key: p.key || '', value: p.value || '', enabled: !p.disabled,
        })),
      };
    }
    if (mode === 'formdata') {
      return {
        bodyMode: 'form-data',
        bodyContent: '',
        bodyFormData: (pmBody.formdata || []).filter(p => p.type !== 'file').map(p => ({
          key: p.key || '', value: p.value || '', enabled: !p.disabled,
        })),
      };
    }
    return { bodyMode: 'none', bodyContent: '', bodyFormData: [] };
  }

  function getScript(events, type) {
    if (!Array.isArray(events)) return '';
    const event = events.find(e => e.listen === type);
    if (!event || !event.script) return '';
    const lines = event.script.exec || [];
    return Array.isArray(lines) ? lines.join('\n') : String(lines);
  }

  function convertRequest(pmItem) {
    const req = pmItem.request || {};
    const body = convertBody(req.body);
    return {
      id: 'req_' + uid(),
      name: pmItem.name || 'Untitled',
      method: (typeof req.method === 'string' ? req.method : req.method || 'GET').toUpperCase(),
      url: convertUrl(req.url),
      params: convertParams(req.url),
      pathVars: convertPathVars(req.url),
      headers: convertHeaders(req.header),
      auth: convertAuth(req.auth, false),
      bodyMode: body.bodyMode,
      bodyContent: body.bodyContent,
      bodyFormData: body.bodyFormData,
      preScript: getScript(pmItem.event, 'prerequest'),
      testScript: getScript(pmItem.event, 'test'),
    };
  }

  function convertVariables(pmVars) {
    if (!Array.isArray(pmVars)) return [];
    return pmVars.map(v => ({
      key: v.key || '',
      value: v.value || '',
      enabled: v.disabled !== true,
    })).filter(v => v.key);
  }

  function convertItems(items) {
    const folders = [];
    const requests = [];
    for (const item of (items || [])) {
      if (item.item && Array.isArray(item.item)) {
        // It's a folder — recurse to preserve nesting
        const sub = convertItems(item.item);
        folders.push({
          id: 'fld_' + uid(),
          name: item.name || 'Folder',
          auth: convertAuth(item.auth, false),
          variables: convertVariables(item.variable),
          preScript: getScript(item.event, 'prerequest'),
          testScript: getScript(item.event, 'test'),
          folders: sub.folders,
          requests: sub.requests,
        });
      } else if (item.request) {
        requests.push(convertRequest(item));
      }
    }
    return { folders, requests };
  }

  const converted = convertItems(data.item);
  const collection = {
    id: 'pmi_' + uid(),
    name: data.info.name || 'Postman Import',
    auth: convertAuth(data.auth, true),
    variables: convertVariables(data.variable),
    preScript: getScript(data.event, 'prerequest'),
    testScript: getScript(data.event, 'test'),
    folders: converted.folders,
    requests: converted.requests,
  };

  const target = req.query.target === 'shared' ? getApiDir() : getPrivateApiDir();
  const collections = readJsonFile('collections.json', [], target);
  collections.push(collection);
  writeJsonFile('collections.json', collections, target);

  const totalRequests = collection.requests.length + collection.folders.reduce((sum, f) => sum + (f.requests?.length || 0), 0);
  res.json({ ...collection, _totalRequests: totalRequests });
});

function buildSchemaExample(schema, spec, depth = 0) {
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
// API Client — import Postman Environment
// ---------------------------------------------------------------------------
app.post('/api/environments/import-postman', (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Invalid Postman environment — missing "name" field' });

  const env = {
    name: data.name,
    variables: (data.values || []).map(v => ({
      key: v.key || '',
      value: v.value || '',
      enabled: v.enabled !== false,
    })).filter(v => v.key),
  };

  const environments = readJsonFile('environments.json', DEFAULT_ENVIRONMENTS, getApiDir());
  environments.push(env);
  writeJsonFile('environments.json', environments, getApiDir());

  res.json({ name: env.name, variableCount: env.variables.length });
});

// ---------------------------------------------------------------------------
// API Client — environments CRUD
// ---------------------------------------------------------------------------
app.get('/api/environments', (_req, res) => {
  let envs = readJsonFile('environments.json', DEFAULT_ENVIRONMENTS, getApiDir());
  // Seed on first run (file exists but is empty)
  if (envs.length === 0 && DEFAULT_ENVIRONMENTS.length > 0) {
    envs = DEFAULT_ENVIRONMENTS;
    writeJsonFile('environments.json', envs, getApiDir());
  }
  res.json(envs);
});

app.put('/api/environments', (req, res) => {
  writeJsonFile('environments.json', req.body, getApiDir());
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API Client — history CRUD
// ---------------------------------------------------------------------------
app.get('/api/history', (_req, res) => {
  res.json(readJsonFile('history.json', [], getPrivateDataDir()));
});

app.post('/api/history', (req, res) => {
  const history = readJsonFile('history.json', [], getPrivateDataDir());
  history.unshift({ ...req.body, timestamp: Date.now() });
  if (history.length > 200) history.length = 200;
  writeJsonFile('history.json', history, getPrivateDataDir());
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Phase 9: GET /api/swagger — proxy swagger-json from API
// ---------------------------------------------------------------------------
app.get('/api/swagger', async (_req, res) => {
  try {
    const apiPort = CONFIG.services?.api?.port || 3000;
    const swaggerUrl = CONFIG.swaggerUrl || `http://localhost:${apiPort}/swagger-json`;
    const response = await fetch(swaggerUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Database Explorer — multi-connection pool map + routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SQLite demo adapter — wraps sql.js to match pg.Pool query interface
// ---------------------------------------------------------------------------
let _sqliteDb = null;
async function getSqliteDemo() {
  if (_sqliteDb) return _sqliteDb;
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // Seed demo tables
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      plan TEXT DEFAULT 'free',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      product TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      ordered_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      price REAL NOT NULL,
      in_stock INTEGER DEFAULT 1
    );
    CREATE VIEW IF NOT EXISTS order_summary AS
      SELECT c.name AS customer, o.product, o.amount, o.status
      FROM orders o JOIN customers c ON c.id = o.customer_id;

    INSERT OR IGNORE INTO customers (id, name, email, plan) VALUES
      (1, 'Alice Chen', 'alice@example.com', 'pro'),
      (2, 'Bob Rivera', 'bob@example.com', 'free'),
      (3, 'Carol Patel', 'carol@example.com', 'enterprise'),
      (4, 'Dave Okafor', 'dave@example.com', 'pro'),
      (5, 'Eva Santos', 'eva@example.com', 'free');

    INSERT OR IGNORE INTO products (id, name, category, price) VALUES
      (1, 'Dashboard Pro', 'software', 49.99),
      (2, 'API Access', 'service', 29.99),
      (3, 'Support Plan', 'service', 19.99),
      (4, 'Data Export', 'addon', 9.99),
      (5, 'Custom Theme', 'addon', 4.99);

    INSERT OR IGNORE INTO orders (id, customer_id, product, amount, status) VALUES
      (1, 1, 'Dashboard Pro', 49.99, 'completed'),
      (2, 1, 'API Access', 29.99, 'completed'),
      (3, 2, 'Support Plan', 19.99, 'pending'),
      (4, 3, 'Dashboard Pro', 49.99, 'completed'),
      (5, 3, 'API Access', 29.99, 'completed'),
      (6, 3, 'Data Export', 9.99, 'completed'),
      (7, 4, 'Custom Theme', 4.99, 'completed'),
      (8, 5, 'Dashboard Pro', 49.99, 'pending'),
      (9, 2, 'API Access', 29.99, 'refunded'),
      (10, 4, 'Support Plan', 19.99, 'completed');
  `);
  _sqliteDb = db;
  return db;
}

/** Wrap sql.js result to match pg.Pool.query() shape */
function sqliteQuery(db, sql) {
  const upper = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  const isSelect = upper.startsWith('SELECT') || upper.startsWith('PRAGMA') || upper.startsWith('WITH');
  if (isSelect) {
    const stmt = db.prepare(sql);
    const columns = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const values = stmt.get();
      const row = {};
      columns.forEach((col, i) => { row[col] = values[i]; });
      rows.push(row);
    }
    stmt.free();
    return { fields: columns.map(name => ({ name })), rows, rowCount: rows.length, command: 'SELECT' };
  } else {
    db.run(sql);
    const changes = db.getRowsModified();
    const cmd = upper.split(/\s/)[0];
    return { fields: [], rows: [], rowCount: changes, command: cmd };
  }
}

function isSqliteConnection(conn) { return conn && conn.driver === 'sqlite'; }

function discoverDbConnections() {
  const connections = [];
  const palette = ['#a6e3a1','#89b4fa','#fab387','#cba6f7','#f9e2af','#94e2d5','#f38ba8'];

  // 1. Default from DB_HOST / DB_USERNAME / etc
  if (process.env.DB_HOST || process.env.DB_USERNAME) {
    connections.push({
      id: 'env-default',
      name: 'Default',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || 'postgres',
      ssl: process.env.DB_SSL === 'true',
      color: palette[0],
      envPrefix: 'DB',
    });
  }

  // 2. Scan DB_<PREFIX>_HOST patterns
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^DB_([A-Z][A-Z0-9_]*)_HOST$/);
    if (!m) continue;
    const prefix = m[1];
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    const p = `DB_${prefix}_`;
    connections.push({
      id: `env-${prefix.toLowerCase()}`,
      name: prefix.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' '),
      host: process.env[p + 'HOST'] || 'localhost',
      port: parseInt(process.env[p + 'PORT'] || '5432', 10),
      user: process.env[p + 'USER'] || 'postgres',
      password: process.env[p + 'PASSWORD'] || '',
      database: process.env[p + 'DATABASE'] || 'core',
      ssl: process.env[p + 'SSL'] === 'true',
      color: palette[connections.length % palette.length],
      envPrefix: `DB_${prefix}`,
    });
  }

  // 3. Fallback: embedded SQLite demo (zero-config)
  if (connections.length === 0) {
    connections.push({
      id: 'demo-sqlite', name: 'Demo (SQLite)',
      host: 'embedded', port: 0, user: '', password: '', database: ':memory:',
      ssl: false, color: palette[0], driver: 'sqlite',
    });
  }

  return connections;
}

const dbPools = new Map();

function getDbPool(connectionId) {
  const connections = discoverDbConnections();
  const conn = connectionId
    ? connections.find(c => c.id === connectionId)
    : connections[0];
  if (!conn) throw new Error('Connection not found');

  // SQLite connections don't use pg.Pool
  if (isSqliteConnection(conn)) return null;

  if (dbPools.has(conn.id)) return dbPools.get(conn.id);

  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: conn.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  dbPools.set(conn.id, pool);
  return pool;
}

function getConnectionById(connectionId) {
  const connections = discoverDbConnections();
  return connectionId ? connections.find(c => c.id === connectionId) : connections[0];
}

function isQuerySafe(sql, allowWrite) {
  if (allowWrite) return true;
  const upper = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').toUpperCase().trim();
  const dangerous = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE)\b/;
  return !dangerous.test(upper);
}

// GET /api/db/connections — return env-sourced connection list
app.get('/api/db/connections', (_req, res) => {
  const connections = discoverDbConnections();
  // Strip passwords from response
  res.json(connections.map(c => ({ ...c, password: c.password ? '••••••' : '' })));
});

// POST /api/db/connections/test — test a connection
app.post('/api/db/connections/test', async (req, res) => {
  let { host, port, user, password, database, ssl, connectionId } = req.body;
  const conn = connectionId ? discoverDbConnections().find(c => c.id === connectionId) : null;
  if (conn && isSqliteConnection(conn)) {
    try {
      const db = await getSqliteDemo();
      const r = sqliteQuery(db, 'SELECT sqlite_version() AS version');
      res.json({ ok: true, version: `SQLite ${r.rows[0].version}` });
    } catch (err) { res.json({ ok: false, error: err.message }); }
    return;
  }
  // Resolve masked password from env
  if (password === '••••••' && conn) password = conn.password;
  const testPool = new pg.Pool({
    host, port, user, password, database,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const result = await testPool.query('SELECT version()');
    res.json({ ok: true, version: result.rows[0].version });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  } finally {
    testPool.end().catch(() => {});
  }
});

// GET /api/db/status — ping DB, return connection info
app.get('/api/db/status', async (req, res) => {
  try {
    const conn = getConnectionById(req.query.connectionId);
    if (isSqliteConnection(conn)) {
      const db = await getSqliteDemo();
      const r = sqliteQuery(db, 'SELECT sqlite_version() AS version');
      return res.json({ connected: true, database: 'Demo (SQLite)', host: 'embedded', version: `SQLite ${r.rows[0].version}` });
    }
    const pool = getDbPool(req.query.connectionId);
    const result = await pool.query('SELECT version()');
    res.json({
      connected: true,
      database: conn?.database || 'unknown',
      host: conn?.host || 'unknown',
      version: result.rows[0].version,
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// GET /api/db/schema — full schema tree (tables, views, mat views, columns, PKs, FKs)
app.get('/api/db/schema', async (req, res) => {
  try {
    const conn = getConnectionById(req.query.connectionId);

    // ── SQLite path ──
    if (isSqliteConnection(conn)) {
      const db = await getSqliteDemo();
      const schema = 'main';
      const schemas = { [schema]: { tables: [], views: [] } };

      // Tables
      const tables = sqliteQuery(db, "SELECT name, type FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      for (const t of tables.rows) {
        const cols = sqliteQuery(db, `PRAGMA table_info("${t.name}")`);
        const fks = sqliteQuery(db, `PRAGMA foreign_key_list("${t.name}")`);
        const fkMap = {};
        for (const fk of fks.rows) fkMap[fk.from] = { refSchema: schema, refTable: fk.table, refColumn: fk.to };

        schemas[schema].tables.push({
          name: t.name, type: 'table',
          columns: cols.rows.map(c => ({
            name: c.name, type: c.type || 'TEXT', nullable: !c.notnull,
            default: c.dflt_value, maxLength: null, isPk: c.pk > 0, fk: fkMap[c.name] || null,
          })),
        });
      }

      // Views
      const views = sqliteQuery(db, "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name");
      for (const v of views.rows) {
        const cols = sqliteQuery(db, `PRAGMA table_info("${v.name}")`);
        schemas[schema].views.push({
          name: v.name, type: 'view',
          columns: cols.rows.map(c => ({
            name: c.name, type: c.type || 'TEXT', nullable: !c.notnull,
            default: c.dflt_value, maxLength: null, isPk: false, fk: null,
          })),
        });
      }

      return res.json(schemas);
    }

    // ── PostgreSQL path ──
    const pool = getDbPool(req.query.connectionId);

    // Tables and views
    const tablesQ = await pool.query(`
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);

    // Columns
    const columnsQ = await pool.query(`
      SELECT table_schema, table_name, column_name, data_type, is_nullable,
             column_default, ordinal_position, character_maximum_length,
             numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position
    `);

    // Primary keys
    const pksQ = await pool.query(`
      SELECT kcu.table_schema, kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
    `);

    // Foreign keys
    const fksQ = await pool.query(`
      SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
             ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
    `);

    // Materialized views
    const matViewsQ = await pool.query(`
      SELECT schemaname AS table_schema, matviewname AS table_name
      FROM pg_matviews
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, matviewname
    `);

    // Build pk/fk lookup sets
    const pkSet = new Set(pksQ.rows.map(r => `${r.table_schema}.${r.table_name}.${r.column_name}`));
    const fkMap = {};
    for (const r of fksQ.rows) {
      fkMap[`${r.table_schema}.${r.table_name}.${r.column_name}`] = {
        refSchema: r.ref_schema,
        refTable: r.ref_table,
        refColumn: r.ref_column,
      };
    }

    // Build nested tree: schema → tables/views → columns
    const schemas = {};
    for (const t of tablesQ.rows) {
      if (!schemas[t.table_schema]) schemas[t.table_schema] = { tables: [], views: [] };
      const entry = { name: t.table_name, type: t.table_type === 'VIEW' ? 'view' : 'table', columns: [] };
      if (t.table_type === 'VIEW') schemas[t.table_schema].views.push(entry);
      else schemas[t.table_schema].tables.push(entry);
    }

    // Add materialized views
    for (const mv of matViewsQ.rows) {
      if (!schemas[mv.table_schema]) schemas[mv.table_schema] = { tables: [], views: [] };
      schemas[mv.table_schema].views.push({ name: mv.table_name, type: 'matview', columns: [] });
    }

    // Attach columns
    const tableLookup = {};
    for (const [schema, groups] of Object.entries(schemas)) {
      for (const t of [...groups.tables, ...groups.views]) {
        tableLookup[`${schema}.${t.name}`] = t;
      }
    }

    for (const c of columnsQ.rows) {
      const key = `${c.table_schema}.${c.table_name}`;
      const t = tableLookup[key];
      if (!t) continue;
      const colKey = `${c.table_schema}.${c.table_name}.${c.column_name}`;
      t.columns.push({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        maxLength: c.character_maximum_length,
        isPk: pkSet.has(colKey),
        fk: fkMap[colKey] || null,
      });
    }

    res.json(schemas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/db/query — execute SQL
app.post('/api/db/query', async (req, res) => {
  try {
    const { sql, writeMode } = req.body;
    if (!sql || !sql.trim()) return res.status(400).json({ error: 'Empty query' });

    if (!isQuerySafe(sql, writeMode)) {
      return res.status(403).json({ error: 'Write operations blocked. Enable Write Mode to execute INSERT/UPDATE/DELETE/DDL.' });
    }

    const conn = getConnectionById(req.query.connectionId);
    const start = Date.now();

    if (isSqliteConnection(conn)) {
      const db = await getSqliteDemo();
      const result = sqliteQuery(db, sql);
      const time = Date.now() - start;
      return res.json({
        columns: result.fields.map(f => f.name),
        rows: result.rows,
        rowCount: result.rowCount,
        time,
        command: result.command,
      });
    }

    const pool = getDbPool(req.query.connectionId);
    const result = await pool.query(sql);
    const time = Date.now() - start;

    res.json({
      columns: result.fields ? result.fields.map(f => f.name) : [],
      rows: result.rows || [],
      rowCount: result.rowCount,
      time,
      command: result.command,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/db/table/:schema/:table — column details, row count, indexes
app.get('/api/db/table/:schema/:table', async (req, res) => {
  try {
    const { schema, table } = req.params;
    const conn = getConnectionById(req.query.connectionId);

    if (isSqliteConnection(conn)) {
      const db = await getSqliteDemo();
      const cols = sqliteQuery(db, `PRAGMA table_info("${table}")`);
      const countR = sqliteQuery(db, `SELECT count(*) AS count FROM "${table}"`);
      const idxList = sqliteQuery(db, `PRAGMA index_list("${table}")`);
      const indexes = idxList.rows.map(idx => ({
        indexname: idx.name,
        indexdef: `${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name}`,
      }));
      return res.json({
        columns: cols.rows.map(c => ({
          column_name: c.name, data_type: c.type || 'TEXT',
          is_nullable: c.notnull ? 'NO' : 'YES', column_default: c.dflt_value,
          character_maximum_length: null, numeric_precision: null,
        })),
        rowCount: countR.rows[0]?.count,
        indexes,
      });
    }

    const pool = getDbPool(req.query.connectionId);

    const [columnsR, countR, indexesR] = await Promise.all([
      pool.query(`
        SELECT column_name, data_type, is_nullable, column_default,
               character_maximum_length, numeric_precision
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, table]),
      pool.query(`SELECT count(*)::int AS count FROM "${schema}"."${table}"`).catch(() => ({ rows: [{ count: '?' }] })),
      pool.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $1 AND tablename = $2
      `, [schema, table]),
    ]);

    res.json({
      columns: columnsR.rows,
      rowCount: countR.rows[0]?.count,
      indexes: indexesR.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DB Scripts file browser
// ---------------------------------------------------------------------------
function getDbScriptsDir() { return join(getDataDir(), 'db-scripts'); }

function ensureScriptsDir() {
  if (!existsSync(getDbScriptsDir())) mkdirSync(getDbScriptsDir(), { recursive: true });
}

function safScriptPath(relPath) {
  const resolved = normalize(join(getDbScriptsDir(), relPath));
  if (!resolved.startsWith(getDbScriptsDir() + sep) && resolved !== getDbScriptsDir()) return null;
  return resolved;
}

function scanScriptsTree(dir, depth = 0) {
  const entries = [];
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return entries; }

  items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    const fullPath = join(dir, item.name);
    const relPath = relative(getDbScriptsDir(), fullPath).replace(/\\/g, '/');

    if (item.isDirectory()) {
      const children = scanScriptsTree(fullPath, depth + 1);
      entries.push({ name: item.name, path: relPath, type: 'dir', depth, children });
    } else if (item.name.endsWith('.sql')) {
      entries.push({ name: item.name, path: relPath, type: 'file', depth });
    }
  }
  return entries;
}

// Tree
app.get('/api/db/scripts/tree', (_req, res) => {
  ensureScriptsDir();
  res.json(scanScriptsTree(getDbScriptsDir()));
});

// Read file
app.get('/api/db/scripts/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const resolved = safScriptPath(filePath);
  if (!resolved) return res.status(403).json({ error: 'access denied' });
  if (!existsSync(resolved)) return res.status(404).json({ error: 'file not found' });

  try {
    const content = readFileSync(resolved, 'utf-8');
    res.json({ path: filePath, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save/create file
app.put('/api/db/scripts/file', express.json({ limit: '2mb' }), (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content == null) return res.status(400).json({ error: 'path and content required' });

  const resolved = safScriptPath(filePath);
  if (!resolved) return res.status(403).json({ error: 'access denied' });

  try {
    ensureScriptsDir();
    const parentDir = dirname(resolved);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create folder
app.post('/api/db/scripts/folder', express.json(), (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'path required' });

  const resolved = safScriptPath(folderPath);
  if (!resolved) return res.status(403).json({ error: 'access denied' });

  if (existsSync(resolved)) return res.status(409).json({ error: 'folder already exists' });

  try {
    mkdirSync(resolved, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file or empty folder
app.delete('/api/db/scripts/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const resolved = safScriptPath(filePath);
  if (!resolved) return res.status(403).json({ error: 'access denied' });
  if (!existsSync(resolved)) return res.status(404).json({ error: 'not found' });

  try {
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      rmdirSync(resolved); // only removes empty dirs
    } else {
      unlinkSync(resolved);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename file or folder
app.post('/api/db/scripts/rename', express.json(), (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });

  const resolvedOld = safScriptPath(oldPath);
  const resolvedNew = safScriptPath(newPath);
  if (!resolvedOld || !resolvedNew) return res.status(403).json({ error: 'access denied' });
  if (!existsSync(resolvedOld)) return res.status(404).json({ error: 'source not found' });
  if (existsSync(resolvedNew)) return res.status(409).json({ error: 'target already exists' });

  try {
    const parentDir = dirname(resolvedNew);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    renameSync(resolvedOld, resolvedNew);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import zip of scripts (preserves folder structure)
app.post('/api/db/scripts/import-zip', express.raw({ type: 'application/zip', limit: '50mb' }), (req, res) => {
  try {
    ensureScriptsDir();
    const zip = new AdmZip(req.body);
    const entries = zip.getEntries();
    let imported = 0;

    for (const entry of entries) {
      // Skip directories, hidden files, macOS resource forks
      if (entry.isDirectory) continue;
      if (entry.entryName.startsWith('__MACOSX')) continue;

      const entryName = entry.entryName;
      // Only import .sql files
      if (!entryName.toLowerCase().endsWith('.sql')) continue;

      // Strip leading single root folder if every entry shares one
      const resolved = safScriptPath(entryName);
      if (!resolved) continue;

      const parentDir = dirname(resolved);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      writeFileSync(resolved, entry.getData());
      imported++;
    }

    res.json({ ok: true, imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------------------------------------------------------
// Metrics — shared custom dashboard widgets backed by SQL queries
// ---------------------------------------------------------------------------
const METRICS_FILE = 'metrics.json';

function isMetricQuerySafe(sql) {
  // Strip line comments and block comments
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Split by semicolons — reject any statement that contains a forbidden keyword
  const statements = stripped.split(';').map(s => s.trim()).filter(Boolean);
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|COPY|VACUUM|ANALYZE|CLUSTER|REINDEX|LOCK)\b/i;
  for (const stmt of statements) {
    if (forbidden.test(stmt)) return false;
  }
  return true;
}

// GET /api/metrics — list all saved metrics
app.get('/api/metrics', (_req, res) => {
  const metrics = readJsonFile(METRICS_FILE, []);
  res.json(metrics);
});

// POST /api/metrics/preview — execute arbitrary SQL for wizard preview
app.post('/api/metrics/preview', express.json(), async (req, res) => {
  const { sql, connectionId: bodyConnId } = req.body;
  const connectionId = bodyConnId || req.query.connectionId;
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'Empty query' });
  if (!isMetricQuerySafe(sql)) {
    return res.status(403).json({ error: 'Only SELECT queries are allowed in metrics.' });
  }
  try {
    const conn = getConnectionById(connectionId);
    const start = Date.now();

    if (isSqliteConnection(conn)) {
      const db = await getSqliteDemo();
      const result = sqliteQuery(db, sql);
      const time = Date.now() - start;
      return res.json({
        columns: result.fields.map(f => f.name),
        rows: result.rows.slice(0, 20),
        rowCount: result.rowCount,
        time,
      });
    }

    const pool = getDbPool(connectionId);
    const raw = await pool.query(sql);
    const time = Date.now() - start;
    // pg returns an array of Results when the SQL contains multiple statements;
    // pick the last result that has actual column fields.
    const results = Array.isArray(raw) ? raw : [raw];
    const result = results.filter(r => r.fields && r.fields.length > 0).pop()
                || results[results.length - 1];
    res.json({
      columns: result.fields ? result.fields.map(f => f.name) : [],
      rows: (result.rows || []).slice(0, 20),
      rowCount: result.rowCount,
      time,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/metrics/:id — create or update a metric
app.put('/api/metrics/:id', express.json(), (req, res) => {
  const { id } = req.params;
  const metrics = readJsonFile(METRICS_FILE, []);
  const idx = metrics.findIndex(m => m.id === id);
  const metric = { ...req.body, id };
  if (idx >= 0) {
    metrics[idx] = metric;
  } else {
    metrics.push(metric);
  }
  writeJsonFile(METRICS_FILE, metrics);
  res.json({ ok: true, metric });
});

// DELETE /api/metrics/:id — remove a metric
app.delete('/api/metrics/:id', (req, res) => {
  const { id } = req.params;
  let metrics = readJsonFile(METRICS_FILE, []);
  const before = metrics.length;
  metrics = metrics.filter(m => m.id !== id);
  if (metrics.length === before) return res.status(404).json({ error: 'Not found' });
  writeJsonFile(METRICS_FILE, metrics);
  res.json({ ok: true });
});

// POST /api/metrics/:id/query — execute a saved metric's SQL
app.post('/api/metrics/:id/query', async (req, res) => {
  const { id } = req.params;
  const metrics = readJsonFile(METRICS_FILE, []);
  const metric = metrics.find(m => m.id === id);
  if (!metric) return res.status(404).json({ error: 'Metric not found' });
  const sql = metric.sql;
  if (!sql || !sql.trim()) return res.status(400).json({ error: 'Empty query' });
  if (!isMetricQuerySafe(sql)) {
    return res.status(403).json({ error: 'Only SELECT queries are allowed in metrics.' });
  }
  try {
    const conn = getConnectionById(metric.connectionId);
    const start = Date.now();

    if (isSqliteConnection(conn)) {
      const db = await getSqliteDemo();
      const result = sqliteQuery(db, sql);
      const time = Date.now() - start;
      return res.json({
        columns: result.fields.map(f => f.name),
        rows: result.rows,
        rowCount: result.rowCount,
        time,
      });
    }

    const pool = getDbPool(metric.connectionId);
    const result = await pool.query(sql);
    const time = Date.now() - start;
    res.json({
      columns: result.fields ? result.fields.map(f => f.name) : [],
      rows: result.rows || [],
      rowCount: result.rowCount,
      time,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Layouts — server-persisted dashboard layouts (survives browser data clears)
// ---------------------------------------------------------------------------
const LAYOUTS_FILE = 'layouts.json';

// GET /api/layouts — return all named layouts + active layout name
app.get('/api/layouts', (_req, res) => {
  const data = readJsonFile(LAYOUTS_FILE, { layouts: {}, active: 'Default', tabOrder: [] });
  res.json(data);
});

// PUT /api/layouts — overwrite all layout data
app.put('/api/layouts', express.json({ limit: '2mb' }), (req, res) => {
  const { layouts, active, tabOrder } = req.body;
  if (!layouts || typeof layouts !== 'object') {
    return res.status(400).json({ error: 'layouts object required' });
  }
  writeJsonFile(LAYOUTS_FILE, { layouts, active: active || 'Default', tabOrder: tabOrder || [] });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Claude Code notification hook endpoint
// Called by the Claude Code Notification hook to signal "awaiting input"
// ---------------------------------------------------------------------------
app.post('/api/claude/notify', express.json(), (req, res) => {
  const { type = 'notification', message = '', project = '' } = req.body || {};
  io.emit('claude-notification', { type, message, project, ts: Date.now() });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Socket.IO connection handler
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // Send current state to new connection
  for (const [key, state] of logState) {
    socket.emit('service-status', { key, status: state.status });
    for (const entry of state.buffer) {
      socket.emit('log', entry);
    }
  }
  socket.emit('git-status', gitStatusCache);
  if (externalStatusCache.length) {
    socket.emit('external-status', externalStatusCache);
  }
  if (claudeUsageCache) {
    socket.emit('claude-usage', claudeUsageCache);
  }

  // Send current service running state
  (async () => {
    for (const [key, def] of Object.entries(LOG_DEFS)) {
      if (!def.port) continue;
      const running = await checkPort(def.port);
      socket.emit('service-running', { key, running });
    }
  })();

  // Log viewer controls
  socket.on('clear-logs', (key) => {
    const state = logState.get(key);
    if (state) {
      state.buffer = [];
      io.emit('clear-logs', key);
    }
  });

  socket.on('check-status', (key) => {
    if (LOG_DEFS[key]) checkLogStatus(key);
  });

  // Manual refresh triggers
  socket.on('refresh', (target) => {
    if (target === 'git') pollGitStatus();
    else if (target === 'external') pollExternalStatus();
    else if (target === 'claude') {
      // Debounce: skip if fetched within the last 60s (prevents page-reload spam → 429s)
      const elapsed = Date.now() - (globalThis._lastClaudeUsageFetch || 0);
      if (elapsed > 60000) fetchClaudeUsage();
      else if (claudeUsageCache) socket.emit('claude-usage', claudeUsageCache);
    }
  });

  // Phase 5: DB migration socket events
  socket.on('migrate-latest', (data) => {
    const env = data?.env;
    const knexEnv = ['local', 'dev', 'prod'].includes(env) ? env : 'local';
    const dbDir = repoDir(CONFIG.dbRepo || 'db');
    if (!existsSync(dbDir)) {
      socket.emit('migrate-output', 'DB repo not configured. Set "dbRepo" in dashboard.config.json\n');
      socket.emit('migrate-done', { success: false });
      return;
    }

    const cmd = isWindows ? 'cmd' : 'npx';
    const args = isWindows
      ? ['/c', 'npx', 'knex', 'migrate:latest', '--env', knexEnv]
      : ['knex', 'migrate:latest', '--env', knexEnv];

    const child = spawn(cmd, args, { cwd: dbDir, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (d) => socket.emit('migrate-output', d.toString()));
    child.stderr.on('data', (d) => socket.emit('migrate-output', d.toString()));
    child.on('close', (code) => socket.emit('migrate-done', { success: code === 0 }));
    child.on('error', (err) => {
      socket.emit('migrate-output', `Error: ${err.message}\n`);
      socket.emit('migrate-done', { success: false });
    });
  });

  socket.on('migrate-rollback', (data) => {
    const env = data?.env;
    const knexEnv = ['local', 'dev', 'prod'].includes(env) ? env : 'local';
    const dbDir = repoDir(CONFIG.dbRepo || 'db');
    if (!existsSync(dbDir)) {
      socket.emit('migrate-output', 'DB repo not configured. Set "dbRepo" in dashboard.config.json\n');
      socket.emit('migrate-done', { success: false });
      return;
    }

    const cmd = isWindows ? 'cmd' : 'npx';
    const args = isWindows
      ? ['/c', 'npx', 'knex', 'migrate:rollback', '--env', knexEnv]
      : ['knex', 'migrate:rollback', '--env', knexEnv];

    const child = spawn(cmd, args, { cwd: dbDir, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (d) => socket.emit('migrate-output', d.toString()));
    child.stderr.on('data', (d) => socket.emit('migrate-output', d.toString()));
    child.on('close', (code) => socket.emit('migrate-done', { success: code === 0 }));
    child.on('error', (err) => {
      socket.emit('migrate-output', `Error: ${err.message}\n`);
      socket.emit('migrate-done', { success: false });
    });
  });

  // CLI Tools socket events
  socket.on('cli-tool-run', (data) => {
    const { id, cmd, args, env } = data || {};
    const cliDir = repoDir(CONFIG.cliRepo || 'cli');
    if (!existsSync(cliDir)) {
      socket.emit('cli-tool-output', { id, text: 'CLI repo not configured. Set "cliRepo" in dashboard.config.json\n' });
      socket.emit('cli-tool-done', { id, success: false });
      return;
    }
    const knexEnv = ['local', 'dev', 'prod'].includes(env) ? env : 'local';
    const spawnCmd = isWindows ? 'cmd' : 'npx';
    const spawnArgs = isWindows
      ? ['/c', 'npx', 'ts-node', cmd, ...(args || []), '--env', knexEnv]
      : ['ts-node', cmd, ...(args || []), '--env', knexEnv];

    const child = spawn(spawnCmd, spawnArgs, { cwd: cliDir, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (d) => socket.emit('cli-tool-output', { id, text: d.toString() }));
    child.stderr.on('data', (d) => socket.emit('cli-tool-output', { id, text: d.toString() }));
    child.on('close', (code) => socket.emit('cli-tool-done', { id, success: code === 0 }));
    child.on('error', (err) => {
      socket.emit('cli-tool-output', { id, text: `Error: ${err.message}\n` });
      socket.emit('cli-tool-done', { id, success: false });
    });
  });

  // Test Runner socket events
  const testProcesses = new Map(); // track running test processes per socket

  socket.on('test-run', (data) => {
    const { repo, pattern, suite } = data || {};
    if (!repo || !REPOS.includes(repo)) {
      socket.emit('test-output', { text: `Invalid repo: ${repo}\n` });
      socket.emit('test-done', { success: false });
      return;
    }
    const dir = repoDir(repo);

    // Kill any existing test process for this socket
    const existing = testProcesses.get(socket.id);
    if (existing && !existing.killed) {
      existing.kill();
    }

    // Determine test command based on repo
    let cmd, args;
    const pkgPath = join(dir, 'package.json');
    let framework = 'jest'; // default
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) framework = 'vitest';
    } catch { /* use default */ }

    if (framework === 'vitest') {
      cmd = 'npx';
      args = ['vitest', 'run', '--reporter=verbose'];
      if (pattern) args.push(pattern);
    } else {
      cmd = 'npx';
      args = ['jest', '--verbose', '--no-coverage'];
      if (suite === 'failed') args.push('--onlyFailures');
      if (pattern) args.push('--testPathPattern', pattern);
    }

    socket.emit('test-output', { text: `\u2500 Running: ${cmd} ${args.join(' ')}\n\u2500 Dir: ${dir}\n\u2500 Framework: ${framework}\n\n` });

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: 'true' },
      });
    } catch (spawnErr) {
      socket.emit('test-output', { text: `Spawn error: ${spawnErr.message}\n` });
      socket.emit('test-done', { success: false });
      return;
    }
    testProcesses.set(socket.id, child);

    // Buffer output and flush every 100ms to reduce socket message flood
    let outputBuf = '';
    let flushTimer = null;
    const flushOutput = () => {
      if (outputBuf) {
        socket.emit('test-output', { text: outputBuf });
        outputBuf = '';
      }
      flushTimer = null;
    };
    const bufferOutput = (text) => {
      outputBuf += text;
      if (!flushTimer) flushTimer = setTimeout(flushOutput, 100);
    };

    child.stdout.on('data', (d) => bufferOutput(d.toString()));
    child.stderr.on('data', (d) => bufferOutput(d.toString()));
    child.on('close', (code) => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      flushOutput(); // flush remaining
      testProcesses.delete(socket.id);
      socket.emit('test-done', { success: code === 0, code });
    });
    child.on('error', (err) => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      testProcesses.delete(socket.id);
      socket.emit('test-output', { text: `Error: ${err.message}\n` });
      socket.emit('test-done', { success: false });
    });
  });

  // Kill a spawned process tree (shell: true means the test runner is a child of the shell)
  function killTree(child) {
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* already dead */ }
  }

  socket.on('test-stop', () => {
    const child = testProcesses.get(socket.id);
    if (child && !child.killed) {
      killTree(child);
      socket.emit('test-output', { text: '\n--- Test run cancelled. ---\n' });
      socket.emit('test-done', { success: false, cancelled: true });
    }
    testProcesses.delete(socket.id);
  });

  socket.on('disconnect', () => {
    const child = testProcesses.get(socket.id);
    killTree(child);
    testProcesses.delete(socket.id);
  });

  // Phase 2: Quick action socket events
  socket.on('quick-action', (action) => {
    const actions = {};
    for (const [name, qaDef] of Object.entries(CONFIG.quickActions || {})) {
      const qaArgs = [qaDef.cmd, ...(qaDef.args || [])];
      actions[name] = {
        cwd: join(BASE_DIR, qaDef.repoDir || ''),
        cmd: isWindows ? 'cmd' : 'npx',
        args: isWindows ? ['/c', 'npx', ...qaArgs] : qaArgs,
      };
    }

    const def = actions[action];
    if (!def) {
      socket.emit('quick-action-output', { action, text: `Unknown action: ${action}\n` });
      socket.emit('quick-action-done', { action, success: false });
      return;
    }

    if (!existsSync(def.cwd)) {
      socket.emit('quick-action-output', { action, text: `Directory not found: ${def.cwd}\n` });
      socket.emit('quick-action-done', { action, success: false });
      return;
    }

    const child = spawn(def.cmd, def.args, { cwd: def.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (d) => socket.emit('quick-action-output', { action, text: d.toString() }));
    child.stderr.on('data', (d) => socket.emit('quick-action-output', { action, text: d.toString() }));
    child.on('close', (code) => socket.emit('quick-action-done', { action, success: code === 0 }));
    child.on('error', (err) => {
      socket.emit('quick-action-output', { action, text: `Error: ${err.message}\n` });
      socket.emit('quick-action-done', { action, success: false });
    });
  });

  // Repo clone
  socket.on('repo:clone', ({ source, cloneUrl, clonePath, repoName }) => {
    // Inject auth into URL server-side — never expose tokens to client
    let authUrl = cloneUrl || '';
    if (source === 'ado') {
      const pat = getAdoPat();
      if (pat) authUrl = authUrl.replace(/^(https?:\/\/)[^@]*@/, `$1:${pat}@`).replace(/^(https?:\/\/)(?!:)/, `$1:${pat}@`);
    } else if (source === 'github') {
      const token = getGithubRepoToken();
      if (token) authUrl = authUrl.replace(/^(https?:\/\/)/, `$1x-access-token:${token}@`);
    }

    const parentDir = dirname(clonePath);
    if (!existsSync(parentDir)) {
      socket.emit('repo:clone:output', { repoName, text: `Error: directory does not exist: ${parentDir}\n` });
      socket.emit('repo:clone:done', { repoName, success: false });
      return;
    }

    socket.emit('repo:clone:output', { repoName, text: `Cloning into '${clonePath}'...\n` });
    const child = spawn('git', ['clone', '--progress', authUrl, clonePath], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', d => socket.emit('repo:clone:output', { repoName, text: d.toString() }));
    child.stderr.on('data', d => socket.emit('repo:clone:output', { repoName, text: d.toString() }));
    child.on('close', code => socket.emit('repo:clone:done', { repoName, success: code === 0, clonePath }));
    child.on('error', err => {
      socket.emit('repo:clone:output', { repoName, text: `Error: ${err.message}\n` });
      socket.emit('repo:clone:done', { repoName, success: false });
    });
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`\n  ${CONFIG.title || 'Dev Dashboard'}`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Base dir: ${BASE_DIR}`);
  console.log(`  Data dir: ${getDataDir()}`);
  console.log(`  API dir:  ${getApiDir()}`);
  console.log(`  Private dir: ${getPrivateDataDir()}`);
  console.log(`  Docs dir: ${getDocsDir()}`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Log dir: ${LOG_DIR}`);
  console.log(`  Logs: ${Object.keys(LOG_DEFS).join(', ')}\n`);

  // Init passive log watchers (fs.watch — zero CPU when idle)
  for (const key of Object.keys(LOG_DEFS)) {
    initLogWatcher(key);
    checkLogStatus(key);
  }

  // Fallback poll: fs.watch can miss events on Windows, so also poll every 2s
  setInterval(() => {
    for (const key of Object.keys(LOG_DEFS)) {
      tailLogFile(key);
    }
  }, 2000);

  // Stagger startup polling
  pollGitStatus();
  setInterval(pollGitStatus, 5000);

  setTimeout(() => { fetchRemoteStatus(); setInterval(fetchRemoteStatus, 60000); }, 3000);
  startMonitorPolling();

  // Check if dev services are running (port check every 10s)
  async function pollServicePorts() {
    for (const [key, def] of Object.entries(LOG_DEFS)) {
      if (!def.port) continue;
      const running = await checkPort(def.port);
      io.emit('service-running', { key, running });
    }
  }
  pollServicePorts();
  setInterval(pollServicePorts, 10000);

  setTimeout(() => {
    fetchClaudeUsage();
    setInterval(() => {
      if (claudeUsageBackoff > 0) {
        const waitMs = Math.pow(2, claudeUsageBackoff) * 60000;
        const elapsed = Date.now() - (globalThis._lastClaudeUsageFetch || 0);
        if (elapsed < waitMs) return;
      }
      globalThis._lastClaudeUsageFetch = Date.now();
      fetchClaudeUsage();
    }, 600000);
  }, 9000);

  // Live-reload: watch public/ for frontend changes → tell browsers to refresh
  initLiveReload();
});

// ---------------------------------------------------------------------------
// Live-reload: watch public/ directory for CSS/JS/HTML changes
// ---------------------------------------------------------------------------
function initLiveReload() {
  const publicDir = join(__dirname, 'public');
  let debounce = null;

  try {
    watch(publicDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Only reload for web assets
      if (!/\.(js|css|html)$/.test(filename)) return;
      // Debounce rapid changes (e.g. editor save + format)
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`  Live-reload: ${filename} changed`);
        io.emit('live-reload', filename);
      }, 150);
    });
    console.log('  Live-reload: watching public/ for changes');
  } catch (err) {
    console.error('  Live-reload: watch failed —', err.message);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown() {
  console.log('\n  Shutting down...');

  // Close log file watchers
  for (const [, state] of logState) {
    if (state.watcher) state.watcher.close();
  }

  for (const [, pool] of dbPools) {
    pool.end().catch(() => {});
  }

  setTimeout(() => {
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
