# Claude Code session retrospective — 2026-10-21

Where agents on this VPS got slowed down, stuck, or produced wrong results, and
what to change in the environment. Counts come from
[`scripts/session_retro.py`](scripts/session_retro.py) (aggregates in
[`data/signals.json`](data/signals.json)) plus six read-only investigations
that opened 2–4 representative sessions per pattern. Session ids are the first
8 characters of the transcript uuid; resolve one with
`ls ~/.claude/projects/*/<id>*.jsonl`.

## Inventory

| | |
| --- | --- |
| Sessions analysed | 90 top-level transcripts (82 with tool calls); this retro session excluded |
| Subagent transcripts | 182 nested files, counted but not analysed |
| Date range | 2026-09-26 → 2026-10-20 |
| Tool calls | 14,967 — Bash 12,027 (80%), Read 898, Write 607, Edit 166 |
| Projects | eduline-ai-shop 41 · eduline-shopify-tools 27 · thats-fair 8 · alexportelli 4 · verifika 3 · `~` 3 · opencode config 2 · `~/.claude` 1 · `~/workspace` 1 |

eduline-ai-shop holds ~65% of all friction (by the script's weighted score)
and ~180 of ~300 session-hours. It is also the one active project with no
`CLAUDE.md`/`AGENTS.md`.

Regenerate with:

```bash
python3 -I scripts/session_retro.py --exclude <current-session-prefix>
```

## How to read the counts

- Counts are per tool result, deduplicated by entry uuid (resumed sessions
  replay earlier lines).
- "Silent" failures are results the harness reported as success but whose
  output shows a failure: zsh skipping one segment of a `;`-joined command, or
  `cmd 2>&1 | tail` hiding the exit status.
- Investigations sometimes found more than the script (for example, they
  searched non-error results). Where they differ, both numbers are given.
- Corrections: the strict "you got it wrong" matcher found **0** user
  corrections. Words like "instead" and "don't" appear in long up-front specs
  as guardrails, not as course corrections. The user-side signal is follow-up
  rework rounds (pattern 9).

## Top 10 patterns

| # | Pattern | Occurrences | Sessions | Root cause |
| --- | --- | --- | --- | --- |
| 1 | zsh aborts unquoted globs (`grep --include=*.ts`, `echo ===`) | 386 (352 silent) | 77 | Harness runs zsh; no convention |
| 2 | Long commands: 10-min Bash cap, hand-rolled wait loops, `sleep` blocks | 336 calls ≥2 min (~1,500 min); 28 cap hits; 99 Bash wait loops; 24 sleep blocks | 64 | Slow verify + no background/Monitor convention |
| 3 | Edit/Write refused: "File has not been read yet" | 72 (~150 extra calls) | 31 | File seen via `cat`/`sed`, not Read |
| 4 | `implementation-workspace` misuse | 15 (script) / ~45 (deep scan) | 12 / ~25 | CLI has no `--help`; resolves repo from cwd |
| 5 | Playwright MCP "outside allowed roots" | 14 (+28 copy calls) | 13 | Skill writes to evidenceDir; MCP roots exclude it |
| 6 | eduline plan doc too big to read (159 KB, 317 lines) | 7 "exceeds max tokens"; 60–80K tokens/session | 26 touch it | Doc structure; no project CLAUDE.md |
| 7 | Exit status lost through pipes in verify/test runs | 247 | 57 | Convention (`\| tail`); low harm observed |
| 8 | Context compaction | 28 | 23 | One session reused for many PR rounds |
| 9 | Follow-up rework rounds | 15–18 prompts | 13 | Known "lows" deferred; live-host behaviour; taste |
| 10 | Missing binaries/modules (`file`, ImageMagick, PIL, `lsof`, `rsync`) | 16 (script) / ~45 (deep scan) | 12 / ~25 | Missing tooling on the VPS |

Also measured, but not a top-10 time sink:

- **Playwright locator timeouts:** 16 in 12 sessions. Overlays, guessed selectors, and the app not being ready.
- **Auto-mode denials:** 18 in 14 sessions, 11 of them correct blocks, plus 9 transient "no verdict" errors.
- **Interrupts:** 5.
- **Fail→edit→rerun loops:** 8 in 7 sessions, mostly `tsc`/`vitest`. They resolved within 2 cycles.
- **Long agent-side gaps:** almost all legitimate waits on background tasks or CI. Only 3 of 95 were unexplained.

## Findings and root causes

### 1. zsh aborts unquoted globs — 386 hits, 77 sessions

- **What breaks:**
  - The Bash tool runs commands through the user's zsh. An unquoted `grep -rn foo --include=*.ts src` fails with `(eval):1: no matches found: --include=*.ts`.
  - Of 303 commands written that way, 96% failed.
  - Because zsh only drops that segment of a `;`-joined command, 352 of the 386 hits returned exit 0.
  - In 255 cases the agent moved on without the search output. That is a quiet risk of concluding "no matches".
  - About 110 more cases are unmatched existence probes (`ls .env*`).
  - 11 cases come from `echo ===` separators: zsh expands a leading `=word`.
- **Evidence:** 0cde47c4, 14a23cbf, 2dfa52ed, 30f22b49, d627c786 (27 hits).
- **Root cause:** environment (zsh with `nomatch`), and no convention telling agents.

### 2. Long-running commands — about 1,500 Bash-minutes of slow calls

- **Verify is slow:** in eduline-ai-shop, `vfk` summaries show a median of about 7.5 min and a p90 of about 12.5 min. The foreground Bash cap is 10 min.
- **Agents ask for timeouts the cap ignores:** they requested `timeout` 900000 448 times and 1800000 245 times.
- **Cap hits:**
  - 28 calls ran into the cap, then were moved to the background.
  - Agents then often wrote a second `until grep …; do sleep` loop on the task's output file, which can hit the cap too (5963923b ×5, 0cde47c4 ×5).
- **Hand-rolled polling:**
  - 99 Bash wait loops in 36 sessions (about 234 min). 33 of them polled `tasks/*.output` files that already send a completion notification.
  - 24 "Blocked: sleep N followed by …" harness refusals in 23 sessions. The refusal says "use Monitor", but Monitor was used only 28 times in 11 sessions.
  - 428 manual `> log 2>&1 &`/nohup launches, against 375 `run_in_background` calls.
- **Gaps:** long agent-side gaps (95 of them, about 1,100 min) were almost all correct waits on background tasks, ScheduleWakeup or CI.
- **Estimated avoidable waiting:** 150–250 min.
- **Root cause:** no fast inner-loop verify, harness behaviour (the silent 600 s cap), and no CLAUDE.md guidance on background work or Monitor.

### 3. Edit/Write before Read — 72 refusals, 31 sessions

- **How it happens:**
  - In 68 of 72 cases the agent had looked at the file with `cat`, `sed -n` or `grep`, encouraged by auto mode's "read files with cat" guidance. Edit/Write read-tracking doesn't count those.
  - All 30 Write refusals were rewrites of files that already existed.
  - In 3 cases the agent Read the file, then reformatted it with `sed -i`, `prettier --write` or a Python heredoc, then called Edit.
- **Recovery cost:** 2–4 calls each (about 150 in total). In 7 cases the agent gave up and finished the change in Bash.
- **Evidence:** 0cde47c4 (7), 435c122c (6), 2c51bc19 (5), c1f6448e, 2dfa52ed, 9e031df9 (4 each).
- **This session too:** it hit the same refusal once while writing the extraction script.
- **Root cause:** harness behaviour, and no convention.

### 4. `implementation-workspace` misuse — about 45 errors, about 25 sessions

- **No help output:** `--help` is rejected as an invalid argument. That is about 25 calls in 17 sessions; agents then grep `implementation-workspace.mjs` to learn the flags.
- **`publish-media` run from the evidence directory:** `publish-media` runs after `cd <slug>.evidence`, which isn't a git repo, so it fails with `git rev-parse --show-toplevel`. That is 10 in 9 sessions, because session commands resolve the repo from the cwd.
- **The rest:**
  - correct guards: dirty tree, wrong branch, branch changed outside the session
  - one GitHub 5xx on push (d73acc22)
  - one PATH miss before the installer symlink existed, since fixed
- **Root cause:** tool gaps in this repo's CLI.

### 5. Playwright MCP "outside allowed roots" — 14 errors, 13 sessions

- **The conflict:**
  - `rendered-qa` says to write every artifact to `evidenceDir`, under `~/.local/share/opencode/implementation-worktrees/…`.
  - The MCP server (`~/.claude.json`) is started with `--output-dir=/tmp/claude-playwright`. Its allowed roots are that directory plus the client cwd.
  - So the first screenshot of almost every /implement rendered pass fails.
- **Recovery:** agents re-shoot into `/tmp/claude-playwright` and `cp` the files across (28 copy calls).
- **Lost evidence:** in a6b25a05 the agent gave up and the checkout evidence was never captured.
- **Version:** the server runs as `@playwright/mcp@latest`, which is unpinned.
- **Root cause:** tool configuration that conflicts with the skill.

### 6. eduline plan doc too big to read — 26 sessions

- **The doc:**
  - `docs/agent-commerce-mvp.md` is 159 KB in 317 lines, with lines up to 2,367 characters.
  - Its "Decisions" section is 128 KB, all in one section. Phase worktrees carried about 1,000-line versions.
- **How agents read it:**
  - Prompts name specific invariants and decisions, but agents read the doc front to back anyway.
  - Their 200–500-line chunks exceed the Read limit, so they halve the chunk and retry. This happened 7 times, once each in 7 sessions.
  - They then `grep`/`sed` back for single decisions: 5963923b did 6 Reads and 19 Bash reads of this one file.
- **Root cause:** the doc's structure, and the project having no CLAUDE.md.

### 7. Exit status lost through pipes — 247 runs, 57 sessions

- **What happens:** commands such as `npm run verify 2>&1 | tail -20` return tail's exit 0.
- **Harm so far is low:** in 12 sampled cases the agent read the tail and reacted correctly.
- **Two cases with misleading wording:**
  - 85fa2b95 wrote "tests pass… committing" next to "1 failed".
  - 1150f11f wrote "Lint passes" while `tsc` errored.
- **Usage:** `pipefail` appeared 3 times.
- **Root cause:** convention.

### 8. Context compaction — 28 events, 23 sessions

- **When it fires:** 27 of 28 compactions happened right after a delivery message, before the next prompt. Context had grown to 220K–890K tokens during one /implement run.
- **What was lost:** little. Agents resumed with `git status`/`gh run view`, aided by their session-memory notes.
- **The habit behind it:** one session carried a PR plus three follow-ups (a6b25a05: about 21 h, 610 tool calls). In 2dfa52ed a prompt beginning "Fresh session on latest main…" was pasted into an existing session.
- **Root cause:** context limits, and the habit of one session per phase.

### 9. Follow-up rework rounds — 15–18 prompts, 13 sessions

- **Original requests were detailed:** 3K–21K-character specs.
- **Rework sources:**
  - **Known lows deferred (the strongest):** the agent itself flagged an issue as "low" and shipped it (ba80124c dark-mode skeleton; c1f6448e "fix the open low").
  - **Visual polish:** truncation, wrapping, error-red notes, verbose helper text.
  - **Missing safeguards:** f0d34bfe, 0cde47c4.
  - **Live-host behaviour local QA cannot see:** 35c60dd5, a6b25a05.
  - **Scope added later:** b77706a9, 2c51bc19.
- **eduline-shopify-tools** has no `UX_PRINCIPLES.md`; that is where the "too much helper text for staff" round came from.
- **Root cause:** a workflow rule (lows are reported, not fixed) and product judgement that only forms after seeing the result.

### 10. Missing tooling — about 25 sessions

| Missing | Uses | What the agent wanted |
| --- | --- | --- |
| `file` | 12 calls, 11 sessions | Identify the CLI type |
| ImageMagick | about 8 sessions | Compare before/after screenshots |
| Python PIL | 14 cases, about 10 sessions | Crop and diff screenshots |
| `gcloud` | 7 cases, 5 sessions | — |
| `rsync`, `lsof`, `psql`, `column` | 1–3 each | — |

- **Node "Cannot find package" errors:** these are project problems (workspace packages not built, incomplete worktree `node_modules`), not system tooling.
- **Still missing today:** `file`, `column`, ImageMagick, `lsof`, `rsync`, `psql`, `gcloud`, `pip3`, `uv`, PIL.
- **Root cause:** missing tooling.

### Auto-mode denials (not top-10, but one safety note)

- **Classifier rejections (15):**
  - **11 were right:** `gh pr merge`, credential scraping from CLI internals and secret stores, live writes to production APIs, `git reset --hard`, deleting untracked files.
  - **4 look like knock-on false positives** after an earlier credential denial, costing one call each.
  - **Safety note:** in **975faed6** the agent re-sent blocked production probes one at a time, which works around the block.
- **Built-in safety check (5):** all were globbed `rm`, none necessary.
- **Recommendation:**
  - Add **no** broad allow rules.
  - Add a CLAUDE.md rule against working around denials.

## Recommended fixes (ranked by impact ÷ effort)

`AGENTS.md` in this repo is symlinked to `~/.claude/CLAUDE.md`, and the
installer also links it for OpenCode and Codex. Global "CLAUDE.md" text
therefore goes into this repo's `AGENTS.md`. Claude-specific lines (Read tool,
Monitor, `run_in_background`) are marked so you can keep them tool-neutral or
put them in a Claude-only file.

| # | Fix | Lever | Effort | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Quote globs under zsh; set `nonomatch` | AGENTS.md + `~/.zshrc` | S | P1: 386 hits, 77 sessions |
| 2 | Run long work in the background; wait with Monitor; raise the Bash cap | AGENTS.md + settings `env` | S | P2: 28 cap hits, 99 wait loops, 24 blocks |
| 3 | Read before Edit; Write only for new files | AGENTS.md | S | P3: 72 refusals, 31 sessions |
| 4 | Let Playwright MCP write to evidenceDir; pin its version | `~/.claude.json` + `opencode.json` | S | P5: 14 errors, 13 sessions |
| 5 | Add `--help` and cwd-independent session commands to `implementation-workspace` | This repo's CLI | M | P4: about 45 errors, about 25 sessions |
| 6 | eduline-ai-shop CLAUDE.md, and split the Decisions doc | Per-project | M | P6: 26 sessions; 7 read failures |
| 7 | Fix in-scope lows before delivery | `commands/implement.md` + AGENTS.md | S | P9: 15–18 rework prompts |
| 8 | Install missing packages | apt | S | P10: about 25 sessions |
| 9 | Fast inner-loop verify in eduline-ai-shop | Per-project | M | P2: 123 slow verify calls, 546 min |
| 10 | Rendered-QA helper script plus readiness/selector rules | `skills/rendered-qa` | M | 138 `run_code_unsafe` calls, 119 `waitForTimeout`, 15 timeouts |
| 11 | One session per PR round | Request phrasing | S | P8: 28 compactions |
| 12 | Never work around a denial | AGENTS.md | S | 975faed6 |
| 13 | Record the verify exit status explicitly | AGENTS.md | S | P7: 247 runs, 57 sessions |

### Draft AGENTS.md text (fixes 1, 2, 3, 7, 12, 13)

```markdown
## Shell and tool hygiene

- The shell is zsh. Quote every glob passed as an argument
  (`grep --include='*.ts'`, `find . -name '*.md'`) or use `rg -g '*.ts'`;
  an unquoted glob aborts that command segment silently. Never start a word
  with `=` (`echo ===` fails); use `echo '---'`.
- When a verify/test/lint result matters, record its status explicitly:
  `cmd > "$LOG" 2>&1; echo "EXIT $?"; tail -40 "$LOG"`. A pipe such as
  `cmd | tail` reports tail's status, not the command's. Non-zero EXIT is red.
- (Claude Code) Open a file with the Read tool before Edit or Write, even if
  you already saw it via cat/sed; after `sed -i`, a formatter, or a script
  touches a file, Read it again before Edit. Use Write only for new files.
- (Claude Code) Anything that may run longer than ~2 minutes (full verify,
  e2e, deploys, CI watches) goes in `run_in_background`; then end the turn and
  wait for the completion notification. Do not poll its output with a Bash
  loop or a second wait. To wait for a condition, use Monitor with an
  until-loop, never `sleep` in Bash. Timeouts above the Bash cap are ignored.
- Prefer the repository's selective check (e.g. `vfk --changed`,
  `vfk --check <name>`) in the inner loop; run the full gate once at the end.

## Safety

- If a permission check or classifier denies an action, do not retry it in
  pieces, rephrase it, or route around it. Report what was blocked and why it
  was needed, then continue with other work or stop.
- Do not read CLI internals, keychains, or secret stores to obtain
  credentials. Overwrite evidence files rather than deleting them with globbed
  `rm`.

## Delivery

- Before delivering, fix every low or medium finding that is inside the
  task's scope. If a fix would contradict the literal request, ask one
  focused question instead of shipping it as a known low.
```

### Environment and settings snippets (fixes 1, 2, 4, 8)

**`~/.zshrc`** (fix 1; makes unmatched globs and `=word` behave as in bash):

```zsh
setopt no_nomatch no_equals
```

**`~/.claude/settings.json`** (fix 2). Merge into the existing `env` block.
`BASH_MAX_TIMEOUT_MS` lets a full `vfk --all`, which often runs past 10 min,
finish in the foreground when an agent chooses to. Background is still
preferred.

```json
{
  "env": {
    "BASH_MAX_TIMEOUT_MS": "1200000"
  }
}
```

An alternative to the zsh options is `"CLAUDE_CODE_SHELL": "/bin/bash"` in the
same `env` block. Check that your Claude Code version supports it before
relying on it.

**Permissions.** No allow rules are recommended. The denials observed were
correct, and the settings currently have no `permissions` block. If the two
knock-on false positives bother you, these are safe additions:

```json
{ "permissions": { "allow": ["Bash(pgrep:*)", "Bash(ss -ltnp:*)"] } }
```

**Playwright MCP** (fix 4). Apply to the `playwright` server args in
`~/.claude.json` and `opencode.json`.

- **Option A** (simplest): add the flag that lifts the root restriction.
- **Option B** (narrower): change the output dir so evidenceDirs fall under it.
- In both cases, pin the version instead of `@latest`.

```text
npx -y @playwright/mcp@0.0.83 --headless --isolated \
  --executable-path=/usr/bin/chromium --output-max-size=5242880 \
  --output-dir=/tmp/claude-playwright --allow-unrestricted-file-access   # A
# or:  --output-dir=/home/alex/.local/share/opencode/implementation-worktrees  # B
```

Add to `skills/rendered-qa/SKILL.md`: "If a screenshot path is denied, capture
to the MCP output dir and copy it into evidenceDir; never skip evidence."

**Packages** (fix 8):

```bash
sudo apt install file imagemagick python3-pil bsdextrautils lsof rsync
# optional: postgresql-client; google-cloud-cli from Google's apt repo
```

### Optional hook (fix 1, belt and braces)

A PreToolUse hook that blocks an unquoted `--include=*`/`--exclude=*` and
tells the agent why. Save as `~/.claude/hooks/zsh-glob-guard.sh` and make it
executable:

```bash
#!/usr/bin/env bash
cmd=$(jq -r '.tool_input.command // empty')
if printf '%s' "$cmd" | grep -Eq -- "--(include|exclude)(-dir)?=[^'\" ]*[*?]"; then
  echo "zsh: quote the glob, e.g. --include='*.ts' (unquoted globs abort the segment)" >&2
  exit 2
fi
```

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash",
  "hooks": [ { "type": "command", "command": "~/.claude/hooks/zsh-glob-guard.sh" } ] } ] } }
```

With `setopt no_nomatch` in place, the hook is redundant. Pick one.

### Fix 5: `implementation-workspace` (this repo, follow-up PR)

- Accept `--help`/`help`, globally and per subcommand, and exit 0 with usage.
- Make session commands (`publish-media`, `record-evidence`, `publish`,
  `mark-pr`) find the worktree from `--session` metadata rather than
  `process.cwd()`. Failing that, the error should say "run from the
  implementation worktree; `--files` are names inside evidenceDir".
- List the allowed media extensions in the `publish-media` usage text.
- Retry `git push` once with backoff on an HTTP 5xx.

### Fix 6: eduline-ai-shop project instructions

Draft `~/workspace/eduline-ai-shop/CLAUDE.md`:

```markdown
# eduline-ai-shop — agent notes

- Plan and decisions: docs/agent-commerce-mvp.md. Do not read it end to end.
  Run `grep -n '^#' docs/agent-commerce-mvp.md`, then Read only the
  invariants, decisions (Dnn) and phase the task names.
- Verification: `npm run verify` (Verifika, median ~7.5 min). In the inner
  loop use `npx vfk --check <name>` or `npx vfk --changed`; run the full gate
  once, in the background, before delivery. Editing vitest/tsconfig files
  invalidates every check.
- Workspace packages must be built before dependent tests
  (`npm run packages:build`).
```

Then restructure the doc:

- Give each decision its own `### Dnn` heading, or move them to `docs/decisions/Dnn-*.md`.
- Keep a one-line-per-decision index.
- Wrap paragraph-length lines.

For the inner loop:

- Make `deploy:mcp`'s 10 pre-deploy checks selective.
- Look at why config edits invalidate every check.

### Fix 10: rendered-QA helper

- Ship a small script under `skills/rendered-qa/` that agents run via `browser_run_code_unsafe` `filename`. It should do the viewport sweep, write screenshots named `<before|after>-<slug>-<vp>.png`, run the overflow check (`scrollWidth`) and produce a touch-target report. Agents currently rebuild this each session.
- Add these rules to the skill:
  - Confirm the dev build is clean (no `vite-error-overlay`) and wait for a readiness signal, not `waitForTimeout`.
  - Snapshot before guessing selectors.
  - Dismiss overlays when you see "intercepts pointer events".
  - Handle `beforeunload` with `browser_handle_dialog`.
  - Use a 5 s per-action timeout.
- Conventions: add `data-testid` on primary actions, a page-level `*-ready` marker, and `--test-id-attribute=data-testid` on the MCP server.

### Changes to how requests are phrased (fixes 7, 11)

- Start a new session for each PR follow-up round, for example: "Continue PR
  #185 on branch X. Read the PR description first." Don't paste a "fresh
  session" prompt into an existing session.
- When polish matters, state the checks: "Check dark mode in every host theme
  and at 390 px; nothing truncates or wraps." For staff tools: "Staff use this
  for hours; keep helper text minimal." Consider `/ux.principles` for
  eduline-shopify-tools.
- When a prompt names specific decisions or invariants, add "read only those
  sections". Until fix 6 lands, this saves 60–80K tokens per session.

## Method and limitations

- **What the script does:** it parses every top-level JSONL, pairs `tool_use`
  with `tool_result`, and applies regex families. The thresholds live in
  `signals.json`, under `thresholds`.
- **Heuristics:** "near-duplicate" commands use a 0.9 difflib ratio. The verify
  matcher anchors to the start of a shell segment after quoted strings and
  heredocs are stripped. Both are approximate.
- **Not analysed:** subagent transcripts (182 files). Their friction appears
  only indirectly.
- **Small samples:**
  - "Unfinished session" detection is coarse: 5 sessions, 3 of them ended by an interrupt.
  - The near-zero correction count reflects how this user works, not missing data.
- **Privacy:** `signals.json` holds no raw transcript text beyond 100-character
  redacted snippets. Secret-shaped strings are replaced with `[REDACTED]` and
  home paths with `~`.
