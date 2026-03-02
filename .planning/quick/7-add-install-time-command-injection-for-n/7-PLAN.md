---
phase: quick-7
plan: 7
type: execute
wave: 1
depends_on: []
files_modified:
  - bin/mgw-install.cjs
  - package.json
  - README.md
autonomous: true
requirements: [INSTALL-01]

must_haves:
  truths:
    - "Running `npm install -g mgw` automatically copies slash commands to ~/.claude/commands/mgw/ without any manual step"
    - "Running `npm install` from a cloned repo also installs slash commands (postinstall fires)"
    - "The install script is idempotent — safe to run multiple times without duplicating files"
    - "The .claude/commands/mgw/ directory is removed from the repo (no longer vendor-locked there)"
    - "README install instructions reflect the automatic install — no manual cp step"
  artifacts:
    - path: "bin/mgw-install.cjs"
      provides: "Install script that detects ~/.claude/commands/ and copies commands/ there"
      exports: []
    - path: "package.json"
      provides: "postinstall script wired to bin/mgw-install.cjs"
      contains: "\"postinstall\""
  key_links:
    - from: "package.json postinstall"
      to: "bin/mgw-install.cjs"
      via: "node ./bin/mgw-install.cjs"
      pattern: "postinstall.*mgw-install"
    - from: "bin/mgw-install.cjs"
      to: "commands/ (package source)"
      via: "path.join(__dirname, '..', 'commands')"
      pattern: "__dirname.*commands"
---

<objective>
Add automatic install-time command injection so that `npm install -g mgw` (and `npm install` from clone) automatically deploys slash commands to `~/.claude/commands/mgw/` — removing the manual copy step from the install flow. Remove `.claude/commands/mgw/` from the repo since it is now a runtime artifact managed by the installer, not a committed directory.

Purpose: Eliminate the manual "copy slash commands" step that users forget, and remove the Claude Code-specific `.claude/` vendor lock from the committed source tree.

Output: `bin/mgw-install.cjs` (idempotent installer), updated `package.json` with `postinstall`, removed `.claude/commands/mgw/` from git, updated README reflecting one-step install.
</objective>

<execution_context>
@/home/hat/.claude/get-shit-done/workflows/execute-plan.md
@/home/hat/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/hd1/repos/mgw/CLAUDE.md
@/hd1/repos/mgw/package.json
@/hd1/repos/mgw/lib/claude.cjs
@/hd1/repos/mgw/README.md

<interfaces>
<!-- Key contracts the executor needs. No codebase exploration needed. -->

From lib/claude.cjs:
```javascript
// getCommandsDir() resolves to: path.join(__dirname, '..', 'commands')
// This is the BUNDLED commands/ used by `claude -p` — NOT the slash command install target.
// The slash command target is ~/.claude/commands/mgw/ (Claude Code convention).
function getCommandsDir() {
  const dir = path.join(__dirname, '..', 'commands');
  // ...
  return dir;
}
```

From package.json:
```json
{
  "files": ["dist/", "commands/", "templates/"],
  "scripts": {
    "build": "pkgroll --clean-dist --src .",
    "prepublishOnly": "npm run build"
    // NO postinstall yet
  }
}
```

Install paths:
- When installed globally: package lives at $(npm root -g)/mgw/
- commands/ source: within the installed package at commands/
- Claude Code slash command target: ~/.claude/commands/mgw/
- The installer must resolve the source via: path.join(__dirname, '..', 'commands')
  (because mgw-install.cjs is in bin/, so __dirname is the bin/ dir of the installed package)
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write bin/mgw-install.cjs — idempotent slash command installer</name>
  <files>/hd1/repos/mgw/bin/mgw-install.cjs</files>
  <action>
Create `bin/mgw-install.cjs` as a standalone Node.js script (no dependencies, no require() from lib/) that:

1. Resolves the source commands/ directory: `path.join(__dirname, '..', 'commands')`
2. Determines the Claude Code install target: `path.join(os.homedir(), '.claude', 'commands', 'mgw')`
3. Checks whether ~/.claude/ exists — if NOT, prints a clear skip message and exits 0 (non-fatal: user may not have Claude Code installed; `npm install -g mgw` should still succeed)
4. If ~/.claude/ exists, creates ~/.claude/commands/mgw/ recursively if missing, then recursively copies the commands/ source tree into it (overwriting existing files — idempotent)
5. Prints one clear summary line: "mgw: installed N slash commands to ~/.claude/commands/mgw/" or "mgw: ~/.claude/ not found — skipping slash command install (run `mgw install-commands` after installing Claude Code)"

Recursive copy implementation: walk the source tree with fs.readdirSync/fs.statSync, mkdir -p destination subdirs, fs.copyFileSync each .md file. Do NOT use shell cp — keep it pure Node.js so it works cross-platform and inside npm sandboxes.

Script must start with `#!/usr/bin/env node\n'use strict';` and use only Node.js built-ins (path, fs, os).

Important: The script runs during npm postinstall. In some npm versions, postinstall runs with limited environment. Keep it simple — no try/catch wrapping the whole script, just catch individual fs errors gracefully and continue.

Do NOT add an `mgw install-commands` CLI subcommand in this task — the install script is invoked directly by npm, not through Commander.
  </action>
  <verify>
node /hd1/repos/mgw/bin/mgw-install.cjs
# Should print either:
# "mgw: installed N slash commands to ~/.claude/commands/mgw/"
# OR skip message if ~/.claude/ doesn't exist.
# Exit code must be 0 in both cases.
echo "Exit: $?"
ls ~/.claude/commands/mgw/ | head -5
  </verify>
  <done>Script exits 0 in both the skip case and the install case. When ~/.claude/ exists, slash commands appear at ~/.claude/commands/mgw/ mirroring the commands/ source tree.</done>
</task>

<task type="auto">
  <name>Task 2: Wire postinstall + remove .claude/commands/mgw/ from repo + update README</name>
  <files>
    /hd1/repos/mgw/package.json
    /hd1/repos/mgw/README.md
  </files>
  <action>
Three changes in this task:

**A. package.json — add postinstall script**

Read package.json. Add `"postinstall": "node ./bin/mgw-install.cjs"` to the `scripts` block. The install script is in bin/ (not dist/), so the path is `./bin/mgw-install.cjs` — this works for both `npm install` from clone and `npm install -g mgw` because the path is relative to the package root. Also add `"bin/mgw-install.cjs"` to the `files` array so it's included in the npm package. Write the updated package.json.

**B. Remove .claude/commands/mgw/ from git**

Run: `git rm -r /hd1/repos/mgw/.claude/commands/mgw/`

This removes the directory from git tracking. The physical files will be deleted. The commands/ source of truth remains at commands/ (already in `files[]`). After git rm, verify `.claude/commands/` is now empty or gone with `ls /hd1/repos/mgw/.claude/commands/ 2>/dev/null`.

If `.claude/` becomes empty after removal, also run `git rm -r /hd1/repos/mgw/.claude/` to clean up the empty directory.

**C. README.md — update Installation section**

The current Installation section (around line 225–260) has:

```bash
git clone https://github.com/snipcodeit/mgw.git
cd mgw
npm install && npm run build
npm link

# Deploy slash commands to Claude Code
mkdir -p ~/.claude/commands/mgw/workflows
cp -r .claude/commands/mgw/* ~/.claude/commands/mgw/
```

Replace with:

```bash
git clone https://github.com/snipcodeit/mgw.git
cd mgw
npm install && npm run build
npm link
# Slash commands are installed automatically by npm postinstall
```

For the "Slash commands only (no CLI)" section, replace with:

```bash
npm install -g mgw
# Slash commands are automatically deployed to ~/.claude/commands/mgw/
```

Update the Verify section to remove the reference to `ls ~/.claude/commands/mgw/` showing files copied from `.claude/commands/mgw/*` — instead note that postinstall handles this.

Also update the "Project Structure" section in README.md: remove the `.claude/` directory block (lines describing `.claude/commands/mgw/` and its workflows). Update the text to note that slash commands are deployed to `~/.claude/commands/mgw/` at install time from the `commands/` source directory.

Use the Edit tool for targeted README changes — do not rewrite sections that aren't changing.
  </action>
  <verify>
# Verify postinstall is wired
node -e "const p = require('/hd1/repos/mgw/package.json'); console.log(p.scripts.postinstall)"
# Expected: node ./bin/mgw-install.cjs

# Verify mgw-install.cjs is in files array
node -e "const p = require('/hd1/repos/mgw/package.json'); console.log(p.files)"

# Verify .claude/commands/mgw/ is gone from git
git -C /hd1/repos/mgw status --short | grep -E "\.claude" || echo "no .claude changes (already clean)"
git -C /hd1/repos/mgw ls-files /hd1/repos/mgw/.claude/commands/mgw/ | head -5 || echo "not tracked"
  </verify>
  <done>package.json has postinstall wired. bin/mgw-install.cjs is in the files array. .claude/commands/mgw/ is removed from git tracking. README install instructions no longer reference a manual cp step.</done>
</task>

</tasks>

<verification>
Run the full install chain to confirm end-to-end:

```bash
# 1. Confirm the installer works standalone
node /hd1/repos/mgw/bin/mgw-install.cjs
# Should print install summary, exit 0

# 2. Confirm slash commands landed correctly
ls ~/.claude/commands/mgw/
diff -r /hd1/repos/mgw/commands/ ~/.claude/commands/mgw/
# Should show no differences (installer mirrors source)

# 3. Confirm .claude/commands/mgw/ is no longer tracked
git -C /hd1/repos/mgw ls-files .claude/ | wc -l
# Should be 0

# 4. Confirm package.json is valid JSON with postinstall
node -e "const p = require('/hd1/repos/mgw/package.json'); console.log('OK', p.scripts.postinstall)"
```
</verification>

<success_criteria>
- `npm install` from the repo root runs the postinstall script automatically
- Slash commands are deployed to `~/.claude/commands/mgw/` without any manual copy step
- The installer is idempotent (running twice produces the same result, no duplicates or errors)
- The installer exits 0 even when `~/.claude/` does not exist (graceful skip)
- `.claude/commands/mgw/` is absent from git history going forward
- README no longer instructs users to manually copy slash commands
</success_criteria>

<output>
After completion, create `.planning/quick/7-add-install-time-command-injection-for-n/7-SUMMARY.md` with:
- What was built (installer script, postinstall hook, README changes)
- Files modified/deleted
- Verification results
- Any edge cases discovered
</output>
