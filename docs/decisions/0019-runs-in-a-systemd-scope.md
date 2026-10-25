---
status: Accepted
date: 2026-10-25
---

# 0019. Setup and verify run in a systemd scope where one can start

Extends [0014](0014-ibni-runs-setup-and-verify.md).

## Context

`ibni` ran setup and the verify command as plain child processes. A run sized its pools to every core, competed with the agent sessions on equal terms, and could use any amount of memory. On a measured 8 vCPU machine, swap was already full, so a memory spike went straight to the OOM killer, which may pick an agent session rather than the run. A server or browser that a verify command left behind kept running, and kept its port, after `ibni` reported the result. Nothing recorded what a run cost, so a slow or heavy check could not be found from `ibni stats`.

On Linux with systemd, an ordinary user can start a transient scope. `systemd-run --user --scope` puts a command in its own control group, with its own CPU weight and memory ceiling. Stopping the scope ends every process in it.

## Decision

- **Scoped where possible, plain where not.** Where `systemd-run --user` can start a scope, setup and verify run in one, named `ibni-<setup|verify>-<session>-<random>`. Elsewhere, such as macOS, Windows or a CI job without a user manager, they run as plain children as before, and `scopeReason` says why. `workflow.scope.enabled` turns scopes off.
- **A lower CPU weight, not a cap.** `CPUWeight` is 50 by default, below systemd's 100, so a run gives way to interactive work when the CPU is busy and still uses every idle core. A CPU quota would slow a run even when it is alone.
- **A memory ceiling.** `MemoryMax` is 50% of physical memory by default. Past it the kernel first reclaims the run's cache, then kills the run's largest process, not an agent session. `OOMPolicy=continue` keeps the rest of the scope alive long enough to report it, as `oomKills`.
- **The scope is stopped when the command exits.** The scope counts what is still running in it, such as a test server or a browser. If anything is, `ibni` stops the scope, which ends them within 5 s, and reports `stoppedLeftovers` and `leftoverProcesses`.
- **A scope that cannot start is not a failure.** If systemd starts no scope for a run, the command runs as a plain child instead, and `scopeReason` says so.
- **The cost is recorded.** The scope's peak memory and CPU time are read from its control group before it closes. They go into `resources` in the setup and verify JSON and the recorded verification, and into each verify attempt in `ibni stats`.

## Consequences

- A heavy run slows interactive sessions less, and a runaway one cannot take the machine's memory with it.
- A verify command can no longer leave a server running after it ends. One that relied on that, such as a check that starts a server for a later step, breaks; no known repository does.
- `ibni stats` shows what each verify run cost, so the slots of [0018](0018-machine-wide-run-slots.md) can be tuned from evidence.
- The weight applies among the user's own systemd units. Agent sessions started from a terminal may sit in a different slice, where the weight has less effect.
- The same repository behaves differently on a machine with and without systemd: only the memory ceiling can change an outcome, and only for a run near it.

## Alternatives considered

- **`nice` and `ulimit` instead:** available everywhere, but `nice` does not hold up against control group scheduling, `ulimit -v` breaks Node's address-space reservations, and neither can find or end the processes a run leaves behind.
- **A process group and `kill(-pgid)` to end leftovers:** works without systemd, but a server that calls `setsid` escapes it, and it measures nothing.
- **A systemd service (`systemd-run --wait`) rather than a scope:** the run would leave `ibni`'s own process, and its output would need more plumbing to reach the log. Limits and accounting would be no better.
