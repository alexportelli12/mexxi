# mexxi

Hand a coding agent a task. Review the pull request in a minute.

mexxi is a workflow around the coding agent you already use: OpenCode, Claude Code or Codex. It gives every task a fresh worktree, deterministic gates, rendered QA and an independent review. You decide whether to merge.

## The problems

Handing an agent a task and hoping for the best goes wrong in four ways.

- **It skips tests.** One run is careful; the next ships without proof.
- **It never looks at the UI.** The code compiles, and nobody has seen the page.
- **It fights its environment.** Across 89 of my sessions, from 26 September to 20 October, agents hit 386 zsh glob aborts in 77 sessions. They tried 72 edits before reading the file, ran into the 10-minute Bash cap 27 times, and hid 247 exit statuses behind pipes.
- **It hands back a pull request you must reverse-engineer.** I sent 15 follow-up prompts asking for rework, and 28 sessions compacted their context mid-pull request.

## How mexxi solves each one

- **A fresh worktree per task.** `ibni prepare` creates a locked worktree, branch and free port, so parallel tasks never collide. Merged worktrees are swept on the way in.
- **A green `verify` before and after.** The work starts from a passing `npm run verify` and ends with one. `ibni publish` pushes only a tree whose passing run is recorded.
- **Rendered QA.** The agent drives the running UI at three viewports and checks motion, keyboard use, touch targets and console errors. The pull request shows before and after.
- **An independent reviewer.** A read-only reviewer judges substantial changes, and calls how risky the merge is.
- **Guardrails in code as well as in the rules.** A hook backs up the rules against force pushes, merges and pushes to the default branch. Claude Code and OpenCode run it before every shell command, and Codex does once you trust it in `/hooks`. A loop breaker stops a third identical failure. A command fixer quotes globs and keeps pipe failures visible.
- **A pull request you review in a minute.** It carries the tests that protect the behaviour, the evidence, and the screenshots.

The product decisions and the merge stay with you.

## Getting started

Paste this into your agent to install mexxi. It checks the prerequisites, asks what it cannot detect, and shows what it will change before it changes anything:

```text
Set up mexxi for me. Read https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md and follow it.
```

Then paste this in a repository to prepare it. The agent opens one pull request that adds what mexxi needs and fixes the checks that already fail.

```text
Make this repository ready for mexxi: run /lesti here.
```

From the repository's default branch, try a command:

```text
/wettaq show the last sync time on the settings page
```

The [setup guide](https://alexportelli12.github.io/mexxi/docs/getting-started.html) covers prerequisites, each host, the Playwright server and installing by hand.

## The names

The tools are named in Maltese, the author's native language, like [Verifika](https://github.com/alexportelli12/verifika). Everything else is English.

| Name | Meaning | What it does |
| --- | --- | --- |
| mexxi | steer, lead | the repository and the workflow as a whole |
| ibni | build | the worktree CLI: a fresh, isolated worktree per task, through to a published PR |
| /wettaq | carry out | takes a request to a reviewable PR |
| /ittestja | test | hands-on rendered QA; reports, never edits |
| /sewwi | put right | audits or changes the workflow itself |
| /fassal | design, sketch out | writes a product's UX principles |
| /irrifletti | reflect | the session retrospective |
| /lesti | get ready | opens a PR that makes a repository mexxi-ready, whatever it lacks |
| ibda | begin | the setup skill a pasted prompt points to: installs or repairs mexxi |

The [names page](https://alexportelli12.github.io/mexxi/docs/names.html) adds pronunciation hints and the old names, which still work for one release.

## Learn more

The details live in the [docs](https://alexportelli12.github.io/mexxi/docs/), generated from this repository so they cannot drift from it:

- [How a run works](https://alexportelli12.github.io/mexxi/docs/how-a-run-works.html), with a diagram of `/wettaq`.
- [Commands](https://alexportelli12.github.io/mexxi/docs/commands/), [agents](https://alexportelli12.github.io/mexxi/docs/agents/) and [skills](https://alexportelli12.github.io/mexxi/docs/skills/).
- The [`ibni` CLI reference](https://alexportelli12.github.io/mexxi/docs/cli/) and every [configuration key](https://alexportelli12.github.io/mexxi/docs/configuration/).
- The [principles](https://alexportelli12.github.io/mexxi/docs/principles/agents.html) behind it, and a [glossary](https://alexportelli12.github.io/mexxi/docs/glossary.html).

## Using it yourself

Go for it. I made this repository public to share the workflow I use day to day. It is opinionated around how I like to work, so take the parts that fit and change the rest.
