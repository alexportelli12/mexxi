---
description: Investigate and implement a request through verified pull request creation
why: An agent saying it is done is only a claim, and checking its work yourself takes as long as writing it, so this brings back a pull request that has already been checked.
summary: >-
  Use it for any change you would hand to a developer: a feature, a fix, or a follow-up on
  an open pull request. You get one pull request that is tested, checked in a browser when the
  UI changes, and reviewed, with the decisions it took listed for you. It needs a request in
  plain words, a repository whose `npm run verify` passes, and your answers to the product
  questions the code cannot settle.
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
`branch`, `defaultBranch`, `baseSha`, `evidenceDir`, `port`, `portEnv`, `verifyCommand`,
`baseline`, `setup` and `cleanup`. `verifyCommand` is the repository's verify
command: the `verify` its committed `.mexxi.json` names, or `npm run verify` by
default. Wherever this command says "run the verify command", run
`ibni verify --session "<sessionId>"`: it runs exactly `verifyCommand` from the
worktree root on the committed tree, writes the output to a log in
`evidenceDir` and records the result. Run it in the background where your host
supports that, wait for it to finish rather than polling, and read only its
final JSON (`passed`, `logPath`, and `logTail` when it failed). It may first
wait for one of the machine's verify slots (`queuedMs` says how long); a slow
start is that queue, not a hang, so never stop it for that. Never run the
full `verifyCommand` by hand: `record-evidence` and `publish` accept only a
result `ibni verify` recorded on exactly the tree being delivered.

From this point on, run every repository inspection, command, delegated task,
edit, verification, render, review, remediation, and delivery operation against
`worktreePath`, never the control checkout. Pass the exact `sessionId` to later
lifecycle operations (`ibni <command> --help` documents each). Write transient
evidence to `evidenceDir`. `port` is the first of the workspace's block of
ports, and `portEnv` names them all (`PORT`, `MEXXI_PORT_<n>` and any variable
the repository reads that config maps to the block); `ibni` gives them to setup
and verify itself. Whenever this run starts a server by hand, export `portEnv`
and serve the app on `port` through the repository's own port setting (such
as `PORT` or the dev server's port flag), and put any further server on another
port of the block, so parallel worktrees never collide. Stop those servers
before `ibni verify`, which refuses to start while any port of the block is
bound. If preparation fails, report
its diagnostic and stop; do not switch branches, improvise another worktree or
attempt more aggressive Git recovery.

`prepare` copies gitignored local env files (`.env*`) from the control checkout
and reports them as `provisionedEnv`. Never invent, edit, or commit them.

If discovery reveals a hard branch-naming requirement incompatible with the
branch `prepare` made, stop rather than renaming it outside the lifecycle tool.

`prepare` also installs dependencies in the worktree and reports it as
`setup`: the `setup` command in `.mexxi.json`, or the root lockfile's own
install. Do not install them by hand. When `setup.ran` is false, read
`setup.reason`: install by hand only if the repository documents a setup that
`.mexxi.json` does not yet name, and say so in the pull request. Rerun
`ibni setup` after a commit that changes a lockfile. Do not share or link
mutable dependency directories between worktrees.

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

Before the first change, run the verify command once on the untouched
worktree: at `baseSha`, this is the baseline run. When `prepare` returned
`baseline.reused: true`, the repository's CI already passed its full verify on
exactly `baseSha`, so `ibni verify` records that run as `reused` without
running anything; cite `baseline` (check, commit, `url`) as the baseline
evidence, including in the pull request's Evidence. If the baseline fails,
stop and report the failure; do not begin implementation or classify failures
as pre-existing. The worktree is retained for diagnosis, and cleanup protects
it because no pull request was recorded.

When the change will alter existing UI, capture before-shots now, while the
worktree is still at `baseSha`: load `rendered-qa` and follow its before-shots
section for the affected routes. Skip this for new UI. Record the decision
either way with `ibni record --session "<sessionId>" --before-shots taken` (or
`skipped`).

## Implementation

The contract defines intent and scope. Resolve ordinary choices from
repository evidence and keep changes bounded. The orchestrator owns
investigation, delegation, remediation, final verification, and delivery.

When the change adds, changes or fixes behaviour, load `test-design`. It
decides which tests the change needs and at what level, and how to see each
one fail. Use the repository's existing test infrastructure. If a criterion
genuinely requires E2E and the repository has no suitable infrastructure, stop
and report the gap rather than introducing a framework as incidental work.

While working, you and delegated agents run targeted checks (a focused test,
typecheck, rendered check, or the repository's selective verification)
directly, but never the full repository gauntlet; a selective pass is
feedback, not the final gate. Where the repository uses Verifika, run
`vfk --changed` or `vfk --check <name>`. Only the orchestrator runs the full
gate, and only through `ibni verify`.

## Final Verification

When implementation is settled, use the repository's intentional auto-fix
mechanism if one exists. Then inspect the diff, stage only intended changes and
commit them (load `commit-pr-writing` for the message), because `ibni verify`
refuses a tree with uncommitted or untracked work. Then run the verify command,
the authoritative final gate. A failure means the implementation is
incomplete: diagnose it from the result's `logTail` and the log at `logPath`
(the `verifika` skill covers reading it), remediate in a new commit, and run it
again. Never weaken repository safeguards to pass. Any later code remediation
requires another commit and another run of the verify command. `ibni verify`
records each run itself. Record each rendered QA or reviewer pass with
`ibni record --session "<sessionId>"` and `--qa <finding-count>` or
`--review <finding-count> --accepted <count> --reviewer same|cross` (`cross`
whenever the reviewer's model is from another family than yours, by whatever
route, `accepted` being the findings you fixed); `ibni stats` reports them
beside the lifecycle step timings.

Then re-read the original request and active contract, and inspect the final
diff to confirm the acceptance criteria and scope are covered. This is the
run's requirements re-read; later stages rely on it.

## Rendered QA

For meaningful user-facing work, after final verification load `rendered-qa`
and run a proportional pass on the affected routes and states. That one pass
produces the evidence the reviewer and the pull request use. Resolve its
`critical`, `high`, and `medium` findings before review, committing the fix,
rerunning the verify command and refreshing the affected evidence when code
changes. Do not
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

1. Inspect worktree status and the full diff. Everything intended is
   committed; never commit an unrelated or empty change.
2. The last `ibni verify` passed on the current commit. If anything was
   committed since, run the verify command again first.
3. Run `ibni record-evidence --session "<sessionId>"` to record that the
   committed tree passed the gates. It refuses with `requiresVerify: true` and
   a `nextAction` when `ibni verify` has not passed on exactly this tree:
   follow it.
4. Run `ibni publish --session "<sessionId>"`. It fetches the default branch,
   integrates it safely, and pushes only the owned feature branch without force.
5. If `publish` returns `requiresEvidence: true`, follow its `nextAction`. When
   `requiresRevalidation` is also true, the integration changed the tree and
   prior evidence is stale: run the verify command (`ibni verify`) on the
   integrated tree, inspect the integration diff, and refresh rendered
   evidence only where the upstream change could materially affect it (a
   review refresh follows `implement-review`). Commit any remediation and
   verify again, then record evidence and publish again.
6. When rendered QA produced screenshots or GIFs, publish the ones the pull
   request should show as `rendered-qa`'s publishing section describes, and use
   the returned URLs. Republish on follow-up delivery so the media stays
   current. If media cannot be published, deliver anyway and say why in
   Evidence.
7. Use `commit-pr-writing` for the pull-request title and description, whose
   first screen gives the merge call, the reviewer's part and the evidence. For
   initial delivery, create the pull request against `defaultBranch` with the
   forge's CLI (`gh pr create` on GitHub, `glab mr create` on GitLab); the
   `forge` field of `prepare` or `ibni info` names it. When `forge` is null,
   stop and report its `forgeReason` rather than guess. For follow-up delivery,
   update the existing pull request instead of creating another. A change to
   `verify`, `setup` or `ciCheck` in `.mexxi.json` changes the gate itself: call
   it out in the description's merge call.
8. Run `ibni mark-pr --session "<sessionId>" --url "<pr-url>"`.
9. When rendered QA ended with **Could become executable checks**, write them
   one per line to a file in `evidenceDir` and run `ibni file-qa-checks
   --session "<sessionId>" --from "<file>"`. It files each as a `qa-check`
   issue in the repository, skipping titles already filed. Mention the created
   issues in your report; if it fails (for example the forge's CLI is
   unauthenticated), report that and carry on, since the pull request is
   already delivered.

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
