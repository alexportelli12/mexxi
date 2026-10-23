---
sources:
  - AGENTS.md
  - skills/workflow-for-alex/SKILL.md
  - scripts/ibni/ibni.mjs
  - docs/decisions/0008-jev-shadow-metadata-only.md
  - docs/decisions/0011-segwi.md
reviewed: 2026-10-23
---

# Glossary

The words these docs use, what each one means, and why it matters to mexxi. The Maltese tool names are in their own small dictionary, [The names](names.md).

## agent

A specialist role, such as the code-reviewer, that a coding agent can hand part of a run to. Each is defined once in `agent/` and rendered for each host. A separate agent can be given fewer powers: the reviewer cannot edit code, so it can only judge.

## approval

A question segwi asks you when an agent wants to run something outside its allow list, such as a `curl` to the internet. It shows the exact command, and only a person can answer it, in the web app. No answer within the time limit counts as a denial, so a run never gets more freedom by waiting. See [segwi](segwi.md).

## baseline

The result of the verify command on the starting commit, run or cited before work starts. It proves the repository was healthy before the change, so a failure at the end belongs to the change.

## CI

Continuous integration: the checks your forge runs on every push, such as GitHub Actions. mexxi can cite a CI run of the verify command instead of repeating it at the start of a run.

## coding agent

An AI tool that works in your repository by reading files, running commands and editing code, such as Claude Code, Codex or OpenCode. mexxi does not replace it; it gives the agent you already use a workflow to follow.

## command

A workflow you start by name in your agent, such as `/wettaq`. Each is a Markdown file in `commands/`, so one set of instructions serves every host.

## cross-family review

A review by a model from a different [model family](#model-family) than the one that wrote the code. Models from one family tend to share blind spots, so a reviewer from another family is a more independent second opinion.

## default branch

The branch pull requests target, usually `main`. mexxi never pushes to it.

## evidence directory

The folder where a run keeps screenshots, recordings and notes, outside the repository so nothing is committed by accident. `ibni prepare` reports it as `evidenceDir`.

## forge

The service that hosts your repository and its pull requests, such as GitHub or GitLab. mexxi talks to it through its CLI, `gh` or `glab`, to open pull requests and see when they merge.

## gate

A check a run must pass before it moves on, such as verify, rendered QA or review. Gates are why a pull request arrives with proof rather than a claim. Its evidence line lists the gates that ran, and the ones that did not.

## guard

The hook that backs up the rules by stopping dangerous commands, such as force pushes and merges, before they run. A stuck agent occasionally tries one anyway. Codex runs it only once you trust it in `/hooks`.

## hook

A small program a host runs automatically at a set moment, such as before every shell command. mexxi uses hooks for the guard and the loop breaker, so those protections do not depend on the agent remembering them.

## host

A coding agent that mexxi installs into: OpenCode, Claude Code or Codex.

## Jev triage

An experiment that asks Jev, an outside decision model, which gates a task needs. It runs in shadow: it records its answers beside the agent's own choices and changes nothing, to learn whether it would help. It sends only metadata, never code, and is off unless you turn it on. [Decision 0008](decisions/0008-jev-shadow-metadata-only.md) explains why.

## loop breaker

A hook that counts identical failing shell commands. When the same command fails a third time, it tells the agent to stop retrying and re-diagnose, because a third identical try rarely works. A successful edit resets the count.

## MCP

The Model Context Protocol: a standard way to give a coding agent extra tools. mexxi uses Playwright MCP to let the agent drive a browser. [segwi](#segwi) offers an MCP server too, so other tools can start and follow runs.

## merge call

The verdict at the top of a pull request, informed by the review: whether it is safe to merge, how easy it is to undo, and whether merging deploys it. It saves you working that out from the diff. [Reviewing a mexxi pull request](reviewing-a-pull-request.md) shows where it sits.

## mod

A Claude Code plugin shipped in `claude/mods/`. The run pane shows where a run stands beside the chat. The command fixer quotes globs and keeps pipe failures visible before a shell command runs, so commands fail less often for avoidable reasons.

## model family

The AI models from one maker, such as the Claude models or the GPT models. A review is [cross-family](#cross-family-review) when the reviewer comes from a different family than the builder.

## Playwright

A tool for driving a real browser from code. Through Playwright MCP, the agent opens your app, clicks through it and takes screenshots at several screen sizes.

## pull request

What a run delivers: a branch with the change, and a description that explains it. On GitLab it is called a merge request.

## rendered QA

Driving the running UI in a real browser and capturing evidence: several screen sizes, motion, keyboard use and console errors. It catches the page that is broken even though the tests pass. It is a gate for user-facing changes.

## segwi

An opt-in tool that starts, follows and answers mexxi runs from your phone or any MCP client, on a machine you own. It is a launcher and viewer: the workflow, the worktrees and the pull request stay the same. It listens on your own machine only. See [segwi](segwi.md) and [decision 0011](decisions/0011-segwi.md).

## session

One agent conversation. `ibni` finds a session's workspace from its ID, so a later step never acts on the wrong worktree.

## skill

Specialist know-how an agent loads only when a task needs it, by matching the skill's name and description. Skills keep the agent's standing instructions short.

## verify

The repository's own pass/fail command for "does it work?": `npm run verify`, or the `verify` its `.mexxi.json` names. An agent's "done" is a claim; a passing verify is proof, so a run is finished only when it passes.

## workspace

A retained worktree together with its record: branch, port, evidence directory and pull request. Keeping it lets a later session pick up follow-up changes. `ibni list` lists them.

## worktree

A Git worktree created for one task: a separate copy of the repository on its own branch. It keeps the agent out of your checkout and lets tasks run side by side.
