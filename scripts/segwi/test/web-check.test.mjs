import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lockHash, needsInstall } from "../web-check.mjs";
import { browserSkipReason } from "./web-harness.mjs";

async function webFixture(t, lock) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "segwi-web-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "package-lock.json"), lock);
  return directory;
}

test("dependencies are installed when node_modules has no stamp", async (t) => {
  assert.equal(needsInstall(await webFixture(t, "{}")), true);
});

test("a stamp that matches the lockfile skips the install, and a changed lockfile brings it back", async (t) => {
  const directory = await webFixture(t, "{}");
  await mkdir(path.join(directory, "node_modules"));
  await writeFile(path.join(directory, "node_modules/.segwi-lock-hash"), `${lockHash(directory)}\n`);
  assert.equal(needsInstall(directory), false);
  await writeFile(path.join(directory, "package-lock.json"), '{"changed":true}');
  assert.equal(needsInstall(directory), true);
});

test("the browser tests skip only when Chromium isn't installed, and never under CI", () => {
  const missing = new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell");
  assert.match(browserSkipReason({ env: {}, launchError: missing }), /Chromium isn't installed/);
  assert.equal(browserSkipReason({ env: { CI: "true" }, launchError: missing }), null);
  assert.equal(browserSkipReason({ env: {}, launchError: new Error("Target crashed") }), null, "any other failure fails");
  assert.equal(browserSkipReason({ env: {}, launchError: null }), null);
});
