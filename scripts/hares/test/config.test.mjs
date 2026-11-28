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
  assert.ok(!("runner" in hares) && !("model" in hares) && !("canary" in hares), "segwi's runner, model and canary are retired");
  assert.deepEqual(hares.repositories, []);
  assert.deepEqual(hares.auth.web, { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: "" });
  assert.equal(hares.limits.concurrentRuns, 2);
  assert.deepEqual(Object.keys(hares.limits).sort(), ["concurrentRuns", "inputMaxChars", "runsPerDay", "taskMaxChars"], "no run timeouts: a session is the person's");
  assert.equal(hares.push, true);
  assert.equal(hares.service.systemdUserUnit, false);
});

test("a partly set hares key keeps the other defaults", async () => {
  const { hares } = await resolveConfig({ hares: { enabled: true, limits: { runsPerDay: 5 } } }, { home });
  assert.equal(hares.enabled, true);
  assert.equal(hares.limits.runsPerDay, 5);
  assert.equal(hares.limits.concurrentRuns, 2);
});

test("a repository with an unknown action, or an unknown auth mode, is refused", async () => {
  await assert.rejects(
    resolveConfig({ hares: { repositories: [{ name: "my-app", path: "~/workspace/my-app", actions: ["deploy"] }] } }, { home }),
    ConfigError,
  );
  await assert.rejects(resolveConfig({ hares: { auth: { web: { mode: "open" } } } }, { home }), ConfigError);
});

test("notifications default to asks, finishes and main red on, ready and bumps off, and a repository may name its GitHub slug", async () => {
  const { hares } = await resolveConfig({}, { home });
  assert.deepEqual(hares.notifications.events, { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false });
  assert.deepEqual(hares.notifications.quietHours, { enabled: false, start: "23:00", end: "07:00" });
  await assert.rejects(resolveConfig({ hares: { notifications: { quietHours: { start: "25:00" } } } }, { home }), ConfigError);
  const slug = await resolveConfig({ hares: { repositories: [{ name: "my-app", path: "~/my-app", actions: ["build"], github: "me/my-app" }] } }, { home });
  assert.equal(slug.hares.repositories[0].github, "me/my-app");
  await assert.rejects(resolveConfig({ hares: { repositories: [{ name: "my-app", path: "~/my-app", actions: ["build"], github: "not a slug" }] } }, { home }), ConfigError);
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

// Break caught: a config still on the old segwi key is told to delete hares.runner, a path it doesn't have,
// so the person can't find the key to delete.
test("a config still on the segwi key names its retired keys under segwi, the key the file uses", async (t) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hares-config-")), "config.json");
  t.after(() => rmSync(path.dirname(file), { recursive: true, force: true }));
  writeFileSync(file, JSON.stringify({ segwi: { enabled: true, runner: "claude", limits: { maxTurns: 40 }, repositories: [{ name: "old", path: "~/old", actions: ["ask"], permissions: "sandboxed" }] } }));
  const warnings = [];
  const settings = await readSettings({ file, home, warn: (message) => warnings.push(message) });
  assert.equal(settings.hares.repositories[0].name, "old", "the old key still loads");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], `hares ignores these keys in ${file}, which no longer do anything; delete them: segwi.runner, segwi.limits.maxTurns, segwi.repositories[0].permissions`);
});
