---
status: Accepted; its "Strict permissions" point is superseded by 0012 and then 0016
date: 2026-10-22
---

# 0011. segwi: an opt-in launcher for mexxi runs, with a web app and MCP

## Context

A mexxi run takes minutes to an hour, and it stops whenever it needs a reply or a permission. Today someone has to sit at the terminal for that. Running mexxi on a remote machine makes it worse: the run waits on a terminal nobody is watching.

Claude Code's Remote Control lets you follow a Claude Code session from a phone. But it serves only Claude Code, stores transcripts on Anthropic's servers, and offers no interface other tools can call. mexxi supports three hosts ([0001](0001-shared-workflow-host-adapters.md)), and its owner wants other tools to start and follow runs.

## Decision

- Add **segwi**, an opt-in feature, off by default. It starts, follows, answers and stops mexxi runs on a machine you own, from a mobile-first web app and from any MCP client.
- segwi is a **launcher and viewer, not a second workflow.** It starts the host with a fixed action (`/wettaq`, `/lesti`, or a read-only question) on a configured repository. `ibni` still owns worktrees, verify and delivery ([0004](0004-isolated-worktree-per-task.md)), and segwi reads the outcome from `ibni` JSON.
- **One local process** with one SQLite database (`node:sqlite`), bound to loopback. Remote access goes through `tailscale serve`, never Funnel or port forwarding.
- **Runners are host adapters** behind one small interface with a shared contract test suite. Claude Code comes first and OpenCode next.
- **Strict permissions.** The allow list is derived from real runs, so a normal run needs no approvals. Anything else becomes an approval that only a person can answer, in the web app. MCP clients can see approvals but never answer them. mexxi's rules, guard and deny list still apply ([0006](0006-rules-stay-rules-guard-backs-up.md)).
- **Configuration** is one optional `segwi` key in the user's `config.json` ([0002](0002-one-config-rendered-host-files.md)). The installer records the CLI link and the optional systemd units and removes them when segwi is turned off ([0003](0003-installer-owns-what-it-records.md)).
- **The web app shares mexxi's look** through one `site/tokens.css` that the landing page, the docs and the app all import. Its Maltese words come from `names.json`.
- **Maintenance is automated from the start.** Dependency updates arrive as pull requests, CI runs verify on every pull request, and a check audits dependencies. A nightly canary runs against the real host CLI, and a scheduled agent run handles framework major versions. Machines open pull requests; a person merges.

How to set segwi up and use it is in [the user guide](../segwi.md).

## Consequences

- With segwi off, nothing changes for anyone, and an integration test proves it.
- mexxi gains its first runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `web-push`) and a web package with its own lockfile. Their checks must stay within a time budget so verify stays fast for every other change.
- Changes to a host's command-line interface can break a runner. The canary is there to catch that before a user does.
- The web app adds a surface that can start agent runs. Loopback binding, identity checks, caps, audit and human-only approvals bound what it can do.

## Alternatives considered

- **Claude Code Remote Control:** no extra code, but it serves one host only, keeps transcripts off the machine, and gives other tools no interface.
- **A separate repository:** it would keep mexxi's checks lighter, but it would split the design tokens and names, and segwi depends on mexxi's JSON contracts. This is revisited if segwi's checks miss their time budget.
- **A bigger first release** (repository management, richer interface): deferred, so the first version is small enough to maintain.
