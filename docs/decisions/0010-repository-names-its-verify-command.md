---
status: Accepted
date: 2026-10-22
---

# 0010. Each repository names its verify command

Supersedes [0005](0005-verify-is-the-contract.md).

## Context

[0005](0005-verify-is-the-contract.md) made `npm run verify` the one command that defines "mechanically healthy" for a repository. The interface was right, but its spelling tied it to npm. A Python, Go or Rust repository had to add a `package.json` that existed only to hold that script. `/lesti` added one even when the repository already had a reliable single command for its whole gate, such as `make check`, `cargo test` or `tox`.

## Decision

- A repository that uses mexxi has one verify command that defines "mechanically healthy" for it. The repository owns what it contains; mexxi only depends on the interface.
- The command is `npm run verify` unless the repository's committed `.mexxi.json` names another as `"verify"`. `ibni prepare` reads it from the commit the task starts from and reports it as `verifyCommand`. A `verify` that is not a non-empty string, or a `.mexxi.json` that is not a JSON object, stops `prepare` rather than falling back to the default.
- [Verifika](https://github.com/alexportelli12/verifika) stays the recommended engine, backing `npm run verify` with `verifika --all`. `/lesti` wires it into npm repositories and repositories with no gate, but records an existing reliable command in `.mexxi.json` rather than adding npm or Verifika.
- `/wettaq` requires a green verify command before work starts and again before delivery. A failure means the work is not finished; checks are fixed, never weakened.
- While working, agents run only the checks their change affects (`vfk --changed` where the repository uses Verifika). That is feedback, never a substitute for the final full run.
- A repository can skip the local baseline run by naming, as `ciCheck` in `.mexxi.json`, the CI check that runs its full verify command. `ibni prepare` reuses that check's result only when it passed on the exact commit the task starts from.
- `/lesti` is the one place mexxi installs this contract into a repository, by request and through a reviewed pull request.

## Consequences

- npm repositories behave exactly as before: with no `verify` in `.mexxi.json`, the command is `npm run verify`.
- Other repositories keep their own tooling and need no `package.json` for mexxi's sake.
- A repository without Verifika has no selective runs, so agents get slower feedback while working. The final gate is unchanged.
- Instructions say "the verify command" instead of a literal command, so agents must carry `verifyCommand` from `prepare` or `adopt` through the run.
- Because `.mexxi.json` is read from the base commit, a branch that changes `verify` takes effect only once it is merged.
- A retained workspace keeps the verify command it was prepared with. A follow-up after the default branch changes `verify` still runs the old command until a fresh `prepare`.

## Alternatives considered

- **Keep `npm run verify` everywhere:** one spelling, but it forces npm onto repositories that have no other use for it.
- **Name the command in mexxi's user config:** it would differ by machine, while the command belongs to the repository and its CI.
- **Detect the command from the stack:** convenient, but a guess is exactly the inconsistency the contract exists to remove.
