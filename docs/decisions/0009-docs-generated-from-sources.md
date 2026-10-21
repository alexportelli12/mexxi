---
status: Accepted
date: 2026-10-21
---

# 0009. Docs are generated from the files they describe

## Context

mexxi is public and meant for other people to adopt, so it needs documentation that is easy to read and search. Hand-written docs that copy facts from commands, skills and the config schema go stale as soon as one of them changes. The repository also sits next to private material, such as retro reports and personal config, that must never reach a public site.

## Decision

- The docs site is built from the repository's own files: the README, `AGENTS.md`, commands, agents, skills, the config schema, `ibni --help`, these decisions, and the hand-written pages in `docs/`. A GitHub Action publishes it to Pages with the landing page.
- Facts that appear in several places live in one file and are read from there: the Maltese names and their meanings in `names.json`, the setup prompts people copy in `prompts.json`.
- The generator reads only files that Git tracks and that match an allowlist in `scripts/docs/lib/source.mjs`. That allowlist is the privacy boundary.
- Hand-written pages declare the files they describe and when someone last checked them. `docs-fresh` fails when a branch changes a listed file without touching the page.
- Decision records are the exception: they record a decision at a point in time and are not edited to follow the code. A changed decision gets a new record that supersedes the old one.
- The `docs` check builds the site and fails on broken links. `prose` runs Vale with a British English dictionary and the glossary's terms. The `docs-writing` skill covers the judgement Vale can't.

## Consequences

- A new command, skill or config key appears on the site without anyone writing a page for it.
- Freshness and prose checks can fail `verify` for wording rather than behaviour. That cost is kept in view: the source lists are narrow, and making `prose` advisory is an open follow-up.
- Nothing outside the allowlist can be published, whatever is added to the repository later.
- The site needs Node and a Vale download to build, and `verify` downloads Vale on first use.

## Alternatives considered

- **Hand-written docs only:** full control over every page, but facts would drift from the files they describe.
- **No site, only the README:** less to maintain, but hard to search and too long to read in one place.
