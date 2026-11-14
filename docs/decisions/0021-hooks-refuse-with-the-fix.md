---
status: Accepted
date: 2026-11-14
---

# 0021. Hooks refuse with the fix; they never rewrite

Extends [0006](0006-rules-stay-rules-guard-backs-up.md).

## Context

The command fixer, a Claude Code mod, rewrote a shell command on its way to the tool: it quoted globs, added `set -o pipefail` and moved a full verify run into the background. Claude Code's auto mode reviews each command before it runs. A command changed after that review is no longer the one it approved, so auto mode refused it and asked for the same call again. That forced 217 retries across 88 runs from 21 October to 14 November.

The same retros counted other avoidable failures that no hook caught:

- test, lint or verify output piped into `tail`, `grep` or `head` without `set -o pipefail`, so a failure read as a pass (184 cases);
- `until` or `while` loops around `sleep` holding the foreground (351 in 52 runs, 151 of them waiting for a development server's URL);
- files read with `cat`, `head`, `tail` or `sed -n` and then edited, which Claude Code refuses because the file was never opened with its Read tool (72 of 79 such refusals);
- a full verify run by hand, which `ibni` will not accept as evidence ([0014](0014-ibni-runs-setup-and-verify.md)).

## Decision

- **No mexxi hook changes a command.** A hook either lets a command through or refuses it, and the refusal names the fix: the corrected command, or the tool to use instead.
- **The checks move into the guard, and the command fixer is removed.** There is one canonical guard for every host, which Codex runs once it is trusted ([0001](0001-shared-workflow-host-adapters.md)). It already backs up written rules ([0006](0006-rules-stay-rules-guard-backs-up.md)). A second, Claude-only mod would split the same job in two.
- **What it refuses, with the fix it names:**
  - an unquoted `--include=`, `--exclude=` or `find -name` glob that zsh expands or aborts on: the quoted form, one option per brace entry;
  - test, lint or verify output piped into `tail`, `grep` or `head` without `pipefail`: the same line after `set -o pipefail;`;
  - a full verify run by hand inside an `ibni` worktree: `ibni verify --session <id>` in the background;
  - an `until` or `while` loop around `sleep` in the foreground of Claude Code's Bash tool: the same loop with `run_in_background`, which reports once when the wait ends. Monitor is for a stream of events, such as each matching log line;
  - a plain `cat`, `head`, `tail` or `sed -n` of a file inside the worktree, on hosts with a read tool: that tool, with an offset and a limit. `grep` and `rg` stay allowed.
- **A rule that needs one host's tool applies only on that host.** The installer renders the guard's hook entry with the host's name, through `scripts/lib/host-hooks.mjs`. Codex has no read tool and no Monitor, so it keeps reading and waiting through the shell.
- **These refusals are help, not red lines.** The rules they back up live in `/wettaq` and the Claude Code overlay. Like the red lines, they stay rules where the guard cannot see.

## Consequences

- Auto mode reviews exactly the command that runs, so a refused command costs one corrected call instead of a forced retry.
- The guard grows from red lines into everyday command hygiene. Its tests assert each refusal's text, so the fix it names cannot drift from what the agent should do.
- A refusal the agent disagrees with is still a refusal: it rewrites the command as named, or reports why it cannot.
- `guard.blockUnquotedGlobs` and the `command-fixer` mod are retired. An old config that names them loads, and the installer says to delete them.

## Alternatives considered

- **Keep the command fixer, rewriting only before auto mode reviews:** the hook order is the host's, not mexxi's, so the fix would depend on a detail mexxi cannot control.
- **Keep the command fixer as a mod that never rewrites:** it would repeat the guard's command parser for one host and leave Codex and OpenCode without the checks.
- **Prose only:** the rules already said most of this, and the retros counted the misses.
