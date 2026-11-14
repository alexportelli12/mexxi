---
status: Accepted
date: 2026-11-14
---

# 0026. A run owns its pull request until CI is green

Extends [0014](0014-ibni-runs-setup-and-verify.md).

## Context

A run ended when it opened the pull request. 51% of those pull requests still had CI pending when the run said it was done, so a failure there pulled the person back in. So did rebases of stacked pull requests, post-merge steps and "shall I go ahead?" stops. Of 71 context compactions across 88 runs, 61 happened after the pull request was delivered, in long sessions that kept going with follow-ups.

Runs also verified again after syncing with the default branch when the sync brought in nothing. That cost 18 runs, about 22%, a verify run that could not change. `ibni publish` already kept its evidence when the tree was unchanged, but `/wettaq` never said so, so runs verified again anyway.

## Decision

- **`ibni ci-wait` waits on the forge's checks.** It runs in the background, through `gh pr checks --watch` on GitHub or `glab` on GitLab, and prints one line of JSON: the state, the failed jobs and the end of each failure's log.
- **A run is done only on green.** It reports done when CI passes, after up to three rounds of fixes, or with a report of what blocks it.
- **No second verify when the sync brought in nothing.** The tree `ibni publish` would push is the one `ibni verify` passed, so the evidence still holds. A test pins that behaviour, and `/wettaq` says to verify again only when `publish` reports `requiresRevalidation`.
- **Post-merge steps belong to the run.** The pull request lists them, and the follow-up session runs them.
- **Stacks keep the no-force-push rule.** When a lower pull request merges, `ibni` merges the new base into the next branch and retargets its pull request with `gh pr edit --base`. GitHub's native stacked pull requests are not adopted.
- **Follow-ups start fresh.** Once CI is green the run ends. `/wettaq <pull request URL>` in a new session adopts the workspace and reads the pull request, its checks and its review comments.

## Consequences

- The person meets a pull request that has passed CI, or one whose blocker is already explained.
- A run lasts longer, since it now includes CI. The wait happens in the background inside the run's turn ([0023](0023-decide-and-record.md)).
- Follow-ups run in sessions with a clean context, at the cost of re-reading the pull request.
- A merge into a stacked branch adds a merge commit where a rebase would not. That is the price of never force pushing.

## Alternatives considered

- **Leave CI to the person:** the cheapest, and the main reason runs pulled the person back in.
- **GitHub's native stacked pull requests:** they rebase and force push the stack, which mexxi never does, and they do not exist on GitLab.
- **Keep follow-ups in the same session:** cheaper to start, but that is where most compactions happened.
