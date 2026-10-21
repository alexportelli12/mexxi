---
sources:
  - AGENTS.md
  - skills/workflow-for-alex/SKILL.md
  - scripts/ibni/ibni.mjs
  - names.json
reviewed: 2026-10-21
---

# Glossary

Each concept has one name across the docs. When two words could mean the same thing, this page says which one to use.

| Term | Meaning |
| --- | --- |
| **agent** | A specialist role such as the code-reviewer, defined once in `agent/` and rendered for each host. |
| **baseline** | The result of `npm run verify` on the base commit, run or cited before work starts. |
| **command** | A workflow you start by name, such as `/wettaq`. A command is a Markdown file in `commands/`. |
| **default branch** | The branch pull requests target, usually `main`. |
| **evidence directory** | The folder where a run keeps screenshots, recordings and notes. `ibni prepare` reports it as `evidenceDir`. |
| **gate** | A check a run must pass before it moves on, such as `verify`, rendered QA or review. |
| **guard** | The hook that backs up the rules against dangerous commands. Codex runs it only once you trust it in `/hooks`. |
| **host** | A coding agent that mexxi installs into: OpenCode, Claude Code or Codex. |
| **mod** | A Claude Code plugin shipped in `claude/mods/`, such as the run pane. |
| **pull request** | What a run delivers. Write "pull request" in full the first time; "PR" is fine after. |
| **rendered QA** | Driving the running UI by hand and capturing evidence. It is a gate for user-facing changes. |
| **session** | One agent conversation. `ibni` finds its workspace from the session ID. |
| **skill** | Specialist expertise an agent loads by matching its name and description. |
| **verify** | The repository's own `npm run verify`, which defines "mechanically healthy" for that project. |
| **workspace** | A retained worktree together with its record: branch, port, evidence directory and pull request. `ibni list` lists them. |
| **worktree** | A Git worktree created for one task. Do not call it a folder or a working directory. |

## Names

The Maltese names are listed with their meanings on [The names](names.md).
