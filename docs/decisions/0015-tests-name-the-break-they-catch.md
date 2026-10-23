---
status: Accepted
date: 2026-10-23
---

# 0015. Every test names the break it catches

## Context

`/wettaq` asked for proof "at the cheapest level" for important, testable criteria, and warned against low-value tests, in one short paragraph. Nothing owned the judgement behind that rule. Agents added tests that pass whatever the code does. They asserted on their own mocks and restated constants and types. They computed the expected value the way the code does, or checked a log line instead of the behaviour. Some repositories now hold hundreds of tests, and nobody can tell which ones protect anything.

The guidance that did exist was spread across `/wettaq`, `workflow-for-alex` and the Angular skill's testing reference. None of them said how to decide whether a change needs a test, which break a test catches, or how to prove that a test can fail. The reviewer judged "tests" with no criterion to apply.

## Decision

- **One skill owns test-design judgement.** `test-design` decides whether a behaviour earns a test, the break each test catches and its level, how to see each test fail, and whether an existing test is worth keeping. Framework skills keep only their technique and point to it.
- **Every test names its break.** Before writing a test, the agent names the production change that should turn it red, and whether that change would be a bug or a deliberate decision.
- **No test is better than a bad one.** Behaviour with an independent source of truth gets a test. What types or lint prevent, trivial units, wiring, config and copy do not.
- **Each new test is seen failing for its named reason.** Test-first is welcome, not required. A bug fix's test goes red on the unfixed code. The two-edit check follows: break the behaviour and the test goes red; change only the internals and it stays green.
- **The reviewer applies the same check.** When a change adds or changes tests, or adds behaviour that should have one, `code-reviewer` loads `test-design` and judges each test by the two-edit check.
- **The pull request reports breaks, not coverage.** It lists the break each new test catches and how it was seen failing, and what was deliberately left untested. A coverage percentage is not evidence.
- **Auditing reports; a person approves deletions.** Audit mode judges a bounded area of an existing suite and gives each test a verdict with evidence. Deletions and rewrites go in their own pull request for a person to approve.

## Consequences

- Runs write fewer tests, and each one can be traced to a break it catches.
- Seeing each test fail costs a focused test run per test, and a temporary edit to the code when the test came after it.
- The pull request's details grow by one line per new test.
- Nothing mechanical checks any of this yet. Mutation testing could back the two-edit check in a repository that wants it, in that repository's own verify command.

## Alternatives considered

- **Mandatory test-first, deleting code written before its test:** it proves a test can fail, but costs a rewrite and adds nothing that seeing the test fail does not.
- **A coverage threshold:** it measures which lines ran, not which breaks would be caught, and rewards exactly the tests this decision removes.
- **Keeping the guidance in each framework skill:** the generic judgement would be written three times and drift apart, and a change with no framework skill would get none.
- **Letting audit mode delete tests directly:** faster, but a wrong deletion removes protection silently, inside an unrelated change.
