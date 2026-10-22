---
name: angular
description: >-
  Angular engineering guidance for meaningful component, form, data-access,
  state-management, testing, or architecture work. Use when implementing,
  refactoring, reviewing, or designing Angular features; inspect the repository
  and affected feature first, then load only the relevant specialist reference.
  Do not load specialist references for trivial, local edits that do not need
  Angular design judgement.
metadata:
  optional: "Angular repositories only."
---

# Angular Engineering

Provide Angular-specific engineering judgement, not a global style guide.
The task and product behavior come first, followed by documented project
principles, intentional local patterns and closest analogues, and broader
repository evidence. Use this skill to interpret those constraints rather than
to override them.

## Before Deciding

For meaningful Angular work:

1. Inspect the Angular version, installed packages, workspace configuration,
   validation scripts, and relevant repository instructions.
2. Inspect the affected feature and its closest analogue. Look for the
   existing component, forms, data, state, dependency-injection, template,
   and test approaches rather than inferring policy from framework age alone.
3. Distinguish an intentional local pattern from a repository-wide majority,
   and both from accidental legacy code. Use `repo-context` when a repository-
   wide map is needed, then verify its observations locally.
4. Define ownership before selecting an API: who owns the state, request,
   validation, side effect, or public contract, and what lifecycle should it
   have?

Use the narrowest change that preserves the feature's behavior. Do not
introduce a newer Angular API, abstraction, migration, or folder taxonomy just
because it is available or fashionable. Confirm compatibility with the
installed Angular and library versions.

## Specialist References

Read only the references relevant to the task. Read more than one when the
feature crosses concerns.

| Concern | Read when |
| --- | --- |
| Components | Designing or refactoring component boundaries, APIs, templates, or local reactive state. |
| Forms | Modelling fields, validation, editing, submission, or form migration. |
| Data access | Choosing or implementing server requests, loading/error state, caching, or concurrency. |
| State management | Deciding whether state should be shared, derived, normalized, or held in a store. |
| Testing | Writing or reshaping Angular component, service, directive, pipe, or state tests. |
| Architecture | Changing feature boundaries, dependency direction, public APIs, lazy boundaries, or abstractions. |

- `references/components.md`
- `references/forms.md`
- `references/data-access.md`
- `references/state-management.md`
- `references/testing.md`
- `references/architecture.md`

## Guardrails

Prefer reasoning that explains a trade-off over unconditional prescriptions.
Do not use this skill to replace compiler, formatter, linter, test-runner, or
architecture tooling. Mechanical naming, syntax, import-boundary, formatting,
and configuration rules belong in repository checks when they matter.

For a typo, isolated copy change, or similarly trivial edit, follow the local
file and do not load specialist references. For implementation that affects
ownership, lifecycle, boundaries, or observable behavior, load the smallest
relevant set and validate against the repository's existing checks.
