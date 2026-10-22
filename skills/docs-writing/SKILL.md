---
name: docs-writing
description: Write or edit the Markdown that people read in the mexxi repository, such as its README, hand-written docs pages and landing page copy. Use when creating or changing any of them there, or when mexxi's prose check fails. Do not use in other repositories, or for agent instructions in commands, skills or agents.
---

# Docs Writing

One voice for the docs site and every Markdown file a person reads here. The `prose` check enforces what a tool can check; this skill covers the judgement it cannot.

## Why before how

Readers include developers who have never handed a task to a coding agent. Every page, section and generated entry opens with the problem it solves, in plain words, before it says how anything works.

- Open a page with what goes wrong without it, or what it lets the reader do. Mechanics come after.
- Give each step or setting a reason in a few words: "picks a free port, so two tasks can run development servers at once", not "picks a free port".
- Prefer a concrete example to an abstract rule.

## Voice

- Write British English: behaviour, optimise, colour.
- Lead with the outcome, then say how. One idea per paragraph.
- Keep sentences under about 25 words. The check fails at 30.
- Address the reader as "you". Use the active voice and plain words.
- Use one term per concept, taken from the [glossary](../../docs/glossary.md). Never give one concept a second name.
- Leave out marketing adjectives and filler openers. The Filler rule lists the common ones.
- Do not restate the heading in the first sentence under it.

## Terms

- Write "pull request" in full the first time on a page; "PR" is fine after.
- A worktree is a worktree: never call it a folder or a working directory.
- Explain an acronym or tool name the first time a newcomer meets it (MCP, CI, Playwright), or link its glossary entry.

## Where facts live

Each fact has one home. Generated pages take their facts from the files that own them (`names.json`, `prompts.json`, `config.schema.json`, each command and skill). Link to a page instead of repeating it.

A hand-written page lists what it describes in `sources:` and the date you last checked it in `reviewed:`. For `README.md` and `site/index.html` that declaration lives in `docs/freshness.json`. When a source changes, update the page, or bump `reviewed` when nothing needs to change.

## Names

The tool names are Maltese (`ibni`, `/wettaq`); everything else is English. The names are mexxi's identity, so present them with pride, never as clutter to apologise for.

- Introduce a name with its job the first time it appears on a page, as in "`/lesti`, the command that gets a repository ready", then use the bare name.
- Never put a job in brackets after every mention.
- Meanings, parts of speech and pronunciations come only from `names.json`, which records them from a dictionary with sources. Never write one from memory.

## Before you finish

Run `vfk --check prose --check docs --check docs-fresh`. Fix findings by rewriting the sentence; do not loosen a rule.
