---
status: Accepted
date: 2026-11-14
---

# 0022. Retire Jev triage and cross-family review

Supersedes [0008](0008-jev-shadow-metadata-only.md). Amends [0007](0007-implementers-implement-reviewers-judge.md).

## Context

Two experiments ran beside every `/wettaq` run, and neither showed its value.

- **Jev triage** ([0008](0008-jev-shadow-metadata-only.md)) asked an outside decision model which gates a change needed, and only recorded its answers. It added a step to every run, a third-party call and its own config, schema and tests. No run ever changed because of it.
- **Cross-family review** ([0007](0007-implementers-implement-reviewers-judge.md)) ran Claude Code's reviewer on a Codex model through `ibni cross-review`, and rendered another model for OpenCode's reviewer. Across 88 runs from 21 October to 14 November, cross-review never delegated once. Each run still read the instructions for it, and each pull request explained why it had not run.

Runs got 1.6 times slower in November, all of it in review and review fixes. Machinery that never pays off makes that cost worse.

## Decision

- `ibni triage`, its Jev client, its tests, the `jev` config group and the triage step of `/wettaq` are removed. `/irrifletti` no longer reports Jev agreement.
- `ibni cross-review`, `crossFamilyReviewer` on every host and the `--reviewer same|cross` option of `ibni record` are removed. The reviewer runs on the model `models.<host>.reviewer` names, or the host's own model. That setting can still name a model from another family on a host that offers one.
- From [0007](0007-implementers-implement-reviewers-judge.md), the cross-family point and its Evidence line are withdrawn. Everything else in 0007 still holds, with the changes in [0024](0024-review-severity-and-bounded-fixes.md).
- An old `config.json` that still sets `jev` or `crossFamilyReviewer` loads. The keys are dropped and the installer names each one to delete, until the shim is removed.

## Consequences

- Every run loses a step, and the always-loaded instructions lose the passages about both experiments.
- Nothing measures whether a reviewer from another family would catch more. A later experiment would need its own decision and evidence.
- Repository text no longer leaves the machine during a run.

## Alternatives considered

- **Keep both, off by default:** cheaper to keep than to remove, but the instructions and tests still cost every run and every change to ibni.
- **Promote Jev past shadow:** there was no data showing its answers beat the agent's, which [0008](0008-jev-shadow-metadata-only.md) required first.
