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
  assert.deepEqual(segwi.auth.web, { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [] });
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
