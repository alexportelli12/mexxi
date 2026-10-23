import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";
import { dataDir, ensurePrivateDir, secretsFile } from "../lib/paths.mjs";
import { settingsFromConfig } from "../lib/settings.mjs";
import { openStore } from "../lib/store.mjs";

const home = path.join(path.sep, "home", "someone");
const withRepos = (repositories) => resolveConfig({ segwi: { repositories } }, { home });

test("repository paths are expanded and the guard's deny list is carried over", async () => {
  const settings = settingsFromConfig(await withRepos([{ name: "my-app", path: "~/workspace/my-app", actions: ["ask"] }]), { home });
  assert.equal(settings.segwi.repositories[0].path, path.join(home, "workspace", "my-app"));
  assert.ok(settings.deny.includes("git push --force"));
});

test("repository names must be unique, lower-case and short", async () => {
  const repo = (name) => ({ name, path: "~/a", actions: ["ask"] });
  assert.throws(() => settingsFromConfig(withRepos0([repo("a"), repo("a")])), ConfigError);
  assert.throws(() => settingsFromConfig(withRepos0([repo("My-App")])), ConfigError);
  assert.throws(() => settingsFromConfig(withRepos0([repo("-x")])), ConfigError);
  assert.throws(() => settingsFromConfig(withRepos0([repo("a".repeat(65))])), ConfigError);
});

// A synchronous stand-in: the config shape settingsFromConfig reads.
function withRepos0(repositories) {
  return { segwi: { repositories }, guard: { deny: [] }, paths: { worktreeRoot: "/w" }, browser: {} };
}

test("the data directory follows XDG and is private", () => {
  assert.equal(dataDir({ env: { XDG_DATA_HOME: "/x" }, home }), path.join("/x", "mexxi", "segwi"));
  assert.equal(dataDir({ env: {}, home }), path.join(home, ".local", "share", "mexxi", "segwi"));
  assert.equal(secretsFile({ home }), path.join(home, ".config", "mexxi", "secrets", "segwi.json"));
  const dir = ensurePrivateDir(path.join(mkdtempSync(path.join(os.tmpdir(), "segwi-paths-")), "a", "b"));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the store versions its schema and keeps run ids, event sequences and client ids unique", () => {
  const store = openStore(":memory:");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 2);
  store.createRun({ id: "r1", repo: "a", action: "ask", task: "t", clientId: "c1" });
  assert.throws(() => store.createRun({ id: "r2", repo: "a", action: "ask", task: "t", clientId: "c1" }));
  const first = store.addEvent("r1", "text", { text: "a" });
  const second = store.addEvent("r1", "text", { text: "b" });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.ok(second.id > first.id);
  assert.deepEqual(store.listEvents("r1", 1).map((event) => event.data.text), ["b"]);
  store.close();
});
