import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";
import { readSettings } from "../lib/settings.mjs";

const home = path.join(path.sep, "home", "someone");

test("hares is off by default, loopback-only, with the plan's caps", async () => {
  const { hares } = await resolveConfig({}, { home });
  assert.equal(hares.enabled, false);
  assert.deepEqual(hares.bind, { host: "127.0.0.1", port: 4280 });
  assert.equal(hares.runner, "claude-code");
  assert.deepEqual(hares.repositories, []);
  assert.deepEqual(hares.auth.web, { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: "" });
  assert.equal(hares.limits.concurrentRuns, 2);
  assert.equal(hares.limits.approvalTimeoutMinutes, 60);
  assert.equal(hares.push, true);
  assert.equal(hares.service.systemdUserUnit, false);
});

test("a partly set hares key keeps the other defaults", async () => {
  const { hares } = await resolveConfig({ hares: { enabled: true, limits: { runsPerDay: 5 } } }, { home });
  assert.equal(hares.enabled, true);
  assert.equal(hares.limits.runsPerDay, 5);
  assert.equal(hares.limits.maxTurns, 80);
});

test("a repository with an unknown action, or an unknown auth mode, is refused", async () => {
  await assert.rejects(
    resolveConfig({ hares: { repositories: [{ name: "my-app", path: "~/workspace/my-app", actions: ["deploy"] }] } }, { home }),
    ConfigError,
  );
  await assert.rejects(resolveConfig({ hares: { auth: { web: { mode: "open" } } } }, { home }), ConfigError);
});

test("the canary defaults to a small model and a short run, and refuses a model name with odd characters", async () => {
  const { hares } = await resolveConfig({}, { home });
  assert.deepEqual(hares.canary, { model: "haiku", maxTurns: 6 });
  assert.equal((await resolveConfig({ hares: { canary: { maxTurns: 3 } } }, { home })).hares.canary.model, "haiku");
  await assert.rejects(resolveConfig({ hares: { canary: { model: "haiku; rm" } } }, { home }), ConfigError);
  await assert.rejects(resolveConfig({ hares: { canary: { maxTurns: 0 } } }, { home }), ConfigError);
});

test("an old config with the retired sandbox and permissions keys still loads, ignores them and warns once, naming each to delete", async (t) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hares-config-")), "config.json");
  t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify({ hares: {
    enabled: true, permissions: "strict", mcpPermissions: "strict", branchPrefixes: ["security/"], allowUnsandboxed: true, allowedDomains: ["fonts.gstatic.com"],
    repositories: [
      { name: "plain", path: "~/plain", actions: ["build"] },
      { name: "old", path: "~/old", actions: ["build", "ask"], permissions: "sandboxed", allowedDomains: ["fonts.googleapis.com"] },
    ],
  } }));
  const warnings = [];
  const settings = await readSettings({ file, home, warn: (message) => warnings.push(message) });
  assert.deepEqual(settings.hares.repositories.map((repository) => [repository.name, repository.actions]), [["plain", ["build"]], ["old", ["build", "ask"]]]);
  for (const key of ["permissions", "mcpPermissions", "branchPrefixes", "allowUnsandboxed", "allowedDomains"]) assert.ok(!(key in settings.hares), key);
  assert.ok(!("permissions" in settings.hares.repositories[1]) && !("allowedDomains" in settings.hares.repositories[1]));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], `hares ignores these keys in ${file}, which no longer do anything; delete them: hares.permissions, hares.mcpPermissions, `
    + "hares.branchPrefixes, hares.allowUnsandboxed, hares.allowedDomains, hares.repositories[1].permissions, hares.repositories[1].allowedDomains");

  // A current config says nothing, and a key that never existed is still refused.
  writeFileSync(file, JSON.stringify({ hares: { enabled: true } }));
  await readSettings({ file, home, warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
  writeFileSync(file, JSON.stringify({ hares: { sandbox: true } }));
  await assert.rejects(readSettings({ file, home, warn: () => {} }), /hares\.sandbox: unknown key/);
});
