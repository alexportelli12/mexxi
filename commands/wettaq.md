---
description: Investigate and implement a request through verified pull request creation
---

# Implement: $ARGUMENTS

Take the request in `$ARGUMENTS` from repository-grounded discovery through a
pull request ready for human product validation. The active session is the task
contract; do not create or persist a planning or requirements artifact. When the
request continues an existing pull request, load `implement-review` and follow
its follow-up path instead of running `prepare`.

## Prepare The Isolated Workspace

Before repository discovery or any feature work, run from the launch checkout:

```bash
ibni prepare --slug "<short-request-slug>"
```

Use `--prefix` only when an already-known repository instruction requires a
different branch prefix. `prepare` checks the launch checkout, sweeps merged
workspaces and creates the feature branch in a dedicated locked worktree. Record
its JSON result in session context, especially `worktreePath`, `sessionId`,
`branch`, `defaultBranch`, `baseSha`, `evidenceDir`, `port`, `verifyCommand`,
`baseline` and `cleanup`. `verifyCommand` is the repository's verify command:
the `verify` its committed `.mexxi.json` names, or `npm run verify` by default.
Wherever this command says "the verify command", run exactly `verifyCommand`
from the worktree root.

From this point on, run every repository inspection, command, delegated task,
edit, verification, render, review, remediation, and delivery operation against
`worktreePath`, never the control checkout. Pass the exact `sessionId` to later
lifecycle operations (`ibni <command> --help` documents each). Write transient
evidence to `evidenceDir`. Whenever this run starts the app, serve it on `port`
through the repository's own port setting (such as `PORT` or the dev server's
port flag), so parallel worktrees never collide. If preparation fails, report
its diagnostic and stop; do not switch branches, improvise another worktree or
attempt more aggressive Git recovery.

`prepare` copies gitignored local env files (`.env*`) from the control checkout
and reports them as `provisionedEnv`. Never invent, edit, or commit them.

If discovery reveals a hard branch-naming requirement incompatible with the
branch `prepare` made, stop rather than renaming it outside the lifecycle tool.
Prepare dependencies inside the worktree with the repository's documented
setup, and where it documents none for an npm project use
`npm ci --prefer-offline --no-audit --no-fund`. Do not share or link mutable
dependency directories between worktrees.

## Establish The Task Contract

Before changing code:

1. Confirm that the verify command (`prepare`'s `verifyCommand`) exists in the
   repository: for the default `npm run verify`, a `verify` script in
   `package.json`; otherwise the tool or target it names. If it does not, stop
   and report that the repository does not satisfy the implementation workflow
   contract (`/lesti` prepares it); do not add it as incidental feature work.
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
5. Write the request text and the contract to `request.md` and `contract.md`
   in `evidenceDir`, then run `ibni triage --session "<sessionId>"
   --request-file <request.md> --contract-file <contract.md>` once. Triage is
   in shadow: it records Jev's view of the gates for later comparison and
   changes nothing. Decide every gate below exactly as written, whatever it
   prints, and carry on if it reports `skipped` or `failed`.

Repository evidence and established product principles are the first source of
answers. Ask the user only about genuine unresolved product behaviour, UX
intent, business rules, architectural choices with product consequences, or
important edge cases that cannot be inferred, with the fewest focused questions
necessary. Do not stop for approval of the contract when the request and
evidence are sufficient, or ask the user to choose ordinary implementation
details. Keep the contract lean: no generic repository context, framework
tutorials, file lists, implementation steps, or speculative abstractions.

**Unattended runs.** When nobody can answer (a scheduled or non-interactive
run, or a question left unanswered for the session), do not stall. Take the
most reasonable reading from repository evidence and product principles, note
it as an assumption, and carry on. Still stop and report for a one-way door: a
destructive or irreversible data change, a security or privacy decision, a
public API or schema break, or anything the pull request cannot undo. List
every assumption under **Decisions and assumptions** in the pull request,
worded so the reviewer can reverse it cheaply; a question that would have
changed the design becomes a decision under **Your part** instead of a stall.

## Preflight: Green Before Work

When `prepare` returned `baseline.reused: true`, the repository's CI already
passed its full verify on exactly `baseSha`: skip the local run and cite
`baseline` (check, commit, `url`) as the baseline evidence, including in the
pull request's Evidence. For any other `baseline`, run the verify command in
the worktree. If it fails, stop and report the failure; do not begin implementation
or classify failures as pre-existing. The worktree is retained for diagnosis,
and cleanup protects it because no pull request was recorded.

When the change will alter existing UI, capture before-shots now, while the
worktree is still at `baseSha`: load `rendered-qa` and follow its before-shots
section for the affected routes. Skip this for new UI. Record the decision
either way with `ibni record --session "<sessionId>" --before-shots taken` (or
`skipped`).

## Implementation

The contract defines intent and scope. Resolve ordinary choices from
repository evidence and keep changes bounded. The orchestrator owns
investigation, delegation, remediation, final verification, and delivery.

When an acceptance criterion is important, reasonably testable, and supported
by existing test infrastructure, add or update proof at the cheapest level that
meaningfully proves it: unit, component, integration, or E2E. This is
behaviour-first, not test-first; do not add low-value tests to raise coverage.
E2E is risk-triggered: use it only when a criterion crosses boundaries that
cheaper checks cannot prove. If a criterion genuinely requires E2E and the
repository has no suitable infrastructure, stop and report the gap rather than
introducing a framework as incidental work.

Delegated agents may run targeted checks (a focused test, typecheck, rendered
check, or the repository's selective verification) but never the full
repository gauntlet; a selective pass is feedback, not the final gate. Where the
repository uses Verifika, they run `vfk --changed` or `vfk --check <name>`; the
`verifika` skill's full run is the orchestrator's final run of the verify
command.

## Final Verification

When implementation is settled, use the repository's intentional auto-fix
mechanism if one exists, then run the verify command, the authoritative final
gate. A failure means the implementation is incomplete: diagnose it from the
failing checks' output and logs (the `verifika` skill covers this), remediate,
and rerun it. Never weaken repository safeguards to pass. Any later code
remediation requires another full run of the verify command. Record each full run with `ibni record --session
"<sessionId>" --verify pass` (or `fail`), and each rendered QA or reviewer pass
with `--qa <finding-count>` or `--review <finding-count> --accepted <count>
--reviewer same|cross` (`cross` whenever the reviewer's model is from another
family than yours, by whatever route, `accepted` being the findings you fixed); `ibni stats` reports them beside the
lifecycle step timings.

Then re-read the original request and active contract, and inspect the final
diff to confirm the acceptance criteria and scope are covered. This is the
run's requirements re-read; later stages rely on it.

## Rendered QA

For meaningful user-facing work, after final verification load `rendered-qa`
and run a proportional pass on the affected routes and states. That one pass
produces the evidence the reviewer and the pull request use. Resolve its
`critical`, `high`, and `medium` findings before review, rerunning the verify
command and refreshing the affected evidence when code changes. Do not
commit screenshots or pixel baselines, and do not present subjective
judgement as deterministic verification.

## Review

Invoke `code-reviewer` when independent judgement materially improves
confidence: substantial behavioural, architectural, integration, security,
maintainability, or meaningful user-facing changes. Small mechanical changes
need no review merely because the agent exists. When a review runs, load
`implement-review` first: it owns the protocol, remediation and the review gate.
Delivery enters only when the final verify command, applicable rendered QA, and
that gate leave no unresolved blockers.

## Delivery

1. Inspect worktree status and the full diff. Stage only intended changes;
   never commit an unrelated or empty change.
2. Load `commit-pr-writing` and commit with the message it derives. Repository
   conventions take precedence.
3. Run `ibni record-evidence --session "<sessionId>"` to record that the
   committed tree passed the gates.
4. Run `ibni publish --session "<sessionId>"`. It fetches the default branch,
   integrates it safely, and pushes only the owned feature branch without force.
5. If `publish` returns `requiresEvidence: true`, follow its `nextAction`. When
   `requiresRevalidation` is also true, prior evidence is stale: rerun the
   verify command, inspect the integration diff, and refresh rendered
   evidence only where the upstream change could materially affect it (a
   review refresh follows `implement-review`). Commit any remediation, record
   evidence, and publish again.
6. When rendered QA produced screenshots or GIFs, publish the ones the pull
   request should show as `rendered-qa`'s publishing section describes, and use
   the returned URLs. Republish on follow-up delivery so the media stays
   current. If media cannot be published, deliver anyway and say why in
   Evidence.
7. Use `commit-pr-writing` for the pull-request title and description, whose
   first screen gives the merge call, the reviewer's part and the evidence. For
   initial delivery, create the pull request with `gh` against `defaultBranch`.
   For follow-up delivery, update the existing pull request instead of
   creating another. A change to `verify` or `ciCheck` in `.mexxi.json` changes
   the gate itself: call it out in the description's merge call.
8. Run `ibni mark-pr --session "<sessionId>" --url "<pr-url>"`.
9. When rendered QA ended with **Could become executable checks**, write them
   one per line to a file in `evidenceDir` and run `ibni file-qa-checks
   --session "<sessionId>" --from "<file>"`. It files each as a `qa-check`
   issue in the repository, skipping titles already filed. Mention the created
   issues in your report; if it fails (for example `gh` is unauthenticated),
   report that and carry on, since the pull request is already delivered.

If any delivery stage fails, preserve the worktree and any commit, and report
the failed stage with the tool's diagnostic. Do not bypass permissions, guess
through ambiguous ownership or conflicts, rewrite shared history, force push,
stash, discard work, include unrelated changes, or improvise destructive
recovery. The guard hook is a backup for some of these, not their owner: what
it allows is not thereby permitted.

## Completion

The run succeeds when the pull request is ready for human product validation
and a merge decision. Report briefly:

- the pull-request link;
- `worktreePath` and `branch`;
- unresolved low findings worth knowing during product review;
- the `prepare` cleanup summary: removed workspaces, and kept ones with reasons.

Do not merge. Keep the worktree for follow-up changes, in this session or in a
later one through `adopt`.
