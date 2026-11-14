---
status: Accepted
date: 2026-11-14
---

# 0025. test-design loads the first time a session edits a test

Extends [0015](0015-tests-name-the-break-they-catch.md).

## Context

[0015](0015-tests-name-the-break-they-catch.md) made `test-design` the owner of test judgement, and `/wettaq` tells a run to load it when a change adds, changes or fixes behaviour. Runs skipped it anyway: 24 of the 62 runs that changed tests never loaded it. Those runs wrote the tests 0015 set out to stop, and the reviewer had no simple question to ask of each one.

## Decision

- **A hook tells the agent to load it.** The first time a session edits a test file, a `PostToolUse` hook injects an explicit instruction to load `test-design` before going on. It fires once per session, and never blocks the edit.
- **The reviewer asks one question of each new test:** which bug does it catch? A test with no answer is a finding.
- The installer renders the hook through `scripts/lib/host-hooks.mjs` for every host that can run one, and Codex runs it once it is trusted in `/hooks`.

## Consequences

- Loading `test-design` no longer depends on the agent remembering a sentence it read much earlier.
- A session that edits tests pays for the skill once, even when the edit is small.
- What counts as a test file is a path pattern. A test in an unusual place is missed, and the reviewer's question still applies.

## Alternatives considered

- **Refuse test edits until the skill is loaded:** a hook cannot reliably tell which skills a session loaded, and a refusal would stop legitimate edits.
- **Load `test-design` with `/wettaq` every time:** it would ride on every run, including the many that change no tests.
