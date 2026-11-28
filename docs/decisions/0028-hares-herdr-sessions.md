---
status: Accepted
date: 2026-11-28
---

# 0028. ħares follows herdr's sessions instead of running its own

Amends [0011](0011-segwi.md), [0013](0013-segwi-run-browser-and-hosts.md), [0016](0016-segwi-runs-trusted-like-own-sessions.md), [0020](0020-segwi-local-extensions.md) and [0027](0027-segwi-reads-github-for-readiness.md). segwi is now called ħares.

## Context

segwi started its own Claude Code processes and watched their output ([0011](0011-segwi.md)). Your real work happens elsewhere: in sessions you start by hand, inside herdr, a terminal workspace manager with a socket API. segwi could not see those sessions, answer their questions or tell you when one stopped. It also carried a runner, an approval MCP server, timeouts and a nightly canary, all to run agents that the person already runs better in a terminal.

A spike against herdr 0.9.5 (protocol 22) and Claude Code 2.1.332 showed that herdr can list sessions, read screens, send keys, spawn panes and push events. It also showed what it cannot do. A pending question's options exist only on screen, and a question and a permission prompt both report "blocked".

The first live gate then tested the unproven cases in a throwaway workspace, with these findings:

- A digit selects a single-choice option, and multi-select toggles with digits and moves to a review step with the right arrow. Several questions in one call advance on a digit, then end at a review step.
- "Type something" takes the digit, then typed text, then Enter. The plan prompt offers auto mode, manual approval and "tell Claude what to change".
- A folder trust prompt has unnumbered options and herdr reports no session id until it is accepted.
- In Code Mode the hook fires for both the outer call and the inner question, with real input.
- A permission request carries no tool-use id. A denied permission leaves its record behind, because no later hook fires.
- herdr's own rule names don't separate questions from permissions, so they can only be a hint.

## Decision

- **herdr is the session source.** ħares lists, reads, answers, steers, starts, ends and resumes sessions through herdr's socket. It no longer starts or watches agent processes. It is the only thing that talks to the socket, locally, and the socket never leaves the machine. It pins the protocol it was built for: on any other protocol it still reads, and it sends nothing.
- **A hook records pending questions and never decides.** The installer adds a Claude Code hook, owned as [0003](0003-installer-owns-what-it-records.md) requires. It writes what was asked to a private file and exits silently, so its output can't be read as a decision. The records give the options that exist only on screen.
- **The guard re-checks before any key.** One module sends keys. It refuses unless the session, terminal and state match what the person saw and herdr's change counter has not moved. The live screen must also still show the record's question and option. The option's position comes from that screen, never from a cache. Any mismatch is a 409 and an audit line.
- **Always allow is a person-only action with a confirmation.** [0011](0011-segwi.md) promised "no allow all". Interactive sessions offer an "always allow" option, so the web app now offers it too, after a confirmation that shows the exact rule or access. MCP, notification buttons and every other path refuse it, and refuse any permission, plan or folder-trust decision.
- **GitHub writes happen in the web app only.** [0027](0027-segwi-reads-github-for-readiness.md) made ħares read-only. A person can now rerun failed jobs, submit a review and merge from the web app. Each goes through their own `gh` login, with a confirmation, a head-commit check on merge and an audit line. ħares's own token stays read-only. No MCP tool imports these writes. Accepting a gate change stays person-only.
- **The audit log keeps 90 days.** It was append-only without limit. Rows inside the window can't be deleted, and older rows are purged. This narrows the earlier promise to append-only for 90 days.
- **The MCP surface is kept and extended, with the same guardrails.** The eight tools keep their names, reply shapes, bearer authentication, audit, Origin check and two-step stop. They now read and act on herdr sessions. Five read-only tools are added: `list_sessions`, `list_prs`, `get_pr`, `list_issues` and `get_ci`. An MCP client still can't decide a permission or add a rule, merge or submit a review, accept a gate change, or edit repositories or limits. `send_input` and `stop_run` reach only sessions ħares started. The server name, the untrusted-text labels and the token prefix stay, so existing clients and tokens keep working.
- **Configuration moves to a `hares` key.** The `segwi` key still loads with a notice, as [0002](0002-one-config-rendered-host-files.md) allows for a rename, and both keys at once is an error. The data folder moves from `mexxi/segwi` to `mexxi/hares` once.

## Consequences

- A session you start by hand shows up in ħares with no setup beyond the hook, and its questions can be answered from a phone.
- Without a running herdr, ħares can read old runs but not sessions, and its health route and Now screen say so.
- Approvals change their source, not their rules. A prompt that is too long to show gets no Allow button and no denial, because a hook can't deny. It waits in the terminal. A prompt has no expiry either, so nothing times out into a denial. Both differ from segwi, in the safe direction.
- The web app can now do more than before: always allow, merge, review. Each is a confirmation away and audited, and the person already holds those powers in the terminal and on GitHub.
- Moving from a rendered screen to keystrokes can break when Claude Code changes its prompts. The guard fails closed and the card says to answer in the terminal. `hares doctor` reports a Claude Code version that ħares wasn't tested with.
- The audit log can no longer prove something happened more than 90 days ago.
- Overlays in the terminal look idle to herdr, so ħares refuses to steer a session that shows one.

## What was retired

- The runner, its contract, the tested-version list and the run timeouts.
- The run and event tables as a source of truth. Old rows stay readable and are never deleted.
- The limits watchdog. The caps stay, counted over the sessions ħares starts.
- The nightly canary and its systemd units. `hares doctor` replaces them, without starting a model.
- The approval MCP server and its internal route, removed after the hook covered every case it handled.

## Alternatives considered

- **Keep the runner and add herdr beside it:** two session models to maintain, and the sessions you start by hand would still be invisible.
- **Retire the approvals tool and the MCP surface:** simpler, but it would drop a tool and guarantees that clients rely on. The MCP surface stays whole.
- **Let the hook decide permissions:** it would answer without a person seeing the call, which is the guarantee approvals exist for.
- **Parse screens only, with no hook:** the options of a question are not reliable to scrape, and a plan's text is only in the hook's record.
- **Keep the audit log append-only forever:** a log that grows without limit on a phone-facing service has no owner for its cost.
