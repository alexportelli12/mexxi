---
status: Accepted
date: 2026-11-14
---

# 0024. Review findings carry a proven severity, and fixes stay bounded

Extends [0007](0007-implementers-implement-reviewers-judge.md).

## Context

Runs got 1.6 times slower in November, and all of the extra time went into review and review fixes. The reviewer graded findings `critical`, `high`, `medium` or `low` with no rule for what earns each grade. In-scope lows were fixed in the same batch, so every review produced a round of polish. Some reviews rewrote the same lines twice, each time with a different preference.

The lows that kept coming back were the same few. Docs were not updated beside a changed behaviour in 27 pull requests, and 15 claimed checks that never ran. Code was left without the repository's formatting in 11, and 16 broke `aria` and label references.

## Decision

- **Four grades, with a rubric in `agent/code-reviewer.md`:**
  - `blocker`: a verified wrong result, security hole or data loss;
  - `major`: a real defect with limited reach, or a missing test;
  - `minor`: an unproven edge case, naming or small duplication;
  - `nit`: style.
- **A blocker or major shows its proof.** It names an input, a call path or a failing test. Without one it drops to `minor`.
- **In-run fixes cover verified blockers and majors.** A minor or nit is fixed only when it sits on lines the run already changed. Everything else goes in the pull request's short **Left for later** list.
- **A loop breaker for review.** If review rewrites the same lines twice, the run stops fixing them and puts both findings and both diffs in the pull request for the person.
- **Repeated lows become rules where they are made:**
  - `/wettaq` updates the docs that describe a changed behaviour in the same commit;
  - `commit-pr-writing` claims only checks that ran, with their result;
  - the auto-fix step runs the repository's formatter before committing;
  - `rendered-qa` runs a scripted `axe` check for `aria` and label references.
- Rendered QA grades its findings on the same four names.

## Consequences

- Review produces fewer in-run fixes, and the ones it does produce are proven.
- Minors outside the change move to the pull request, where the person can choose to ask for them.
- The two-pass limit of 0007 still holds; the loop breaker stops repeated rewrites inside it.

## Alternatives considered

- **Keep the old grades and tighten the definitions:** the old names did not say what proof each needs, and "medium" invited judgement calls.
- **Drop in-run fixes of anything below major:** small fixes on lines already changed are cheap and avoid a second pull request.
