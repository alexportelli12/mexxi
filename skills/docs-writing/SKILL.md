---
name: docs-writing
description: Write or edit the Markdown that people read in this repository, such as the README, the hand-written docs pages and the landing page copy. Use when creating or changing any of them, or when the prose check fails. Do not use for agent instructions in commands, skills or agents.
---

# Docs Writing

One voice for the docs site and every Markdown file a person reads here. The `prose` check enforces what a tool can check; this skill covers the judgement it cannot.

## Voice

- Write British English: behaviour, optimise, colour.
- Lead with the outcome, then say how. One idea per paragraph.
- Keep sentences under about 25 words. The check fails at 30.
- Address the reader as "you". Use the active voice and plain words.
- Use one term per concept, taken from the [glossary](../../docs/glossary.md). Never give one concept a second name.
- Leave out marketing adjectives and filler openers. The Filler rule lists the common ones.
- Do not restate the heading in the first sentence under it.

## Where facts live

Each fact has one home. Generated pages take their facts from the files that own them (`names.json`, `prompts.json`, `config.schema.json`, each command and skill). Link to a page instead of repeating it.

A hand-written page lists what it describes in `sources:` and the date you last checked it in `reviewed:`. For `README.md` and `site/index.html` that declaration lives in `docs/freshness.json`. When a source changes, update the page, or bump `reviewed` when nothing needs to change.

## Names

Names are Maltese (`ibni`, `/wettaq`); everything else is English. Pronunciation hints are written by Alex. Never invent one, and leave `TODO: Alex` in `names.json` until he supplies it.

## Before you finish

Run `vfk --check prose --check docs --check docs-fresh`. Fix findings by rewriting the sentence; do not loosen a rule.
