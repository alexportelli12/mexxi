# mexxi

Your coding agent's pull requests arrive tested, checked in a real browser and reviewed, so you can approve them without reading every line.

You already hand tasks to Claude Code, Codex or OpenCode, and you read less of the code each time. mexxi is a workflow for that agent. Ask for a change with `/wettaq` (build it) and you get back one pull request. Its first screen says what changed, whether it is safe to merge, and what is left for you to decide.

[Reviewing a mexxi pull request](https://alexportelli12.github.io/mexxi/docs/reviewing-a-pull-request.html) explains each part of that pull request and what to check in a minute.

## The problems

Handing an agent a task and hoping for the best goes wrong in four ways.

- **It skips tests.** One run is careful; the next ships without proof.
- **It never looks at the UI.** The code compiles, and nobody has opened the page.
- **It fights its environment.** It retries the same failing command, trips over shell quoting and hides failed steps.
- **It hands back a pull request you must reverse-engineer.** You read the whole diff to learn what it did and why.

## How mexxi solves each one

- **Each task gets its own copy of the repository.** `ibni` (the worktree CLI) creates a Git worktree and branch per task, so parallel tasks never collide and your checkout stays untouched.
- **Your checks pass before and after.** The work starts from a passing run of your repository's verify command (`npm run verify` by default) and ends with one. `ibni publish` refuses to push a branch without a recorded passing run.
- **The agent looks at what it built.** For UI changes it drives the running app in a real browser at phone, tablet and desktop sizes. The pull request shows before and after.
- **A second agent reviews it.** A reviewer that cannot edit code judges substantial changes and says how risky the merge is.
- **Guardrails in code as well as in the rules.** A hook backs up the rules against force pushes, merges and pushes to the default branch. Another makes the agent stop and rethink when the same command fails a third time.
- **A pull request you review in a minute.** Its first screen gives the merge call, your part and the evidence: which checks ran, and which did not.

The product decisions and the merge stay with you.

To see the difference, compare two pull requests for the same request in a small demo app: [without mexxi](https://github.com/alexportelli12/mexxi-demo/pull/1) and [with mexxi](https://github.com/alexportelli12/mexxi-demo/pull/2).

## Getting started

You need Node.js 22.13 or newer, Git, the GitHub CLI (`gh`), and one of Claude Code, Codex or OpenCode. Optional: the review tool ([OpenCodeReview](https://github.com/alibaba/open-code-review), `ocr`), the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server for browser checks, and `ffmpeg` for GIFs.

Paste this into your agent to install mexxi. It checks the prerequisites, asks what it cannot detect, and shows what it will change before it changes anything:

```text
Set up mexxi for me. Read https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md and follow it.
```

Then paste this in a repository to prepare it. `/lesti` (get a repo ready) opens one pull request that adds what mexxi needs and fixes the checks that already fail.

```text
Make this repository ready for mexxi: run /lesti here.
```

From the repository's default branch, ask for a change:

```text
/wettaq show the last sync time on the settings page
```

The [setup guide](https://alexportelli12.github.io/mexxi/docs/getting-started.html) covers installing by hand, and [Host details](https://alexportelli12.github.io/mexxi/docs/host-details.html) covers each agent and the Playwright server.

## The names

The tools have Maltese names, from the author's native language, like [Verifika](https://github.com/alexportelli12/verifika). Each comes with its job: `/wettaq` (build it), `/ittestja` (test the UI), `/lesti` (get a repo ready), `/fassal` (write UX principles), `/sewwi` (change the workflow), `/irrifletti` (look back at sessions) and `ibni` (the worktree CLI). [The names](https://alexportelli12.github.io/mexxi/docs/names.html) gives each one's meaning.

## Learn more

The details live in the [docs](https://alexportelli12.github.io/mexxi/docs/), generated from this repository so they cannot drift from it:

- [Reviewing a mexxi pull request](https://alexportelli12.github.io/mexxi/docs/reviewing-a-pull-request.html): what to check, and what stays your job.
- [How a run works](https://alexportelli12.github.io/mexxi/docs/how-a-run-works.html), with a diagram of `/wettaq`.
- [Commands](https://alexportelli12.github.io/mexxi/docs/commands/), [agents](https://alexportelli12.github.io/mexxi/docs/agents/) and [skills](https://alexportelli12.github.io/mexxi/docs/skills/).
- The [`ibni` CLI reference](https://alexportelli12.github.io/mexxi/docs/cli/) and every [configuration key](https://alexportelli12.github.io/mexxi/docs/configuration/).
- The [principles](https://alexportelli12.github.io/mexxi/docs/principles/agents.html) behind it, and a [glossary](https://alexportelli12.github.io/mexxi/docs/glossary.html).

## Where the problems come from

They are measured, not guessed. Across 89 of my sessions, from 26 September to 20 October, agents hit 386 zsh glob aborts in 77 sessions. They tried 72 edits before reading the file, ran into the 10-minute Bash cap 27 times, and hid 247 exit statuses behind pipes. I sent 15 follow-up prompts asking for rework, and 28 sessions compacted their context mid-pull request.

## Using it yourself

Go for it. I made this repository public to share the workflow I use day to day. It is opinionated around how I like to work, so take the parts that fit and change the rest.
