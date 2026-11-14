---
name: commit-pr-writing
description: Write outcome-focused commit messages, pull-request titles, and concise pull-request descriptions from completed work and its evidence. Use whenever an agent is preparing commit or pull-request copy, especially during automated implementation delivery; do not use it for Git execution, branching, releases, or repository management.
metadata:
  why: "A pull request you have to reverse-engineer from the diff costs more time than the agent saved."
  group: run
---

# Commit And Pull Request Writing

Turn a completed change into copy that lets a reviewer decide whether to merge
without reading the diff: what changed for the user, whether the merge is safe,
what they must do, and what proved it.

Work from the request, the session's acceptance criteria, the final diff and
the evidence that actually exists, never session notes or the story of the
implementation. Repository commit conventions, contribution guidance and
pull-request templates take precedence over this skill; do not impose
Conventional Commits unless the repository does.

## Commit Message And Title

A commit subject names the outcome, such as `Add staff access controls` or
`Track listing price changes`, never mechanics such as `Update files`. Usually
the subject is all; add a short body only for context, a constraint or a
trade-off the subject cannot carry. A pull-request title does the same for
someone scanning a list: the capability, behaviour or problem, not filenames or
classes.

## Pull Request Description

The reader will not read the diff and wants to decide in about a minute, so the
first screen holds everything the decision needs. Ground it in the full final
diff against the actual base and the verified evidence. On every later
delivery, rewrite the title and body for the whole pull request as it now
stands, with a current merge call; never append follow-up sections. Use the
application's own language: no workflow names, phase numbers or finding IDs,
and "easy to undo" or "hard to undo" rather than door jargon.

Follow the repository's template when it has one, with the first-screen items
at its top. Otherwise:

```markdown
<What changed for the user or maintainer, and why, in one or two sentences.>

**Merge call:** <Safe to merge | Safe once you <action> | Needs your decision>. <Easy to undo | Hard to undo: <why>>. <Deploys on merge, when it does.>

**Your part:**
- <A decision only you can make: the options and what each changes.>
- <The one check worth doing: where · action · expected result.>

**Evidence:** <verify ✓ · rendered QA ✓ <viewports> · review ✓ · CI ✓ once it passes · not run: <what>>

<UI changes: one before/after pair of the most important state.>

## What changed
- <Three to six bullets grouped by behaviour, not by file.>

## Decisions and assumptions
- <A choice made without asking: the reading taken and the cheapest way to reverse it.>

## After merge
- <A step that must run once this merges, with its exact command.>

## Left for later
- <A known limit, a review finding not fixed in this run, or a check worth automating.>

<details><summary>Details</summary>

<Other viewports, flake explanations, the test report, and the diffs behind any
review disagreement the run stopped fixing.>

</details>
```

- **Length:** the first screen, lead to Evidence, about 120 words; everything
  visible about 450 and never over 600, the rest folded into Details. If it
  still cannot fit, say the pull request should have been split. Omit any
  section with nothing true to say, except Merge call, Your part and Evidence.
- **Merge call:** the reviewer's door and blast radius in plain words. With no
  review, judge it with `code-reviewer`'s definitions and add
  "(self-assessed)". Give the real undo path when it is more than a revert,
  such as data written, a migration or a deploy. Anything that affects whether
  to merge belongs here or in Your part, never lower.
- **Your part:** only what the reviewer can do: a product decision, an action
  only a person may take (such as a production deploy) with its command, or the
  shortest check from the acceptance criteria, with the repository's documented
  preview URL when it has one. Otherwise "Nothing; safe to merge as it is."
- **Evidence:** claim only checks that ran, each with its result, and say what
  did not run. Add the most useful proof in plain words only when it changes
  the decision. Keep tests, manual observations and unrun checks distinct.
  Never paste logs, count routine fixes, infer a pass from a changed test, or
  treat an unavailable capture or an infrastructure failure as proof. The
  `test-design` report (each new test's break and how it was seen failing)
  goes in Details; a coverage percentage is never proof.
- **Decisions and assumptions:** each reversible choice made without asking,
  and any deviation from the request; one that would have changed the design
  goes in Your part.
- **After merge:** steps with exact commands, such as regenerating data;
  `/wettaq <pull request URL>` in a new session runs them.

## Choose What To Show

Show only when it saves explanation, with one primary visual right after
Evidence: before/after screenshots for changed UI, a focused screenshot for new
UI, a small Mermaid diagram for relationships or flow, a decision table for
conditional behaviour, and nothing for a plain fix. A diagram explains design;
it does not prove execution.

Embed the URLs `ibni publish-media` returns in a `| Before | After |` table:
the state and viewport that best show the outcome (mobile first for a
phone-first task), other viewports folded. Pair real captures of comparable
states; never fabricate a before-shot or present a mock-up as the running UI,
and when a pair is missing say so in Evidence. Alt text names the state and
viewport; use a GIF only when motion is the outcome.

The visual choices adapt [Matt Pocock's `pr`](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md),
[Dex Horthy's `show-me`](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md)
and [TanStack AI's guidance](https://github.com/TanStack/ai/blob/main/.agents/skills/pr-description/SKILL.md).

## Final Check

Before posting, read the title and first screen as a busy reviewer: can you
tell what changed, whether to merge, what you must do and what proved it? Is
anything that affects the decision folded away? Do every claim, link and image
still match the final diff and evidence? If it is still dense, cut facts rather
than packing sentences.
