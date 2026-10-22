---
name: ux-principles
description: Define, generate, or refine a product's UX_PRINCIPLES.md through repository-informed discovery and adaptive product-owner questions. Use when establishing product-specific UX decision principles, revisiting existing UX principles, or running the /fassal command. Do not use for visual design systems, component styling rules, or feature-level UI specifications.
metadata:
  why: "Without written UX principles, every agent decides interface questions its own way."
  group: ui
---

# UX Principles

Create and maintain `UX_PRINCIPLES.md` as a concise product decision guide. The document should help planning, implementation, and review resolve UX trade-offs consistently. It is not a design system, feature specification, or generic usability checklist.

## Establish Context First

Work from evidence before interviewing the user.

1. Check whether `UX_PRINCIPLES.md` already exists and read it completely.
2. Inspect the repository's relevant product documentation, planning artifacts, user-facing structure and copy, accessibility guidance, research, feedback, and analytics references.
3. Use `repo-context` when repository-wide context is needed; do not duplicate its technical findings in `UX_PRINCIPLES.md`.
4. Separate established facts from inferences and unresolved questions. Repository patterns show current behavior, not necessarily intended UX.

For an existing document, preserve supported principles and useful provenance. Refine only what new evidence or explicit product-owner decisions justify; do not replace it blindly or erase meaningful disagreements.

For a new or sparse project, begin with the available brief and repository evidence, then discover missing product context with the user.

## Adaptive Discovery

Ask the smallest useful question or related group of questions, then use each answer to decide what to explore next. Do not run a fixed questionnaire or ask for information already available in the repository.

Develop enough understanding to explain:

- the product's purpose and target users;
- users' primary goals and the moments where the product must help them succeed;
- the intended UX philosophy, tone, and information priorities;
- what users must trust the product with and how that trust can be lost;
- important tensions, trade-offs, and product or delivery constraints.

Probe where the answer would change a principle. Ask for concrete examples, counterexamples, evidence, or a forced choice when an answer is vague, aspirational, generic, or internally inconsistent. Useful prompts expose decisions, for example: which user wins when needs conflict, what must never be optimized away, or when speed should yield to reassurance.

Do not force certainty. Record unresolved but material tensions explicitly rather than inventing a product decision. Continue discovery until the principles are specific enough to guide a realistic UX decision and the evidence for them is clear.

## Form Strong Principles

Each principle must be specific to this product and discriminate between plausible choices. A principle is meaningful when an engineer or designer can use it to choose one approach over another and explain the cost accepted.

For every principle capture:

- **Principle:** A short, memorable decision rule.
- **Why it exists:** The product or user problem it protects against.
- **Evidence/source:** Verifiable provenance such as product-owner input, a repository document or path, research, analytics, or user feedback. Label assumptions and inferred evidence honestly; never fabricate support.
- **Implementation implications:** A small set of behavioral consequences for flows, content, states, defaults, feedback, or accessibility. Keep these at decision level rather than prescribing components.
- **Relevant trade-offs:** What this principle prioritizes, what it may cost, and when another concern could override it.

Prefer a small set of distinct, durable principles. Merge overlapping ideas and remove statements that amount to universal advice such as "be intuitive," "be consistent," or "make it accessible" unless product-specific evidence turns them into an actionable choice.

## Document Shape

Write `UX_PRINCIPLES.md` at the repository root unless repository documentation conventions establish a clearly authoritative alternative. Use the following shape, adapting headings only where the product needs it:

```markdown
# UX Principles

## Product Context

A brief statement of purpose, users, primary goals, and the evidence used to establish this context. Link to authoritative project documents rather than repeating them.

## Principles

### <Principle name>

**Principle:** <decision rule>

**Why it exists:** <product-specific rationale>

**Evidence/source:** <owner input, research, feedback, or repository reference>

**Implementation implications:**

- <decision-level implication>

**Relevant trade-offs:** <priority, cost, and override conditions>

## Open Questions

Only unresolved product decisions that materially limit application of the principles. Omit when none remain.
```

Keep context concise and link to existing sources instead of duplicating product documentation. Preserve source distinctions when multiple stakeholders or evidence types disagree.

## Boundaries

Exclude:

- colors, typography scales, spacing, breakpoints, tokens, and component styling;
- pixel-level direction or page-specific mockup instructions;
- generic UX heuristics and large compliance checklists;
- implementation architecture already documented elsewhere;
- unsupported claims presented as research or user needs.

Do not modify product code, implementation task contracts, execution workflows,
agents, or unrelated documentation while running this skill.

## Completion

Before finishing, verify that the document:

- contains product-specific principles that resolve meaningful choices;
- gives every principle rationale, honest provenance, implications, and trade-offs;
- reflects repository evidence and the user's confirmed decisions without conflating them;
- preserves useful existing content unless there is a stated reason to change it;
- avoids design-system rules, feature specifications, generic advice, and duplicated documentation.

Summarize what was created or refined, the evidence used, assumptions made, and any material open questions.
