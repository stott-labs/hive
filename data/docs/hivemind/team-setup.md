# Team Setup Guide

This guide covers rolling out Hivemind to a development team.

## Before You Start

Decide on:

1. **Provider** — Azure DevOps or GitHub (the whole team should use the same one)
2. **Repos to track** — Which repositories the team works in
3. **Reviewers** — Default PR reviewers (ADO GUIDs or GitHub usernames)
4. **Documentation** — Whether you want bug docs generated (requires a shared docs directory)

## Prepare the Fork

Fork or clone Hivemind into your organization:

```bash
git clone https://github.com/your-org/hivemind.git
```

Update `hivemind.config.example.md` with your org's skeleton values — org name, project name, and repo list. This gives new team members a reference when running setup.

You can also customize skill implementations if your team has specific conventions — PR description templates, bug documentation structure, branch naming rules, etc.

## Per-Developer Setup

Each developer runs through this once:

### 1. Install HIVE (recommended first)

```bash
git clone https://github.com/your-org/hive.git
cd hive && npm install
./setup.sh   # or .\setup.ps1 on Windows
```

This creates `~/.config/hivemind/config.md` with the developer's identity and provider settings.

### 2. Install Hivemind

```bash
git clone https://github.com/your-org/hivemind.git
cd hivemind
./setup.sh   # detects existing config, installs skills
```

### 3. Add to shell profile

```bash
# ~/.zshrc or ~/.bashrc
alias claude='claude --add-dir /path/to/hivemind'
```

```powershell
# PowerShell $PROFILE
function claude { & claude.exe --add-dir 'C:\path\to\hivemind' @args }
```

### 4. Verify

```
claude
> /repos
```

The developer should see a status table of their repos.

## Updating Skills

When skill implementations change, each developer just pulls:

```bash
cd /path/to/hivemind
git pull
```

Because skills are installed as symlinks, the updates take effect immediately — no reinstall, no restart.

## Per-Developer vs. Shared State

| What | Where | Shared? |
|------|-------|---------|
| Skill definitions | `hivemind/.claude/skills/` | Yes — via git |
| Config values | `~/.config/hivemind/config.md` | No — per developer |
| Path discovery | `~/.config/hivemind/paths.env` | No — per developer |
| Platform CLAUDE.md | `{projects_dir}/CLAUDE.md` | Yes — symlinked |
| Skill symlinks | `~/.claude/skills/` | No — per developer |

## Customizing for Your Org

### Custom PR templates

Edit `.claude/skills/create-pr/SKILL.md` to change the PR description format, title conventions, or reviewer logic.

### Custom bug templates

Edit `.claude/skills/create-bug/SKILL.md` to change the documentation template, severity mapping, or branch naming.

### Adding new skills

Create a new directory under `.claude/skills/` with a `SKILL.md` file. After setup, it'll be symlinked to every developer's machine.

### Removing skills

Delete the skill directory and re-run setup, or manually remove the symlink from `~/.claude/skills/`.

## Troubleshooting

**Skills not showing up?**
- Verify the alias is set: `which claude` should show the alias
- Check symlinks: `ls -la ~/.claude/skills/` should show links to hivemind
- Re-run setup: `cd hivemind && ./setup.sh`

**Provider errors?**
- ADO: Verify `ADO_PAT` is set and has sufficient permissions (Work Items Read/Write, Code Read/Write, Build Read/Execute)
- GitHub: Verify `gh auth status` or `GITHUB_TOKEN` is set

**Config not found?**
- Check `~/.config/hivemind/config.md` exists
- Re-run HIVE setup or Hivemind setup to regenerate
