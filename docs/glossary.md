---
sources:
  - AGENTS.md
  - skills/workflow-for-alex/SKILL.md
  - scripts/ibni/ibni.mjs
  - docs/decisions/0008-jev-shadow-metadata-only.md
reviewed: 2026-10-22
---

# Glossary

Each concept has one name across the docs. When two words could mean the same thing, this page says which one to use. The Maltese names are listed with their jobs on [The names](names.md).

## agent

A specialist role such as the code-reviewer, defined once in `agent/` and rendered for each host.

## baseline

The result of `npm run verify` on the base commit, run or cited before work starts.

## command

A workflow you start by name, such as `/wettaq` (build it). A command is a Markdown file in `commands/`.

## default branch

The branch pull requests target, usually `main`.

## evidence directory

The folder where a run keeps screenshots, recordings and notes. `ibni prepare` reports it as `evidenceDir`.

## gate

A check a run must pass before it moves on, such as `verify`, rendered QA or review.

## guard

The hook that backs up the rules against dangerous commands, such as force pushes and merges. Codex runs it only once you trust it in `/hooks`.

## host

A coding agent that mexxi installs into: OpenCode, Claude Code or Codex.

## Jev triage

An experiment that asks Jev, an outside decision model, which gates a task needs. It runs in shadow: it records its answers beside the agent's own choices and changes nothing. It sends only metadata, never code, and is off unless you turn it on. [Decision 0008](decisions/0008-jev-shadow-metadata-only.md) explains why.

## loop breaker

A hook that counts identical failing shell commands. When the same command fails a third time, it tells the agent to stop retrying and re-diagnose. A successful edit resets the count.

## merge call

The verdict at the top of a pull request, informed by the review: whether it is safe to merge, how easy it is to undo, and whether merging deploys it. [Reviewing a mexxi pull request](reviewing-a-pull-request.md) shows where it sits.

## mod

A Claude Code plugin shipped in `claude/mods/`. The run pane shows where a run stands beside the chat; the command fixer quotes globs and keeps pipe failures visible before a shell command runs.

## pull request

What a run delivers. Write "pull request" in full the first time; "PR" is fine after.

## rendered QA

Driving the running UI in a real browser and capturing evidence: several screen sizes, motion, keyboard use and console errors. It is a gate for user-facing changes.

## session

One agent conversation. `ibni` finds its workspace from the session ID.

## skill

Specialist expertise an agent loads by matching its name and description.

## verify

The repository's own `npm run verify`, which defines "mechanically healthy" for that project.

## workspace

A retained worktree together with its record: branch, port, evidence directory and pull request. `ibni list` lists them.

## worktree

A Git worktree created for one task: a separate checkout of the repository on its own branch. Do not call it a folder or a working directory.
