---
description: Measure how recent agent sessions went against the last retrospective, privately
why: Without measuring, you cannot tell whether a change to the workflow made runs better or worse.
summary: >-
  Use it a couple of weeks after you change the workflow, to see whether runs got better. You
  get a private report comparing recent sessions with the last retrospective. It needs only a
  `retro.output` folder outside any public repository; the report never leaves your machine.
---

# Retrospective: $ARGUMENTS

Measure how the agent sessions on this machine went, and compare with an
earlier retrospective. Run it on demand (suggested: two weeks after a workflow
change lands), never on a schedule.

Run from the mexxi clone (`paths.checkout` in `~/.config/mexxi/config.json`,
default `~/workspace/mexxi`), adding to `$ARGUMENTS` only a window
(`--since <date>`, `--until <date>`), `--baseline <report>` when the user names
the retro to compare with (a `retro-*.json` path, or its stem such as
`retro-2026-11-10-2132`, found in `retro.output`; without it, the latest one),
or `--exclude <session-id-prefix>` for the session running this retro:

```bash
node scripts/retro/retro.mjs $ARGUMENTS
```

It reads Claude Code's transcripts and counts interactive sessions only:
skill-creator eval runs and sessions under a temporary directory (canary
runs) are left out and reported as counts by reason. It adds ibni's runs
from live workspace metadata and from the run log
(`<paths.worktreeRoot>/.ibni/runs.jsonl`, which outlives cleanup): outcomes,
CI green at the first wait or after fixes, step times, verify attempts and
review acceptance. It writes `retro-<date>.md` and `.json` to `retro.output`.
It refuses an output folder inside a Git repository unless that folder is
gitignored there with nothing tracked in it, so reports never reach a public
repository. If it refuses, report that and stop; do not choose another folder
yourself.

Then read the printed goal-signals table and summarise what moved against the
baseline it names, which signals missed the targets in its Target column,
and what the ibni numbers add. If it says the baseline counted every session,
compare rates with care. The report holds transcript-derived text: quote counts
and signal names only, never snippets, and never copy the report into a
repository, pull request or issue.
