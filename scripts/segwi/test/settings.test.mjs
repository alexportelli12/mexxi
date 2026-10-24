import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";
import { dataDir, ensurePrivateDir } from "../lib/paths.mjs";
import { settingsFromConfig } from "../lib/settings.mjs";
import { openStore } from "../lib/store.mjs";
import { tempDir } from "./helpers.mjs";

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

test("the data directory follows XDG and is private", (t) => {
  assert.equal(dataDir({ env: { XDG_DATA_HOME: "/x" }, home }), path.join("/x", "mexxi", "segwi"));
  assert.equal(dataDir({ env: {}, home }), path.join(home, ".local", "share", "mexxi", "segwi"));
  const parent = mkdtempSync(path.join(os.tmpdir(), "segwi-paths-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = ensurePrivateDir(path.join(parent, "a", "b"));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("the store versions its schema and keeps run ids, event sequences and client ids unique", () => {
  const store = openStore(":memory:");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 5);
  store.createRun({ id: "r1", repo: "a", action: "ask", task: "t", clientId: "c1" });
  assert.throws(() => store.createRun({ id: "r2", repo: "a", action: "ask", task: "t", clientId: "c1" }));
  const first = store.addEvent("r1", "text", { text: "a" });
  const second = store.addEvent("r1", "text", { text: "b" });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.ok(second.id > first.id);
  assert.deepEqual(store.listEvents("r1", 1).map((event) => event.data.text), ["b"]);
  store.close();
});

test("a version 4 database gains waitingOn and the ibni snapshot, and keeps its runs", (t) => {
  const file = path.join(tempDir(t, "segwi-store-"), "segwi.db");
  const old = openStore(file);
  old.createRun({ id: "r1", repo: "a", action: "build", task: "t" });
  old.db.exec("ALTER TABLE runs DROP COLUMN waiting_on; ALTER TABLE runs DROP COLUMN ibni; PRAGMA user_version = 4;");
  old.close();
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 5);
  assert.equal(store.getRun("r1").waitingOn, null);
  const updated = store.updateRun("r1", { waitingOn: "Waiting on npm run verify", ibni: { steps: [{ step: "prepare", outcome: "succeeded" }] } });
  assert.deepEqual([updated.waitingOn, updated.ibni], ["Waiting on npm run verify", { steps: [{ step: "prepare", outcome: "succeeded" }] }]);
});

test("the VAPID subject is empty by default, takes a real contact, and refuses placeholders push services reject", async () => {
  const withSubject = (vapidSubject) => ({ ...withRepos0([]), workflow: { ports: {} }, segwi: { repositories: [], vapidSubject } });
  assert.equal((await resolveConfig({}, { home })).segwi.vapidSubject, "");
  for (const good of ["", "mailto:me@example.com", "https://example.com", "https://ops.example.org/contact"]) {
    assert.equal(settingsFromConfig(withSubject(good)).segwi.vapidSubject, good);
  }
  for (const bad of ["mailto:segwi@localhost", "mailto:me@box", "https://localhost", "https://printer.local", "https://db.internal", "https://a.test", "https://127.0.0.1", "mailto:me@[::1]", "http://example.com", "mailto:nobody"]) {
    assert.throws(() => settingsFromConfig(withSubject(bad)), (error) => error instanceof ConfigError && error.message.startsWith(`segwi.vapidSubject: "${bad}"`), bad);
  }
  assert.throws(() => settingsFromConfig(withSubject("mailto:segwi@localhost")), /placeholder/);
  // The schema checks the shape; the clear message about placeholders comes from settings.
  await assert.rejects(resolveConfig({ segwi: { vapidSubject: "segwi@example.com" } }, { home }), /vapidSubject/);
});
