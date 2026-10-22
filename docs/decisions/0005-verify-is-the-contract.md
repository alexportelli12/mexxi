---
status: Superseded by 0010
date: 2026-10-21
---

# 0005. `npm run verify` is each repository's deterministic contract

## Context

Each application repository checks itself differently: lint, types, unit tests, builds and end-to-end tests in varying combinations. A global workflow that listed those checks would be wrong for most repositories and stale for the rest. Agents also skipped slow checks or ran different subsets on different days.

## Decision

- A repository that uses mexxi exposes one command, `npm run verify`, which defines "mechanically healthy" for that repository. The repository owns what it contains; mexxi only depends on the interface.
- [Verifika](https://github.com/alexportelli12/verifika) is the recommended engine. A repository lists its checks in `verifika.config.json` and backs `verify` with `verifika --all`.
- `/wettaq` requires a green `verify` before work starts and again before delivery. A failure means the work is not finished; checks are fixed, never weakened.
- While working, agents run only the checks their change affects (`vfk --changed`). That is feedback, never a substitute for the final full run.
- A repository can skip the local baseline run by naming its CI check in `.mexxi.json`. `ibni prepare` reuses that check's result only when it passed on the exact commit the task starts from.
- `/lesti` is the one place mexxi installs this contract into a repository, by request and through a reviewed pull request.

## Consequences

- The workflow stays the same across very different repositories, and each repository keeps its own judgement about what to check.
- A repository without `verify` can't use `/wettaq` until `/lesti` has prepared it.
- The quality of the gate is only as good as the repository's checks. mexxi suggests checks from rendered QA findings, but never adds them on its own.
- Reusing a CI result trusts that CI ran the same full gate. The opt-in names the check explicitly so that trust is a decision, not an accident.

## Alternatives considered

- **A global list of checks in mexxi:** consistent, but wrong for most repositories.
- **Letting the agent decide what to run:** flexible, but it is exactly the inconsistency the contract exists to remove.
