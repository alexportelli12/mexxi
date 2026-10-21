---
status: Accepted
date: 2026-10-21
---

# 0002. One user config file; host files rendered at install

## Context

Models, paths, enabled hosts and guard rules differ from person to person. When those values were committed in host files, anyone using mexxi had to edit tracked files, and every pull from upstream risked a conflict. The clone also had to live inside `~/.config/opencode`, which mixed OpenCode's runtime files into the repository.

## Decision

- Everything a person could reasonably want different lives in one file, `~/.config/mexxi/config.json`. A key belongs there only if two reasonable users would set it differently.
- `config.schema.json` gives every key a default and a description. The installer validates the file against it and refuses unknown keys, naming the key's path.
- Host files are templates in the repository. The installer renders them from the config into `~/.local/share/mexxi/generated/` and links each host to the rendered copy. Rendered files are never committed.
- The clone can live anywhere; the config records where. The installer runs only from the clone the config names.
- `npm run verify` renders the host files with the default config and checks the result, so a broken template fails the gate.
- `install --check` re-renders from the current config and fails on any drift.

## Consequences

- Someone using mexxi edits `config.json` and nothing else. Upstream changes arrive with a plain `git pull`.
- The configuration reference on the docs site is generated from the schema, so it cannot fall behind.
- A value that is hard-coded in a tracked file is a defect: it belongs in the schema.
- Rendering adds a build step between the repository and the hosts. `install --check` is how drift between them is caught.

## Alternatives considered

- **Committed host files with a local override file per host:** each host's override format differs, and overrides would still be hand-edited.
- **`OPENCODE_CONFIG_DIR` pointing OpenCode at the clone:** it needs an environment variable in every shell and service, and it merges on top of the global config. It would also leave OpenCode configured differently from the other two hosts.
