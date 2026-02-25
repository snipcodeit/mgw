---
phase: 1-docs-readme-md-missing-init-command-and-
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [README.md]
autonomous: true
requirements: [DOC-01, DOC-02, DOC-03, DOC-04, DOC-05]

must_haves:
  truths:
    - "/mgw:init command is documented in the Commands table"
    - "init.md appears in the Project Structure file listing"
    - "Verify output shows init.md in the expected ls output"
    - "State Management tree accurately reflects files created by init.md"
    - "No claims in README about files or features that do not exist in the codebase"
  artifacts:
    - path: "README.md"
      provides: "Accurate project documentation"
      contains: "/mgw:init"
  key_links:
    - from: "README.md Commands table"
      to: ".claude/commands/mgw/init.md"
      via: "command name reference"
      pattern: "mgw:init"
---

<objective>
Fix all 5 stale/missing documentation issues in README.md identified in issue #9.

Purpose: README is the first thing users and contributors see. Stale claims about nonexistent files and a missing command entry undermine trust in the project.
Output: Updated README.md with accurate commands table, project structure, verification output, and state tree.
</objective>

<execution_context>
@/home/hat/.claude/get-shit-done/workflows/execute-plan.md
@/home/hat/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@README.md
@.claude/commands/mgw/init.md
@.claude/commands/mgw/workflows/state.md
@.claude/commands/mgw/help.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add /mgw:init to Commands table, verify output, and project structure</name>
  <files>README.md</files>
  <action>
Make three targeted edits to README.md:

1. **Commands table (line ~45-54):** Add a row for `/mgw:init` as the FIRST entry in the table (it is a setup command that runs before all others). Use this row:
   `| /mgw:init | Bootstrap repo for MGW — creates .mgw/ state, GitHub templates, gitignore entries |`

2. **Verify output (line ~129-130):** Update the `ls` output to include `init.md` in alphabetical position among the other files:
   ```
   # help.md  init.md  issue.md  issues.md  link.md  pr.md  run.md  sync.md  update.md  workflows/
   ```

3. **Project Structure (line ~168-182):** Add `init.md` with description in the file listing, placed after `help.md` alphabetically:
   ```
   init.md               One-time repo bootstrap (state, templates, labels)
   ```

Maintain existing formatting, indentation, and alignment conventions used in the file.
  </action>
  <verify>
    <automated>grep -c "mgw:init" README.md | grep -q "^[1-9]" && grep "init.md" README.md | grep -c "init.md" | grep -q "^[3-9]" && echo "PASS: init.md appears in commands table, verify output, and project structure" || echo "FAIL"</automated>
  </verify>
  <done>
    - /mgw:init row present in Commands table
    - init.md listed in verification ls output
    - init.md listed in Project Structure with description
  </done>
</task>

<task type="auto">
  <name>Task 2: Fix stale .mgw/ state tree and stow note</name>
  <files>README.md</files>
  <action>
Make two targeted edits to README.md:

1. **State Management .mgw/ tree (line ~78-85):** Remove the `config.json  User preferences` line from the tree listing. The init.md command does NOT create this file — it creates `active/`, `completed/`, and `cross-refs.json` only. The updated tree should be:
   ```
   .mgw/
     active/              In-progress issue pipelines
       42-fix-auth.json   Issue state: triage results, pipeline stage, artifacts
     completed/           Archived after PR merge
     cross-refs.json      Bidirectional issue/PR/branch links
   ```
   Note: Although state.md and help.md reference config.json, those are internal command docs. The README should document what actually gets created. This is a README-only fix; do NOT modify state.md or help.md.

2. **Stow deployment example (line ~115):** The stow command `stow -v -t ~ mgw` assumes the cloned directory is named `mgw`. Add a brief parenthetical note after the stow command block:
   ```
   > **Note:** The stow command assumes the repo directory is named `mgw` (the default from `git clone`). If you renamed the directory, replace `mgw` with its actual name.
   ```
   Place this note immediately after the `stow -v -t ~ mgw` code block and before the "To update after pulling changes:" line.
  </action>
  <verify>
    <automated>! grep -q "config.json.*User preferences" README.md && grep -q "repo directory is named" README.md && echo "PASS: config.json removed, stow note added" || echo "FAIL"</automated>
  </verify>
  <done>
    - config.json line removed from .mgw/ state tree
    - Stow directory name note present after deployment example
  </done>
</task>

</tasks>

<verification>
All 5 documentation issues from issue #9 are addressed:
1. [Blocking] /mgw:init in Commands table
2. [Blocking] init.md in Project Structure
3. [Blocking] init.md in verify ls output
4. [Cosmetic] config.json removed from .mgw/ tree
5. [Cosmetic] Stow directory name note added

Run final check:
```bash
# Verify all fixes present
grep "mgw:init" README.md          # Should show command table row
grep "init.md" README.md           # Should show 3+ occurrences (table, verify, structure)
grep "config.json" README.md       # Should show 0 occurrences
grep "repo directory" README.md    # Should show stow note
```
</verification>

<success_criteria>
- README.md contains /mgw:init in the Commands table
- README.md lists init.md in the verification output and project structure
- README.md does not claim config.json exists in .mgw/
- README.md includes stow directory naming note
- No other content in README.md is modified
</success_criteria>

<output>
After completion, create `.planning/quick/1-docs-readme-md-missing-init-command-and-/1-01-SUMMARY.md`
</output>
