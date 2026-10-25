---
sources:
  - scripts/install.mjs
reviewed: 2026-10-25
---

# Migrating from coding-agent-config

mexxi used to live in `~/.config/opencode`, under the name coding-agent-config. These steps move an existing install to a clone of mexxi, and back again if you need to. A new install does not need them: follow [Getting started](getting-started.md).

## Move to the new clone

Move the old clone in `~/.config/opencode` aside first, because OpenCode's links go where its files are now. Then give OpenCode an empty directory and let the installer relink everything to the new clone. The dry run comes first: it reports anything else the install would stop on, such as a `BASH_MAX_TIMEOUT_MS` or `cleanupPeriodDays` you already set in `settings.json`, and changes nothing. The move runs only if the dry run passes; otherwise resolve what it lists and run the block again.

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

## If the install stops

`--migrate-from` names the old path, not the moved copy: it takes over the links that still point inside it. If the old clone is still in place, the installer stops and prints the move sequence above. If the install stops after the move, run `readlink ~/.claude/CLAUDE.md`, the first link the installer moves. If it already points into `~/.local/share/mexxi/generated`, the links have moved to the new clone: don't restore anything; fix the cause the installer printed and rerun `node scripts/install.mjs --migrate-from ~/.config/opencode` from the new clone. Otherwise every host still links into `~/.config/opencode`, so put the old clone back before you do anything else: `rmdir ~/.config/opencode && mv ~/.config/opencode.pre-move ~/.config/opencode`. `rmdir` refuses while files you copied back are still there; delete those copies first.

## Roll back

To roll back a completed move, first set `"hosts": {"opencode": false, "claude": false, "codex": false}` in `config.json` and run `node scripts/install.mjs` from the new clone. A host that is off keeps nothing mexxi gave it: the installer removes its links, the entries it added to `settings.json` and Codex's `hooks.json`, and, for Claude Code, the mods. Then remove what is shared, put the old clone back and run its own installer:

```bash
claude plugin marketplace remove mexxi
rm ~/.local/bin/ibni ~/.local/bin/implementation-workspace
mv ~/.config/opencode ~/.config/opencode.mexxi
mv ~/.config/opencode.pre-move ~/.config/opencode
cd ~/.config/opencode && node scripts/install.mjs
```

`~/.config/opencode.mexxi` then holds only the files you copied back. Delete it, `~/.config/mexxi` and `~/.local/share/mexxi/generated` once you are sure. Keep the rest of `~/.local/share/mexxi`: it holds the retained implementation workspaces.
