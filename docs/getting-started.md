---
sources:
  - scripts/install.mjs
  - scripts/lib/config.mjs
  - config.schema.json
  - config.example.json
  - skills/ibda/SKILL.md
  - prompts.json
reviewed: 2026-10-22
---

# Getting started

You can set mexxi up by pasting one prompt into the agent you already use, or by running the installer yourself. Both end at the same check: `install --check` passes.

## What you need

mexxi runs inside one of Claude Code, Codex or OpenCode. The pasted prompt below checks everything else for you; to set up by hand, install these first.

You need Node.js 22.13 or newer, [`git`](https://git-scm.com/), a signed-in forge CLI, and `~/.local/bin` on your `PATH`. The forge CLI is [`gh`](https://cli.github.com/) for GitHub or [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab; a self-hosted forge also needs its host name in `forge.hosts` ([Configuration](configuration/index.md)). Three more tools are optional or host-specific:

- the [`ocr`](https://github.com/alibaba/open-code-review) CLI, which the independent review uses unless you set `review.tool` to `none`;
- the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server, which rendered QA needs; and
- `ffmpeg`, if you want GIFs of motion.

## Set up by pasting a prompt

Paste this into Claude Code, Codex or OpenCode. The agent installs mexxi and asks you only what it cannot detect.

**Install mexxi**

```text
Set up mexxi for me. Read https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md and follow it.
```

When mexxi is installed, open a repository and paste this. [`/lesti`](../commands/lesti.md) (get a repo ready) opens one pull request that adds what the repository lacks and fixes the checks that already fail.

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

It renders the host files from `config.json` into `~/.local/share/mexxi/generated/`, then links them and the shared files into each host's home. [Configuration](configuration/index.md) lists every link. It never overwrites existing configuration: on a conflict it stops and lists the paths. It also:

- puts [`ibni`](cli/index.md) (the worktree CLI) in `~/.local/bin`;
- adds a `post-merge` hook, so a later `git pull` on `main` reinstalls automatically; and
- preserves your personal Codex `config.toml`.

`install --check` renders again and fails on any difference, so a hand-edited host file or a stale render shows up as a failure.

Moving from the old clone in `~/.config/opencode`? Follow [Migrating from coding-agent-config](migrating-from-coding-agent-config.md). [Host details](host-details.md) covers what each agent needs after installing, the Playwright server and the [guard](glossary.md#guard).

## Prepare your repository

An application repository needs one thing: a verify command that defines "mechanically healthy" for that project. By default it is `npm run verify`. [Verifika](https://github.com/alexportelli12/verifika) is the recommended way: list the checks in `verifika.config.json` and set `"verify": "verifika --all"`. Agents then run only the checks a change affects while they work. The `/lesti` prompt above does this for you.

A repository that already has one reliable command, such as `make check` or `tox`, can keep it instead. Name it in a committed `.mexxi.json`:

```json
{ "verify": "make check" }
```

To skip a baseline that CI has already proven, add to `.mexxi.json` the name of the CI check that runs your full verify command:

```json
{ "ciCheck": "verify" }
```

When that check succeeded on exactly the commit `ibni prepare` starts from, `prepare` records it as the baseline and `/wettaq` cites it instead of rerunning verify. Anything else, such as no opt-in, a pending or failed run, or a different commit, runs the baseline as before.

## Try it

From the repository's default branch, ask [`/wettaq`](../commands/wettaq.md) (build it) for a change:

```text
/wettaq show the last sync time on the settings page
```

[How a run works](how-a-run-works.md) walks through what happens next, and [Reviewing a mexxi pull request](reviewing-a-pull-request.md) covers what you check when the pull request arrives. For occasional manual use, `ibni list` shows retained [workspaces](glossary.md#workspace) and `ibni cleanup` shows what it would remove. [CLI reference](cli/index.md) covers the rest.
