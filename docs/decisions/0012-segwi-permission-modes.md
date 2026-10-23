---
status: Accepted
date: 2026-10-23
---

# 0012. segwi: three permissions modes, auto by default

Supersedes the "Strict permissions" point of [0011](0011-segwi.md).

## Context

[0011](0011-segwi.md) made every call off segwi's allow list an approval that only a person can answer. Real runs showed the cost. A readme change raised two approvals, and an audit fix raised two more before it failed. All four were harmless: a `cd` chained with `cat` and `ls`, a pull request body with a Markdown heading, and two chains of `echo` or `pwd` with an `ibni` command. Each one stopped the run until someone answered on a phone. Claude Code's sandbox already bounds what those commands can write and reach, and its auto mode can judge the rest.

## Decision

- `segwi.permissions` picks one of three modes for build and ready runs, and `segwi.repositories[].permissions` overrides it for one repository.
- **`auto`** is the default. Claude Code runs with `--permission-mode auto`, and its classifier decides each call off the allow list. The agent is told never to retry a refused call in pieces or rephrase it, but to stop and ask, which shows as "Needs your reply". segwi's approval tool stays wired, because auto mode asks it after repeated refusals.
- **`sandboxed`** runs every command inside the sandbox unasked (`autoAllowBashIfSandboxed`), and sends what runs outside the sandbox to a person.
- **`strict`** keeps 0011's behaviour.
- In every mode the sandbox, the deny list, the denied writes and the denied reads are the same, and a test checks that. The file tools run outside the sandbox, and in auto mode a model would judge their writes. So in every mode they are denied the secrets, shell and git config, `~/.config`, `~/.local/bin`, `~/.claude`, the mexxi clone and every configured repository's checkout, existing or not. `git push` and the `gh` commands that change a repository always ask, since in `sandboxed` mode they would otherwise run unasked. An ask run is always `strict`, because it promises to change nothing.
- Each refusal, whether by the classifier, a deny rule or a hook, is a run step and a `run.refused` row in the audit log.

## Consequences

- Existing installs move from `strict` to `auto` when they upgrade, unless they set `segwi.permissions`.
- A normal run waits on you far less. In auto mode a model, not you, has the final say on most calls, and it can be wrong either way; its calls add cost.
- In `sandboxed` mode nothing reviews a command that runs inside the sandbox. Anything the sandbox allows, such as deleting files in the worktree, runs unasked.
- Auto mode needs a model and an account that support it. Without one, Claude Code starts in its default mode, and every call off the allow list goes to a person, as in `strict`.
- The sandbox and the deny list now carry more of the weight, so changes to them need the same care as before, and more.

## Alternatives considered

- **Keep `strict` and widen the allow list:** each real-run shape would need its own rule, and chains of allowed commands still ask.
- **`sandboxed` as the default:** it removes the same approvals, but nothing then looks at what a command inside the sandbox does, which auto mode still does.
