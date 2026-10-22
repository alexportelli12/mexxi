---
description: Run hands-on rendered QA of a route, flow, pull request, or implementation session and report findings without changing code
summary: >-
  Use it to see how a page, a flow or a pull request really behaves before you merge. You get
  a findings report with a severity, a screenshot and steps to reproduce for each problem; it
  never changes code. It needs the app to run locally and the Playwright MCP server.
---

# QA: $ARGUMENTS

Exercise the running UI named by `$ARGUMENTS` (a route, a flow, a pull
request, or an implementation session) and return a findings report. QA
observes and reports; it never edits code, commits, or switches branches.

## Resolve The Target

1. If `$ARGUMENTS` or this session identifies a retained implementation
   workspace, run `ibni info --session "<sessionId>"`. For
   a pull request, find its workspace with `ibni list` by
   `prUrl`. Work in that `worktreePath`, start the app on its recorded `port`,
   and write evidence to its `evidenceDir`.
2. Otherwise use the current checkout and a fresh system temporary directory
   for evidence. For a pull request with no retained workspace, confirm with
   `gh pr view` that the checkout is on its head branch; if it is not, say so
   and stop rather than switching branches.
3. Derive the routes, states and flows to exercise from the arguments and,
   for a pull request or session, from its description and diff.

## Run The Pass

Load `rendered-qa` and follow it against the resolved target.

## Report

Return the `rendered-qa` report: each finding's severity, what you saw, where
(route, section and viewport), how to reproduce it, its evidence path, and the
smallest suggested fix. Then list what was tested and worked, the checks you
skipped, and the suggested executable checks.

Stop after the report. Fixes go through `/wettaq`'s follow-up path, which
adopts the pull request's workspace when this session does not own it, or a
new request when there is no pull request.
