---
status: Accepted
date: 2026-11-20
---

# 0027. segwi reads GitHub, read-only, to say whether a pull request is ready

## Context

A segwi run is `completed` when the agent's turn ends and a pull request exists. That says nothing about CI, review, conflicts or whether the diff loosened a check, and a client could only take the agent's word for those ([issue #67](https://github.com/alexportelli12/mexxi/issues/67)). The facts that settle them live on GitHub: the pull request's head commit, its check runs and statuses, the base branch's required checks and the diff.

Until now segwi never talked to GitHub. [Decision 0016](0016-segwi-runs-trusted-like-own-sessions.md) left what reaches GitHub to the token the GitHub CLI holds for a run, which can push and open pull requests. segwi itself held no GitHub credential, so adding one changes what segwi can reach.

## Decision

- **Readiness is advisory and fail-closed.** `get_run` and the web app show `readiness: { ready, checks: [{ name, pass, detail }] }`, ten named checks computed from what segwi recorded and what it fetched, never from the agent's words. A check whose facts can't be had fails and says why, so `ready` is true only when every check passed. Nothing merges, approves, marks a pull request ready or changes a repository's required checks.
- **segwi holds its own token, separate from the GitHub CLI's.** It is a fine-grained token, limited to the repositories in `segwi.repositories` with read-only access to contents, pull requests, checks and commit statuses. `segwi github-token set` reads it from standard input and stores it in the state directory with mode 0600, like the VAPID keys. segwi refuses a classic token, which can't be limited that way, and refuses a token file that other users can read. It reads the token on each check, so replacing or removing it needs no restart. Without it, every check that needs GitHub fails and says how to set it up.
- **The reader only reads, and only the listed repositories.** Every request is a GET to `api.github.com`, under the `owner/repo` that the listed checkout's `origin` remote names. A pull request in any other repository is not read, and its checks fail. Text that comes from GitHub reaches MCP clients inside the same untrusted wrapper as run output.
- **The repository's own settings decide what CI must show.** The CI check that runs the full verify command is the `ciCheck` in `.mexxi.json` on the base branch, as `ibni prepare` reads it. A pull request can't rename the check it is judged by, and a repository without one can't be ready.
- **The reviewed commit comes from ibni.** `ibni record --review` keeps the worktree's HEAD when nothing is uncommitted, and readiness compares it with the pull request's head.
- **Only a person accepts a gate-weakening change**, in the web app, for one head commit. The acceptance is stored with who accepted it and what it covered, and audited. A new push needs a new acceptance. No MCP tool can set, accept or override any check.

## Consequences

- segwi's state directory now holds a GitHub credential. It can read the listed repositories' code and pull requests, and nothing else, as long as the person creates the token as the docs say. segwi can check the token's kind but not its permissions, so a fine-grained token given write access would still only ever be used for GET requests.
- As with approvals ([decision 0016](0016-segwi-runs-trusted-like-own-sessions.md)), a command a run runs is a process of yours and could reach the web app's accept route, or read the token file. Acceptance keeps an agent that follows its rules out of the decision; it doesn't wall off one that breaks them.
- Each check costs a handful of GitHub requests, cached for 30 seconds per run. That fits a fine-grained token's hourly limit at the polling pace that [Using segwi from a bot](../segwi.md#using-segwi-from-a-bot) asks for.
- ibni keeps counts only, never a finding's text, so it has no written reason for dismissing a finding. A review pass whose findings weren't all fixed or left open fails readiness until ibni can record such a reason.
- Only github.com is read. A repository on GitLab or GitHub Enterprise is never ready.

## Alternatives considered

- **Use the GitHub CLI's token through `gh`:** that token can push, comment and merge, so segwi would hold far more than reading needs. Its scope would also be whatever the person gave the CLI.
- **Trust what the agent reports, or ibni's own records of CI:** both come from the agent's side of the trust boundary, which is the claim readiness exists to check.
- **Let a bot accept a gate-weakening change through MCP:** the point of the check is that a person sees the loosened check before the pull request reaches them as ready.
