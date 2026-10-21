---
description: Audit or coherently update Alex's global coding-agent workflow configuration
---

# Update My Workflow: $ARGUMENTS

Load the `workflow-for-alex` skill before doing anything else. Treat it as the
architectural and governance source of truth for this configuration.

If `$ARGUMENTS` is present, investigate the reported workflow problem. If it is
empty, perform a general audit. In either mode:

1. Inspect the relevant current files and, for a broad audit, the root
   configuration holistically: `AGENTS.md`, agents, commands, skills,
   references, `.gitignore`, installation tooling, `config.schema.json`, and
   the host adapter templates (`opencode/`, `claude/`, `codex/`).
2. Search for every instruction touching the concern.
3. Identify the current owner or owners and classify the finding as
   contradiction, duplication, stale instruction, wrong ownership, missing
   deterministic protection, missing expertise, orchestration inefficiency, or
   not a workflow problem.
4. Prefer replacing, moving, consolidating, or deleting an existing instruction
   over adding another one.
5. When responsibility moves, establish the new owner, remove obsolete
   duplicates, search for stale references, and inspect the result as a whole.
6. Keep behavioural instructions in shared sources; place models, permissions,
   MCP and installation details in host adapters. Check all supported hosts and the
   configuration verification gate after changing integration.
7. Update the docs pages the change affects in the same change, following
   `docs-writing`. Generated pages follow their sources; for a hand-written
   page, edit it in place (never append a duplicate) or bump its `reviewed`
   date when nothing needs to change. `docs-fresh` names the pages to review.

For a requested change, implement the smallest coherent correction justified by
the evidence. Do not add a new agent, skill, command, or reference unless its
responsibility is distinct and recurring enough to earn its maintenance cost.

Audit semantic contradictions explicitly. Searches find candidate overlaps;
reason about whether instructions actually conflict. Check especially for
competing final-verification owners, reviewers implementing changes, global
framework or tooling absolutes overriding repository evidence, stale references,
and commands duplicating specialist expertise.

Identify prose that could be mechanically enforced, but do not add
repository-specific tooling from this global configuration. Classify the
opportunity for the repository's own `verify`, tests, architecture checks, or
other appropriate owner instead.

## Re-run Trigger Evals

When a change edits the `description` of a core skill (`rendered-qa`,
`repo-context`, `commit-pr-writing`, `verifika`), run that skill's eval set
before reporting. These need model calls, so they are not part of `npm run
verify` (which only checks the sets are well formed). From
`skills/skill-creator` in the checkout, once per installed host:

```bash
for host in claude opencode codex; do
  SKILL_CREATOR_HOST=$host python -m scripts.run_eval \
    --eval-set ../../evals/triggers/<skill>.json --skill-path <skill-folder> \
    --runs-per-query 3 --timeout 120 --verbose
done
```

`<skill-folder>` is `../<skill>`, or `../../node_modules/verifika/skills/verifika`
for `verifika`. Every query must pass on every host (`summary.failed` is 0);
fix the description, not the eval, unless a query is wrong. The Codex run tests
the description installed from the primary checkout, which a branch does not
change: run it after the pull request is merged and installed, and report it as
pending until then.

## Reconcile Host Installation

After a workflow change passes this repository's `npm run verify`, run
`npm ci` (when dependencies changed) and `node scripts/install.mjs` from the
**primary configuration checkout**, then
`node scripts/install.mjs --check`. Also do this on a no-change audit to catch
missing links. This is the installation step for all supported hosts and the shared
executables; do not make application repositories handle it.

First establish whether the checkout being edited is the primary worktree or
an isolated feature worktree (`git rev-parse --absolute-git-dir` and
`git rev-parse --git-common-dir`). Never install from an unmerged feature
worktree: it would point global agent configuration at a PR branch. For the
same reason, deliver workflow changes from a linked worktree and never switch
the primary checkout off `main`. When editing from a feature worktree, leave
the live installation on the primary checkout and explicitly report that
installation is pending until the change is merged and pulled into the primary
checkout. The installer's local `post-merge` hook runs on that
fast-forward pull if it has been bootstrapped; otherwise report the one-time
`node scripts/install.mjs` setup step. Do not claim all supported hosts are
updated merely because a PR was published. If the installer finds existing
configuration conflicts or a missing bin directory on `PATH`, report its
diagnostic; do not replace user configuration or bypass its preflight.

Make only clearly justified, low-risk changes during a general audit. Report a
larger architectural change before implementing it. Do not manufacture work:
no meaningful workflow change is a valid result.

For a requested change, report what changed and why, what ownership moved or
was consolidated, and important alternatives deliberately rejected. For a
general audit, report meaningful findings, applied cleanup, and any larger
findings left for a deliberate decision. Keep the report concise.
