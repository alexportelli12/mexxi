---
status: Accepted
date: 2026-10-21
---

# 0006. Rules stay rules; deterministic layers back them up

## Context

The workflow's governance prefers deterministic enforcement to prose: a check that cannot be argued with beats a sentence an agent may forget. The guard hook was added for the Git and production red lines. But a review found real bypasses, Codex skips new hooks until they are trusted, and the instructions had started to describe the guard as if it owned the rules. If the docs present the guard as the owner of a rule rather than its backup, an agent can conclude that anything the guard misses is allowed.

## Decision

- Red lines are written as rules in `AGENTS.md` and `/wettaq`. Never merge, force push or push to the default branch. Never rewrite published history, discard work you did not make, or work around a denial.
- Deterministic layers back those rules up, from the agent's side outwards:
  1. the guard hook, which checks each proposed command;
  2. the host's own permission deny list;
  3. GitHub branch protection on the default branch, set in each repository's settings rather than by mexxi.
- Wherever the docs mention the guard acting on a rule, they call it a backup. `check-config` fails a sentence that makes the guard the owner of a rule, or that claims a hook runs on every host without naming Codex's trust step.
- The guard fails closed: if it cannot load or cannot read a command, it refuses. Gaps it knows about are listed in `scripts/hooks/guard.mjs`.
- The command fixer mod and the loop breaker only help the agent. Neither one is allowed to change a rule.

## Consequences

- A bypass in the guard is a bug to fix, not a hole in the rules.
- The always-loaded instructions keep the red lines, which costs some context in every session.
- Each layer catches what the others miss: branch protection holds even if an agent finds a command the guard does not parse.
- The wording check can fail `verify` on ordinary prose. That trade is accepted for these claims only.

## Alternatives considered

- **The guard as the single owner of the red lines:** less prose, but it trusts a command parser to understand every shell construction.
- **Prose only:** no false positives, but nothing catches the moment an agent improvises.
