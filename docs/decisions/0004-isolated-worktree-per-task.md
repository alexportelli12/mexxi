---
status: Superseded by 0014
date: 2026-10-21
---

# 0004. One isolated worktree per task, run by ibni

## Context

Agents working in the person's own checkout switched branches, stashed work and left the tree dirty. Parallel tasks collided on files, branches and dev-server ports. Git safety written as prose instructions depended on the agent remembering it, and recovery attempts after a failed push were the riskiest moments of a run.

## Decision

- Every `/wettaq` task gets its own linked worktree and branch. `ibni prepare` creates them from the up-to-date default branch.
- The person's normal checkout is the control worktree. Feature work never happens there.
- `ibni` owns the Git lifecycle: prepare, sync, record evidence, publish, publish media, mark the pull request, adopt and clean up. Each command checks ownership from the workspace's metadata and fails closed when anything is ambiguous: a dirty tree, another session's worktree, a Git operation in progress, or unproven history.
- Delivery is always a pull request. `ibni` pushes only the owned feature branch and never force-pushes. Merging stays with a person.
- Workspaces are kept after the pull request opens, so follow-ups can continue. `ibni adopt --pr` lets a new session take over after proving the branch, head and metadata match.
- `prepare` cleans up a workspace only once GitHub says its pull request merged and Git proves its history reached the default branch.
- Evidence such as screenshots and review background goes in an evidence directory beside the worktree, never inside it.

## Consequences

- The person's checkout is never touched by a run, and tasks can run in parallel.
- Every `ibni` command prints JSON, so the run pane and the retro read the same record the agent acts on.
- Each worktree needs its own dependency install. That costs time, but a shared `node_modules` would let tasks corrupt each other.
- `ibni` is the most safety-critical code in the repository, and its test suite is the proof that a refactor changed nothing.

## Alternatives considered

- **Branches in the person's checkout:** no extra disk or installs, but it collides with their own work and with parallel tasks.
- **Git safety as prose only:** cheaper to write, but the retro showed agents improvising risky recovery when instructions were all they had.
