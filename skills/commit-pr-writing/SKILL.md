---
name: commit-pr-writing
description: Write outcome-focused commit messages, pull-request titles, and concise pull-request descriptions from completed work and its evidence. Use whenever an agent is preparing commit or pull-request copy, especially during automated implementation delivery; do not use it for Git execution, branching, releases, or repository management.
---

# Commit And Pull Request Writing

Translate a completed change into copy that lets a reviewer understand its
purpose, outcome, behavioural impact, validation target, and quality evidence
without reading the diff.

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

Let a reviewer grasp the purpose and main outcomes within 30 seconds. Start
with what changed and why it matters, in one or two short sentences. Use the
application's user-facing language (and its glossary when available); explain
specialised terms only when they are essential. For architecture work, name
the capability or boundary gained before describing the machinery.

Ground the description in the full final diff against the PR's actual base,
including all commits, and the verified evidence. Session plans explain intent,
not what shipped. On subsequent delivery, rewrite the title and body to match
the current whole PR; remove superseded claims, checks and media rather than
appending an update diary. `/wettaq` owns posting and media publication.

### Shape The Description

Normally aim for about 100–200 words of main-body prose, plus a useful visual.
This is a guide, not a quota: a straightforward change can be shorter; important
risks or evidence limits can need more. Do not move essential information out
of sight just to meet a word count.

Use the smallest structure that explains the change. Follow a repository's
template when present, keeping each answer concise and checkboxes honest.
Otherwise, this is a starting shape, not a form to fill mechanically:

```markdown
<Outcome and why it matters.>

**Important:** <Material limitation, deployment action or hard-to-reverse effect,
when present. Keep it above long media.>

<Focused visual or a few outcome bullets, only if the lead needs them.>

## Evidence
- <Most useful verified result and any material coverage limit.>
- <Gates that actually ran.>

**Check:** <Entry point · action · expected result, when useful for human review.>

**Risk / rollback:** <What could break and how to undo it; see below.>

**Assumptions:** <Unattended runs only; see below.>
```

Choose the two or three outcomes that define the PR, rather than compressing
every implementation bullet into a dense paragraph. Keep the lead about the
result; tests, symbols, timeout values and build wiring belong elsewhere only
when they change a review decision.

Avoid repeating the lead in bullets. Omit empty sections, generic assurances,
routine implementation details, low-value findings, and file-by-file inventories.
Do not repeat the diff, logs, planning documents or session history. Link an
existing relevant artifact or use `<details>` only for genuinely useful supporting
depth; do not create a report just to give the description somewhere to link.

### Choose What To Show

Prefer showing when it reduces the explanation, not because a PR needs decoration.
Pick the smallest view that answers the reviewer's question:

| Change / question | Best starting format |
| --- | --- |
| Existing UI: what looks or works differently? | Actual before/after screenshots of the affected state |
| New UI: what can I use? | Focused screenshot of the new feature |
| Relationships, ownership boundaries or flow | Small Mermaid diagram with domain labels |
| Conditional behaviour: when does each outcome happen? | Simple decision table or short pseudocode |
| Straightforward fix, configuration or wording | Brief text; no visual needed |

Use one primary visual by default. Add another only when it answers a different,
important question faster than prose. Replace the explanation it makes redundant.
Keep diagrams shallow, with only the participants, branches and labels needed to
explain this change. Distinguish current from intended/future behaviour. Avoid
symbol-heavy trees, code dumps and miniature diffs that make the reader decode
the implementation. A diagram explains design; it does not prove execution.

**UI media.** Embed URLs returned by `ibni publish-media`;
capture and publishing safety stay with `rendered-qa` and `/wettaq`. Choose
the route, state and viewport that best shows the outcome—mobile first for a
phone-first task. Keep that comparison in the open, near the lead; link or
collapse secondary states and viewports only when useful. For example:

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

Pair actual before/after captures at comparable routes, states, viewports and
data. Do not fabricate a before-shot or label a mockup as the running UI; if a
pair is unavailable, show the verified after-state and state the limit. New UI
needs no before column. Alt text names the state and viewport; a short caption
explains what to notice. Include a GIF only when motion or an interaction is
part of the outcome, not for every animated element. Link original videos
rather than embedding them. If relevant media cannot be published, say why
briefly in Evidence without treating an unavailable capture as proof.

### Assumptions

When the run was unattended, or a question went unanswered, the author took the
most reasonable reading instead of asking. Add an **Assumptions** section after
the lead and any **Important** note, above media, with one line per assumption:
the open question, the reading taken, and the cheapest way to reverse it. A
question that would have changed the design is a review item, so say what the
reviewer should decide. Omit the section when nothing was assumed.

### Evidence And Material Risks

Give the most useful proof in plain language: the behaviour a test protects,
what rendered QA exercised, or an observed result with its scope. For example,
"Checkout tests cover discounts that would make the total negative." List only
gates that ran, such as `verify ✓ · rendered QA ✓ · review ✓`; do not unpack
`verify`, paste logs, or count routine findings resolved. Distinguish automated
tests, manual observations and unrun checks. Do not invent fail-then-pass proof
or infer a passing test from a changed spec. State sampling or environment
limits when they affect confidence; local counts are not production estimates,
and infrastructure failures do not prove behavioural parity. Preserve what a
measurement actually counted; do not broaden a sample result into a guarantee.

When useful, give the shortest human check derived from acceptance criteria:
entry point, action and expected result. Link longer existing instructions
rather than recreating a test plan.

Preserve the independent reviewer's door and blast-radius assessment from
`code-reviewer`, translating it into a concise **Risk / rollback** line: scope
of possible failure, reversibility and the real undo path. When no review ran,
mark it "self-assessed" and use that agent's definitions. Do not equate a code
revert with undoing data writes, migrations or an already-deployed change.
Material risks, compatibility breaks, required deployment actions and important
verification gaps stay visible in the main body. If they affect whether to
merge or use the feature, put them immediately after the lead, above media;
do not bury them in collapsed details or duplicate them at the bottom.

The visual-selection approach adapts [Matt Pocock's `pr`](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md)
and [Dex Horthy's `show-me`](https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md).
Final-diff grounding and refreshing the whole description adapt
[TanStack AI's PR-description guidance](https://github.com/TanStack/ai/blob/main/.agents/skills/pr-description/SKILL.md).

## Final Check

Read the title and body as a busy human reviewer, then perform this editing
pass before posting (do not print the checklist in the PR):

- Can the first 30 seconds tell me what changed and why it matters?
- Does each visual simplify a specific question, with readable labels and
  honest before/after evidence, rather than duplicate text or expose internals?
- Are the most important verification result, unrun checks and merge risks easy
  to find without expanding anything?
- Can jargon, headings, repeated facts or routine detail be removed without
  losing meaning? Is remaining technical detail necessary for a review decision?
- Do the title, outcomes, claims, links, media and rollback advice still match
  the final whole-PR diff and actual evidence after the latest changes?

If the draft is still dense, select fewer facts rather than packing more into
each sentence. Move material risks above media, use available actual before/after
pairs, and remove numerical or technical detail that does not help the decision.
