---
sources:
  - scripts/install.mjs
  - scripts/lib/claude-settings.mjs
  - scripts/lib/claude-mods.mjs
  - scripts/lib/browser.mjs
  - scripts/lib/host-hooks.mjs
reviewed: 2026-10-22
---

# Host details

The installer sets up Claude Code, Codex and OpenCode from the same shared files. What differs is how each one takes its settings, and the step or two you take after installing.

## Claude Code

The installer merges only the keys it owns into your `settings.json`: `permissions.deny`, `env.BASH_MAX_TIMEOUT_MS` and the hook entries. It records what it added, so changing `config.json` later removes only those entries. It also installs the [mods](glossary.md#mod) that `config.json` names from this clone. Open sessions pick up changes with `/reload-plugins`.

## Codex

Start a new session after installing. Codex skips new hooks until you approve them once in `/hooks`. A non-empty `AGENTS.override.md` in Codex's home takes precedence over the installed `AGENTS.md`; remove it if you want the shared guidance. Run commands as `$mexxi-wettaq <request>`.

## OpenCode

Its `opencode.json` is rendered, including the Playwright server and the guard plugin.

## Playwright MCP

The pin, browser path and output directory come from the `browser` group in `config.json`. Claude Code and Codex keep MCP servers in files that are yours, so the installer prints the registration lines and never runs them:

```bash
claude mcp add --scope user playwright -- npx -y @playwright/mcp@0.0.83 --headless --isolated --executable-path=/usr/bin/chromium --output-dir=<worktree root>
codex mcp add playwright -- npx -y @playwright/mcp@0.0.83 --headless --isolated --executable-path=/usr/bin/chromium --output-dir=<worktree root>
```

`install --check` reads those files back and fails when a server is missing or has another version, another output directory, or `--allow-unrestricted-file-access`. To change the pin, edit `config.json`, rerun the installer, remove the old server and register it again with the new lines.

## The guard

Claude Code and Codex run `scripts/hooks/guard.mjs` before every shell command, and OpenCode runs the same code through a plugin. Codex runs it only once you trust it in `/hooks`. The rules in `AGENTS.md` are what bind the agent; the guard is a backup for some of them, not a substitute. A command it lets through is not thereby allowed. A refusal reaches the agent as the tool's error, with the reason.

A second hook, the [loop breaker](glossary.md#loop-breaker), tells the agent to re-diagnose when the same shell command fails a third time.
