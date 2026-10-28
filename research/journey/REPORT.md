# How the workflow became mexxi: what the data shows

This report tests six stories about how my coding-agent workflow grew into mexxi. Each story is checked against 358 agent sessions and the Git history of 12 repositories. Three stories hold in part, one fails as stated, and two cannot be settled from this data.

The summary below quotes the run of 28 October 2026, which covered sessions up to 27 October. `node research/journey/scripts/run.mjs --until <date>` refreshes the tables at the end and `journey-data.json`, but not this summary. [METHOD.md](METHOD.md) defines every number.

## Verdicts

| Story | Verdict | Headline |
| --- | --- | --- |
| H1. Instructions piled up, then shrank | mixed | They moved more than they shrank. Workflow rules in project repositories fell from 118 to 23. Always-loaded rules never shrank, and 34 skills arrived. |
| H2. "Done" claims became reliable | insufficient data | Unverified claims still happen: 6% to 13% of claims in every era. The detector is too noisy to show a trend. |
| H3. Strict lint replaced prose rules | insufficient data | The only dated lint tightening came before the session logs begin, so there is nothing to compare. |
| H4. Verifika cut context noise | mixed | Large check outputs shrank, but most of that drop is the switch from OpenCode to Claude Code. Compactions went up, not down. |
| H5. The problems were environmental | not supported, as stated | Only 5.7% of failed Bash calls had an environmental cause. But the environmental friction that did exist hid in calls that reported success, and tools removed most of it. |
| H6. ibni made parallel work possible | mixed | The daily peak of parallel sessions rose by 31%, and timeouts fell. Port clashes did not fall, but the counts are tiny. |

## What the numbers say

**H1. The backpack moved into mexxi.** In December 2025 one private repository carried 926 lines of slash-command workflow. By August 2026, project repositories held 118 workflow rules between them. Today they hold 23, because that workflow now lives once, in mexxi. mexxi's own workflow text stayed flat, at 106 rules at its peak and 97 now. Always-loaded rules in AGENTS.md and CLAUDE.md files never shrank: they reached 96 on 25 October and stayed there. Meanwhile, the number of concerns a tool enforces across repositories grew from 1 to 25. So the story is "consolidated and backed by tools", not "shrank".

**H2. Agents still claim checks pass without a fresh run.** Across all eras, 6% to 13% of replies that say tests or checks pass come after an edit with no passing check since. A hand check of 25 flagged replies found 7 clear cases, 5 unclear ones and 13 false alarms. That is too noisy to call a trend, so the verdict is insufficient data. The logs also start four days before the first verify script, which leaves no clean "before".

**H4. The context-noise story is mostly a host story.** Across all sessions, the slowest tenth of check runs (p90) put 6.0 KB into context before verifika and 1.8 KB after. Holding the host constant shows a smaller effect: in Claude Code alone, p90 fell from 2.3 KB to 1.8 KB, and the median barely moved (392 to 372 bytes). Compactions per session in Claude Code rose from 0.07 to 0.49. That rise peaked in the verifika week, which held long, multi-phase sessions, so verifika did not reduce compaction.

**H5. Environmental friction was real, but it was not most of the failures.** Of 2,731 failed Bash calls, 155 (5.7%) came from the environment: shell globs, timeouts, busy ports, missing packages or commands. Most other failures were tests and builds failing during normal work, which could mean the agent's mistake or simply work in progress. The bigger environmental story sits outside the failures:

- **Glob aborts.** 392 zsh glob aborts happened in calls that often still exited 0. They fell from 2.6 per 100 tool calls to 0.1 once the command fixer shipped on 21 October.
- **Hidden exit codes.** 422 check runs showed failure in their output while the call succeeded. Those fell from 1.7 per 100 calls in the verifika era to 1.0 and then 0.3.
- **Edits before reading.** These fell from 2.35 per 100 calls in the first era to 0.64 later in OpenCode, and to about 0.4 in Claude Code. Most of the drop came before the host changed.

**H6. More parallel work, as far as four days can show.** The mean daily peak of sessions active at once rose from 1.63 before ibni to 2.14 after. The highest single day was 4 sessions, on 23 October. In Claude Code, timeouts fell from 0.26 to 0.03 per 100 tool calls after port blocks and run slots. Port clashes rose from 0.07 to 0.14 per 100 calls, but that is about 5 events in 4 days, too few to read.

## Surprises

- The single strongest trend is the command fixer: glob aborts dropped by about 95% overnight. That is a tool replacing a rule that was never written down: no AGENTS.md or CLAUDE.md ever mentioned globs or quoting.
- The verify script did not make "done" reliable on its own. The rate of unverified claims is about the same in the ibni era (12.6%) as in the first era (12.1%).
- Pull requests from agent branches merge fast: 232 of 252 merged, with a median of 30 minutes from opening to merge. Only 2 had commits pushed after a GitHub review, because the workflow's own reviewer does not post GitHub reviews. Review rounds therefore cannot be measured from the forge.

## What the data does not show

- **Anything before 20 August 2026 in sessions.** OpenCode's database starts then, Claude Code's transcripts start on 26 September, and Codex has five sessions in October. Earlier milestones come from Git history only.
- **Causes.** Every era changes several things at once: the host (OpenCode until 12 October, Claude Code after), the models, the repositories and the size of tasks. Each comparison names its confounders in `journey-data.json`.
- **Model intelligence.** Nothing here measures how capable a model is; the data can only recognise environmental causes by their error text.
- **When mexxi became public.** GitHub does not record when a repository's visibility changes. The date used is the rename to mexxi and the first docs-site deployment, 21 October.

## Quotes

Each was checked by hand: the reply claims a pass, and the transcript shows no passing check after the last change.

> "Ordering, age, occasion and price specs pass." (15 October 2026; the test run just before printed a failing spec)

> "SE fits and the new layout test passes on both phones." (24 October 2026; the last test run exited with code 1)

> "The header migration is done (11 pages, focused specs green)." (8 October 2026; new files were written after the last test run)

> "Lint and typecheck pass." (16 October 2026; a stylesheet changed after the last lint run)

## Tables

<!-- generated:start (scripts/run.mjs rewrites this block) -->

### Milestones

| Milestone | Date | Repository | Commit |
| --- | --- | --- | --- |
| first-agent-commit | 2025-07-19 | private repo C | 921500f |
| first-instructions-file | 2025-07-18 | private repo B | 73dab84 |
| first-skill | 2026-01-30 | private repo D | 506f0b0 |
| first-verify-command | 2026-08-24 | private repo D | 6e01461 |
| strict-lint | 2026-08-23 | private repo D | 1062fa8 |
| verifika-adoption | 2026-10-13 | eduline-ai-shop | 438d96f |
| worktree-cli | 2026-09-10 | mexxi | b1bc0c0 |
| ibni-first-use | 2026-10-21 | mexxi | 38384e7 |
| port-blocks | 2026-10-25 | mexxi | 37be64b |
| run-slots | 2026-10-25 | mexxi | 2ac58e0 |
| mexxi-public | 2026-10-21 | mexxi | a809607 |

### Verdicts

| Hypothesis | Verdict |
| --- | --- |
| H1-backpack | mixed |
| H2-done-claims | insufficient data |
| H3-lint | insufficient data |
| H4-verifika | mixed |
| H5-environment | not supported |
| H6-parallel | mixed |

### Eras

| Era | Dates | Sessions | Tool calls | Bash failure rate | Glob aborts /100 | Hidden exits /100 | Timeouts /100 | Port clashes /100 | Edit before read /100 | Compactions /session | Median check run | Rework /session | Peak concurrent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| prose-and-scripts | 2026-08-20 to 2026-09-09 | 80 | 9431 | 17.4% | 0 | 0.14 | 0 | 0.1 | 2.35 | 0.14 | 0.7 KB | 0.13 | 2 |
| worktree-cli | 2026-09-10 to 2026-10-12 | 194 | 31711 | 9% | 0.73 | 0.78 | 0.05 | 0.07 | 0.53 | 0.14 | 0.5 KB | 0.18 | 3 |
| verifika | 2026-10-13 to 2026-10-20 | 25 | 5800 | 4.5% | 2.64 | 1.69 | 0.43 | 0.16 | 0.47 | 0.88 | 0.4 KB | 0.4 | 2 |
| ibni-mexxi | 2026-10-21 to 2026-10-24 | 38 | 5276 | 11.3% | 0.11 | 0.97 | 0.36 | 0.09 | 0.49 | 0.32 | 0.3 KB | 0.24 | 4 |
| port-blocks-run-slots | 2026-10-25 to 2026-10-27 | 21 | 3594 | 9.8% | 0 | 0.33 | 0.03 | 0.14 | 0.39 | 0.14 | 0.3 KB | 0.14 | 2 |

### Eras by host

| Era | Host | Sessions | Bash failure rate | Glob aborts /100 | Hidden exits /100 | Compactions /session | Median check run | p90 check run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| prose-and-scripts | opencode | 80 | 17.4% | 0 | 0.14 | 0.14 | 0.7 KB | 14.8 KB |
| worktree-cli | opencode | 136 | 13.5% | 0 | 0.44 | 0.15 | 0.6 KB | 7.3 KB |
| worktree-cli | claude | 58 | 4.5% | 2.53 | 1.62 | 0.1 | 0.4 KB | 2.1 KB |
| verifika | claude | 25 | 4.5% | 2.64 | 1.69 | 0.88 | 0.4 KB | 2 KB |
| ibni-mexxi | claude | 38 | 11.3% | 0.11 | 0.97 | 0.32 | 0.3 KB | 1.5 KB |
| port-blocks-run-slots | claude | 21 | 9.8% | 0 | 0.33 | 0.14 | 0.3 KB | 1.7 KB |

### Backpack: directive rules across all repositories

Always-loaded rules (AGENTS.md, CLAUDE.md, rule files), then workflow rules (commands and agents, loaded per run) and how many of them still sit in project repositories.

```text
date        always-loaded                    workflow (in projects)          tools skills
2025-07-18     9 █                   11 █                ( 11)      1      0
2025-07-19    16 █                   25 ██               ( 25)      2      0
2025-07-31    36 ███                 37 ███              ( 37)      6      0
2025-08-31    39 ███                 37 ███              ( 37)      6      0
2025-09-30    39 ███                 37 ███              ( 37)      6      0
2025-10-31    39 ███                 37 ███              ( 37)      6      0
2025-11-30    50 ████                37 ███              ( 37)      7      0
2025-12-31    64 █████               67 █████            ( 67)      7      0
2026-01-30    55 ████                91 ███████          ( 91)      7     10
2026-01-31    55 ████                91 ███████          ( 91)      7     10
2026-02-28    54 ████                28 ██               ( 28)      7     10
2026-03-31    54 ████                28 ██               ( 28)      8     11
2026-04-30    54 ████                28 ██               ( 28)      8     11
2026-05-31    54 ████                95 ███████          ( 95)      8      2
2026-06-30    54 ████                95 ███████          ( 95)      8      2
2026-07-31    54 ████                95 ███████          ( 95)      8      3
2026-08-23    72 █████              210 ████████████████ (118)      5     11
2026-08-24    69 █████              139 ███████████      ( 46)      6     11
2026-08-31    69 █████              139 ███████████      ( 46)      6     11
2026-09-10    70 █████              145 ███████████      ( 46)     10     25
2026-09-30    70 █████              152 ████████████     ( 46)     15     26
2026-10-13    72 █████              119 █████████        ( 46)     22     35
2026-10-21    87 ███████            122 █████████        ( 46)     23     33
2026-10-25    96 ███████            143 ███████████      ( 46)     25     34
2026-10-27    96 ███████            120 █████████        ( 23)     25     34
```

### Concerns: prose first, tool later

| Concern | First in prose | First in a tool | Repositories with prose now | With the tool now |
| --- | --- | --- | --- | --- |
| run-checks-before-done (verify script) | 2025-07-18 | 2026-08-24 | 7 | 6 |
| formatting (format check in verify) | 2025-07-18 | 2025-07-31 | 2 | 5 |
| code-patterns (lint rule) | 2025-07-19 | 2025-07-31 | 2 | 6 |
| complexity-coverage (coverage or CRAP gate) | 2025-07-18 | 2025-07-18 | 5 | 4 |
| isolated-workspace (ibni prepare) | 2026-08-23 | 2026-09-10 | 2 | 1 |
| ports (ibni port blocks) | 2026-10-21 | 2026-10-25 | 5 | 1 |
| long-runs-and-waits (run slots and Monitor rule) | 2026-10-25 | 2026-10-25 | 1 | 1 |
| shell-quoting-and-exit-codes (command fixer) | n/a | 2026-10-21 | 0 | 1 |

### Peak concurrent sessions by week

```text
2026-W34   1 █████                  18 sessions
2026-W35   2 ██████████             47 sessions
2026-W36   2 ██████████             10 sessions
2026-W37   2 ██████████             18 sessions
2026-W38   3 ███████████████        45 sessions
2026-W39   2 ██████████             77 sessions
2026-W40   2 ██████████             24 sessions
2026-W41   3 ███████████████        28 sessions
2026-W42   2 ██████████             28 sessions
2026-W43   4 ████████████████████   49 sessions
2026-W44   2 ██████████             14 sessions
```

<!-- generated:end -->
