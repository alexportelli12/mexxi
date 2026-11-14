---
name: implement-review
description: The independent review gate, review remediation and the follow-up path of /wettaq. Load it when a wettaq run reaches a code-reviewer pass, or when a request continues an existing pull request. Do not load it for runs that skip review.
metadata:
  why: "A review only helps if its findings are fixed and confirmed once, not argued over in an endless loop."
  group: run
---

# Implementation Review And Follow-Up

These stages of `/wettaq` load only when a review runs or a pull request is
continued; `/wettaq` owns everything around them.

## Independent Review

Run rendered QA first when it applies, then invoke `code-reviewer` in
`discovery` mode with:

- the worktree and the review target: workspace changes against HEAD before the
  first commit, the branch range once committed, or only the new changes on a
  follow-up;
- a background file in `evidenceDir`, under 8,000 characters: the request's
  purpose, acceptance criteria, relevant principles and constraints, and for
  confirmation the accepted findings and fixes. Never transcripts, reasoning,
  self-review or advocacy;
- the verify result, the rendered-QA evidence paths, and the `reviewTool` that
  `ibni info` prints (`ocr` or `none`).

With `ocr`, when the reviewer reports relevant tests excluded from its
selection, add narrowly scoped `include` rules to `.opencodereview/rule.json`
(keeping existing ones), run the verify command and invoke it again; a halted
run is not a pass. If OCR delegation fails, the gate is not clear: report it.

The reviewer's latest door and blast-radius call becomes the pull request's
**Merge call**. A pull request whose review is still blocked is not delivered.

## Review Remediation

Check every finding against repository evidence; fix it, or establish that it
does not apply. Fix a finding about tests with `test-design`, seeing each new
or rewritten test fail. Then fix what the reviewer's rubric proves, and no more:

- A verified `blocker` or `major` is fixed in this run. One without its proof
  (an input, a call path or a failing test) counts as `minor`.
- A `minor` or `nit` is fixed only when it sits on lines this run already
  changed.
- Everything else goes under **Left for later** in the pull request.
- **Loop breaker:** when review asks to rewrite lines a review fix already
  rewrote, stop fixing them, and put both findings and both diffs in the pull
  request for the person to decide.

Keep a finding ledger in session context only: severity, proof and
disposition of each finding.

With no verified blocker or major, make any fixes on changed lines, run the
verify command, and the gate is complete. Otherwise batch the fixes (delegating
only for specialist expertise, never to the reviewer), run the verify command,
refresh rendered evidence when UI changed, and invoke the same reviewer once in
`confirmation` mode with the requirements, the ledger, a remediation summary
and the current evidence.

Confirmation checks that each fixed blocker and major is resolved and that the
fixes did no harm; it is not another discovery. Its finding blocks only as an
unresolved original blocker or major, a regression from the fixes, a
correctness or safety issue, or a failed requirement. Such a blocker stops the
run: report it with the ledger and evidence, and do not deliver. There are at
most two reviewer passes.

When `publish` reports `requiresRevalidation`, refresh review only where the
upstream change could matter. That refresh is the `confirmation` pass; if it is
already spent, stop and report.

## Follow-Up On An Existing Pull Request

Follow-ups start in a fresh session: run `ibni adopt --pr "<pr-url>"` instead
of `prepare` and keep its result as you would `prepare`'s. Adopt proves the
workspace belongs to the open pull request, then moves ownership to a new
`sessionId`. If it refuses, report its diagnostic and stop; never take over a
retained worktree any other way.

Read adopt's `pr`, `checks` and `reviewComments` (with the commands it gives)
first: failed checks and unresolved review comments are part of the request.

- **Merged** (`merged: true`): adopt takes nothing over. Run the description's
  **After merge** steps from the control checkout on the freshly pulled default
  branch, never in the retained worktree, and only when that checkout is on the
  default branch with no changes; otherwise ask, and never switch its branch or
  stash. A step only a person may take stays theirs: report it.
- **Open:** run `ibni sync --session "<sessionId>"` first. When the pull request
  was stacked on one that has merged, sync merges the new base and retargets
  it; follow any `stack.nextAction`. Follow `dependencies.nextAction` when
  `dependencies.current` is not true, then run the verify command as the new
  baseline.

Then follow `/wettaq` through delivery and CI, and rewrite the description for
the whole pull request as it now stands rather than appending to it.
