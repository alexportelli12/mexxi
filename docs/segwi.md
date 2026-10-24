---
sources:
  - scripts/segwi/**
  - scripts/lib/segwi-install.mjs
  - scripts/install.mjs
  - config.schema.json
  - docs/decisions/0011-segwi.md
  - docs/decisions/0012-segwi-permission-modes.md
  - docs/decisions/0013-segwi-run-browser-and-hosts.md
  - docs/decisions/0016-segwi-runs-trusted-like-own-sessions.md
reviewed: 2026-10-24
---

# segwi

A mexxi run takes minutes to an hour, and it stops whenever it needs a reply or a permission. Without segwi you must be at the terminal to keep it moving. segwi lets you start, follow, answer and stop a run from your phone, or from any MCP client, while the work stays on a machine you own.

segwi, Maltese for "to follow", is a launcher and viewer. It is not a second workflow. It starts your coding agent with `/wettaq`, `/lesti` or a read-only question, in a repository you listed. `ibni` still owns the worktree, the verify command and the pull request, and mexxi never merges for you. [Decision 0011](decisions/0011-segwi.md) explains why it is built this way.

segwi is opt-in and off by default. With the `segwi` key unset, nothing about your install changes.

## What you can do with it

- Start a run in a repository you listed, with one of three actions: build (`/wettaq`), get ready (`/lesti`) or ask a question that changes nothing.
- Follow the run as readable steps, with its branch, pull request link and verify result.
- Reply when the agent asks you something, and stop the run when you want.
- Answer an [approval](glossary.md#approval): a question about one call that Claude Code's auto mode leaves to you.
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

segwi can't tell your phone from the machine it runs on by the request: a forwarded address is easy to forge, so it doesn't use one. The agent's browser marks every request it makes, and segwi refuses any request with that mark, however the address is written. So the agent can't open the app and tap Approve. Other programs on this machine are not limited this way: segwi trusts your own user account, and a command the agent runs is one of them. [What keeps a run safe](#what-keeps-a-run-safe) says what that means.

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

A run has the same trust as a session you start yourself in a terminal on this machine. It runs as your user, in your repository's checkout, with Claude Code's auto mode and your own Claude Code settings. So mexxi's rules, its guard hook, its [loop breaker](glossary.md#loop-breaker) and its `guard.deny` list apply exactly as they do for you. segwi adds no sandbox and no allow list of its own. [Decision 0016](decisions/0016-segwi-runs-trusted-like-own-sessions.md) explains why.

That means the agent can do what you can do on this machine. It can read your files, use your credentials and reach the network. Protect what matters outside the machine the way you would for your own sessions:

- Turn on branch protection for each repository's default branch, so nothing reaches it without a pull request.
- Give the GitHub CLI a token scoped to your own repositories, so a run can't reach anything else on GitHub.

On top of that, segwi adds what a remote launcher needs:

- **Tailnet-only access.** The server listens only on loopback, and remote access goes through `tailscale serve` to the identities you list.
- **A token for MCP.** An MCP client must send the bearer token, and it can never answer an approval.
- **Approvals only a person answers.** Auto mode's classifier, a second model, decides most calls. When it refuses several in a row, Claude Code asks you instead, through an approval in the web app. You see exactly what would run: the whole command, or the whole text a file edit would write, with nothing removed or shortened, not even a secret. You also see its working directory, why the agent says it needs it, and a plain-words risk label. A call too long to show in full on a phone is denied without asking. Once you answer, segwi removes secrets from the stored copy. The default answer is Deny. A decision covers that one call only, and there is no "allow all". If nobody answers within `segwi.limits.approvalTimeoutMinutes`, it counts as a denial.
- **Caps.** `segwi.limits` bounds concurrent runs, runs per day, agent turns, idle time, total time, the approval wait and the length of a task or reply. A request over a cap gets a 429.
- **An audit log.** Every API and MCP call, every approval and every stop is recorded in an append-only log. Secrets are removed from anything segwi stores or returns.

Approvals stop the agent's browser and your MCP clients, not every program on this machine. A command the agent runs is a process of yours, so it could reach segwi's port as you can. Approvals keep an agent that follows its rules in check; they don't wall off one that breaks them.

When auto mode, a `guard.deny` rule or mexxi's guard hook, the backup to mexxi's rules, refuses a call, the run shows a step. It reads "Refused:" followed by the command and the reason. The agent is told to stop and ask you rather than work around a refusal, so the run then shows **Needs your reply**. Each refusal is also counted in the audit log as `run.refused`.

An ask run is meant to change nothing. It runs in auto mode too, without the tools that edit or write files, and it is told to change nothing. It still has the shell, though, so only auto mode and that instruction keep a command such as `sed -i` from changing your checkout.

segwi's own service runs with `NODE_ENV=production`, and a run doesn't inherit it, so `npm ci` installs a repository's test tools as it does in your terminal.

## The nightly canary

Your coding agent's command line and output can change between versions, and a broken assumption would show up as a failed run on a day you needed it. The canary finds out first. `segwi canary` makes a scratch repository, starts a real `ask` run with the model in `segwi.canary.model`, and asks it to run the first command in `guard.deny`, with `--help` so it stays harmless if it ever ran. It checks three things:

- That command is refused and shows on the run as a refusal step, so your deny list still holds in a run.
- The run reaches `completed` within four minutes, and shows every kind of event a run shows: tool calls and their results, the refusal, a message and the result.
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
