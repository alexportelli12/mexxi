---
status: Accepted
date: 2026-10-25
---

# 0017. Each workspace gets a block of ports, and ibni hands it to setup and verify

Extends [0014](0014-ibni-runs-setup-and-verify.md).

## Context

`ibni prepare` gave each workspace one free port, recorded it and printed it, and the agent was told to serve the app on it. Nothing else saw it. `ibni verify` and setup ran their commands with ibni's own environment, so a repository's test servers fell back to the fixed ports in its own config.

Measured on 2026-10-25 in a web app repository with browser tests: two `npm run verify` runs at once both failed, one on `4392` and one on `8790` ("already used"). The same pair passed 18/18 with distinct ports in four variables the repository already reads. Transcripts since 2026-10-02 show the same error in eight sessions, six of them in that repository. Every collision came from a test server, none from a development server. One port per workspace could not have prevented them, because a verify run starts several servers.

The port was also checked only at `prepare` time, under the repository lock alone. Prepares in two repositories could take the same port, and anything could bind it later.

## Decision

- **A block, not a port.** `prepare` gives each workspace `workflow.ports.blockSize` consecutive ports (10 by default), aligned from `workflow.ports.first`. A block is skipped if it overlaps one a retained workspace holds, in any repository, or if any of its ports is bound. `port` stays the block's first port, so everything that reads it keeps working.
- **One machine-wide lock.** The block is chosen, and the metadata that claims it written, under a lock in `<paths.worktreeRoot>/.ibni/`, so prepares in different repositories cannot take the same block.
- **ibni passes the block on.** Setup and verify get `PORT` (the first port) and `MEXXI_PORT_0` to `MEXXI_PORT_<blockSize-1>`. Any port variable ibni inherited is dropped first, so another workspace's block never leaks into this one's run. `prepare` and `info` print the same variables as `portEnv`, for a server the agent starts by hand.
- **Config maps the variables a repository already reads.** `workflow.portVariables` maps a repository, by its checkout's folder name, to variable names and offsets in the block, such as a test server's `E2E_PORT` at offset 1. ibni sets each one too. A repository's test servers move into the block without a change to the repository, and the mapping is read at each run, so it reaches retained workspaces.
- **verify checks the block first.** `ibni verify` refuses to start, and records nothing, while any port of the block is bound, naming the port. A failed verify then means the checks failed, not that a server lost a race.
- **Older workspaces keep their port.** A workspace recorded with only `port` holds a block of one, and a new block never overlaps it.

## Consequences

- Parallel verify runs in different workspaces no longer collide, as long as each repository's test servers read a variable from the block: one of its own mapped in config, or `MEXXI_PORT_<n>`.
- Only runs through `ibni` get the block. When an agent runs the verify command by hand, its servers still use their fixed ports. Most runs in that repository did so in October 2026. `/wettaq` already sends the full gate through `ibni verify`.
- The default range of 700 ports holds 70 blocks of 10. A machine with more retained workspaces than that needs `ibni cleanup` or a wider range.
- A config whose `workflow.ports` range holds fewer than `blockSize` ports no longer loads, and says so. Narrow it with `blockSize`, or widen the range.
- The machine-wide lock covers creating the worktree as well as choosing the block, so a slow checkout makes other prepares wait. They give up after the same 30 s as the repository lock.
- A development server the agent leaves running on `port` makes `ibni verify` refuse. That is deliberate: the alternative is a verify run that fails for a reason the checks did not find.
- The mapping is per machine, in `config.json`, rather than in the repository. A repository that wants every user to get it can read `MEXXI_PORT_<n>` itself.

## Alternatives considered

- **Keep one port and derive the rest from it**, such as `PORT + 1`: no config is needed. But a derived port could be another workspace's, and every repository would need code for it.
- **Map variables in the repository's `.mexxi.json`:** the mapping would travel with the repository, but every repository would need a change, and one with no stake in mexxi would carry mexxi's keys. A repository can still read `MEXXI_PORT_<n>` directly.
- **Have verify wait for a busy port to free up:** it hides the cause and can wait for ever on a server nobody stops.
