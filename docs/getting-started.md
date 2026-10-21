---
sources:
  - scripts/install.mjs
  - scripts/lib/config.mjs
  - scripts/lib/claude-settings.mjs
  - config.schema.json
  - config.example.json
  - skills/ibda/SKILL.md
  - prompts.json
reviewed: 2026-10-21
---

# Getting started

You can set mexxi up by pasting one prompt into the agent you already use, or by running the installer yourself. Both end at the same check: `install --check` passes.

## Set up by pasting a prompt

Paste this into Claude Code, Codex or OpenCode. The agent installs mexxi and asks you only what it cannot detect.

**Install mexxi**

```text
Set up mexxi for me. Read https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md and follow it.
```

When mexxi is installed, open a repository and paste this. [`/lesti`](../commands/lesti.md) opens one pull request that adds what the repository lacks and fixes the checks that already fail.

**Prepare a repository**

```text
Make this repository ready for mexxi: run /lesti here.
```

## Set up by hand

You need Node.js 22.13 or newer, [`git`](https://git-scm.com/), the [`gh`](https://cli.github.com/) CLI (signed in), and `~/.local/bin` on your `PATH`. Three more tools are optional or host-specific:

- the [`ocr`](https://github.com/alibaba/open-code-review) CLI, which the independent review needs;
- the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server, which rendered QA needs; and
- `ffmpeg`, if you want GIFs of motion.

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

- puts [`ibni`](cli/index.md) in `~/.local/bin`;
- adds a `post-merge` hook, so a later `git pull` on `main` reinstalls automatically; and
- preserves your personal Codex `config.toml`.

`install --check` renders again and fails on any difference, so a hand-edited host file or a stale render shows up as a failure.

If you are moving from the old clone in `~/.config/opencode`, move it aside first, because OpenCode's links go where its files are now. Then give OpenCode an empty directory and let the installer relink everything to the new clone. The dry run comes first: it reports anything else the install would stop on, such as a `BASH_MAX_TIMEOUT_MS` or `cleanupPeriodDays` you already set in `settings.json`, and changes nothing. The move runs only if the dry run passes; otherwise resolve what it lists and run the block again.

```bash
cd ~/workspace/mexxi &&
  node scripts/install.mjs --dry-run --migrate-from ~/.config/opencode &&
  mv ~/.config/opencode ~/.config/opencode.pre-move &&
  mkdir ~/.config/opencode
```

Copy back into `~/.config/opencode` the runtime-only files you keep there, such as `tui.jsonc`, `herdr` files and personal plugins, then install from the new clone:

```bash
cp -R ~/.config/opencode.pre-move/skills/synced skills/ &&
  cp ~/.config/opencode.pre-move/skills-lock.json . &&
  node scripts/install.mjs --migrate-from ~/.config/opencode
```

The two `cp` lines carry over the old clone's synced skills and their lock file, which Git ignores and so the new clone does not have. Delete either one if the old clone has no such file. They also stop the install when the move did not happen.

`--migrate-from` names the old path, not the moved copy: it takes over the links that still point inside it. If the old clone is still in place, the installer stops and prints this sequence. If the install stops after the move, run `readlink ~/.claude/CLAUDE.md`, the first link the installer moves. If it already points into `~/.local/share/mexxi/generated`, the links have moved to the new clone: don't restore anything; fix the cause the installer printed and rerun `node scripts/install.mjs --migrate-from ~/.config/opencode` from the new clone. Otherwise every host still links into `~/.config/opencode`, so put the old clone back before you do anything else: `rmdir ~/.config/opencode && mv ~/.config/opencode.pre-move ~/.config/opencode`. `rmdir` refuses while files you copied back are still there; delete those copies first.

To roll back a completed move, first set `"hosts": {"opencode": false, "claude": false, "codex": false}` in `config.json` and run `node scripts/install.mjs` from the new clone. A host that is off keeps nothing mexxi gave it: the installer removes its links, the entries it added to `settings.json` and Codex's `hooks.json`, and, for Claude Code, the mods. Then remove what is shared, put the old clone back and run its own installer:

```bash
claude plugin marketplace remove mexxi
rm ~/.local/bin/ibni ~/.local/bin/implementation-workspace
mv ~/.config/opencode ~/.config/opencode.mexxi
mv ~/.config/opencode.pre-move ~/.config/opencode
cd ~/.config/opencode && node scripts/install.mjs
```

`~/.config/opencode.mexxi` then holds only the files you copied back. Delete it, `~/.config/mexxi` and `~/.local/share/mexxi/generated` once you are sure. Keep the rest of `~/.local/share/mexxi`: it holds the retained implementation workspaces.

### Host details

**Claude Code.** The installer merges only the keys it owns into your `settings.json`: `permissions.deny`, `env.BASH_MAX_TIMEOUT_MS` and the hook entries. It records what it added, so changing `config.json` later removes only those entries. It also installs the mods that `config.json` names from this clone. Open sessions pick up changes with `/reload-plugins`.

**Codex.** Start a new session after installing. Codex skips new hooks until you approve them once in `/hooks`. A non-empty `AGENTS.override.md` in Codex's home takes precedence over the installed `AGENTS.md`; remove it if you want the shared guidance. Run commands as `$mexxi-wettaq <request>`.

**OpenCode.** Its `opencode.json` is rendered, including the Playwright server and the guard plugin.

**Playwright MCP.** The pin, browser path and output directory come from the `browser` group in `config.json`. Claude Code and Codex keep MCP servers in files that are yours, so the installer prints the registration lines and never runs them:

```bash
claude mcp add --scope user playwright -- npx -y @playwright/mcp@0.0.83 --headless --isolated --executable-path=/usr/bin/chromium --output-dir=<worktree root>
codex mcp add playwright -- npx -y @playwright/mcp@0.0.83 --headless --isolated --executable-path=/usr/bin/chromium --output-dir=<worktree root>
```

`install --check` reads those files back and fails when a server is missing or has another version, another output directory, or `--allow-unrestricted-file-access`. To change the pin, edit `config.json`, rerun the installer, remove the old server and register it again with the new lines.

**The guard.** Claude Code and Codex run `scripts/hooks/guard.mjs` before every shell command, and OpenCode runs the same code through a plugin. Codex runs it only once you trust it in `/hooks`. The rules in `AGENTS.md` are what bind the agent; the guard is a backup for some of them, not a substitute. A command it lets through is not thereby allowed. A refusal reaches the agent as the tool's error, with the reason.

## Prepare your repository

An application repository needs one thing: an `npm run verify` script that defines "mechanically healthy" for that project. [Verifika](https://github.com/alexportelli12/verifika) is the recommended way: list the checks in `verifika.config.json` and set `"verify": "verifika --all"`. Agents then run only the checks a change affects while they work. The `/lesti` prompt above does this for you.

To skip a baseline that CI has already proven, commit a `.mexxi.json` that names the CI check running your full `verify`:

```json
{ "ciCheck": "verify" }
```

When that check succeeded on exactly the commit `ibni prepare` starts from, `prepare` records it as the baseline and `/wettaq` cites it instead of rerunning verify. Anything else, such as no opt-in, a pending or failed run, or a different commit, runs the baseline as before.

## Try it

From the repository's default branch:

```text
/wettaq show the last sync time on the settings page
```

[How a run works](how-a-run-works.md) walks through what happens next. For occasional manual use, `ibni list` shows retained workspaces and `ibni cleanup` shows what it would remove. [CLI reference](cli/index.md) covers the rest.
