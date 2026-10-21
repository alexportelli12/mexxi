---
description: Investigate and implement a request through verified pull request creation
---

# Implement: $ARGUMENTS

Take the request in `$ARGUMENTS` from repository-grounded discovery through a
pull request ready for human product validation. The active session is the task
contract; do not create or persist a planning or requirements artifact.

## Prepare The Isolated Workspace

Before repository discovery or any feature work, run from the launch checkout:

```bash
ibni prepare --slug "<short-request-slug>"
```

Use `--prefix` only when an already-known repository instruction requires a
different branch prefix. The tool checks that the launch checkout is the clean
primary control worktree on the remote default branch, fast-forwards it when
safe, sweeps retained workspaces whose pull requests are proven merged, and
creates a collision-safe feature branch in a dedicated locked worktree. Record
its JSON result in session context, especially `worktreePath`, `sessionId`,
`branch`, `defaultBranch`, `baseSha`, `evidenceDir`, and `cleanup`.

From this point on, run every repository inspection, command, delegated task,
edit, verification, render, review, remediation, and delivery operation against
`worktreePath`, never the control checkout. Pass the exact `sessionId` to later
lifecycle operations; they resolve the owned worktree from session metadata
from any location inside the repository. Write transient evidence to
`evidenceDir`. If preparation fails, report its diagnostic and stop; do not
stash, switch branches, improvise another worktree, or attempt more aggressive
Git recovery.

`prepare` copies gitignored local env files (`.env*`) from the control checkout
and reports them as `provisionedEnv`. Never invent, edit, or commit them.

Apply branch naming requirements already present in launch-time instructions;
if discovery later reveals an incompatible hard requirement, stop rather than
renaming the owned branch outside the lifecycle tool. Prepare dependencies
inside the worktree with the repository's documented setup; do not share or
link mutable dependency directories between worktrees.

## Establish The Task Contract

Before changing code:

1. Confirm that `npm run verify` is available from the repository root. If it
   is not, stop and report that the repository does not satisfy the
   implementation workflow contract; do not add it as incidental feature work.
2. Load `repo-context` when the session lacks a reliable map of the
   repository, its agent docs are thin, or the change spans several areas.
   Skip it for a local change in a well-documented repository.
3. Inspect the affected feature, its closest analogues, architecture, tests or
   behavioural contracts, local instructions, contribution and pull-request
   conventions, and relevant product or UX principles. Use specialist skills
   when their expertise materially improves the work.
4. Derive a concise active contract: goal, requirements, meaningful resolved
   decisions, observable behaviour and experience acceptance criteria, real
   constraints, and relevant edge cases. Omit categories that add no value.

Repository evidence and established product principles are the first source of
answers. Ask the user only about genuine unresolved product behaviour, UX
intent, business rules, architectural choices with product consequences, or
important edge cases that cannot be inferred, and ask the fewest focused
questions necessary. Do not stop for approval of the contract when the request
and evidence are sufficient, and do not ask the user to choose ordinary
implementation details. Keep the contract lean: no generic repository context,
framework tutorials, file lists, implementation steps, or speculative
abstractions.

## Preflight: Green Before Work

Run `npm run verify` in the worktree. If it fails, stop and report the failure;
do not begin implementation or classify failures as pre-existing. The worktree
is retained for diagnosis, and cleanup protects it because no pull request was
recorded.

When the change will alter existing UI, capture before-shots now, while the
worktree is still at `baseSha`: load `rendered-qa` and follow its before-shots
section for the affected routes. Skip this for new UI.

## Implementation

The contract defines intent and scope. Resolve ordinary choices from
repository evidence, keep changes bounded, and avoid unrelated refactors. The
orchestrator owns investigation, delegation, remediation, final verification,
and delivery.

When an acceptance criterion is important, reasonably testable, and supported
by existing test infrastructure, add or update proof at the cheapest level that
meaningfully proves it: unit, component, integration, or E2E. This is
behaviour-first, not test-first; do not add low-value tests to raise coverage.
E2E is risk-triggered: use it only when a criterion crosses boundaries that
cheaper checks cannot prove. If a criterion genuinely requires E2E and the
repository has no suitable infrastructure, stop and report the gap rather than
introducing a framework as incidental work.

Delegated agents may run targeted checks useful to their work, such as a focused
test, typecheck, rendered check, or the repository's selective verification.
They do not own final verification and must not run the full repository
gauntlet. A selective pass is feedback, never a substitute for the final gate.
Where the repository uses Verifika, delegated agents run `vfk --changed` or
`vfk --check <name>`; the `verifika` skill's full run before delivery is the
orchestrator's final `npm run verify`.

## Final Verification

When implementation is settled, use the repository's intentional auto-fix
mechanism if one exists, then run `npm run verify`. This is the authoritative
final deterministic gate. A failure means the implementation is incomplete:
diagnose it from the failing checks' output and logs (the `verifika` skill
covers this where the repository uses Verifika), remediate
implementation-caused failures, and rerun it. Never weaken repository
safeguards to pass. Any later code remediation requires another full
`npm run verify`.

Then re-read the original request and active contract, and inspect the final
diff to confirm the acceptance criteria and scope are covered. This is the
run's requirements re-read; later stages rely on it.

## Rendered QA

For meaningful user-facing work, after final verification load `rendered-qa`
and run a proportional pass on the affected routes and states. That one pass
produces the evidence the reviewer and the pull request use. Resolve its
`critical`, `high`, and `medium` findings before review, rerunning
`npm run verify` and refreshing the affected evidence when code changes. Do not
commit screenshots or pixel baselines, and do not present subjective
judgement as deterministic verification.

## Independent Review

Invoke `code-reviewer` in `discovery` mode when independent judgement
materially improves confidence: substantial behavioural, architectural,
integration, security, maintainability, or meaningful user-facing changes.
Small mechanical changes need no review merely because the agent exists. Run
rendered QA first when applicable.

1. Write a background file in `evidenceDir`, within 8,000 characters: the
   request's purpose, resolved requirements and acceptance criteria, relevant
   repository and UX principles and constraints, and, for confirmation, the
   accepted findings and fixes. Never include implementation transcripts,
   reasoning, self-review, or advocacy.
2. Invoke `code-reviewer` with the worktree, the review target (workspace
   changes against HEAD before the first commit, the branch range once fully
   committed, or only the new changes on follow-up), the background file path,
   verification status, and rendered QA evidence. The reviewer owns the OCR
   delegation mechanics.
3. If the reviewer reports relevant tests or specs excluded from its
   selection, add narrowly scoped `include` rules to the repository's
   `.opencodereview/rule.json`, preserving existing rules, rerun
   `npm run verify`, and invoke the reviewer again. A run halted for coverage
   is not a review pass.

If delegation or rule resolution fails, the review gate is not clear; report
the failure.

## Review Remediation

Investigate every finding with repository evidence; resolve it with a bounded
fix or by establishing that it does not apply. Do not blindly accept subjective
or out-of-scope findings.

`critical`, `high`, and `medium` findings block and must be resolved. `low`
findings are reported, not churned, unless the user asks. Keep a concise
finding ledger in session context only: each finding's severity and
disposition, and the remediation for each blocker.

If discovery has no applicable blockers, the gate is complete. Otherwise, batch
all blocker fixes (delegate only when specialist expertise helps, never to the
reviewer), rerun `npm run verify`, refresh rendered evidence when UI is
affected, and invoke the same reviewer once in `confirmation` mode with the
original requirements, the ledger, a concise remediation summary, the current
diff, verification status, and rendered evidence.

Confirmation checks that each blocker is resolved and that the fixes caused no
material harm; it is not another discovery. A confirmation finding blocks only
when it is an unresolved original blocker, a material regression caused or
exposed by remediation, a correctness or safety issue, or a genuine failure of
the task requirements. A qualifying blocker at confirmation stops the run:
report it to the user with the finding ledger and verification evidence, and do
not deliver. There are at most two reviewer passes: discovery and
confirmation.

## Delivery

Enter only after final `npm run verify`, applicable rendered QA, and
the review gate leave no unresolved blockers.

1. Inspect worktree status and the full diff. Stage only intended changes;
   never commit an unrelated or empty change.
2. Load `commit-pr-writing` and commit with the message it derives. Repository
   conventions take precedence.
3. Run `ibni record-evidence --session "<sessionId>"` to
   record that the committed tree passed the gates.
4. Run `ibni publish --session "<sessionId>"`. It fetches
   the default branch, integrates it safely, and pushes only the owned feature
   branch without force.
5. If `publish` returns `requiresEvidence: true`, follow its `nextAction`. When
   `requiresRevalidation` is also true, prior evidence is stale: rerun
   `npm run verify`, inspect the integration diff, and refresh rendered
   evidence or review only where the upstream change could materially affect
   it. A review refresh is the `confirmation` pass; if that pass is already
   spent, stop and report instead. Commit any remediation, record evidence, and
   publish again.
6. When rendered QA produced screenshots or GIFs, publish the ones the pull
   request should show with `ibni publish-media --session
   "<sessionId>" --files "<comma-separated names in evidenceDir>"` and use the
   returned URLs. First look at every file for secrets, tokens, personal or real
   user data, and internal hostnames, and leave out any that show them: the
   branch may be public, and later cleanup does not erase history. Republish on
   follow-up delivery so the media stays current.
   If media cannot be published, deliver anyway and say why in Evidence.
7. Use `commit-pr-writing` for the pull-request title and description. For
   initial delivery, create the pull request with `gh` against `defaultBranch`.
   For follow-up delivery, update the existing pull request instead of
   creating another. Never merge it.
8. Run `ibni mark-pr --session "<sessionId>" --url
   "<pr-url>"`.

If any delivery stage fails, preserve the worktree and any commit, and report
the failed stage with the tool's diagnostic. Do not bypass permissions, guess
through ambiguous ownership or conflicts, rewrite shared history, force push,
stash, discard work, include unrelated changes, or improvise destructive
recovery.

## Follow-Up On An Existing Pull Request

When this session already owns a retained `worktreePath`, `sessionId`, and
pull-request URL, reuse that workspace instead of running `prepare`; never
infer ownership of another retained worktree. Run
`ibni sync --session "<sessionId>"` before changing
anything, refresh the contract for the new request, and establish a green
baseline. Then follow the normal gates through delivery; publication updates
the existing branch and `mark-pr` records the same URL again.

## Completion

The run succeeds when the pull request is ready for human product validation
and a merge decision. Report briefly:

- the pull-request link;
- `worktreePath` and `branch`;
- unresolved low findings worth knowing during product review;
- the `prepare` cleanup summary: removed workspaces, and kept ones with reasons.

Do not merge. Keep the worktree for follow-up changes in this session.
