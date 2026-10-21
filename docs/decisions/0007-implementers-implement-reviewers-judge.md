---
status: Accepted
date: 2026-10-21
---

# 0007. Implementers implement, reviewers judge

## Context

An agent that reviews its own work tends to approve it, and a reviewer that also fixes what it finds turns review into another round of implementation. Unbounded review loops cost time and tokens and rarely converge. When implementer and reviewer share a model, they also share its blind spots.

## Decision

- The `code-reviewer` agent judges and never edits. It works from the diff and a short background file with the requirements, not from the implementation transcript or the implementer's reasoning.
- Review runs when independent judgement adds confidence: substantial behaviour, architecture, integration, security or user-facing changes. Small mechanical changes skip it.
- There are at most two passes: discovery, then one confirmation that checks each blocker was resolved. A blocker found at confirmation stops the run and goes to the person.
- The orchestrator checks every finding against repository evidence. Critical, high and medium findings block. Low findings inside the task's scope with a bounded fix are fixed; the rest are listed in the pull request.
- Where the host allows it, the reviewer runs on a model from another family. Claude Code delegates through `ibni cross-review` to `codex exec`; OpenCode renders another model for the reviewer. Codex has one family, so its review is always same-family. The pull request's Evidence says which kind ran.
- Every review ends with a merge-danger call: whether the change is a one-way or two-way door, and its blast radius.

## Consequences

- Review findings are evidence to investigate, never commands to obey.
- A run always ends after two passes, so review can't loop indefinitely.
- Cross-family review needs a second tool installed. Without it the review still runs, and the pull request says it was same-family.
- The retro compares how many findings were accepted from same-family and cross-family reviews, so the extra cost has to show its value.

## Alternatives considered

- **Self-review by the implementer:** cheap, but it approves its own blind spots.
- **A reviewer that fixes its own findings:** fewer hand-offs, but the review is no longer independent.
