---
description: Open one pull request that makes this repository mexxi-ready, fixing whatever it lacks and any checks that already fail
summary: >-
  Use it once per repository, before your first /wettaq run. You get one pull request that
  adds an `npm run verify` gate, short agent docs and review settings, and fixes the checks
  that already fail. It needs nothing from you up front; where tests are missing it records a
  gap for you instead of inventing them.
---

# Lesti: $ARGUMENTS

Make the current repository ready for mexxi in one pull request: audit it
against the contract below, fix every gap and every failing check, prove the
result and deliver. `$ARGUMENTS` may narrow or steer the work; empty means the
whole audit. Unlike `/wettaq` this cannot demand a green `npm run verify`
first, since establishing one is the job.

`/wettaq` in `commands/wettaq.md` of the mexxi clone (`paths.checkout` in
`~/.config/mexxi/config.json`, default `~/workspace/mexxi`) owns the lifecycle
this command reuses. Read it, and follow its **Prepare The Isolated Workspace**
(use the slug `lesti`), **Delivery** and **Completion** sections as written.
Skip its contract, triage and **Preflight** stages: ignore `baseline`, and do
not stop on a failing verify.

## Audit Before Changing Anything

Gather evidence in the worktree: run `repo-context`'s `scripts/inspect.js` for
the stack, tests and CI, read the package scripts, CI workflows and tool
configs, and run `npm run verify` if it exists to learn what already fails.
Write the gap list to `evidenceDir` before the first edit.

| Requirement | Check |
| --- | --- |
| `npm run verify` | Exists, runs Verifika (`verifika --all`, version pinned exactly), and covers the checks the repository really has: package scripts, CI workflows, tool configs |
| Tests | A test runner is set up and runs. Where there are none, invent none: record it as a gap for a human |
| Agent docs | A short `AGENTS.md`: how to install, run, test and seed the app |
| Review coverage | `.opencodereview/rule.json` includes the repository's test paths |
| Rendered QA (UI repositories) | A documented dev-server command and port (`PORT` honoured); whether a preview deploy exists |
| Baseline reuse | Which CI check runs the full verify, if any |
| UX principles (UI repositories) | `UX_PRINCIPLES.md` exists. If not, suggest `/fassal` afterwards; never invent principles |

## Fix The Gaps

Apply the smallest change that meets each requirement, in the repository's own
conventions. Use the `verifika` skill to wire the gate. A repository without
`package.json` gets a minimal one holding Verifika and the `verify` script. If
a CI check runs the full verify, commit `.mexxi.json` as
`{"ciCheck": "<that check's name as GitHub reports it>"}` so `ibni prepare` can
reuse CI's result; with no such check, write nothing.

Commit in two kinds, setup first: Verifika, `verify`, agent docs and config
come first; then each failing check is fixed in its own commit, so the setup
reads separately from the code fixes.

**Fix, never weaken.** Fix a failure at its cause. Disabling a lint rule,
skipping or deleting a test, loosening types or lowering a threshold is not a
fix. If a failure cannot be fixed without a product decision, ask. In an
unattended run follow `/wettaq`'s **Unattended runs** rule: take the most
reasonable reading, fix it and record it as an assumption; stop and report only
for a one-way door.

## Prove It

From a clean `npm ci` in the worktree, `npm run verify` passes on the branch.
That is what `ibni prepare` followed by `/wettaq`'s preflight would run, so it
is the proof they would succeed; say in the description that baseline reuse
only starts once this PR is merged.

## Review And Deliver

Review is mandatory when the PR contains code fixes, and follows the usual
gate for any other substantial change: load `implement-review` and follow it.
Deliver as `/wettaq` does. The pull-request description lists each gap, what
was added and why, every pre-existing failure with how it was fixed (one line
per commit), every assumption taken in place of a product decision, and what is
left for a human: product principles and tests to write.
