---
status: Accepted; its browser launcher, allowed hosts and smoke check are superseded by 0016
date: 2026-10-23
---

# 0013. segwi: a browser and extra hosts for a run's checks, without loosening the sandbox

## Context

A build run in a real Angular repository ran `npm run verify` on an untouched main, and four of its seven checks failed for reasons outside the code:

- Karma and Playwright couldn't start Chromium. Chromium's own sandbox needs user namespaces, and the run's sandbox refuses them. With `--no-sandbox`, the full Chromium still aborts, because a seccomp filter blocks the Unix socket it opens to keep one browser per profile.
- With the browser running, every page that loads Google Fonts failed with 407. The sandbox's proxy takes a username and password in its URL, and Chromium can't send them.
- The build couldn't inline Google Fonts, because the network allow list was fixed to GitHub and the npm registry.
- The Firebase Storage rules tests failed with 403. firebase-tools sends even its calls between emulators through `HTTPS_PROXY`, ignoring `NO_PROXY`, and the proxy refuses this machine. It also exits with an error when it can't save its settings in the read-only `~/.config`.

The run had also inherited `NODE_ENV=production` from segwi's service, so `npm ci` skipped development dependencies.

Claude Code has settings that would make the browser start: `sandbox.allowNestedUserNamespaces` and `sandbox.network.allowAllUnixSockets`. Its own description of the first says it removes code-execution isolation: a command could undo every write rule, git hooks and config included. The second lets a command reach any service on this machine, such as the session bus, which can start programs outside the sandbox.

## Decision

- The run's sandbox stays the boundary. segwi turns on neither setting, and writes nowhere new in the home folder or git directory.
- A build or ready run gets `CHROME_BIN` set to `scripts/segwi/bin/chromium.mjs`, in the mexxi clone, which a run can't write. It starts Playwright's `chrome-headless-shell`, which opens no such socket, with `--no-sandbox`. It gives the browser config and cache folders in the run's temporary folder. When the proxy needs credentials, it puts a loopback relay in front, which adds them. The agent is told not to override `CHROME_BIN`.
- `segwi.allowedDomains`, and `allowedDomains` on a repository in `segwi.repositories`, add hosts to the network allow list. Only your config adds them, never the repository. Local names such as `localhost`, and public services that resolve to any address, are refused, because the proxy runs outside the sandbox. That catches mistakes; a name you add that points at this machine still reaches it.
- A run's environment drops `NODE_ENV`.
- firebase-tools is the repository's to handle: a script that starts emulators clears the proxy variables and points `XDG_CONFIG_HOME` at a temporary folder. segwi doesn't wrap third-party tools.
- `scripts/segwi/smoke.mjs` checks one configured repository on this machine, through a real run's sandbox, with a scripted model.

## Consequences

- Without Chromium's own sandbox, a hostile page could take over the browser's processes, which then hold only what the run's sandbox allows. Tests load the repository's own pages and the hosts you list, which a run can already reach with any command.
- Each host you add is somewhere a run can send what it reads. The setting says so.
- Browser tests need `chrome-headless-shell`, installed with `npx playwright install chromium`. Without it, a run says so at the start.
- A repository that runs a browser other than through `CHROME_BIN`, or Playwright's bundled browser against remote hosts, still meets the 407.

## Alternatives considered

- **A writable per-run `HOME` or `XDG_CONFIG_HOME` for the whole run:** GitHub CLI's login, `ibni`'s own config in `~/.config/mexxi` and Playwright's browsers live there, so runs would lose them. The browser gets its own folders instead.
- **Letting runs write `~/.config/chromium` or `~/.config/configstore`:** they hold your real browser profile and Firebase login.
- **A `firebase` wrapper on the run's PATH:** it would hide a third-party bug inside segwi, for one repository's needs.
