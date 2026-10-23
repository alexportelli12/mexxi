---
sources:
  - scripts/segwi/**
  - scripts/lib/segwi-install.mjs
  - scripts/install.mjs
  - config.schema.json
  - docs/decisions/0011-segwi.md
reviewed: 2026-10-23
---

# segwi

A mexxi run takes minutes to an hour, and it stops whenever it needs a reply or a permission. Without segwi you must be at the terminal to keep it moving. segwi lets you start, follow, answer and stop a run from your phone, or from any MCP client, while the work stays on a machine you own.

segwi, Maltese for "to follow", is a launcher and viewer. It is not a second workflow. It starts your coding agent with `/wettaq`, `/lesti` or a read-only question, in a repository you listed. `ibni` still owns the worktree, the verify command and the pull request, and mexxi never merges for you. [Decision 0011](decisions/0011-segwi.md) explains why it is built this way.

segwi is opt-in and off by default. With the `segwi` key unset, nothing about your install changes.

## What you can do with it

- Start a run in a repository you listed, with one of three actions: build (`/wettaq`), get ready (`/lesti`) or ask a question that changes nothing.
- Follow the run as readable steps, with its branch, pull request link and verify result.
- Reply when the agent asks you something, and stop the run when you want.
- Answer an [approval](glossary.md#approval): a question about one command the agent is not pre-approved to run.
- Get a push notification when a run needs you, finishes or fails.

## Turn it on

segwi needs Node.js 22.22.3 or newer on 22.x, or 24.15 or newer. That is newer than the rest of mexxi needs, because the web app's Angular build tools require it. Add the key to `~/.config/mexxi/config.json`. Every setting is optional apart from the repositories you want to use. The [configuration page](configuration/index.md) lists them all.

```json
{
  "segwi": {
    "enabled": true,
    "repositories": [
      { "name": "my-app", "path": "~/workspace/my-app", "actions": ["build", "ready", "ask"] }
    ],
    "service": { "systemdUserUnit": true }
  }
}
```

A run starts only in a repository listed here, with an action listed for it. Its checkout must be clean and on the default branch, because that is what `ibni` needs. Then build the web app once and run the installer from your mexxi clone:

```bash
npm --prefix scripts/segwi/web ci
npm --prefix scripts/segwi/web run build
node scripts/install.mjs --dry-run
node scripts/install.mjs
```

With `enabled` on, the installer links `segwi` into `~/.local/bin`, as it does for `ibni`. With `service.systemdUserUnit` on as well, and on Linux, it also writes three systemd user units to `~/.config/systemd/user/`:

- `segwi.service` runs the server, and restarts it if it fails.
- `segwi-canary.service` runs the [nightly check](#the-nightly-canary).
- `segwi-canary.timer` starts that check at about 03:30.

The installer records each unit in `~/.local/share/mexxi/state/segwi-units.json`. It never overwrites a unit it did not write: a file with the same name is a conflict, and the install stops. `--dry-run` lists the files and the `systemctl --user` commands it would run, and `install --check` reports a unit you edited or deleted. The installer also runs `systemctl --user daemon-reload` and `enable --now` for you. Without `systemctl`, it writes the files and prints the commands to run instead.

The units run with the `PATH` the installer ran with, so a run finds the same `node`, `claude`, `gh` and `ibni` as your shell. Install again after you move one of them. When a unit changes, the installer restarts `segwi.service` so the new one takes effect.

A user service runs only while you are logged in, unless lingering is on. Turn it on once so segwi keeps running after you log out:

```bash
loginctl enable-linger "$USER"
```

Turn `service.systemdUserUnit` or `enabled` off and the next install stops and removes exactly the units it recorded. Turning `enabled` off also removes the `segwi` link. Without the service, start the server yourself with `segwi serve`.

segwi reads its config only when it starts. After you change the `segwi` key, restart it with `systemctl --user restart segwi.service`, or stop `segwi serve` and start it again.

The server listens on `127.0.0.1:<port>`. In the commands and addresses below, `<port>` is `segwi.bind.port`, which is 4280 by default.

## Who may sign in

The web app has two modes, set in `segwi.auth.web.mode`. The server only ever listens on loopback. It refuses to start on any other address, because it can start agents that run commands on your machine.

- **`localhost-only`** is the default. It trusts anyone using this machine, and it refuses any request that a proxy forwarded. Use it when you work at the machine itself.
- **`tailscale-header`** trusts the identity header that `tailscale serve` adds, but only on loopback. List the identities you allow in `segwi.auth.web.allowed`, and set `segwi.auth.web.hostname` to this machine's tailnet name. segwi answers only to that name and to loopback names, so a page on another site can't reach it by pointing its own name at your machine. The server will not start with an empty list or without the name.

segwi can't tell your phone from the machine it runs on by the request: a forwarded address is easy to forge, so it doesn't use one. What stops the agent from answering its own approval is the [sandbox](#what-keeps-a-run-safe). Every command the agent runs is inside it, and the sandbox has its own network, so it can't reach segwi's port at all. A test runs the real Claude Code to prove that. The agent's browser runs outside the sandbox, so it is blocked from segwi's loopback addresses and from your tailnet name.

MCP clients never use the web sign-in. They always send a bearer token, described [below](#connect-an-mcp-client).

## Reach it from your phone

[Tailscale](https://tailscale.com/) gives your devices a private network, and `tailscale serve` shares one local port with it over HTTPS. Set `segwi.auth.web.mode` to `tailscale-header`, list your Tailscale login in `allowed`, set `hostname` to the name `tailscale serve status` shows, such as `my-machine.example.ts.net`, restart segwi, and run:

```bash
tailscale serve --bg http://127.0.0.1:<port>
```

Then open `https://my-machine.example.ts.net` on a device signed in to your tailnet. Use the address `tailscale serve status` shows.

Never use `tailscale funnel` or port forwarding. Funnel puts the address on the open internet, where anyone who finds it can reach a tool that starts agents on your machine. segwi does not support it.

## Connect an MCP client

Any MCP client can use segwi's server at `/mcp`. It lists repositories, starts a run, reads output and stops a run. It can also list approvals, but it can never answer one: only a person in the web app can. Create a token first:

```bash
segwi token rotate
```

The token is printed once, and only its hash is stored. Run the command again to replace it, and the old one stops working at once. Then add the server to your client. For Claude Code:

```bash
claude mcp add --transport http segwi http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
```

For a client that reads a JSON file:

```json
{
  "mcpServers": {
    "segwi": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Run output that segwi returns is labelled as untrusted and has secrets removed, because a repository can put text in it that tries to steer your client. Stopping a run takes two calls: the first returns a confirmation token that is valid for two minutes.

## Get push notifications

Push lets your phone tell you when a run needs you, so you don't have to keep the app open. It needs two things: a key pair that signs each message, and a contact address that push services can reach about it. Create the keys once:

```bash
segwi vapid init
```

Then set `segwi.vapidSubject` in `config.json` to a `mailto:` address or an `https://` URL you own:

```json
{
  "segwi": { "vapidSubject": "mailto:you@example.com" }
}
```

Restart segwi after both steps. Until both are done, push counts as not set up: segwi sends nothing, and the app says push isn't set up. Push services such as Apple's refuse placeholder contacts, so segwi refuses them too when it reads its settings. That covers an address at `localhost`, a host name without a dot, a `.local` or `.test` name, and an IP address.

Open the app on your phone and allow notifications when it asks. A notification names only the run, the repository and the new status, never the task or any output. On iOS, add the app to the Home Screen first, because Safari sends push only to installed apps. Each run keeps one notification, so a later event replaces the earlier one.

Each time the app opens, it sends this device's subscription to segwi again. If you replaced the keys with `segwi vapid init --force`, it subscribes again with the new key, so notifications keep arriving. The app does the same when the browser renews a subscription on its own.

## What keeps a run safe

segwi adds permissions around the agent, and mexxi's own rules still apply.

- **An allow list.** A normal run asks for nothing. The agent may use `ibni`, your repository's verify command, `vfk`, common `git` and `gh pr` commands, `npm run` and `npm test`, the usual `npx` build tools, and Playwright. It may read, edit and write files only under your worktree root and its temporary directory. Interpreters such as `python3`, network clients such as `curl`, `rm`, `kill`, `git push` and `gh api` are not on it. An ask run gets a shorter, read-only list: it may read files and run `git`, `gh` and `ibni` commands that only look. Anything that edits, installs, builds, commits or opens a pull request asks you first.
- **Approvals.** Anything else becomes an approval, and the run waits. You see exactly what would run: the whole command, or the whole text a file edit would write, with nothing removed or shortened, not even a secret. You also see its working directory, why the agent says it needs it, and a plain-words risk label. A call too long to show in full on a phone is denied without asking. Once you answer, segwi removes secrets from the stored copy. The default answer is Deny. A decision covers that one call only, and there is no "allow all". If nobody answers within `segwi.limits.approvalTimeoutMinutes`, it counts as a denial.
- **The deny list.** The commands in `guard.deny` never become an approval. They are refused outright, as in every mexxi run.
- **The sandbox.** segwi turns on Claude Code's sandbox, with writes limited to the worktree root and network limited to GitHub and the npm registry. On Linux it needs `bubblewrap` and `socat`. Without them Claude Code would run commands outside the sandbox and say nothing, so segwi refuses to start a run, and the health route and the app say why. Setting `segwi.allowUnsandboxed` lets runs start anyway. Don't, unless you accept that every allowed command then runs with all of your access.
- **Caps.** `segwi.limits` bounds concurrent runs, runs per day, agent turns, idle time, total time, the approval wait and the length of a task or reply. A request over a cap gets a 429.

Every API and MCP call, every approval and every stop is recorded in an append-only audit log. Secrets are removed from anything segwi stores or returns.

## The nightly canary

Your coding agent's command line and output can change between versions, and a broken assumption would show up as a failed run on a day you needed it. The canary finds out first. `segwi canary` makes a scratch repository, starts a real `ask` run with the model in `segwi.canary.model`, and checks three things:

- A blocked `curl` raises an approval within a minute.
- Denying that approval lets the run reach `completed` within four minutes.
- The adapter recognises every line the agent wrote.

It writes the result to `~/.local/share/mexxi/state/segwi-canary.json`, and the health route shows it. A pass adds the agent's version to the versions segwi treats as tested, next to the reviewed list in the repository. A failure exits non-zero, names the agent's version in one line, and sends a `canary_failed` push if push is set up.

The nightly run costs a few cents. Run it yourself any time with `segwi canary`. To refresh the recorded streams the contract tests replay, add `--save-stream <file>`. The file has secrets removed and your paths replaced, so you can review it and commit it in a pull request. The timer never writes into the repository, so a nightly run cannot leave your checkout dirty.

## Adding a runner

A runner is an adapter for one coding agent, and it holds host mechanics only: how to start the agent, read its output and stop it. The rules stay in the shared workflow. Claude Code is the only adapter so far.

1. Write an adapter in `scripts/segwi/runners/` that implements the `RunnerAdapter` contract in `contract.mjs`. It reports `detect()`, then `start`, `send`, `answer`, `close` and `stop`, and it emits only events that `runEventSchema` accepts.
2. Register it in `runners/index.mjs` and add its id to the `segwi.runner` list in `config.schema.json`.
3. Record a few real streams of the agent into `scripts/segwi/test/fixtures/`, and add a fake host that replays them.
4. Run the shared contract tests in `scripts/segwi/test/contract.test.mjs` against the new adapter. The same tests run for every adapter, so a second runner cannot behave differently by accident.

An adapter never receives a flag, a path or an environment variable from a request or from config beyond the fixed run settings.
