// H.I.V.E. Health Check — validates setup across hive, drone, and hivemind
// Run: npm run doctor

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASS = '\x1b[32m[pass]\x1b[0m';
const WARN = '\x1b[33m[warn]\x1b[0m';
const FAIL = '\x1b[31m[FAIL]\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let passCount = 0;
let warnCount = 0;
let failCount = 0;

function pass(msg) { passCount++; console.log(`  ${PASS} ${msg}`); }
function warn(msg) { warnCount++; console.log(`  ${WARN} ${msg}`); }
function fail(msg) { failCount++; console.log(`  ${FAIL} ${msg}`); }

async function isReachable(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    // Drain the response body so the underlying socket is released cleanly
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`\n  ${CYAN}${BOLD}H.I.V.E. Health Check${RESET}`);
  console.log(`  ${CYAN}${'─'.repeat(40)}${RESET}\n`);

  // ── 1. Config file ──
  const configPath = join(__dirname, 'dashboard.config.json');
  let config = null;
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
      pass('dashboard.config.json exists and is valid JSON');
    } catch {
      fail('dashboard.config.json exists but is not valid JSON');
    }
  } else {
    fail('dashboard.config.json not found — run setup.ps1 or setup.sh');
  }

  // ── 2. Projects directory ──
  if (config?.projectsDir) {
    if (existsSync(config.projectsDir)) {
      pass(`projectsDir exists: ${config.projectsDir}`);
    } else {
      fail(`projectsDir not found: ${config.projectsDir}`);
    }
  } else if (config) {
    warn('projectsDir not set in config');
  }

  // ��─ 3. Repos ──
  if (config?.repos?.length > 0 && config.projectsDir) {
    for (const repo of config.repos) {
      const repoPath = join(config.projectsDir, repo);
      if (existsSync(repoPath)) {
        pass(`Repo: ${repo}`);
      } else {
        warn(`Repo not found: ${repo} (expected at ${repoPath})`);
      }
    }
  } else if (config) {
    warn('No repos configured — dashboard git widgets will be empty');
  }

  // ── 4. Environment tokens ──
  const envPath = join(__dirname, '.env');
  let envVars = {};
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }

  const tokenChecks = [
    { key: 'SENTRY_AUTH_TOKEN', label: 'Sentry widget' },
    { key: 'ADO_PAT', label: 'Azure DevOps widgets' },
    { key: 'GITHUB_TOKEN', label: 'GitHub widgets' },
  ];

  for (const { key, label } of tokenChecks) {
    // Only warn for tokens that the config suggests are needed
    const needed = (key === 'ADO_PAT' && config?.ado) ||
                   (key === 'SENTRY_AUTH_TOKEN' && config?.sentry) ||
                   (key === 'GITHUB_TOKEN' && config?.github);
    if (envVars[key]) {
      pass(`${key} set`);
    } else if (needed) {
      warn(`${key} not set — ${label} will not load`);
    }
    // If not needed, don't mention it at all
  }

  // ── 5. Drone ──
  const droneRunning = await isReachable('http://localhost:4000/api/state');
  if (droneRunning) {
    pass('Drone running at http://localhost:4000');
  } else {
    const hasDroneRepo = config?.repos?.includes('drone');
    if (hasDroneRepo) {
      warn('Drone not running (http://localhost:4000 unreachable) — start it with: cd drone && npm start');
    }
    // If drone isn't in repos, don't mention it
  }

  // ── 6. HIVE server ──
  const hiveRunning = await isReachable('http://localhost:3333/api/config');
  if (hiveRunning) {
    pass('HIVE running at http://localhost:3333');
  } else {
    warn('HIVE not running — start it with: npm start');
  }

  // ── 7. Database connections ──
  const dbPath = join(__dirname, 'data', 'databases.json');
  if (existsSync(dbPath)) {
    try {
      const dbs = JSON.parse(readFileSync(dbPath, 'utf-8'));
      if (Array.isArray(dbs) && dbs.length > 0) {
        pass(`Database connections configured: ${dbs.length}`);
      } else {
        pass('No database connections configured — embedded SQLite demo will be used');
      }
    } catch {
      warn('data/databases.json is not valid JSON');
    }
  }

  // ── 8. Hivemind config ──
  const hivemindConfig = join(homedir(), '.config', 'hivemind', 'config.md');
  if (existsSync(hivemindConfig)) {
    pass(`Hivemind config at ${hivemindConfig}`);
  } else {
    warn('Hivemind config not found — run setup in hivemind/ for skill support');
  }

  // ── 9. Hivemind skills ──
  const skillsDir = join(homedir(), '.claude', 'skills');
  if (existsSync(skillsDir)) {
    const expectedSkills = ['prd', 'create-pr', 'create-bug', 'repos', 'dashboard'];
    let installedCount = 0;
    for (const skill of expectedSkills) {
      if (existsSync(join(skillsDir, skill))) installedCount++;
    }
    if (installedCount === expectedSkills.length) {
      pass(`Hivemind skills installed (${installedCount}/${expectedSkills.length} checked)`);
    } else if (installedCount > 0) {
      warn(`Hivemind skills partially installed (${installedCount}/${expectedSkills.length}) — re-run hivemind setup`);
    } else {
      warn('Hivemind skills not installed — run setup.ps1/setup.sh in hivemind/');
    }
  }

  // ── Summary ──
  console.log(`\n  ${CYAN}${'─'.repeat(40)}${RESET}`);
  const parts = [];
  if (passCount > 0) parts.push(`\x1b[32m${passCount} passed\x1b[0m`);
  if (warnCount > 0) parts.push(`\x1b[33m${warnCount} warnings\x1b[0m`);
  if (failCount > 0) parts.push(`\x1b[31m${failCount} failed\x1b[0m`);
  console.log(`  ${parts.join(', ')}\n`);

  // Use exitCode instead of process.exit() to let Node drain pending handles
  // cleanly (avoids UV_HANDLE_CLOSING assertion on Windows)
  process.exitCode = failCount > 0 ? 1 : 0;
}

main();
