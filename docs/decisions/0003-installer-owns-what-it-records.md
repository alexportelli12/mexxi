---
status: Accepted
date: 2026-10-21
---

# 0003. The installer owns only what it records

## Context

The installer writes into folders that belong to the person, not to mexxi: `~/.claude`, `~/.codex`, `~/.agents/skills`, `~/.config/opencode` and `~/.local/bin`. Claude Code's `settings.json` and Codex's `hooks.json` hold the person's own keys, hooks and plugins next to anything mexxi adds. An installer that overwrote these files, or guessed what it had written before, could destroy settings without anyone noticing.

## Decision

- The installer never overwrites a file or a link it did not create. On any conflict it stops, changes nothing and lists the paths.
- In `settings.json` and `hooks.json` it merges only the keys it owns, such as the deny list, the Bash timeout and its own hook entries. It records each one under `~/.local/share/mexxi/state/`.
- A value the person set themselves for a key mexxi would own counts as a conflict, never as something to take over.
- `--dry-run` reports conflicts without writing anything, so a move or upgrade can be checked first.
- Running the installer twice changes nothing. Turning a host off in the config removes that host's links, keys and mods.
- `--migrate-from` relinks only links that point into the old clone.
- Failures that come after the links have moved, such as a failing plugin install, are reported as warnings. The rest of the install still completes, so nobody undoes a move that has already happened.

## Consequences

- An install can always be undone from the state records: remove what mexxi recorded and its links, then put the old setup back.
- Upgrades and repairs are the same operation: run the installer again.
- The person's formatting of `settings.json` is not preserved when mexxi writes to it, though their keys and key order are.
- Every new kind of change the installer makes needs a state record and a rollback path before it ships.

## Alternatives considered

- **Replacing the host files wholesale:** simple, but it destroys the person's own settings.
- **Asking the person to edit their settings by hand:** safe, but error-prone, and impossible to check for drift.
