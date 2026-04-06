 Setup Experience Review: Hive + Hivemind + Drone

 Context

 A new user evaluating the system currently faces a multi-repo, multi-terminal, manual-step gauntlet:

 1. Clone hive → npm install → run setup.ps1 (10-step interactive wizard) → npm start
 2. Clone drone → npm install → npm start → node setup.mjs (requires hive already running) → manually append dummy tokens to hive's .env → restart hive
 3. Clone hivemind → run setup.ps1 → manually edit PowerShell $PROFILE for the --add-dir alias

 That's 3 repos, 3 install steps, 3 setup scripts, 2 manual config edits, and a restart — with ordering dependencies that aren't obvious. A user who just wants to see what
 this thing does will likely bail before step 2.

 ---
 Top 3 Recommendations

 1. Drone setup.mjs should be fully automatic (zero manual steps after node setup.mjs)

 Problem: After running node setup.mjs, the user must still:
 - Manually append SENTRY_AUTH_TOKEN=drone-demo and ADO_PAT=drone-demo to hive's .env
 - Manually restart hive

 These are mechanical steps with no decision-making — they should be automated.

 Change: Enhance drone/setup.mjs to:
 1. Auto-inject dummy tokens — read hive's .env file, append the tokens if missing (the path to hive is already known since setup.mjs talks to hive's API; derive it from the
  config's projectsDir or accept it as a CLI arg)
 2. Trigger a config reload — either call a /api/reload endpoint on hive (if one exists or we add one), or at minimum tell the user exactly what to do with a copy-pasteable
 command rather than a generic "restart HIVE"
 3. Serve a redirect at / — http://localhost:4000 currently serves nothing. Add a one-line redirect to /control so users who navigate to the root URL land somewhere useful.

 Files to modify:
 - C:\Users\jwsto\projects\occ\drone\setup.mjs — add token injection + hive .env path resolution
 - C:\Users\jwsto\projects\occ\drone\server.mjs — add root redirect to /control
 - C:\Users\jwsto\projects\occ\hive\server.mjs — add POST /api/reload endpoint (hot-reload config + re-read .env without full restart)

 Impact: Drone setup goes from 5 steps to 2: npm start then node setup.mjs. Done.

 ---
 2. Add a "demo mode" quick-start path to hive's setup script

 Problem: Hive's setup.ps1 is a 10-step wizard designed for real teams with real repos, real ADO/GitHub projects, and real services. A new user evaluating the system has
 none of these — every question is a speed bump where they either guess or skip.

 Change: Add a "demo mode" branch at the very top of setup:

 Would you like to:
   [1] Full setup (configure your repos, services, and integrations)
   [2] Demo mode (minimal config — pair with Drone to see everything in action)

 Demo mode would:
 - Skip identity/provider/services questions entirely
 - Set projectsDir to the parent of hive's directory (auto-detected)
 - Add drone to the repos list (auto-detected if sibling exists)
 - Write a minimal dashboard.config.json that works out of the box
 - Print clear next-steps: "Now clone drone, run npm install && npm start && node setup.mjs"

 Files to modify:
 - C:\Users\jwsto\projects\occ\hive\setup.ps1 — add demo-mode branch after banner
 - C:\Users\jwsto\projects\occ\hive\setup.sh — same change for macOS/Linux

 Impact: A new user can go from clone to running dashboard in under 2 minutes, then layer on real configuration later.

 ---
 3. Add a post-setup health check script (npm run doctor)

 Problem: Across all three projects, there is no validation that setup actually worked. Users only discover problems when widgets are blank or skills fail silently. Common
 failures:
 - projectsDir doesn't exist or repos aren't cloned there
 - Drone isn't running when its health endpoints are configured
 - Dummy tokens missing from .env
 - Hivemind skills not symlinked into ~/.claude/skills/
 - PowerShell alias not set up

 Change: Add a doctor.mjs script to hive that checks the full stack:

 $ npm run doctor

   H.I.V.E. Health Check
   ----------------------
   [pass] dashboard.config.json exists
   [pass] projectsDir C:\Users\jwsto\projects\occ exists
   [pass] Repo: hive (found)
   [pass] Repo: drone (found)
   [warn] Drone not running (http://localhost:4000 unreachable)
   [pass] SENTRY_AUTH_TOKEN set
   [pass] ADO_PAT set
   [warn] No database connections configured (SQL widgets will be disabled)
   [pass] Hivemind config at ~/.config/hivemind/config.md
   [warn] Hivemind skills not installed — run setup.ps1 in hivemind/

 Files to create:
 - C:\Users\jwsto\projects\occ\hive\doctor.mjs — health check script
 - Update C:\Users\jwsto\projects\occ\hive\package.json — add "doctor": "node doctor.mjs" to scripts

 Impact: Single command answers "is my setup working?" — eliminates the most frustrating part of onboarding (silent failures).

 ---
 Verification Plan

 After implementing all three changes:

 1. Fresh clone test: Clone hive into a temp directory, run setup.ps1, choose demo mode, verify dashboard.config.json is minimal and valid
 2. Drone auto-setup test: Start hive, start drone, run node setup.mjs, verify tokens are in hive's .env without manual editing, verify hive picks up the new config
 3. Doctor test: Run npm run doctor with various states (drone running/stopped, tokens present/missing, hivemind installed/not) and verify output is accurate
 4. Root redirect test: Navigate to http://localhost:4000 and verify redirect to /control
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌

 Claude has written up a plan and is ready to execute. Would you like to proceed?

 ❯ 1. Yes, and bypass permissions
   2. Yes, manually approve edits
   3. No, refine with Ultraplan on Claude Code on the web
   4. Tell Claude what to change
      shift+tab to approve with this feedback