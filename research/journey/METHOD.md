# Method

This page defines every number in `journey-data.json` and REPORT.md: where it comes from, how it is counted and where it goes wrong. Without the definitions, a reader cannot tell a real trend from a counting artefact.

## Running it

```sh
node research/journey/scripts/run.mjs --until 2026-10-27
node --test research/journey/scripts/journey.test.mjs
```

`run.mjs` reads this machine's session stores and the Git repositories under `~/workspace`. It clones `constitution-explained` into `~/.cache/mexxi-journey`, reads pull requests with `gh`, and writes `journey-data.json` and the generated block of REPORT.md. `--offline` skips GitHub. `--until` drops sessions that start after that day; leave it out to include today. A full run takes about a minute.

Before writing, every output passes a leak scan (`scanForLeaks`). It runs mexxi's secret patterns (`scripts/lib/redact.mjs`) and refuses home or temp paths, email addresses, IP addresses, cloud hostnames and the name of any repository not cleared for publication. If anything matches, the run stops and writes nothing.

## Sources and coverage

| Source | Where | Sessions on disk | Analysed | Dates |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | 465 | 142 | 26 Sep to 27 Oct 2026 |
| OpenCode | `~/.local/share/opencode/opencode.db` | 222 top-level | 216 | 20 Aug to 12 Oct 2026 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 5 | 5 (timing only) | 2 Oct to 10 Oct 2026 |

- **Top-level sessions only.** Subagent transcripts are left out, as `scripts/retro/session_retro.py` does. Checks a subagent ran are invisible to its parent.
- **Exclusions.** Sessions with no tool calls (283 Claude Code sessions, mostly headless runs and title-only stubs) are left out. So are sessions whose working directory is under `/tmp`: segwi canaries and test fixtures.
- **Retention.** Claude Code keeps transcripts for `cleanupPeriodDays` (90 here). The oldest on disk starts on 26 September, so nothing older survives. Session data before 20 August 2026 does not exist; earlier milestones come from Git only.
- **Codex** is read for start, end, working directory and tool-call count. Five sessions did not justify a third full parser, so Codex counts towards concurrency only.
- **Repositories.** Every Git repository under `~/workspace`, plus `alexportelli12/constitution-explained`. That repository is taken to be constitutionofmalta.com: no repository by that name exists, and this one is the public Maltese-constitution app with a CLAUDE.md. coding-agent-config is mexxi's old name, so its history is mexxi's.
- **Repository labels.** Repositories not named in the brief become "private repo A", "B" and so on, lettered by first commit date so the letters are stable. Their commit hashes are published for milestones, and left out of per-snapshot backpack rows.

## Matching sessions to repositories

A session belongs to the repository its working directory is in. That covers checkouts under `~/workspace/<name>` and worktrees under mexxi's, OpenCode's and coding-agent's worktree roots, with the `-<10 hex>` suffix removed. A second checkout named `<repo>-<suffix>`, such as `mexxi-upgrade`, maps to `<repo>`. Any other name maps to `unknown` (10 sessions): the code holds no table of private names, and the deleted checkouts behind these sessions can no longer be looked up. Sessions in the home directory or in host config directories are labelled `home` and `global-config`.

## Milestones

Each milestone is the earliest match across all repositories.

| Milestone | Rule |
| --- | --- |
| first-agent-commit | First commit with a `Co-Authored-By: Claude/Codex/OpenCode` or "Generated with Claude/OpenCode" trailer. Unattributed agent commits are invisible. |
| first-instructions-file | First commit adding any AGENTS.md or CLAUDE.md. |
| first-skill | First commit adding any SKILL.md. |
| first-verify-command | First commit whose package.json diff adds a `"verify":` script. |
| strict-lint | First commit to an ESLint config whose subject says it hardens, tightens or makes lint strict. Only one repository says so in words. |
| verifika-adoption | First `verifika.config.json` outside verifika itself. |
| worktree-cli | First commit of mexxi's `scripts/implementation-workspace.mjs`, ibni's predecessor. |
| ibni-first-use | First commit of `scripts/ibni/`, plus the first session that ran `ibni prepare`, `verify` or `publish`. |
| port-blocks, run-slots | The commits adding decisions 0017 and 0018. |
| mexxi-public | The commit adding the docs site, the day of the rename to mexxi and the first GitHub Pages deployment. GitHub keeps no record of visibility changes, so this is the earliest public evidence, not the switch itself. |

## Eras

Eras run from one milestone to the day before the next, by the session's start date in UTC: prose-and-scripts (20 Aug), worktree-cli (10 Sep), verifika (13 Oct), ibni-mexxi (21 Oct), port-blocks-run-slots (25 Oct). The host changed at the same time: the first era is all OpenCode, the second is mixed, and the last three are all Claude Code. The "Eras by host" table separates them.

## Backpack

The backpack is what an agent carries in instructions. For each repository, at every month end and milestone date, `run.mjs` reads the tree at the last commit before that day and counts the following.

- **instructions**: directive lines in AGENTS.md, CLAUDE.md, `.github/copilot-instructions.md`, `.cursorrules` and `.claude/rules/*.md`. These files are always loaded. A directive line contains always, never, must, do not, don't, avoid, prefer, only, make sure, ensure, should, instead of, or "before you/any/the/making/changing/editing". Headings and code fences are skipped.
- **instructionLines**: non-blank lines in the same files.
- **workflowRules, workflowLines**: the same counts for slash commands and agent definitions (`commands/`, `agent/`, `.claude/commands`, `.opencode/command`). These load when a command runs, not always. `projectWorkflowRules` excludes mexxi, so it shows what still lives in project repositories.
- **skills, skillDescriptionWords**: SKILL.md files outside evals and tests, and the words of their `description:`. A host keeps every skill's description in context, so this is the always-loaded part of a skill.
- **lintErrorRules**: occurrences of `"error"` or `: 2` in ESLint configs, a rough count of rules set to error.
- **movedToTools**: how many of the tracked concerns below a tool enforces in that repository at that date.

Global instructions have lived in mexxi's own AGENTS.md since August 2026. Before that, they sat in the hosts' config directories, outside Git, and have no history.

### Tracked concerns

| Concern | Found in prose by | Enforced when |
| --- | --- | --- |
| run-checks-before-done | "run ... tests/lint/checks/verify/build", "before saying ... done" | package.json has `verify`, or verifika.config.json exists |
| formatting | "prettier", "format ... code/files" | `verify` runs a format check, or any script runs `prettier --check` or `format:check` |
| code-patterns | "any type", "no console", "import order", "explicit types", "naming convention", "OnPush", "standalone components" | an ESLint config sets at least one rule to error |
| complexity-coverage | "coverage", "complexity", "CRAP" | any script mentions crap or coverage |
| isolated-workspace | "worktree" | mexxi has the worktree CLI or ibni |
| ports | "port" | mexxi has decision 0017 |
| long-runs-and-waits | "run_in_background", "sleep", "long-running", "poll" | mexxi has decision 0018 |
| shell-quoting-and-exit-codes | "glob", "quote", "pipefail", "exit code" | mexxi has the command-fixer mod |

**Known errors:** mexxi's tools serve every repository but are counted only in mexxi's row. A prose match can be incidental: any mention of a port counts as the ports concern.

## Per-session metrics

Rates in eras and weeks come from totals (sum of events ÷ sum of tool calls × 100), not from averages of session rates. Medians and p90s are nearest-rank, so each is a value that was measured.

### Shared with the retro

These use the patterns in `scripts/retro/session_retro.py`, copied into `lib/patterns.mjs`. A test fails if a copy drifts. On the retro's own window (Claude Code, 26 September to 20 October, 90 sessions), this code reproduces its figures exactly. Those figures are 386 glob aborts in 77 sessions, 73 refused edits, 27 Bash cap hits, 247 hidden exit codes, 15 follow-ups and 28 compactions. [Where the problems come from](../../docs/where-the-problems-come-from.md) says 89 sessions and 72 edits, because it left out the session that ran it.

| Metric | Definition |
| --- | --- |
| globAborts | Bash outputs matching the zsh pitfall pattern (`(eval):N: no matches found` and similar), whether or not the call failed. Per 100 tool calls. OpenCode runs bash, so it never shows them. |
| hiddenExitCodes | Bash calls whose command matches the retro's check pattern (npm test, vitest, tsc, eslint, verify...) and exited 0, but whose output shows failure (`FAIL`, `N failed`, `error TS`). Per 100 tool calls. |
| bashFailureRate | Failed Bash calls ÷ Bash calls. A call fails when the tool reports an error or its output starts with `Exit code N` (Claude Code), when OpenCode's exit code is non-zero, or when it is a hidden exit code. |
| timeouts | Failed Bash calls whose cause lines match the timeout pattern or that ran 595 seconds or more (the Bash cap), counted once per call. Per 100 tool calls. `bashCapHits` separately counts every call that ran that long, failed or not. |
| missingPackages, commandNotFound | Failed Bash calls whose cause lines match the retro's patterns. Cause lines are the first 4 and last 6 lines that read like an error. |
| compactionsPerSession | Claude Code `compact_boundary` entries and OpenCode `compaction` parts, per session. |
| correctionsPerSession | Prompts under 1,500 characters matching the retro's correction pattern ("no", "wrong", "I said", "still broken"), unless they are follow-ups. |

### New in this research

| Metric | Definition |
| --- | --- |
| portClashes | Tool outputs mentioning `EADDRINUSE`, "address already in use", "port N is already in use" or Playwright's "is already used". Per 100 tool calls. |
| environmentalFailures | Failed Bash calls caused by a timeout, missing package, missing command, glob abort or port clash. |
| failingRetries | Exact repeats of one command, run 3 or more times with at least 2 failures; one per command per session. The retro also merges near-duplicates (90% similar), so it counts more. |
| editBeforeRead | Edits to a file the session had not read, written or edited before. It counts by structure, so it works for OpenCode too; the retro counts Claude Code's refusals instead (`editRefused` here). |
| toolOutputBytes | UTF-8 bytes of every tool result in a session. The median and p90 are across sessions. |
| checkRunBytes | UTF-8 bytes of the output of each foreground check run (see "What counts as a check"). This is what reached the agent's context, after any `tail` or `grep` the agent added. |
| reworkPromptsPerSession | Prompts after a reply that claimed the work was done ("done", "implemented", "PR is open", or a checks-pass claim), which ask for rework. They match the correction pattern, a follow-up, or fix, redo, still, again, broken, missing, forgot or revert. |
| maxConcurrentSessions | The highest number of sessions active at once on any day of the period. A session is active from one event to the next while the gap stays under 30 minutes. Spans are cut at midnight UTC. |
| meanDailyMaxConcurrent | The mean of each day's peak. |

### Unverified "done" claims

A **claim** is a sentence in an agent reply that names a check (tests, specs, checks, verify, lint, typecheck, build, gate, suite) followed within 40 characters by pass, passed, green, succeeds or "is clean". "All green" also counts. A sentence is not a claim when it:

- negates or hedges: not, n't, never, fail, until, once, before, if, whether, should, will, would, could, may, might, then, but, except, or 'll;
- reports history: baseline, preflight, previously, earlier, on main;
- reports a partial count, such as "5 of 6";
- is a table row.

A claim is **unverified** when no check has passed since the last edit. That means one of these, after the last edit:

- **A foreground check exited 0.** It counts only if its output shows no failure (exit N, N failed, error TS, npm ERR!, `fail N`).
- **A background check finished.** Its later `<task-notification>` must report completed with exit code 0.
- **A passing result was read back.** A Read, or a Bash call that is not itself a check, showed one: ibni's JSON with `"passed": true`, verifika's `PASS N/N`, node:test's `fail 0`, Vitest's `Tests N passed (N)`, Karma's `TOTAL: N SUCCESS`, or two or more ✓ lines with no ✗.
- **ibni reused a passing CI run** for the base commit.

An **edit** is a successful Edit or Write, or a Bash call that edits files: `python3 -` or `node -` with a heredoc, `sed -i`, `perl -i`, a redirect into a source file, `git apply`, or `git restore`. Edits under `/tmp`, scratchpads, `.evidence` folders, `.claude` and memory files, and pull-request body files do not count.

**What counts as a check:** the retro's check pattern, plus `ibni verify`, `ibni record-evidence`, `node --test`, `ng test|lint|build`, binaries in `node_modules/.bin`, `npx` with flags, `node <script>` whose name contains verify, check, build or test, and `git diff --check`. Leading `VAR=value`, `timeout N`, `fnm exec` and `env` prefixes are ignored. CI polling (`gh pr checks`) is not a check: it exits 8 while checks are pending, which would read as a failure.

**Measured precision.** After the last change to these rules, a hand check of 25 randomly drawn flagged claims found 7 genuinely unverified and 5 unclear. The other 13 were false positives, so precision is 28% to 48%. Earlier rounds, before the rules were tightened, found 5 to 8 of 25. The false positives come from:

- check runners the rules do not know (firebase emulators, supabase test, custom scripts);
- claims about delegated work, which subagents verify out of sight;
- honest reports a sentence-level rule cannot separate, such as "The build passes" when a different check is failing.

That is why H2 is forced to insufficient data.

**unverifiedDoneRate** is unverified claims ÷ claims. At most one claim counts per reply.

## Comparisons and verdicts

Each comparison splits sessions at a milestone and compares one metric. Where a tool was adopted per repository (verify script, lint, verifika), the split is within the repositories that adopted it. A session counts as "after" from its own repository's adoption date, and repositories that never adopted the tool are left out. Machine-wide tools (ibni, port blocks) split all sessions by date. Comparisons marked "Claude Code only" hold the host constant.

A comparison's **reading** is:

- **insufficient data**: either side has fewer than 20 sessions, or a value is missing;
- **no change**: the relative change is under 10%;
- **improved**: the change is at least 25% in the hypothesis's direction;
- **slightly improved**: the change is 10% to 25% in that direction;
- **worse**: any change of 10% or more against it.

A hypothesis is **supported** when every usable comparison improved, and **not supported** when none improved or slightly improved. It is **mixed** otherwise, and **insufficient data** when no comparison is usable or the metric is too noisy (H2).

- **H1** compares each backpack series at its peak with its latest value, instead of a before and after.
- **H5** has no comparison. It is supported if environmental causes explain at least half of the failed Bash calls.

None of this shows cause. Every era changed the host, the models, the repositories and the tasks together, and each hypothesis lists its confounders in `caveats`.

## Pull requests

`gh api graphql` pages through every pull request in each repository with a GitHub remote. Agent pull requests are those whose branch starts with `agent/`, `opencode/`, `claude/` or `codex/`. For each one, the run records:

- whether it merged, and the hours from opening to merge;
- its number of commits;
- its submitted GitHub reviews;
- the commits made after its first review.

The workflow's own reviewer does not post GitHub reviews, so review counts are near zero, and review rounds cannot be read from the forge.

## Quotes

`scripts/quotes.json` is hand-picked, not generated. Each quote comes from a reply the claim detector flagged as unverified. Each was confirmed by reading the tool calls before it: a failing run, or an edit with no check after. Each is anonymised and under 25 words. A refresh keeps them as they are.

## What was left out

- No transcript text, file contents, prompts, titles or pull-request bodies are published: only counts, sizes, dates and the four quotes.
- The private repositories' names are replaced by letters. Their session counts and milestone commits remain.
