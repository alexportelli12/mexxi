---
sources:
  - config.schema.json
  - config.example.json
  - mexxi.schema.json
  - scripts/install.mjs
  - scripts/lib/config.mjs
  - scripts/ibni/lib/baseline.mjs
  - scripts/ibni/lib/forge.mjs
  - scripts/ibni/lib/ports.mjs
  - scripts/ibni/lib/lock.mjs
  - scripts/ibni/lib/scope.mjs
  - scripts/ibni/lib/caches.mjs
reviewed: 2026-10-25
---

# Configuration

mexxi works without any configuration. You change it when your setup differs from the defaults: another forge, fewer agents, a stricter guard. Settings live in two files, so that how you work never has to be committed to a repository, and what a repository needs travels with it.

- **`~/.config/mexxi/config.json`** is how you work, on your machine: which agents to install for, which models to use, which commands the guard watches for. Nobody else sees it, and a `git pull` of mexxi never conflicts with it. [Decision 0002](decisions/0002-one-config-rendered-host-files.md) explains why.
- **`.mexxi.json`**, committed to a repository, is what that repository needs, whoever runs the task: its verify command, its setup command, its CI check, its forge. It is read from the default branch, so a task branch cannot change the rules it is checked by. [Decision 0010](decisions/0010-repository-names-its-verify-command.md) and [decision 0014](decisions/0014-ibni-runs-setup-and-verify.md) explain why.

After changing `config.json`, run `node scripts/install.mjs` again from your mexxi clone, so the agents pick up the change. A change to `.mexxi.json` takes effect once it is on the default branch.

## Common changes

Each recipe is a few lines of `~/.config/mexxi/config.json`, unless it says `.mexxi.json`. Keys you leave out keep their defaults.

### Use GitLab or a self-hosted forge

GitHub and GitLab on `github.com` and `gitlab.com` work as they are; sign in with `gh` or `glab`. For a forge on your own domain, map its host:

```json
{ "forge": { "hosts": { "git.example.com": "gitlab" } } }
```

A single repository can instead name its forge in its `.mexxi.json`: `{ "forge": "gitlab" }`.

### Install for Claude Code only

Switch off the agents you do not use. The installer removes what it gave them before:

```json
{ "hosts": { "opencode": false, "codex": false } }
```

### Get a reviewer from another model family

A reviewer from the builder's own family shares its blind spots. On Claude Code, with Codex installed, name a Codex model and `ibni cross-review` runs the review on it:

```json
{ "models": { "claude": { "crossFamilyReviewer": "<a Codex model>" } } }
```

On OpenCode, set `models.opencode.crossFamilyReviewer` to a `provider/model` from another family. Codex has one family, so its review is always same-family.

### Run without `ocr`

The reviewer can read the whole diff itself instead of having OpenCodeReview pick the files and rules:

```json
{ "review": { "tool": "none" } }
```

### Change the screen sizes the browser check uses

Widths in CSS pixels:

```json
{ "workflow": { "viewports": [1280, 834, 375] } }
```

### Block your own deploy command

To keep production deploys for a human, add your deploy command to the guard's list as a backup to your own rules. Setting the list replaces the defaults, so keep the ones you still want:

```json
{ "guard": { "deny": ["npm publish", "gh pr merge", "gh release create", "git push --force", "git push -f", "npm run deploy"] } }
```

### Use another verify command, or reuse a CI run that already passed

In the repository's `.mexxi.json`:

```json
{ "verify": "make check", "ciCheck": "verify" }
```

### Run several tasks at once on one machine

Two tasks that check their work at the same moment can fight over ports and starve each other of CPU. The defaults already handle most of it, and these keys tune it.

Each workspace gets a block of ports, and `ibni` hands it to setup and verify as `PORT` and `MEXXI_PORT_0` to `MEXXI_PORT_9`. A repository whose test servers read their own variables, with a fixed fallback port, can have those variables mapped to the block in `config.json`, so it needs no change. Key the mapping by the folder name of the repository's checkout, with each variable's offset in the block (offset 0 is `PORT`):

```json
{
  "workflow": {
    "ports": { "first": 4300, "last": 4999, "blockSize": 10 },
    "portVariables": {
      "my-web-app": { "E2E_PORT": 1, "E2E_MOCK_API_PORT": 2, "STORYBOOK_PORT": 3 }
    }
  }
}
```

Two more settings keep parallel checks from overloading the machine:

- **`verifySlots`** is how many setup and verify runs go at once, across every repository. The rest wait in a queue, and the result reports the wait as `queuedMs`. Two suits a machine with 8 cores. Raise it if runs rarely wait; lower it if checks start to time out under load.
- **`scope`** runs each setup and verify in a systemd user scope, where `systemd-run --user` works (most Linux machines). A lower `cpuWeight` lets your interactive sessions stay responsive while checks run. `memoryMax` makes the kernel stop a runaway check rather than an agent session. When the run ends, the scope also stops any server or browser the command left behind. Elsewhere, such as on macOS, runs are plain child processes without these limits.

```json
{ "workflow": { "verifySlots": 2, "scope": { "enabled": true, "cpuWeight": 50, "memoryMax": "50%" } } }
```

`warmCaches`, on by default, copies your checkout's build and test caches into each new worktree, so its first check does not start cold. Set it to `false` if a tool in your repository misbehaves with a copied cache.
