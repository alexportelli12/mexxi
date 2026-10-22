---
name: repo-context
description: Inspect a repository and report a concise, evidence-based map of its stack, structure, observed patterns, testing, CI/CD, and infrastructure. Use when repository-wide evidence is needed before implementation or architectural reasoning; do not treat the report as an architecture decision.
metadata:
  why: "An agent that changes code before it understands the repository breaks the patterns already there."
  group: run
---

# Repo Context

Build a concise, evidence-based starting map of a repository by scanning source
files and configuration. The report complements repository documentation and
local code inspection; it does not replace architecture decisions, ADRs, or
feature-specific context.

## Usage

```bash
node <skill-base>/scripts/inspect.js [path-to-repo]
```

Defaults to `process.cwd()` if path is omitted. Report only the sections
relevant to the decision rather than treating the full report as permanent
context. State scan limits and uncertainty honestly.

The scanner is strongest for JavaScript and TypeScript repositories. Other
ecosystems receive manifest and structure detection but may not receive
equivalent convention analysis.

## Report Sections

| Section                        | What it detects                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Tech Stack**                 | Root and workspace package manifests, frameworks + versions, key libraries, dev tools, build scripts                                    |
| **Detected Patterns**          | File coverage for state APIs, styling approaches, and async syntax                                                                      |
| **Conventions**                | Observed DI style, I/O style, control flow, forms API evidence, templates, change detection, file naming, selector prefixes             |
| **Architecture & Topology**    | Primary source areas, Angular projects, framework locations, likely entry points                                                        |
| **Backend & Infrastructure**   | Supabase (config, migrations, edge functions, shared support), Docker files, env files                                                  |
| **CI / CD**                    | Pipeline names, jobs and triggers plus Vercel, Netlify, Render, Fly.io, and Firebase App Hosting configuration                           |
| **Testing Setup**              | Framework dependencies/configs, Angular and Node test runners, redacted Playwright origin/test directory, unit and end-to-end counts    |
| **Monorepo / Workspaces**      | npm/yarn/pnpm workspaces, Turborepo, Nx, Lerna, Rush; lists packages in `packages/`, `apps/`, `libs/`                                   |
| **Project Structure**          | Budgeted tree prioritising root config and important top-level source areas while filtering generated output                           |

## Reporting Evidence

The report is observational. Separate facts directly detected by the scanner
from inferences, and include paths, counts, coverage, or examples when they
make the finding decision-relevant.

For competing conventions, report usage rather than an unconditional
recommendation. For example:

```text
Dependency injection:
- inject(): 93%
- constructor injection: 7%
- confidence: strong
```

Describe what the confidence means:

- **strong**: multiple eligible files show one approach with little competing
  evidence;
- **mixed**: competing approaches are both established, or files contain both;
- **limited**: there is too little evidence to infer a repository-wide pattern.

Make the scan scope clear. Repository-wide prevalence is not feature-local
intent: inspect the affected area and its closest analogue before making a
decision. A well-supported local pattern may intentionally override a broader
majority. Absence of detected syntax is not proof that an alternative is
absent.

Do not turn statistical prevalence into architecture authority, and do not
duplicate framework-specific expertise that belongs in specialist skills.
For CI/CD, report workflow names, jobs, and triggers as observed; inspect the
workflow before reusing any identifier. For backend infrastructure, report the
relevant files and locations without inferring design decisions from their
presence alone.

## Extending

Edit `PATTERN_DEFS` or `CONVENTION_PAIRS` at the top of `scripts/inspect.js`:

```js
// Pattern counting (which approaches are observed)
const PATTERN_DEFS = {
  Category: { "Label A": [/regex/], "Label B": [/regex/] },
};

// Convention pairs (A vs B, preserving mixed evidence)
const CONVENTION_PAIRS = [
  {
    category: "Name",
    scope: "typescript",
    a: { label: "X", re: /x/ },
    b: { label: "Y", re: /y/ },
  },
];
```
