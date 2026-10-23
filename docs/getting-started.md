---
sources:
  - scripts/install.mjs
  - scripts/lib/config.mjs
  - config.schema.json
  - config.example.json
  - skills/ibda/SKILL.md
  - prompts.json
  - scripts/ibni/**
  - skills/rendered-qa/SKILL.md
reviewed: 2026-10-23
---

# Getting started

Setting up mexxi takes two pastes into the agent you already use: one installs mexxi on your machine, and one prepares a repository. After that, you ask for changes with `/wettaq` and review the pull requests it opens.

## What you need, and what each one is for

mexxi runs inside the coding agent you already use, so it needs one of Claude Code, Codex or OpenCode, with its own subscription or API key. mexxi adds no cost of its own. The pasted install prompt below checks the rest for you. To set up by hand, install these first:

- **Node.js 22.13 or newer**, which runs mexxi's installer and its tools.
- **[Git](https://git-scm.com/)**, which gives each task its own copy of the repository.
- **The forge's CLI, signed in**: [`gh`](https://cli.github.com/) for GitHub or [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab. The agent uses it to open the pull request and to see when it has merged, so finished worktrees can be cleaned up. A self-hosted forge also needs its host name in `forge.hosts` ([Configuration](configuration/index.md)).
- **`~/.local/bin` on your `PATH`**, so the agent can run [`ibni`](cli/index.md), the command-line tool it uses for each task's worktree.

Three more are optional or host-specific:

- the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server, which lets the agent drive a real browser to check UI changes. MCP is the standard way to give an agent extra tools. Without this one, the agent cannot click through the app itself, and the pull request's evidence says what did not run;
- the [`ocr`](https://github.com/alibaba/open-code-review) CLI, which picks the files and rules the independent reviewer looks at. With `review.tool` set to `none`, the reviewer reads the whole diff itself instead; and
- `ffmpeg`, which turns recordings of motion into GIFs for the pull request.

## Set up by pasting a prompt

Paste this into Claude Code, Codex or OpenCode. The agent follows mexxi's setup instructions, the `ibda` skill: it checks the prerequisites, asks only what it cannot detect, and shows what it will change before it changes anything. The prompt has your agent follow the instructions in that file, so read it first if you want to know exactly what it will do, or [set up by hand](#set-up-by-hand).

**Install mexxi**

```text
Set up mexxi for me. Read https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md and follow it.
```

When mexxi is installed, open a repository and paste this. [`/lesti`](../commands/lesti.md), the command that gets a repository ready, opens one pull request that adds what the repository lacks and fixes the checks that already fail.

**Prepare a repository**

```text
Make this repository ready for mexxi: run /lesti here.
```

## Set up by hand

Clone mexxi and install:

```bash
git clone https://github.com/alexportelli12/mexxi.git ~/workspace/mexxi
cd ~/workspace/mexxi
npm ci
node scripts/install.mjs
node scripts/install.mjs --check
```

To clone somewhere else, write `{"paths": {"checkout": "<your clone>"}}` to `~/.config/mexxi/config.json` first. The installer refuses to run from any clone but the one that file names.

### Configure it

Everything you might want different lives in one file: `~/.config/mexxi/config.json`, or the file `MEXXI_CONFIG` names. The first install writes a minimal one. Every key is optional and falls back to the default in [Configuration](configuration/index.md). Change that file, never a tracked one, then run the installer again.

### What the installer does

Claude Code, Codex and OpenCode each expect their commands, agents, skills and hooks in their own folders and formats. The installer lets one set of files serve all three, so a change to the workflow reaches every agent, and updates arrive with a `git pull`.

It renders the host files from `config.json` into `~/.local/share/mexxi/generated/`, then links them and the shared files into each host's home. [Configuration](configuration/index.md) lists every link. It never overwrites existing configuration: on a conflict it stops and lists the paths. It also:

- puts `ibni` in `~/.local/bin`;
- adds a `post-merge` hook, so a later `git pull` on `main` reinstalls automatically; and
- preserves your personal Codex `config.toml`.

`install --check` renders again and fails on any difference, so a hand-edited host file or a stale render shows up as a failure.

If you used mexxi before it was renamed, from a clone in `~/.config/opencode`, follow [Migrating from coding-agent-config](migrating-from-coding-agent-config.md). [Host details](host-details.md) covers what each agent needs after installing, the Playwright server and the [guard](glossary.md#guard).

## Prepare your repository

An agent will say its work is done whether or not it is. So mexxi needs one command per repository that answers "does it work?" with a pass or a fail: the [verify command](glossary.md#verify). It runs your tests, linters and build, and a run is finished only when it passes. By default it is `npm run verify`.

[Verifika](https://github.com/alexportelli12/verifika), a small check runner installed as a development dependency, is the recommended way to write one. List the checks in `verifika.config.json`, each with the files it covers, and set the `verify` script in `package.json` to `verifika --all`. Agents then run only the checks a change affects while they work, and the full set at the end. The `/lesti` prompt above does this for you.

A repository that already has one reliable command, such as `make check` or `tox`, can keep it instead. Name it in a committed `.mexxi.json`:

```json
{ "verify": "make check" }
```

Every run starts by running verify once, to prove the starting point is green. Before that, `ibni` installs the repository's dependencies with the command its lockfile names, such as `npm ci` for `package-lock.json`. Name another as `setup` in `.mexxi.json`. That first result is the [baseline](glossary.md#baseline). When your CI already runs the full verify command on every commit, that first run repeats work CI has done. Name the CI job that runs it in `.mexxi.json`, such as `verify` on GitHub Actions, and a run cites the CI result instead:

```json
{ "ciCheck": "verify" }
```

The CI result counts only when that check succeeded on exactly the commit the task starts from. Otherwise, such as when the run is pending, failed or on another commit, the agent runs verify itself as usual. [Configuration](configuration/index.md#settings-in-mexxi-json) lists every `.mexxi.json` key.

## Try it

From the repository's default branch, type this in your agent's chat to ask [`/wettaq`](../commands/wettaq.md), the command that builds a change:

```text
/wettaq show the last sync time on the settings page
```

The agent works on its own and asks you only about product decisions it cannot settle from the code. To start and follow runs from your phone instead, set up [segwi](segwi.md). Its runs start browser tests in Playwright's headless Chromium, so install it once with `npx playwright install chromium`. [How a run works](how-a-run-works.md) walks through what happens next, and [Reviewing a mexxi pull request](reviewing-a-pull-request.md) covers what you check when the pull request arrives.

You rarely run `ibni` yourself. Each task's worktree is kept after its pull request opens, for follow-up changes. A kept worktree and its record are called a [workspace](glossary.md#workspace). Once the pull request merges, the next task you start removes it. An agent working outside `/wettaq` uses `ibni` too when it opens a pull request from your default branch, so its worktree is kept and removed the same way. `ibni list` shows the kept workspaces, and `ibni cleanup` shows what it would remove. The [CLI reference](cli/index.md) lists the few subcommands you might run, and why each exists.
