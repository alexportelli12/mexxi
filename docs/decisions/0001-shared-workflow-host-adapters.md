---
status: Accepted
date: 2026-10-21
---

# 0001. One shared workflow, thin host adapters

## Context

mexxi runs under three coding agents: OpenCode, Claude Code and Codex. Each has its own folders, file formats and way of loading commands, agents, skills and hooks. Copying the workflow into each host's format would let the three drift apart, and a fix in one would not reach the others.

## Decision

- The workflow has one canonical copy: `AGENTS.md`, `commands/`, `agent/` and `skills/`. Every host reads these same files.
- Anything only one host understands lives in that host's adapter: `claude/` (the overlay, agent fields and mods), `codex/` (agent fields) and `opencode/` (its config and guard plugin).
- Adapters carry host mechanics such as models, tool permissions, sandbox modes and file formats. They never carry workflow rules.
- Rules that only make sense on one host go in that host's overlay, not in the shared files. The Claude Code overlay is the current example.
- Host files are generated from the canonical copy and the adapters (see [0002](0002-one-config-rendered-host-files.md)). Nobody edits them by hand.

## Consequences

- A workflow change is made once and reaches all three hosts on the next install.
- Adding a host means writing one adapter and one renderer, not a fourth copy of the workflow.
- Shared files must stay host-neutral. A rule that names one host's tool, such as Claude Code's Read tool, belongs in that host's overlay.
- Some host features have no equivalent elsewhere: Claude Code's mods, or Codex's single model family for review. The docs say where behaviour differs, rather than pretending it is the same.

## Alternatives considered

- **A full copy of the workflow per host:** each copy would be easier to tune, but they would drift, and every change would cost three edits.
- **Supporting one host only:** simpler, but it would tie the workflow to one vendor's release cycle and pricing.
