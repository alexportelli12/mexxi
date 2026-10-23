import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";

const home = path.join(path.sep, "home", "someone");

test("segwi is off by default, loopback-only, with the plan's caps", async () => {
  const { segwi } = await resolveConfig({}, { home });
  assert.equal(segwi.enabled, false);
  assert.deepEqual(segwi.bind, { host: "127.0.0.1", port: 4280 });
  assert.equal(segwi.runner, "claude-code");
  assert.deepEqual(segwi.repositories, []);
  assert.deepEqual(segwi.auth.web, { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: "" });
  assert.equal(segwi.allowUnsandboxed, false);
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

test("runs use auto permissions and only workflow.branchPrefix by default, and an unknown mode or a bad prefix is refused", async () => {
  const { segwi } = await resolveConfig({}, { home });
  assert.equal(segwi.permissions, "auto");
  assert.deepEqual(segwi.branchPrefixes, []);
  const repository = { name: "my-app", path: "~/workspace/my-app", actions: ["build"] };
  const set = await resolveConfig({ segwi: { permissions: "strict", branchPrefixes: ["security/"], repositories: [{ ...repository, permissions: "sandboxed" }] } }, { home });
  assert.equal(set.segwi.repositories[0].permissions, "sandboxed");
  for (const segwi of [{ permissions: "yolo" }, { branchPrefixes: ["security"] }, { branchPrefixes: ["../x/"] }, { branchPrefixes: ["Security/"] }, { repositories: [{ ...repository, permissions: "bypass" }] }]) {
    await assert.rejects(resolveConfig({ segwi }, { home }), ConfigError, JSON.stringify(segwi));
  }
});
