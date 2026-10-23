# mexxi

Coding agents write code fast. mexxi makes them prove it works.

A coding agent is an AI tool that works in your repository: it reads the code, runs commands and makes changes. Give the one you already use, Claude Code, Codex or OpenCode, a task in plain words. You get back one pull request that passes your repository's own checks, with screenshots from a real browser and a plain call on whether it is safe to merge. You still decide: mexxi never merges. It runs on your machine, with the agent and subscription you already have, and needs no service or account of its own.

*mexxi* is Maltese for "to lead, to manage". [The names](https://alexportelli12.github.io/mexxi/docs/names.html) explains the rest of the Maltese.

## The problem

Coding agents can now take a whole task: read the code, make the change and open a pull request. That moves the slow part of the job. Writing the code is quick; trusting it is not.

What an agent hands back on its own is hard to trust:

- **It skips tests.** One run is careful; the next ships without proof, and says "all tests pass" either way.
- **It never looks at the UI.** The code compiles, and nobody has opened the page.
- **It loses time to its environment.** It retries the same failing command and hides failed steps.
- **Its pull request needs reverse-engineering.** You read the whole diff to learn what it did and why.

So you either read every line, which costs the time the agent saved, or merge on trust.

## How mexxi solves it

mexxi moves the checking into the run, so the pull request arrives with its proof. [The ideas behind mexxi](https://alexportelli12.github.io/mexxi/docs/ideas.html) explains each one.

- **Each task gets its own copy of the repository**, so your checkout stays untouched and tasks can run side by side.
- **A pass/fail command defines done.** Your repository's checks, `npm run verify` by default, must pass before work starts and again at the end. The agent records the exact code its checks passed on with `ibni`, the command-line tool it runs, and `ibni` refuses to push any other code. A later change has to be checked and recorded again.
- **Somebody looks at the page.** For UI changes the agent drives the running app in a real browser at phone, tablet and desktop sizes, and the pull request shows before and after.
- **A second reviewer judges it.** A reviewer agent that cannot edit code judges substantial changes. It is an extra opinion; the checks and the browser are the proof.
- **Guardrails in code as well as in the rules.** A hook backs up the rules against force pushes, merges and pushes to the default branch, and another stops an agent that keeps retrying a failing command.
- **The first screen does the explaining.** The pull request opens with the merge call, the decisions only you can make, and the evidence: which checks ran, and which did not.

To see the difference, compare two pull requests for the same request in a small demo app: [without mexxi](https://github.com/alexportelli12/mexxi-demo/pull/1) and [with mexxi](https://github.com/alexportelli12/mexxi-demo/pull/2). [Reviewing a mexxi pull request](https://alexportelli12.github.io/mexxi/docs/reviewing-a-pull-request.html) explains each part and what to check in a minute.

## Getting started

You need one of Claude Code, Codex or OpenCode, Node.js 22.13 or newer, and Git. You also need the forge's CLI, signed in, to open the pull request: `gh` for GitHub or `glab` for GitLab.

Three tools are optional. The [Playwright MCP](https://github.com/microsoft/playwright-mcp) server lets the agent drive a browser itself; without it, the pull request's evidence says which checks did not run. The review tool [OpenCodeReview](https://github.com/alibaba/open-code-review) (`ocr`) picks what the reviewer looks at. `ffmpeg` makes GIFs.

Paste this into your agent to install mexxi. It checks the prerequisites, asks what it cannot detect, and shows what it will change before it changes anything:

```text
Set up mexxi for me. Read https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md and follow it.
```

Then paste this in a repository to prepare it. `/lesti` opens one pull request that adds what mexxi needs, such as the verify command, and fixes the checks that already fail.

```text
Make this repository ready for mexxi: run /lesti here.
```

From the repository's default branch, type this in your agent's chat to ask for a change with `/wettaq`, the command that builds it:

```text
/wettaq show the last sync time on the settings page
```

The [setup guide](https://alexportelli12.github.io/mexxi/docs/getting-started.html) covers installing by hand and what each prerequisite is for.

## What's in the box

Coding agents load their instructions as *commands* you type, *agents* they can hand part of a task to, and *skills* they load only when a task needs them. The [glossary](https://alexportelli12.github.io/mexxi/docs/glossary.html) explains each term.

- **Commands** you type in your agent: `/wettaq` builds a change, `/ittestja` tests a UI by hand in a browser, and `/lesti` gets a repository ready. Three more look after the workflow itself: `/fassal` writes UX principles, `/sewwi` changes the workflow and `/irrifletti` looks back at sessions.
- **Agents**: an independent code reviewer and a UI designer, each with the tools it needs and no more.
- **Skills**: browser checks, repository mapping, commit and pull request writing, and the review step.
- **`ibni`**, which takes each task's worktree from `prepare` to `publish`, with step timings.
- **Guardrails**: rules forbid force pushes and merges, and a guard hook backs them up. When one command fails a third time, the agent must stop and rethink.
- **Retrospectives**: `/irrifletti` measures how recent sessions went, privately, on your machine.
- **One experiment**: Jev triage, which asks an outside model which checks a task needs and only records the answer. It sends metadata, never code, and is off unless you turn it on.

The same files serve Claude Code, Codex and OpenCode; [Host details](https://alexportelli12.github.io/mexxi/docs/host-details.html) says what each one adds.

## The names

The tools are named in Maltese, the author's native language, like [Verifika](https://github.com/alexportelli12/verifika). Each name is an everyday word for the tool's job: `/wettaq` means "to carry out", `/lesti` "to get something ready" and `ibni` "to build". [The names](https://alexportelli12.github.io/mexxi/docs/names.html) is a small dictionary of all of them.

## Learn more

The details live in the [docs](https://alexportelli12.github.io/mexxi/docs/), generated from this repository so they cannot drift from it:

- [The ideas behind mexxi](https://alexportelli12.github.io/mexxi/docs/ideas.html): each problem, and what mexxi does about it.
- [Reviewing a mexxi pull request](https://alexportelli12.github.io/mexxi/docs/reviewing-a-pull-request.html): what to check, and what stays your job.
- [How a run works](https://alexportelli12.github.io/mexxi/docs/how-a-run-works.html), step by step.
- [Commands](https://alexportelli12.github.io/mexxi/docs/commands/), [agents](https://alexportelli12.github.io/mexxi/docs/agents/) and [skills](https://alexportelli12.github.io/mexxi/docs/skills/).
- The [`ibni` CLI reference](https://alexportelli12.github.io/mexxi/docs/cli/) and every [configuration key](https://alexportelli12.github.io/mexxi/docs/configuration/).
- [Where the problems come from](https://alexportelli12.github.io/mexxi/docs/where-the-problems-come-from.html): what my own sessions measured.
- The [principles](https://alexportelli12.github.io/mexxi/docs/principles/agents.html) behind it, and a [glossary](https://alexportelli12.github.io/mexxi/docs/glossary.html).

## Using it yourself

Go for it. I made this repository public to share the workflow I use day to day. It is opinionated around how I like to work, so take the parts that fit and change the rest.

mexxi is released under the [MIT licence](LICENSE). To send a change back, read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Credits

The [frontend-design](skills/frontend-design/) and [skill-creator](skills/skill-creator/) skills are adapted from Anthropic's [skills repository](https://github.com/anthropics/skills), under the Apache License 2.0. Each folder keeps its licence in `LICENSE.txt`.
