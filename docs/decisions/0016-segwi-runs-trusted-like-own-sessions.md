---
status: Accepted
date: 2026-10-24
---

# 0016. segwi runs are trusted like your own sessions

Supersedes [0012](0012-segwi-permission-modes.md), the "Strict permissions" point of [0011](0011-segwi.md), and the sandbox parts of [0013](0013-segwi-run-browser-and-hosts.md) and [0014](0014-ibni-runs-setup-and-verify.md).

## Context

segwi started every run in Claude Code's sandbox, with its own allow, ask and deny lists ([0011](0011-segwi.md), [0012](0012-segwi-permission-modes.md)). Real runs showed what that costs. The sandbox broke checks that pass on the same machine: Chromium, Google Fonts and Firebase's emulators each needed a workaround ([0013](0013-segwi-run-browser-and-hosts.md)). `ibni` grew five environment variables that only segwi set, so that `prepare` could run outside the sandbox and the rest inside. The agent was steered away from shell redirection, `cat`, inline pull request bodies and chained `ibni prepare` calls, and each new shape of command could still stop a run.

Meanwhile the same agent runs on the same machine, as the same user, without any sandbox, whenever its owner types `claude` in a terminal. There, mexxi's rules, its guard hook, its loop breaker and the `guard.deny` list are what keep it in line ([0006](0006-rules-stay-rules-guard-backs-up.md)). The machine is the owner's, and so is everything a run can reach. segwi's sandbox protected that machine from an agent its owner already trusts with it.

## Decision

- **A run is the session you would start by hand.** Build, ready and ask runs start in the repository's checkout with `--permission-mode auto` and your own Claude Code settings. segwi renders no settings file: no sandbox, no allow, ask or deny list. mexxi's guard hook, loop breaker and `guard.deny` apply exactly as in a session you start yourself.
- **An ask run stays read-only, without plan mode.** It runs in auto mode too, with `--disallowedTools Edit,Write,NotebookEdit`, and its prompt says to change nothing. Plan mode stays out, because it let `curl` run unasked and switched to a larger model than `--model` names.
- **segwi keeps what protects it from outsiders.** Loopback binding, the tailnet identity check with its Host allow list, same-origin writes and the MCP bearer token stay. So do approvals only a person can answer and the mark on the run's own browser. Caps, timeouts, the two-step stop, audit, redaction and push stay as they are.
- **The approval tool stays wired** as `--permission-prompt-tool`, for the rare call auto mode escalates after repeated refusals.
- **`ibni` behaves as it does for you.** `IBNI_LAUNCH_CHECKOUT`, `IBNI_LOCK_ROOT`, `IBNI_BRANCH_PREFIXES`, `IBNI_SKIP_SWEEP` and `IBNI_DEFER_SETUP` are gone, and so is the deferred setup they served.
- **The removed settings are retired for one release.** `segwi.permissions`, `segwi.repositories[].permissions`, `segwi.mcpPermissions`, `segwi.branchPrefixes`, `segwi.allowUnsandboxed`, `segwi.allowedDomains` and `segwi.repositories[].allowedDomains` still load. segwi ignores them and warns once, naming each one to delete.
- **The canary checks what still matters.** A real ask run must show every kind of event, show one command from `guard.deny` as a refusal step, and complete.

## Consequences

- A run can do what you can do on this machine, as a session you start by hand can. Branch protection on your default branch and a GitHub token scoped to your own repositories bound what reaches GitHub.
- A command a run runs is a process of yours, so it could reach segwi's port or read its data, as any program you run can. Human-only approvals hold against MCP clients and the run's browser, but they are a check on an agent that follows its rules, not a wall against one that doesn't.
- Checks that pass in your terminal pass in a run, with no per-repository hosts, browser launcher or smoke check to maintain.
- In auto mode a model has the final say on most calls, and it can be wrong either way, as in your own auto-mode sessions.

## Alternatives considered

- **Keep the sandbox and keep widening it:** each repository found a new gap, and every fix either loosened the sandbox or added machinery to maintain.
- **Keep the modes and default to no sandbox:** three code paths to maintain and test, for a protection the owner chose not to use.
