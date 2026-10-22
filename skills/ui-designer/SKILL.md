---
name: ui-designer
description: Practical UI design reasoning for creating, implementing, improving, or refactoring application interfaces and flows. Use whenever UI implementation requires decisions about usability, hierarchy, layout, spacing, colour, typography, copy, actions, forms, accessibility, responsive behaviour, interaction states, or rendered validation. Apply alongside framework-specific skills. Do not use for defining product-level UX principles or for purely aesthetic art direction without an interface task.
metadata:
  why: "Interface code written without design judgement works, but is hard to use."
  group: ui
---

# UI Designer

Make interface decisions that improve a user's ability to understand and complete their task. Every meaningful design choice needs a reason grounded in usability, hierarchy, clarity, consistency, accessibility, interaction cost, or intentional brand expression. Taste alone is not enough.

Use this skill as practical UI judgement, not as permission to redesign a working product or mechanically apply a checklist.

## Follow Precedence

Resolve design decisions in this order:

1. Explicit task requirements
2. Project-specific UX principles
3. Existing design system, component library, and established repository patterns
4. This skill's general UI guidance
5. General aesthetic preference

Project UX principles define the intended experience. The design system defines its established expression. This skill helps make sound implementation decisions inside those constraints.

Call out a material conflict rather than silently overriding higher-precedence guidance. Follow the product intent unless it creates a serious accessibility or usability problem.

Use `ux-principles` when the task is to define or refine product-level UX principles. Use `frontend-design` as well when a new or reshaped interface needs distinctive aesthetic direction. This skill remains responsible for usability, hierarchy, states, and implementation quality.

## Apply Core Judgement

- Start with the user's task and make the important thing obvious.
- Minimise usability risk. Prefer recognisable, understandable, accessible patterns over novelty that has not earned its cost.
- Minimise unnecessary interaction and cognitive load, but do not optimise click count at the expense of comprehension or safety.
- Remove what does not help. Do not confuse simplicity with sparse minimalism that hides needed context.
- Reuse existing components, tokens, terminology, and interaction conventions before inventing new ones.
- Use spacing, type, colour, layout, and depth to communicate hierarchy and relationships rather than decorate empty space.
- Make controls and relevant states obvious. A static screenshot is not the complete interface.
- Design for real content, constrained viewports, keyboard use, touch, and assistive technology from the start.
- Focus effort on the primary journeys and highest-impact risks. Keep the change as small and coherent as the task allows.

Read [references/fundamentals.md](references/fundamentals.md) when making cross-cutting UI decisions or when the correct trade-off is unclear.

## Work From Context

Before changing UI:

1. Identify the user's goal, primary action, required information, and supporting detail.
2. Read relevant `UX_PRINCIPLES.md`, design-system documentation, tokens, components, and nearby patterns.
3. Inspect the existing implementation and surrounding flow. Do not design from the prompt alone when the repository can answer the question.
4. Identify concrete usability risks: ambiguity, hidden meaning, excessive choice, inaccessible treatment, unnecessary effort, missing states, or fragile responsive behaviour.
5. Choose the smallest coherent change that resolves the requirement and meaningful risks.

While implementing, use the existing system first. Introduce a new pattern only when the requirement cannot be handled coherently by what exists, and be able to explain why.

Do not turn every UI task into a redesign. Small, low-risk consistency improvements are appropriate when they naturally support the requested change.

## Load Only Relevant Guidance

- For content priority, progressive disclosure, simplicity, choice, or visual hierarchy, read [references/simplicity-and-hierarchy.md](references/simplicity-and-hierarchy.md).
- For palette, contrast, semantic colour, depth, states, or dark mode, read [references/colour.md](references/colour.md).
- For grouping, spacing, alignment, responsive composition, or real-content resilience, read [references/layout-and-spacing.md](references/layout-and-spacing.md).
- For type, readability, interface language, links, or messages, read [references/typography-and-copy.md](references/typography-and-copy.md).
- For action hierarchy, labels, targets, disabled controls, or destructive actions, read [references/buttons-and-actions.md](references/buttons-and-actions.md).
- For any form design or validation task, read [references/forms.md](references/forms.md) and use the relevant framework-specific form skill when available.
- The independent `code-reviewer` owns applicable UI judgement; it may read [references/ui-review.md](references/ui-review.md) for rendered review guidance.

Do not load every reference by default.

## Self-Check The Rendered Result

While implementing, look at the actual render; source and CSS values alone
cannot establish visual results. Load `rendered-qa` for technique and where
evidence goes. Keep this a brief self-check of the primary journey at mobile
and desktop widths:

- the primary action and hierarchy remain obvious, and related elements stay
  grouped;
- relevant states and realistic, long, or missing content do not break the
  task;
- copy is clear, contrast is sufficient, and focus is visible.

This supports implementation; it does not replace the orchestrator's rendered
QA pass, final verification, or independent review. Run targeted tests or
automated accessibility checks where relevant, but not the full repository
gauntlet.
