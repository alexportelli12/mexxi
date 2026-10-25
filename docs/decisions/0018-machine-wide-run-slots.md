---
status: Accepted
date: 2026-10-25
---

# 0018. Setup and verify wait for one of a few machine-wide slots

Extends [0014](0014-ibni-runs-setup-and-verify.md).

## Context

[0014](0014-ibni-runs-setup-and-verify.md) moved setup and the verify command into `ibni`, with no limit on how many run at once. Each run sizes its test and build pools to every core, so parallel runs compete for the same CPU.

Measured on 2026-10-25 on an 8 vCPU machine, with a web app repository whose verify command builds and runs browser tests. One run alone took 129 to 153 s. Two at once each took 167 s, 29% longer, and passed. Three at once took 204 to 223 s, and two of the three failed: a unit test hit its 5 s timeout under the load. Running the three two at a time took about 296 s with no failures, against 387 s one at a time. Transcripts showed up to five verify runs in flight at once, mostly from agents that a session handed part of its task to.

## Decision

- **A fixed number of slots for the whole machine.** `workflow.verifySlots` (2 by default) is how many setup and verify runs `ibni` lets run at once, in any repository. Both kinds share the slots, since both load the same CPU.
- **A run beyond that waits for a free slot.** It waits as long as it takes, with no timeout, as setup and verify themselves have none. While it waits, a file in `<paths.worktreeRoot>/.ibni/slots/queue/` names its session and kind, so anyone can see what is queued.
- **The wait is reported.** `queuedMs` in the setup and verify JSON, and in the recorded verification, says how long the run waited. `durationMs` still counts only the run.
- **A slot whose holder died is taken over.** A slot is a lock directory with its owner's process ID, like the repository lock, so a crashed `ibni` never blocks the queue. A takeover checks that what it moved aside was still the dead owner's, and a slot left with no owner for a minute is reclaimed. Waiting runs drop queue entries whose process is gone.
- **Reusing a CI baseline takes no slot**, because nothing runs.

## Consequences

- Gated runs no longer fail from load alone, and two at a time finish sooner than one at a time.
- Only runs through `ibni` take a slot. A verify command an agent runs by hand still competes freely; `/wettaq` already sends the full gate through `ibni verify`.
- `ibni prepare` can take longer, because its setup may wait behind two verify runs.
- An agent may see a verify run start late. `/wettaq` says that is the queue, not a hang.
- The right number depends on the machine and the repositories. Two suits a machine with 8 virtual cores and the measured repository; a bigger machine can raise it.

## Alternatives considered

- **Size pools down instead**, with a CPU quota per run: it slows every run, even one alone, and needs every tool to read the quota.
- **A slot count from the number of cores:** simple, but the measured limit came from one repository's tests, not the core count. A setting with a measured default is honest about that.
- **Fail rather than queue when the slots are full:** the agent would retry in a loop, which is what [0014](0014-ibni-runs-setup-and-verify.md) set out to stop.
