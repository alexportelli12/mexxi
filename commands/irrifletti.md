---
description: Measure how recent agent sessions went against the last retrospective, privately
why: Without measuring, you cannot tell whether a change to the workflow made runs better or worse.
summary: >-
  Use it a couple of weeks after you change the workflow, to see whether runs got better. You
  get a private report comparing recent sessions with the last retrospective. It needs only a
  `retro.output` folder outside any public repository; the report never leaves your machine.
---

# Retrospective: $ARGUMENTS

Measure how the agent sessions on this machine went, and compare with the last
retrospective. Run it on demand (suggested: two weeks after a workflow change
lands, and at the end of the Jev shadow period), never on a schedule.

Run from the mexxi clone (`paths.checkout` in `~/.config/mexxi/config.json`,
default `~/workspace/mexxi`), adding to `$ARGUMENTS` only a window
(`--since <date>`, `--until <date>`) or `--exclude <session-id-prefix>` for the
session running this retro:

```bash
node scripts/retro/retro.mjs $ARGUMENTS
```

It reads Claude Code's transcripts, ibni's per-step timings, Jev triage
agreement and review acceptance (same-family against cross-family reviewer),
and writes `retro-<date>.md` and `.json` to `retro.output`. It refuses an
output folder inside a Git repository unless that folder is gitignored there
with nothing tracked in it, so reports never reach a public repository. If it
refuses, report that and stop; do not choose another folder yourself.

Then read the printed goal-signals table and summarise what moved against the
previous retro, which signals missed the targets in its Target column,
and what the ibni numbers add. The report holds transcript-derived text:
quote counts and signal names only, never snippets, and never copy the report
into a repository, pull request or issue.
