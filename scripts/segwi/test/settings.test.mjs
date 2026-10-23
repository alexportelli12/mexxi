import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";
import { dataDir, ensurePrivateDir } from "../lib/paths.mjs";
import { permissionsFor, settingsFromConfig } from "../lib/settings.mjs";
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
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 4);
  store.createRun({ id: "r1", repo: "a", action: "ask", task: "t", clientId: "c1" });
  assert.throws(() => store.createRun({ id: "r2", repo: "a", action: "ask", task: "t", clientId: "c1" }));
  const first = store.addEvent("r1", "text", { text: "a" });
  const second = store.addEvent("r1", "text", { text: "b" });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.ok(second.id > first.id);
  assert.deepEqual(store.listEvents("r1", 1).map((event) => event.data.text), ["b"]);
  store.close();
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

test("a run takes its repository's permissions mode, else segwi.permissions, and an ask run is always strict", async () => {
  const config = await resolveConfig({ segwi: { permissions: "sandboxed", repositories: [
    { name: "own", path: "~/own", actions: ["build", "ask"], permissions: "strict" },
    { name: "inherits", path: "~/inherits", actions: ["build", "ready", "ask"] },
  ] } }, { home });
  const { segwi } = settingsFromConfig(config, { home });
  const [own, inherits] = segwi.repositories;
  assert.equal(permissionsFor({ segwi, repository: own, action: "build" }), "strict");
  assert.equal(permissionsFor({ segwi, repository: inherits, action: "build" }), "sandboxed");
  assert.equal(permissionsFor({ segwi, repository: inherits, action: "ready" }), "sandboxed");
  assert.equal(permissionsFor({ segwi: { ...segwi, permissions: "auto" }, repository: inherits, action: "ask" }), "strict");
});
