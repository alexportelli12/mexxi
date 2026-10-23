import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";
import { readSettings } from "../lib/settings.mjs";

const home = path.join(path.sep, "home", "someone");

test("segwi is off by default, loopback-only, with the plan's caps", async () => {
  const { segwi } = await resolveConfig({}, { home });
  assert.equal(segwi.enabled, false);
  assert.deepEqual(segwi.bind, { host: "127.0.0.1", port: 4280 });
  assert.equal(segwi.runner, "claude-code");
  assert.deepEqual(segwi.repositories, []);
  assert.deepEqual(segwi.auth.web, { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: "" });
  assert.equal(segwi.limits.concurrentRuns, 2);
  assert.equal(segwi.limits.approvalTimeoutMinutes, 60);
  assert.equal(segwi.push, true);
  assert.equal(segwi.service.systemdUserUnit, false);
});

test("a partly set segwi key keeps the other defaults", async () => {
  const { segwi } = await resolveConfig({ segwi: { enabled: true, limits: { runsPerDay: 5 } } }, { home });
  assert.equal(segwi.enabled, true);
  assert.equal(segwi.limits.runsPerDay, 5);
  assert.equal(segwi.limits.maxTurns, 80);
});

test("a repository with an unknown action, or an unknown auth mode, is refused", async () => {
  await assert.rejects(
    resolveConfig({ segwi: { repositories: [{ name: "my-app", path: "~/workspace/my-app", actions: ["deploy"] }] } }, { home }),
    ConfigError,
  );
  await assert.rejects(resolveConfig({ segwi: { auth: { web: { mode: "open" } } } }, { home }), ConfigError);
});

test("the canary defaults to a small model and a short run, and refuses a model name with odd characters", async () => {
  const { segwi } = await resolveConfig({}, { home });
  assert.deepEqual(segwi.canary, { model: "haiku", maxTurns: 6 });
  assert.equal((await resolveConfig({ segwi: { canary: { maxTurns: 3 } } }, { home })).segwi.canary.model, "haiku");
  await assert.rejects(resolveConfig({ segwi: { canary: { model: "haiku; rm" } } }, { home }), ConfigError);
  await assert.rejects(resolveConfig({ segwi: { canary: { maxTurns: 0 } } }, { home }), ConfigError);
});

test("an old config with the retired sandbox and permissions keys still loads, ignores them and warns once, naming each to delete", async (t) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "segwi-config-")), "config.json");
  t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify({ segwi: {
    enabled: true, permissions: "strict", mcpPermissions: "strict", branchPrefixes: ["security/"], allowUnsandboxed: true, allowedDomains: ["fonts.gstatic.com"],
    repositories: [
      { name: "plain", path: "~/plain", actions: ["build"] },
      { name: "old", path: "~/old", actions: ["build", "ask"], permissions: "sandboxed", allowedDomains: ["fonts.googleapis.com"] },
    ],
  } }));
  const warnings = [];
  const settings = await readSettings({ file, home, warn: (message) => warnings.push(message) });
  assert.deepEqual(settings.segwi.repositories.map((repository) => [repository.name, repository.actions]), [["plain", ["build"]], ["old", ["build", "ask"]]]);
  for (const key of ["permissions", "mcpPermissions", "branchPrefixes", "allowUnsandboxed", "allowedDomains"]) assert.ok(!(key in settings.segwi), key);
  assert.ok(!("permissions" in settings.segwi.repositories[1]) && !("allowedDomains" in settings.segwi.repositories[1]));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], `segwi ignores these keys in ${file}, which no longer do anything; delete them: segwi.permissions, segwi.mcpPermissions, `
    + "segwi.branchPrefixes, segwi.allowUnsandboxed, segwi.allowedDomains, segwi.repositories[1].permissions, segwi.repositories[1].allowedDomains");

  // A current config says nothing, and a key that never existed is still refused.
  writeFileSync(file, JSON.stringify({ segwi: { enabled: true } }));
  await readSettings({ file, home, warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
  writeFileSync(file, JSON.stringify({ segwi: { sandbox: true } }));
  await assert.rejects(readSettings({ file, home, warn: () => {} }), /segwi\.sandbox: unknown key/);
});
