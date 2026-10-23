---
status: Accepted
date: 2026-10-23
---

# 0014. ibni installs dependencies and runs the verify command

Supersedes [0004](0004-isolated-worktree-per-task.md) and [0010](0010-repository-names-its-verify-command.md).

## Context

[0004](0004-isolated-worktree-per-task.md) gave `ibni` the Git lifecycle, but two steps stayed with the agent: installing dependencies in the new worktree, and running the verify command. `/wettaq` told the agent to use "the repository's documented setup" or `npm ci`. `ibni record-evidence` took the agent's word that the verify command had passed.

The 2026-10-23 retro still showed both steps going wrong after `ibni` landed. Agents wrote their own wait loops around a long verify run, hit the Bash output cap on its log and misused `ibni` commands. Nothing tied the evidence to a verify run that actually happened, on the code being pushed.

## Decision

Everything in [0004](0004-isolated-worktree-per-task.md) and [0010](0010-repository-names-its-verify-command.md) still holds, with these changes.

- **`ibni` installs dependencies.** `ibni prepare` runs a setup command in the new worktree after it copies the local environment files, logs it to the evidence directory and reports it as `setup`. A failed setup rolls the new workspace back, like any other `prepare` failure.
- **The setup command comes from the repository.** `"setup"` in the committed `.mexxi.json` names it, read from the base commit and checked the way `verify` is. Without one, a lockfile at the root names it: `package-lock.json` means `npm ci --prefer-offline --no-audit --no-fund`, and `pnpm-lock.yaml` means `pnpm install --frozen-lockfile --prefer-offline`. With neither, or with more than one lockfile, `ibni` installs nothing and says why.
- **`ibni` runs the verify command.** `ibni verify --session <id>` runs the session's verify command from the worktree root on a clean, committed tree. It writes the output to a log in the evidence directory and records the tree, the commit, the result, the exit code and the duration. Its own output is one line of JSON, so the agent can run it in the background and read only the result.
- **A branch may add a gate, never replace one.** `ibni verify` runs the verify command the default branch names. Only when the default branch has none at all does it run the one the branch's `.mexxi.json` names, and it reports `commandSource: branch`. Without this, `/lesti` could never pass the gate in a repository it is making ready.
- **Push only a tree `ibni` verified.** `ibni record-evidence` and `ibni publish` refuse unless `ibni verify` passed on exactly the tree being recorded or pushed. When `publish` brings in upstream changes that change the tree, the next step is `ibni verify` again.
- **The baseline is a verify run like any other.** Before the first commit the worktree holds exactly the base commit, so `ibni verify` there is the baseline run. When `prepare` proved a passing CI run on the base commit (`baseline.reused`), `ibni verify` on that tree records the CI run instead of running the command again.
- **A launcher with a sandbox can defer setup.** segwi runs `ibni prepare` outside its sandbox, because only there can it update the checkout. A setup command runs the repository's code, such as npm install scripts, which must stay inside the sandbox. segwi sets `IBNI_DEFER_SETUP=1`, so `prepare` installs nothing and the run calls `ibni setup --session <id>` inside the sandbox instead.
- **`ibni adopt` reports, never reinstalls.** It says whether the retained worktree's lockfiles still match the last recorded setup, and what to run when they don't.
- **Agents still run targeted checks.** While working, agents run only the checks their change affects (`vfk --changed` where the repository uses Verifika). Only the full gate moves into `ibni`.
- **The rules stay rules** ([0006](0006-rules-stay-rules-guard-backs-up.md)). `/wettaq` still says when to verify and what a failure means. The gate in `record-evidence` and `publish` backs that up.

### Why a lockfile may name the setup command

[0010](0010-repository-names-its-verify-command.md) rejected detecting the verify command from the stack, because that would be a guess. A lockfile is not a guess. It belongs to exactly one package manager, and that manager has one command that installs exactly what the lockfile pins. `ibni` maps a lockfile's name to a fixed command and never reads the lockfile's contents. A repository whose setup is anything else names it in `.mexxi.json`. When the evidence is ambiguous, such as two lockfiles, `ibni` installs nothing.

## Consequences

- Agents no longer write wait loops or read verify logs in full. They run `ibni verify` in the background and read one JSON result, with the end of the log when it fails.
- A push carries a verify result `ibni` saw itself, bound to the pushed tree. A later commit, an integration or an edit makes it stale.
- The gate reads the workspace's metadata, which sits in the repository's Git directory. An agent that edits that file directly could forge a result. The gate stops honest mistakes, not a hostile agent; the rules and the review still matter.
- Workspaces prepared before this change have no recorded setup or verify run. They still adopt and publish: `adopt` says it can't tell whether the dependencies are current, and `record-evidence` or `publish` names `ibni verify` as the next step.
- Apart from the case where the default branch has no verify command, `ibni verify` runs exactly the session's `verifyCommand`. So the retained-workspace caveat in [0010](0010-repository-names-its-verify-command.md) still applies.
- The result binds to the commit and a clean tree at the start and the end of the run. An edit made and undone while it runs goes unnoticed, which only a hostile agent would do.
- Setup and verify have no time limit. A hung install holds `prepare` until it is stopped.
- `ibni prepare` takes longer, because it now includes the install. The repository lock is not held while the install runs, so other sessions are not blocked.
- A repository that uses Yarn, or any other setup, needs `"setup"` in `.mexxi.json`. Yarn has two lockfile formats with different install flags, so its lockfile alone does not name one command.

## Alternatives considered

- **Keep both steps with the agent, and only tighten the instructions:** cheaper, but the retro showed the instructions alone were not followed reliably.
- **Have `record-evidence` run the verify command itself:** one command fewer, but it would hold the agent in a foreground call for the whole run. That is where the wait loops and output caps came from.
- **Detect setup from the stack, such as `package.json` without a lockfile:** that is the guess [0010](0010-repository-names-its-verify-command.md) rejected. A missing lockfile means `ibni` installs nothing.
- **Run setup in segwi's `prepare` outside the sandbox:** simpler, but install scripts would run with access to the whole machine.
