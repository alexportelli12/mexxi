---
sources:
  - scripts/retro/retro.mjs
  - scripts/hooks/loop-breaker.mjs
  - claude/mods/command-fixer/hooks/fix.ts
  - config.schema.json
reviewed: 2026-10-23
---

# Where the problems come from

The problems mexxi solves were measured, not guessed. This page keeps the numbers that shaped it, so you can judge whether they match how agents behave for you.

Across 89 of my sessions, from 26 September to 20 October, agents hit 386 zsh glob aborts in 77 sessions. They tried 72 edits before reading the file, ran into the 10-minute Bash cap 27 times, and hid 247 exit statuses behind pipes. I sent 15 follow-up prompts asking for rework, and 28 sessions compacted their context mid-pull request.

Several of mexxi's parts answer these numbers. On Claude Code, the command fixer quotes globs and keeps pipe failures visible. The [loop breaker](glossary.md#loop-breaker) stops repeated failures, [`claude.bashMaxTimeoutMs`](configuration/index.md#claude) raises the Bash cap, and the pull request's first screen aims to cut the rework prompts. [`/irrifletti`](../commands/irrifletti.md), which looks back at recent sessions privately, is how these numbers are measured again after a change.
