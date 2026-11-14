---
description: Investigate and implement a request through verified pull request creation
why: An agent saying it is done is only a claim, and checking its work yourself takes as long as writing it, so this brings back a pull request that has already been checked.
summary: >-
  Use it for any change you would hand to a developer: a feature, a fix, or a follow-up on
  an open pull request. You get one pull request that is tested, checked in a browser when the
  UI changes, reviewed and green in CI, with the decisions it took listed for you. It needs a
  request in plain words, a repository whose `npm run verify` passes, and your answer only
  when a choice is hard to undo or the product direction is unclear.
---

# Implement: $ARGUMENTS

Take the request in `$ARGUMENTS` from repository-grounded discovery to a pull
request whose CI is green. The session is the task contract; write no planning
artifact. When `$ARGUMENTS` is a pull request URL, or continues one, load
`implement-review` and follow its follow-up path instead of `prepare`.

## The Rules Runs Break Most

- **Decide and record.** Make every reversible choice yourself and list it in
  the pull request. Stop only for a one-way door or product direction (see
  **Contract**). Never ask permission for work the request already asks for,
  and never offer a menu of options: pick one and record why.
- **Wait inside the turn.** Never end your turn while a background job you
  started is still running; wait for it, then carry on.
- **View with your read tool before you edit.** Open a file with the host's
  read tool (offset and limit for a long one) before editing it; `cat` or
  `sed -n` output does not count.
- **Claim only checks that ran.** Every "passes" names a run you saw, with its
  result.

## Prepare

Before any repository work, from the launch checkout, run
`ibni prepare --slug "<short-request-slug>"` (`--prefix` only when the
repository requires another branch prefix) and keep its JSON. If it fails, or
the repository requires a branch name it did not make, report and stop; never
switch branches, improvise a worktree or force Git recovery.

From then on, everything runs in `worktreePath`, never the control checkout,
with `sessionId` passed to `ibni` and transient evidence in `evidenceDir`.

- **"Run the verify command"** means `ibni verify --session "<sessionId>"` in
  the background, reading only its final JSON (`passed`, `logPath`, `logTail`).
  A long `queuedMs` is the slot queue, not a hang. Never run `verifyCommand` by
  hand: only a run `ibni verify` recorded on the exact tree can be delivered.
- **A server you start** gets `portEnv` exported and serves on `port`; a second
  server takes another port of the block.
- **Dependencies** come from `prepare`'s `setup`. When `setup.ran` is false,
  install by hand only what the repository documents, and say so in the pull
  request. Run `ibni setup` after a commit that changes a lockfile. Never invent,
  edit or commit the `.env*` files `prepare` copied.

## Contract

1. Confirm `verifyCommand` exists (for `npm run verify`, a `verify` script).
   If not, stop: `/lesti` prepares the repository.
2. Inspect the affected feature, its closest analogues and tests, local
   instructions, pull-request conventions and product or UX principles. Load a
   specialist skill when it changes the work.
3. Derive a lean contract: goal, requirements, resolved decisions, observable
   acceptance criteria, real constraints and edge cases.

Repository evidence and product principles settle questions first. Record
each choice under **Decisions and assumptions**, worded so it is cheap to
reverse. Stop and ask, in one focused message, only for:

- a **one-way door**: a destructive or irreversible data change, a security or
  privacy decision, a public API or schema break, or anything the pull request
  cannot undo; or
- **product direction** that neither the request nor the principles settle.

If nobody answers, take the safest reading, record it as a decision under
**Your part**, and carry on only while the pull request can still undo it.

## Preflight: Green Before Work

Run the verify command once on the untouched worktree: that is the baseline.
With `baseline.reused: true` it records CI's passing run on `baseSha`; cite it.
If the baseline fails, stop and report; never start work or call failures
pre-existing. When the change alters existing UI, take before-shots now
through the rendered-QA subagent, and record `ibni record --session
"<sessionId>" --before-shots taken|skipped`.

## Implementation

Keep the change bounded; the orchestrator owns delegation, remediation,
verification and delivery.

- Load `test-design` before writing any test. If a criterion needs end-to-end
  tests the repository cannot run, stop and report the gap.
- Update the docs that describe a changed behaviour in the same commit.
- Run only targeted checks while working (a focused test, a typecheck,
  `vfk --changed`); the full gate is `ibni verify`.

## Final Verification

1. Stop every server this run started: `ibni verify` refuses while a port of
   the block is bound, and names the holder.
2. Run the repository's formatter and other auto-fix steps.
3. Inspect the diff and commit only intended changes (`commit-pr-writing`).
4. Run the verify command. On failure, diagnose from `logTail` and `logPath`
   (see the `verifika` skill), fix in a new commit and run it again. Never
   weaken a safeguard to pass.
5. Record each QA and review pass: `ibni record --session "<sessionId>"
   --qa <findings>` or `--review <findings> --accepted <fixed>`.
6. Re-read the request and contract against the final diff.

## Rendered QA

For user-facing work, delegate a proportional pass to a subagent that loads
`rendered-qa`; it returns findings with file paths, never images. Fix its
`blocker` and `major` findings before review (commit, verify, refresh the
evidence). Its suggested executable checks go under **Left for later**. Never
commit screenshots.

## Review

Invoke `code-reviewer`, after loading `implement-review`, for substantial
behavioural, architectural, integration, security or user-facing changes;
small mechanical ones skip it. Deliver only when verify, rendered QA and
review leave no unresolved blocker.

## Delivery

1. Everything intended is committed, nothing else, and the last `ibni verify`
   passed on this commit.
2. `ibni record-evidence --session "<sessionId>"`, then `ibni publish
   --session "<sessionId>"`, following any `nextAction`. Verify again only when
   `publish` reports `requiresRevalidation`; then also check the integration
   diff and refresh evidence the upstream change could affect.
3. Publish the screenshots the pull request shows with `ibni publish-media`;
   if that fails, deliver anyway and say why in Evidence.
4. Write the title and description with `commit-pr-writing`, listing steps
   that must run once merged under **After merge**. A change to `verify`,
   `setup` or `ciCheck` in `.mexxi.json` changes the gate: the merge call says
   so.
5. Create the pull request against `defaultBranch` with the CLI `forge` names
   (`gh pr create`, `glab mr create`), or update it on a follow-up. When
   `forge` is null, stop and report `forgeReason`.
6. `ibni mark-pr --session "<sessionId>" --url "<pr-url>"`.

## CI

Run `ibni ci-wait --session "<sessionId>"` in the background and wait for it.

- `green`: update the description's Evidence with CI's result; the run is
  done.
- `failed`: fix the failed jobs from their log tails in a new commit, verify,
  record evidence and publish, then wait again; at most three rounds.
- `none`: the repository runs no pull-request checks; done, and say so.
- `stale`: follow its `nextAction`, then wait again.
- Anything else, or a failure outside scope: report the run as blocked, with
  the jobs and log tails.

If a delivery or CI stage fails, keep the worktree and commits and report the
tool's diagnostic. Do not bypass a permission, guess through ambiguous
ownership or a conflict, rewrite shared history, force push, stash, discard
work, include unrelated changes, or improvise destructive recovery. The guard
hook backs up some of these; what it allows is not thereby permitted.

## Completion

Report the pull-request link and CI state, `worktreePath` and `branch`, the
**Left for later** list and `prepare`'s cleanup summary. The run ends here; do
not merge. Follow-ups, review comments and post-merge steps start in a fresh
session with `/wettaq <pull request URL>`.
