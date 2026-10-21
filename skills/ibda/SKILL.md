---
name: ibda
description: Install, set up, repair or upgrade mexxi, the coding-agent workflow in github.com/alexportelli12/mexxi, on this machine. Use when asked to install or set up mexxi, to fix a broken mexxi install, to upgrade or update it, or when a pasted prompt points at this file. Do not use to prepare a repository for mexxi (that is /lesti) or to change the workflow's own rules (that is /sewwi).
---

# Ibda: install, repair or upgrade mexxi

`ibda` (Maltese for "begin") takes a machine to a working mexxi install and
proves it with `install --check`. It is safe to rerun: on an existing install
it upgrades and repairs instead of starting over.

This file is self-contained, because it may be fetched raw from
`https://raw.githubusercontent.com/alexportelli12/mexxi/main/skills/ibda/SKILL.md`
by an agent with nothing installed yet. Docs: https://alexportelli12.github.io/mexxi/docs/

Rules that hold throughout:

- Install nothing, and run no command that changes the machine outside the
  clone and `~/.config/mexxi`, without asking first. Say what a command does
  before running it.
- Never overwrite or hand-edit a host's existing configuration (`~/.claude`,
  `~/.codex`, `~/.config/opencode`). The installer links mexxi's files in and
  refuses on a conflict. When it reports one, show the user the paths, explain
  what differs, and ask; do not delete, move or force anything.
- Ask only what cannot be detected. Everything else takes the defaults in
  `config.schema.json`.
- Never write an API key into any file. Jev's key stays in `OPENROUTER_API_KEY`.

## 1. Check prerequisites

Check each and report the results in one table before going on:

| Need | Check | If missing |
| --- | --- | --- |
| Node 22.13 or newer, with npm | `node --version` | Install from https://nodejs.org or the system package manager |
| git | `git --version` | Install with the system package manager |
| `gh`, signed in | `gh auth status` | Install from https://cli.github.com, then `gh auth login` |
| `ocr` (OpenCodeReview) | `ocr --version` | The independent review gate needs it; install per https://github.com/alibaba/open-code-review |
| `ffmpeg` (optional) | `ffmpeg -version` | Only for turning rendered-QA recordings into GIFs; skip if unwanted |
| `~/.local/bin` on `PATH` | `echo $PATH` | The installer links `ibni` there; offer to add it to the shell profile and wait for a yes |

Also detect which hosts are installed: `claude`, `codex` and `opencode` on
`PATH`. Stop and ask when a required tool is missing; do not continue past it.

## 2. Find out whether this is a first install

Look for `~/.config/mexxi/config.json` (or the file `MEXXI_CONFIG` names).

- **It exists:** this is a rerun. Read `paths.checkout` from it and go to
  "Upgrade and repair".
- **It does not exist, but `~/.config/opencode` is a Git clone of
  `coding-agent-config`** (`git -C ~/.config/opencode remote -v`): this is the
  pre-move layout. The new clone goes elsewhere, and the old clone has to be
  moved aside first, because OpenCode's links go where its files are now. The
  installer then takes over the old links with `--migrate-from`. Explain the
  sequence in step 4 and get a yes before moving anything; the moved clone
  stays at `~/.config/opencode.pre-move` until the user deletes it.
- **Otherwise:** a first install.

## 3. Ask only what cannot be detected

For a first install, ask these together, in one message, offering the answer
you would pick:

1. **Clone location.** Default `~/workspace/mexxi`. If a non-mexxi directory
   already exists there, ask for another path.
2. **Hosts.** Offer the detected ones; each undetected host is set to `false`.
3. **Models per role,** for each chosen host: the `reviewer` and `uiDesigner`
   agents, and optionally a `crossFamilyReviewer` (a model from a different
   family to the implementer's, which makes the independent review stronger).
   OpenCode also has `general` and `explore`. "Host default" (`null`) is a fine
   answer, and for OpenCode the schema defaults apply unless told otherwise.
4. **Jev on or off.** Default off. If on, ask for the GitHub owners that are
   theirs (`jev.owners`) and the repositories it may run in
   (`jev.repositories`, as `owner/name`), and tell them to export
   `OPENROUTER_API_KEY`. Jev only records answers beside the agent's own
   decisions; it changes nothing.

## 4. Install

First install, in order:

1. Clone: `git clone https://github.com/alexportelli12/mexxi.git <clone>`
   (parent directory created if needed). Stay on `main`.
2. Install dependencies from the clone: `npm ci`.
3. Write the config to a scratch file outside `~/.config`, with only the keys
   that differ from the defaults. It must set `paths.checkout` to the clone,
   and may set `hosts`, `models` and `jev`. Example:

   ```json
   {
     "paths": { "checkout": "~/workspace/mexxi" },
     "hosts": { "opencode": false },
     "models": { "claude": { "reviewer": "opus" } },
     "jev": { "enabled": true, "owners": ["me"], "repositories": ["me/app"] }
   }
   ```

   `config.schema.json` in the clone documents every key.
4. Run the installer from the clone. It validates the file against the schema
   before writing anything, copies it to `~/.config/mexxi/config.json`, links
   the hosts and installs the Claude Code mods:

   ```bash
   node scripts/install.mjs --config <scratch-file> --yes
   ```

   `--yes` confirms that write. If `~/.config/mexxi/config.json` already
   exists and differs, the installer stops and changes nothing; show the user
   both files and let them decide.

   For the pre-move layout, with the user's yes, run this sequence instead of
   the command above. Only it works: `--migrate-from` takes over links that
   point inside the path it names, so it must name `~/.config/opencode`
   itself, and that directory must no longer hold the old clone.

   ```bash
   mv ~/.config/opencode ~/.config/opencode.pre-move
   mkdir ~/.config/opencode
   # copy back runtime-only files from ~/.config/opencode.pre-move:
   # tui.jsonc, herdr files, personal plugins; nothing mexxi installs
   node scripts/install.mjs --config <scratch-file> --yes --migrate-from ~/.config/opencode
   ```

   Run the installer from the new clone. If it stops saying
   `~/.config/opencode` is still the old clone, the move did not happen.
5. Delete the scratch file once it is installed.

## 5. Add Playwright, then prove it

The installer prints, for each chosen host, the Playwright MCP command to run
(`claude mcp add ...`, `codex mcp add ...`); OpenCode needs none. It never runs
them. Show each line, and run it only when the user agrees.

Then run `node scripts/install.mjs --check`. It must exit 0 with no output
about drift or missing registrations; it fails, listing every gap, until each
host's Playwright registration matches. Fix what it names (most are one-line
commands it prints) and rerun until it is green. Do not report success on any
other evidence.

Codex needs one more step the installer cannot do: start `codex` once and
trust the mexxi guard and loop breaker hooks in `/hooks`. Codex skips untrusted
hooks. Say so whenever Codex is a chosen host.

## Upgrade and repair

On a rerun, in the clone from `paths.checkout`:

1. `git status`: if it has uncommitted changes or is not on `main`, stop and
   tell the user; do not stash or discard anything.
2. `git pull --ff-only`, then `npm ci`.
3. `node scripts/install.mjs`, then `node scripts/install.mjs --check`. This
   re-renders the host files from `config.json`, so it also repairs a broken
   link or a stale render. Edits to `config.json` (new models, Jev on) take
   effect the same way.
4. Work through anything `--check` lists, as in step 5.

Never run the installer from a feature worktree or another clone; it refuses.

## 6. Hand over

1. Tell the user what was installed (hosts, clone path, config path) and that
   `~/.config/mexxi/config.json` is the only file they ever edit.
2. Prepare a repository: offer to run `/lesti` in one of their repositories.
   It opens a single PR that adds whatever the repository lacks (a `verify`
   script, agent docs, review coverage) and fixes its failing checks. The
   copyable prompt is: "Make this repository ready for mexxi: run /lesti here."
3. Suggest a first small `/wettaq` in a prepared repository (a copy tweak or a
   one-line fix), to see the worktree, verify, review and PR flow end to end.
4. Link the docs: https://alexportelli12.github.io/mexxi/docs/
