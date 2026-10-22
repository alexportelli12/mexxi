---
sources:
  - skills/commit-pr-writing/SKILL.md
  - skills/implement-review/SKILL.md
  - commands/wettaq.md
reviewed: 2026-10-22
---

# Reviewing a mexxi pull request

Checking an agent's work is now the slow part, not writing it. So a pull request from [`/wettaq`](../commands/wettaq.md), the command that builds a change, is written to be reviewed in about a minute. Its first screen tells you whether to merge and what only you can decide. The rest is there when you want to dig in.

You still own the merge. mexxi never merges for you.

## The first screen

The top of the description runs to about 120 words. For most pull requests it is all you need to read.

| Part | What it tells you |
| --- | --- |
| **Lead** | One or two sentences: what changed for the user, and why. |
| **Merge call** | Safe to merge, safe once you take one action, or needs your decision. Whether it is easy or hard to undo, and how. Whether merging deploys it. |
| **Your part** | The decisions only you can make, and the one check worth doing yourself: where to go, what to do, what you should see. |
| **Evidence** | One line listing the [gates](glossary.md#gate) that ran, such as `verify ✓ · rendered QA ✓ · review ✓`, and what did not run. |
| **Before and after** | For a UI change, one pair of screenshots, just below the evidence. |

### Merge call

The [merge call](glossary.md#merge-call) sums up the run and its review. It reads one of three ways:

- **Safe to merge**: the gates passed and nothing needs you.
- **Safe once you …**: merge after the one action it names, such as setting an environment variable.
- **Needs your decision**: a product or one-way call only you can make. Your part says what it is.

"(self-assessed)" after the call means no independent review ran, so the call is the building agent's own. The undo line tells you whether a revert is enough, or whether data, users or other systems would notice.

### Your part

These are product calls the agent could not settle from the code, and the one check that best shows the change works. A check reads like "settings page · open it on a phone · the sync time sits under the title". When it says "Nothing; safe to merge as it is", the agent found nothing that needs you.

### Evidence

Each mark is a gate:

- **verify**: your repository's own checks, `npm run verify` by default, passed on the final code. See [verify](glossary.md#verify).
- **rendered QA**: the agent opened the running app in a real browser and checked it. See [rendered QA](glossary.md#rendered-qa).
- **review**: a separate reviewer agent, which cannot edit code, judged the change.

The review mark notes when the reviewer came from the same model family as the agent that wrote the code. A reviewer from another family is a more independent second opinion. The line also names what did not run and why, such as no browser check for a change with no UI.

## Below the first screen

- **What changed**, grouped by behaviour rather than by file.
- **Decisions and assumptions**: what the agent decided without asking you. Each is worded so you can reverse it cheaply, usually with one follow-up request.
- **Gaps**: what the agent could not do or prove, such as a flow it could not reach or a test it could not write.
- **Details**, collapsed: everything else, such as test lists, review findings and where the evidence files are.

## A one-minute review

1. Read the merge call and Your part. Make the decisions they ask for.
2. Compare the before and after screenshots with what you asked for.
3. Check that the evidence names tests that protect the behaviour you care about, and read what did not run.
4. Scan the decisions and assumptions for any you disagree with.
5. Do the one check under Your part, if there is one.

If everything matches, merge it.

## What stays your job

- **Product judgement.** Whether the behaviour is what your users need.
- **Whether the request was the right one.** The agent builds what you asked for; it does not question the goal.
- **Anything one-way.** Deleting or migrating data, security and privacy choices, and breaking a public API or schema cannot be undone by another pull request. The agent stops and asks about these, but the call is yours.
- **The merge itself.**

## When to stop and read the code

Read the diff, or ask someone who knows that area, when:

- the merge call says the change is hard to undo, or that merging deploys it;
- it touches sign-in, permissions, secrets, payments or personal data;
- evidence is missing, or a gate did not run and nothing says why;
- the screenshots do not match what you asked for; or
- an assumption surprises you and you cannot tell what else it affects.

## Asking for changes

Ask with `/wettaq` and the pull request's link, for example `/wettaq follow up on <pull request URL>: keep the old label as a tooltip`. It picks up the same [worktree](glossary.md#worktree), runs the same gates and updates the same pull request. For a second look without code changes, [`/ittestja`](../commands/ittestja.md), the command that tests a UI by hand in a browser, returns a findings report. [Commands](../commands/index.md) lists the rest, with the problem each one solves.
