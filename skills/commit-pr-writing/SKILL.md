---
name: commit-pr-writing
description: Write outcome-focused commit messages, pull-request titles, and concise pull-request descriptions from completed work and its evidence. Use whenever an agent is preparing commit or pull-request copy, especially during automated implementation delivery; do not use it for Git execution, branching, releases, or repository management.
---

# Commit And Pull Request Writing

Translate a completed change into copy that lets a reviewer decide whether to
merge without reading the diff: what changed for the user, whether the merge is
safe, what they must do, and what proved it.

## Evidence And Precedence

Use the original request, resolved requirements and acceptance criteria from the
active session, repository context, final diff, verification results, and
applicable review evidence. Describe what the final implementation actually
achieves rather than copying session notes or narrating the implementation
process.

Inspect and follow repository-specific commit conventions, contribution
guidance, and pull-request templates. They take precedence over this skill. Do
not impose Conventional Commits unless the repository requires them.

## Commit Message

Write a concise subject that communicates the meaningful outcome. Prefer a
capability or behavioural result such as `Add staff access controls`, `Show
today's items on household overview`, or `Track listing price changes`.

Avoid generic mechanics such as `Update files`, `Refactor components`, or a
list of modified implementation units. Normally return only the subject. Add a
short body only when material context, a non-obvious constraint, or an important
trade-off cannot be communicated accurately in the subject.

## Pull Request Title

Write a concise title describing the capability, behaviour, or problem
addressed. Someone scanning a pull-request list should understand the intended
outcome without opening the diff. Avoid filenames, classes, components,
services, and implementation mechanics unless they genuinely are the subject
of the change.

## Pull Request Description

The reader is a reviewer who will not read the diff and wants to decide
whether to merge in about a minute. Everything that decision needs sits in the
first screen; everything else sits below it or folds away.

Ground the description in the full final diff against the PR's actual base,
including all commits, and the verified evidence. Session plans explain intent,
not what shipped. On every later delivery, rewrite the title and body to match
the whole PR as it now stands, including the current merge call; never append
"follow-up" sections or leave the verdict in review comments. `/wettaq` owns
posting and media publication.

Use the application's user-facing language. Explain or drop workflow names,
phase numbers and finding IDs; say "easy to undo" or "hard to undo" rather than
"two-way door" or "one-way door".

### Shape The Description

Follow a repository's own template when present, putting the first-screen items
below at its top. Otherwise use this shape:

```markdown
<What changed for the user or maintainer, and why, in one or two sentences.>

**Merge call:** <Safe to merge | Safe once you <action> | Needs your decision>. <Easy to undo | Hard to undo: <why, in a few words>>. <Deploys on merge, when it does.>

**Your part:**
- <A decision only you can make: the options and what each one changes.>
- <The one check worth doing: where · action · expected result.>

**Evidence:** <verify ✓ · rendered QA ✓ <viewports> · review ✓ <reviewer> · not run: <what>>

<UI changes: one before/after pair of the most important state.>

## What changed
- <Three to six bullets grouped by behaviour, not by file.>

## Decisions and assumptions
- <Something decided without being asked: the reading taken and the cheapest way to reverse it.>

## Gaps
- <Known limits and follow-ups.>

<details><summary>Details</summary>

<Supporting depth: other viewports, flake explanations, data tables, and the
review's out-of-scope or taste-only `low` findings, one line each with why they
were left.>

</details>
```

**Length.** Keep the first screen, from the lead to Evidence, to about 120
words; media goes after Evidence so the evidence stays in view. Keep everything
visible to about 450 words and never more than 600; past that, fold the rest
into `<details>`, and if the visible part still cannot fit, say the PR should
have been split. Omit any section with nothing true to say, except **Merge
call**, **Your part** and **Evidence**, which every PR has. A straightforward
change can be the first screen alone.

**Merge call.** Translate the independent reviewer's door and blast radius from
`code-reviewer` into plain words: how safe the merge is, how hard it is to undo
and what could break. When no review ran, judge it yourself with
`code-reviewer`'s door and blast-radius definitions and write
"(self-assessed)". Give the real undo path only when it is more than reverting
the PR, such as redeploying or cleaning up data; do not equate a code revert
with undoing data writes, migrations or an already-deployed change. Anything
that affects whether to merge, such as a deployment action, a compatibility
break or a check that could not run, belongs here or in **Your part**, never
below the first screen.

**Your part.** Say what only the reviewer can do: a product decision, a
pre- or post-merge action with its exact command, or the shortest human check
derived from the acceptance criteria. When the repository documents a preview
deploy (a Firebase Hosting channel, a Vercel preview), put its URL in the check
so the change can be validated from a phone; never invent one. When there is
nothing to do, write "Nothing; safe to merge as it is."

**Evidence.** One line of the gates that actually ran, then, only if it changes
the decision, the most useful proof in plain words, such as "Checkout tests
cover discounts that would make the total negative." Say what did not run, and
say when the reviewer shared the implementer's model family. Keep automated
tests, manual observations and unrun checks distinct. Do not unpack `verify`,
paste logs, count routine findings resolved, invent fail-then-pass proof, infer
a passing test from a changed spec, treat an unavailable capture or an
infrastructure failure as proof, or broaden a local or sampled result into a
guarantee.

**Decisions and assumptions.** When the run was unattended, or a question went
unanswered, list each assumption: the open question, the reading taken, and how
to reverse it. Also list deviations from the request the author was not asked
for. A question that would have changed the design goes in **Your part** as a
decision instead.

### Choose What To Show

Show when it saves explanation. Pick the smallest view that answers the
reviewer's question:

| Change / question | Best starting format |
| --- | --- |
| Existing UI: what looks or works differently? | Actual before/after screenshots of the affected state |
| New UI: what can I use? | Focused screenshot of the new feature |
| Relationships, ownership boundaries or flow | Small Mermaid diagram with domain labels |
| Conditional behaviour: when does each outcome happen? | Simple decision table or short pseudocode |
| Straightforward fix, configuration or wording | Brief text; no visual needed |

Use one primary visual, right after Evidence. Keep diagrams shallow and
distinguish current from intended behaviour; a diagram explains design, it does
not prove execution. A terminal UI gets a captured screenshot, not a
hand-drawn mock-up.

**UI media.** Embed URLs returned by `ibni publish-media`; capture and
publishing safety stay with `rendered-qa` and `/wettaq`. Choose the route,
state and viewport that best shows the outcome, mobile first for a phone-first
task, and fold the other viewports:

```markdown
| Before | After |
| --- | --- |
| ![Before: settings, desktop](<before-url>) | ![After: settings, desktop](<after-url>) |

<details><summary>Mobile</summary>

| Before | After |
| --- | --- |
| ![Before: settings, mobile](<before-mobile-url>) | ![After: settings, mobile](<after-mobile-url>) |

</details>
```

Pair actual captures at comparable routes, states, viewports and data. Never
fabricate a before-shot or label a mockup as the running UI; if a pair is
unavailable, show the verified after-state and say so in Evidence. New UI needs
no before column. Alt text names the state and viewport. Include a GIF only when
motion is part of the outcome, and link videos rather than embedding them.

The visual-selection approach adapts [Matt Pocock's `pr`](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md)
and [Dex Horthy's `show-me`](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md).
Final-diff grounding and refreshing the whole description adapt
[TanStack AI's PR-description guidance](https://github.com/TanStack/ai/blob/main/.agents/skills/pr-description/SKILL.md).
The first-screen order comes from a review of 30 recent pull requests (27 made
with mexxi): the risk call sat in the first screen in 1 of 30 and the evidence
in 2 of 30, and all 8 descriptions over 1,000 words scored poorly.

## Final Check

Read the title and the first screen as a busy reviewer who will not open the
diff, then perform this editing pass before posting (do not print the checklist
in the PR):

- From the first screen alone, can I tell what changed, whether it is safe to
  merge, what I must do, and what proved it?
- Is anything that affects the merge decision below the first screen or
  folded away?
- Is the visible text under about 450 words, with no workflow jargon, phase
  numbers, file-by-file lists or restated title?
- Does each visual answer a specific question with honest before/after
  evidence?
- Do the title, merge call, claims, links and media still match the final
  whole-PR diff and evidence after the latest changes?

If the draft is still dense, select fewer facts rather than packing more into
each sentence.
