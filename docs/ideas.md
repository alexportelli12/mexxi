---
sources:
  - commands/wettaq.md
  - skills/implement-review/SKILL.md
  - skills/rendered-qa/SKILL.md
  - skills/commit-pr-writing/SKILL.md
  - scripts/ibni/commands/prepare.mjs
  - scripts/ibni/commands/publish.mjs
  - scripts/hooks/guard-rules.mjs
  - scripts/hooks/loop-breaker.mjs
  - docs/decisions/*.md
  - config.schema.json
  - scripts/ibni/commands/record-evidence.mjs
  - scripts/ibni/commands/cross-review.mjs
reviewed: 2026-10-22
---

# The ideas behind mexxi

Coding agents can now take a whole task and hand back a pull request. Writing the code is no longer the slow part; trusting it is. mexxi rests on six ideas that move the checking from you to the run, and leave you the decisions.

Each idea below is a problem, what mexxi does about it, and what you see. The decision record linked from each one gives the full reasoning.

## Each task gets its own copy of the repository

**The problem.** An agent working in your checkout trips over your own unfinished work. It switches branches under you, leaves files changed, and two tasks at once collide on the same files and the same dev-server port.

**What mexxi does.** Before any work starts, `ibni`, the command-line tool the agent runs, makes a [worktree](glossary.md#worktree): a separate copy of the repository on a new branch, with its own free port. Every later step happens there.

**What you see.** Your checkout stays exactly as you left it, and you can run several tasks side by side. [Decision 0004](decisions/0004-isolated-worktree-per-task.md)

## A pass/fail command defines "done"

**The problem.** An agent will say "done, all tests pass" whether or not it ran them. A claim can be talked around; a command that passes or fails cannot.

**What mexxi does.** Each repository has one [verify command](glossary.md#verify), `npm run verify` by default: your tests, linters and build in one pass/fail run. It must pass before work starts, so an old failure is never blamed on the change, and again at the end. When it passes, the agent records with `ibni` the exact code it passed on. `ibni` refuses to push any other code, so a change made afterwards has to be checked and recorded again.

**What you see.** The pull request's evidence line starts with `verify ✓`. If the repository's checks were already failing, the run stops and tells you instead of building on top of them. [Decision 0010](decisions/0010-repository-names-its-verify-command.md)

## Somebody looks at the page in a real browser

**The problem.** Tests pass and the page is still broken: a button sits off the screen on a phone, text overlaps, or an error fills the console. Nobody opened it.

**What mexxi does.** For a change with a UI, the agent runs the app and drives it in a real browser at phone, tablet and desktop sizes. It tries the keyboard as well as the mouse. This is [rendered QA](glossary.md#rendered-qa).

**What you see.** Before and after screenshots near the top of the pull request, and what the check found.

## A second reviewer judges the work

**The problem.** The author grading their own work is not a review. An agent that reviews its own change tends to approve it, and one that also fixes what it finds turns review into more building.

**What mexxi does.** For substantial changes, a separate reviewer agent judges the finished work; the building agent decides what counts, and a one-line fix skips it. The reviewer cannot edit code, so it only reports. If you set it up, it runs on a model from another [model family](glossary.md#model-family), such as an OpenAI model when Claude wrote the code. Then it does not share the builder's blind spots. It is off by default. On Claude Code it needs Codex installed and `models.claude.crossFamilyReviewer` set; on OpenCode, `models.opencode.crossFamilyReviewer`. On Codex the review is always from the same family. [Configuration](configuration/index.md) has the keys. The proof is still your checks and the browser; the review is an extra opinion on top.

**What you see.** `review ✓` in the evidence, with a note when the reviewer came from the same model family as the builder. When no review ran, the evidence says so and the merge call is marked "(self-assessed)". [Decision 0007](decisions/0007-implementers-implement-reviewers-judge.md)

## The pull request's first screen does the explaining

**The problem.** Checking is now the slow part, not writing. A pull request you have to reverse-engineer from the diff costs more of your time than the agent saved.

**What mexxi does.** The description opens with about 120 words. They say what changed for the user and give a [merge call](glossary.md#merge-call): is it safe to merge, and how easy is it to undo? Then come the decisions only you can make, and the evidence.

**What you see.** A pull request most people can review in about a minute. [Reviewing a mexxi pull request](reviewing-a-pull-request.md) walks through it.

## Guardrails in code, not only in the rules

**The problem.** An agent that gets stuck occasionally does something destructive: a force push, a merge, a retry of the same failing command twenty times.

**What mexxi does.** The rules forbid merging, force pushing and pushing to the default branch. A [guard](glossary.md#guard) hook backs some of them up by blocking those commands. The [loop breaker](glossary.md#loop-breaker) tells the agent to stop and rethink when the same command fails a third time. The rules still bind where the guard cannot see.

**What you see.** Mostly nothing: the agent never merges, never pushes to your main branch, and stops to report rather than forcing its way through. [Decision 0006](decisions/0006-rules-stay-rules-guard-backs-up.md)
