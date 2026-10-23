---
name: test-design
description: Decide which tests a change needs and write tests that can actually fail. Load it before writing, rewriting, reviewing or deleting any test, including fixing a bug that needs a regression test, deciding which changes need a test at all, tests for new behaviour, pinning behaviour before a refactor, judging whether tests assert on mocks or copy the code's own formula, and keep, rewrite or delete verdicts on an existing suite. Do not use to configure a test runner or Playwright, to fix a failing verify run, for rendered QA, or to write pull-request copy.
metadata:
  why: "Agents write tests that pass whatever the code does, so a green suite with hundreds of tests can still protect nothing."
  group: run
---

# Test Design

A test earns its place only if a real break in the behaviour it claims would
turn it red. This skill owns that judgement: whether a change needs a test,
which break each test catches and at what level, the proof that each can fail,
and whether an existing test is worth keeping. Framework technique, such as
Angular test setup or Playwright selectors, stays with its own skill and the
repository's conventions; repository evidence outranks this skill
(`workflow-for-alex` gives the precedence).

Prefer no new test over a bad one. A test that cannot fail costs maintenance,
slows the suite and makes the next reader trust something that protects
nothing.

[`references/examples.md`](references/examples.md) has a short bad and good
pair for each rule below. Read it when a rule's meaning is unclear for the code
in front of you.

## 1. Does It Earn A Test?

- **Important behaviour with an independent truth gets a test.** A rule from
  the request, a spec, a domain fact or a bug report says what the right
  answer is, independently of the code, and a regression in it would matter
  to a user or a caller.
- **What types or lint already prevent is left to them.** Do not test that a
  field exists, a function returns the declared type or a required argument is
  required.
- **Trivial units are tested through their consumer.** Getters, constants,
  simple delegation and plain data holders get no test of their own; the
  behaviour that uses them proves them.
- **Wiring, config and copy get no test.** A route table, a provider list, a
  feature-flag value or a sentence of UI text restated in a test is a change
  detector. Test the behaviour the wiring produces, at a level that sees it,
  only when that behaviour earns a test on its own.

Say what you deliberately leave untested and why; it goes in the report (§5).
When the repository has no runner for the level a break needs, record that
gap (§5) and do not add a test framework as incidental work.

## 2. Plan From Named Breaks

Before writing a test, name its break: the production change that should turn
it red. Then say whether that change would be a **bug** or a **deliberate
decision**. A test that goes red on a deliberate decision, such as a renamed
label or a reordered call, is a change detector; drop it or aim it at the
contract instead.

Find the breaks from:

- each acceptance criterion in the task contract;
- the failure classes those criteria imply: boundaries and off-by-one, empty
  and missing input, invalid input, error and timeout paths, permissions,
  ordering, concurrency and duplicate events, state that persists across
  steps;
- for a bug fix, the bug itself.

For each break:

1. **Pick the seam**: the public interface a caller uses. Use the highest seam
   that still sees the break cheaply; never reach past it into private
   functions or fields.
2. **Pick the cheapest level that sees the break**: unit, component,
   integration or end-to-end (E2E). A date-formatting rule is a unit test; a
   flow that crosses pages or services may need E2E.
3. **One break, one level.** Do not prove the same break again at every
   layer. E2E stays risk-triggered: use it only when the break crosses
   boundaries that cheaper levels cannot see.

Decide what to replace with a test double by the kind of dependency:

| Dependency | Example | In the test |
| --- | --- | --- |
| In-process | Pure functions, domain objects, in-memory collaborators | Use the real thing |
| Local and substitutable | Database, file system, a local queue | A real local instance or in-memory substitute the repository already uses |
| Remote and owned | Your own other service or API | A double at the client boundary, matching the real contract |
| True external | Payment provider, email, clock, randomness | A double, fake clock or fixed seed |

Before mocking a method, list what the real one does (writes, events,
returned state) so the double does not quietly drop a side effect the
behaviour depends on.

## 3. Write Tests That Can Fail

- **Drive the real interface.** Call what callers call; render what users see.
- **Use literal or spec-derived expectations.** Write `expect(total).toBe(90)`,
  not `expect(total).toBe(price * (1 - discount))`. An expected value
  computed the way the code computes it is a mirror assertion: it agrees with
  any bug.
- **Assert the contract, no less and no more.** Assert the outcome the
  behaviour promises. Asserting less (it "was called", it "is defined") lets
  wrong behaviour pass; asserting more (exact call order, internal state, a
  whole snapshot) breaks on harmless changes.
- **Mock only at boundaries**, as the table above says. A mock earns an
  assertion only when the call it stands for is itself the contract, such as
  "the charge request is sent once with this amount". Do not assert that a
  mock returned what you told it to return.
- **Pair every "not called" or "absent" assertion** with a case where the call
  happens or the thing is present, so the assertion can tell the two apart.
- **Verify through the interface, not a side channel.** Read the result the
  way a caller would, not by peeking at a log line, a private field or the
  database row behind an API that has its own read path.
- **Keep tests deterministic.** Control time, randomness, ordering and
  network; no real sleeps, no shared mutable state between tests.
- **No test-only production code.** Do not add a method, export, flag or
  branch to production code that only a test uses.
- **Name tests after capabilities**: "applies the loyalty discount to orders
  over €100", not "calls calculateDiscount" or "works".

Use the repository's runner, assertion style, file layout and helpers.

## 4. See Each New Test Fail

Every new or changed test must be seen going red for its named reason. Run
only the focused test for this; the full verify command belongs to the
command running the task.

- **Test-first** is welcome, not required: write the test, see it fail for
  the named reason, then make it pass.
- **Test-after:** apply the named break to the production code, run the test,
  see it go red with a message that names the break, then restore the code.
  Never commit the temporary break.
- **Bug fix:** the test must go red on the unfixed code. If the fix is already
  written, revert it, see red, then restore it.
- **Refactor:** pin the current behaviour first. The pinning tests pass before
  and after; no new failure proof is needed for behaviour that did not change.

Then apply the **two-edit check** to each test:

1. **Break the behaviour** it claims to protect: it must go red.
2. **Change only the internals** (rename a private helper, reorder independent
   steps, swap an equivalent algorithm): it must stay green.

A test that fails the first edit protects nothing; rewrite or drop it. A test
that fails the second is a change detector; aim it at the contract. Where the
second edit is impractical to make, reason it through and say so.

A test that fails for the wrong reason (a setup error, a missing import, a
typo) has not been seen failing.

## 5. Report What The Tests Prove

Record, for the pull request's evidence:

- each new or changed test, the break it catches, and how it was seen
  failing (test-first, a temporary break, or the unfixed code);
- what was deliberately left untested, and why (§1);
- any break that needed a level the repository has no infrastructure for,
  which is a gap, not a detail.

`commit-pr-writing` decides where this goes and how it is worded. A coverage
percentage is not evidence: it shows which lines ran, not which breaks would be
caught.

## 6. Review Tests

When judging tests someone else wrote, as `code-reviewer` does:

- For each new or changed test, name the break it claims and run the two-edit
  check in your head against the code: what production change would turn it
  red, and does a harmless internal change keep it green?
- Report a test that cannot fail for its claimed break, a mirror assertion, a
  mock that earns no assertion, an unpaired "not called" check, a side-channel
  check and test-only production code.
- Report an acceptance criterion with an independent truth and no test that
  sees its break, and a test the change made redundant ("replace, don't
  layer": once an interface test covers a break, a shallower test of the same
  break should go).
- Do not ask for tests §1 says to leave out, or for a higher level than the
  break needs.

## 7. Audit An Existing Suite

Use audit mode when asked whether existing tests are worth keeping. It reports
only; it never edits or deletes tests.

1. **Bound the area**: one feature, module or test file at a time, never the
   whole suite at once. Say what the area is and what was left out.
2. For each test, name the break it claims, apply §1 and §3, and run the
   two-edit check: mentally, or with a temporary break when a verdict depends
   on it. Restore every temporary edit.
3. Give each test one verdict with its evidence:

   | Verdict | When |
   | --- | --- |
   | keep | It catches a named break no other test catches, at a sensible level |
   | rewrite | It aims at a real break but cannot fail for it, or breaks on internals |
   | merge | Several tests prove the same break; name the one to keep |
   | delete | It protects nothing (§1 or a failed first edit), or an interface test already catches its break |
   | unsure | The evidence does not settle it; say what would |

4. Report the verdicts as a table with the test's name and path, the claimed
   break, the verdict and the evidence. Every delete names what, if anything,
   still catches the break.

Deletions and rewrites from an audit go in their own pull request for a person
to approve, never folded into feature work.
