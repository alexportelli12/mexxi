---
sources:
  - commands/wettaq.md
  - skills/implement-review/SKILL.md
  - skills/rendered-qa/SKILL.md
  - skills/commit-pr-writing/SKILL.md
  - skills/test-design/SKILL.md
  - scripts/ibni/commands/prepare.mjs
  - scripts/ibni/commands/publish.mjs
  - scripts/hooks/guard-rules.mjs
  - scripts/hooks/loop-breaker.mjs
  - docs/decisions/*.md
  - config.schema.json
  - scripts/ibni/commands/record-evidence.mjs
  - scripts/ibni/commands/cross-review.mjs
reviewed: 2026-10-25
---

# The ideas behind mexxi

Coding agents can now take a whole task and hand back a pull request. Writing the code is no longer the slow part; trusting it is. mexxi rests on seven ideas that move the checking from you to the run, and leave you the decisions.

Each idea starts with the problem, then says what mexxi does about it and what you will notice. The decision record linked from each one gives the full reasoning. [Decisions](decisions/index.md) lists every record.

## Each task gets its own copy of the repository

An agent working in your checkout trips over your own unfinished work. It switches branches under you, leaves files changed, and two tasks at once collide on the same files and the same dev-server port.

Before any work starts, `ibni`, the command-line tool the agent runs, makes a [worktree](glossary.md#worktree): a separate copy of the repository on a new branch. It gets its own block of free ports, which its install, its checks and its servers all use. Every later step happens there.

Your checkout stays exactly as you left it, and you can run several tasks side by side, checks included. [Decision 0004](decisions/0004-isolated-worktree-per-task.md) and [decision 0017](decisions/0017-workspace-port-blocks.md)

## A pass/fail command defines "done"

An agent will say "done, all tests pass" whether or not it ran them. A claim can be talked around; a command that passes or fails cannot.

Each repository has one [verify command](glossary.md#verify), `npm run verify` by default: your tests, linters and build in one pass/fail run. It must pass before work starts, so an old failure is never blamed on the change, and again at the end. `ibni` runs it itself and records the exact code it passed on. `ibni` refuses to push any other code, so a change made afterwards has to be checked and recorded again. That holds in a [segwi](segwi.md) run too, which runs the verify command as your own terminal does.

The pull request's evidence line starts with `verify ✓`. If the repository's checks were already failing, the run stops and tells you instead of building on top of them. [Decision 0010](decisions/0010-repository-names-its-verify-command.md) and [decision 0014](decisions/0014-ibni-runs-setup-and-verify.md)

## Every test names the break it catches

A passing check is only as good as its tests. Agents write tests that pass whatever the code does: they check their own fake objects, restate a constant, or work out the expected answer the same way the code does. A repository can collect hundreds of them, and nobody can tell which ones protect anything.

Before writing a test, the agent names the bug it should catch, and tests only behaviour with a right answer it can check. It watches each new test fail for that reason before making it pass. Breaking the behaviour must turn the test red; tidying the code underneath must not. This is the [two-edit check](glossary.md#two-edit-check). The [reviewer](#a-second-reviewer-judges-the-work) checks the same two things. See [test-design](../skills/test-design/SKILL.md).

You get fewer tests, and the pull request lists what each one catches and what was deliberately left untested, never a coverage percentage. [Decision 0015](decisions/0015-tests-name-the-break-they-catch.md)

## Somebody looks at the page in a real browser

Tests pass and the page is still broken: a button sits off the screen on a phone, text overlaps, or an error fills the console. Nobody opened it.

For a change with a UI, the agent runs the app and drives it in a real browser at phone, tablet and desktop sizes. It tries the keyboard as well as the mouse. This is [rendered QA](glossary.md#rendered-qa).

You get before and after screenshots near the top of the pull request, and what the check found.

## A second reviewer judges the work

The author grading their own work is not a review. An agent that reviews its own change tends to approve it, and one that also fixes what it finds turns review into more building.

For substantial changes, a separate reviewer agent judges the finished work; the building agent decides what counts, and a one-line fix skips it. The reviewer cannot edit code, so it only reports. If you set it up, it runs on a model from another [model family](glossary.md#model-family), such as an OpenAI model when Claude wrote the code. Then it does not share the builder's blind spots. The review itself always runs for substantial changes; only the cross-family model is off by default. On Claude Code it needs Codex installed and `models.claude.crossFamilyReviewer` set; on OpenCode, `models.opencode.crossFamilyReviewer`. On Codex the review is always from the same family. [Configuration](configuration/index.md#get-a-reviewer-from-another-model-family) shows how to set it up. The proof is still your checks and the browser; the review is an extra opinion on top.

The evidence shows `review ✓`, with a note when the reviewer came from the same model family as the builder. When no review ran, the evidence says so and the merge call is marked "(self-assessed)". [Decision 0007](decisions/0007-implementers-implement-reviewers-judge.md)

## The pull request's first screen does the explaining

Checking is now the slow part, not writing. A pull request you have to reverse-engineer from the diff costs more of your time than the agent saved.

The description opens with about 120 words. They say what changed for the user and give a [merge call](glossary.md#merge-call): is it safe to merge, and how easy is it to undo? Then come the decisions only you can make, and the evidence.

Most people can review the pull request in about a minute. [Reviewing a mexxi pull request](reviewing-a-pull-request.md) walks through it.

## Guardrails in code, not only in the rules

An agent that gets stuck occasionally does something destructive: a force push, a merge, a retry of the same failing command twenty times.

The rules forbid merging, force pushing and pushing to the default branch. A [guard](glossary.md#guard) hook backs some of them up by blocking those commands. The [loop breaker](glossary.md#loop-breaker) tells the agent to stop and rethink when the same command fails a third time. The rules still bind where the guard cannot see.

Mostly you notice nothing: the agent never merges, never pushes to your main branch, and stops to report rather than forcing its way through. [Decision 0006](decisions/0006-rules-stay-rules-guard-backs-up.md)
