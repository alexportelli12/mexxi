import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, resolveConfig } from "../../lib/config.mjs";
import { dataDir, ensurePrivateDir } from "../lib/paths.mjs";
import { readSettings, settingsFromConfig } from "../lib/settings.mjs";
import { openStore } from "../lib/store.mjs";
import { tempDir } from "./helpers.mjs";

const home = path.join(path.sep, "home", "someone");
const withRepos = (repositories) => resolveConfig({ hares: { repositories } }, { home });

test("repository paths are expanded and the guard's deny list is carried over", async () => {
  const settings = settingsFromConfig(await withRepos([{ name: "my-app", path: "~/workspace/my-app", actions: ["ask"] }]), { home });
  assert.equal(settings.hares.repositories[0].path, path.join(home, "workspace", "my-app"));
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
  return { hares: { repositories }, guard: { deny: [] }, paths: { worktreeRoot: "/w" }, browser: {} };
}

test("the data directory follows XDG and is private", (t) => {
  assert.equal(dataDir({ env: { XDG_DATA_HOME: "/x" }, home }), path.join("/x", "mexxi", "hares"));
  assert.equal(dataDir({ env: {}, home }), path.join(home, ".local", "share", "mexxi", "hares"));
  const parent = mkdtempSync(path.join(os.tmpdir(), "hares-paths-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = ensurePrivateDir(path.join(parent, "a", "b"));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("data left in mexxi/segwi moves to mexxi/hares once, and never over a hares directory that already exists", (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), "hares-migrate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { XDG_DATA_HOME: base };
  mkdirSync(path.join(base, "mexxi", "segwi"), { recursive: true });
  writeFileSync(path.join(base, "mexxi", "segwi", "segwi.db"), "old-data");

  assert.equal(dataDir({ env, home }), path.join(base, "mexxi", "hares"));
  assert.equal(readFileSync(path.join(base, "mexxi", "hares", "segwi.db"), "utf8"), "old-data");
  assert.equal(existsSync(path.join(base, "mexxi", "segwi")), false);

  // A second call, and a later stray segwi directory, leave the hares data alone.
  mkdirSync(path.join(base, "mexxi", "segwi"));
  dataDir({ env, home });
  assert.equal(readFileSync(path.join(base, "mexxi", "hares", "segwi.db"), "utf8"), "old-data");
  assert.equal(existsSync(path.join(base, "mexxi", "segwi")), true);
});

// Break caught: the hook writes mexxi/hares/pending before ħares first starts, and the move from mexxi/segwi is
// skipped because mexxi/hares exists, stranding segwi's store, push subscriptions and extension data.
test("segwi's data still moves to mexxi/hares when only the hook's pending folder is there, and the hook's records stay", (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), "hares-migrate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { XDG_DATA_HOME: base };
  const segwi = path.join(base, "mexxi", "segwi");
  const hares = path.join(base, "mexxi", "hares");
  mkdirSync(path.join(segwi, "ext", "atlas-ops"), { recursive: true });
  writeFileSync(path.join(segwi, "segwi.db"), "old-data");
  writeFileSync(path.join(segwi, "ext", "atlas-ops", "state.json"), "{}");
  mkdirSync(path.join(hares, "pending", "11111111-1111-4111-8111-111111111111"), { recursive: true });
  writeFileSync(path.join(hares, "pending", "11111111-1111-4111-8111-111111111111", "question_toolu_1.json"), "hook-record");

  assert.equal(dataDir({ env, home }), hares);
  assert.equal(readFileSync(path.join(hares, "segwi.db"), "utf8"), "old-data");
  assert.equal(readFileSync(path.join(hares, "ext", "atlas-ops", "state.json"), "utf8"), "{}");
  assert.equal(readFileSync(path.join(hares, "pending", "11111111-1111-4111-8111-111111111111", "question_toolu_1.json"), "utf8"), "hook-record");
  assert.equal(existsSync(segwi), false);
});

test("the store versions its schema and keeps run ids, event sequences and client ids unique", () => {
  const store = openStore(":memory:");
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 8);
  store.createRun({ id: "r1", repo: "a", action: "ask", task: "t", clientId: "c1" });
  assert.throws(() => store.createRun({ id: "r2", repo: "a", action: "ask", task: "t", clientId: "c1" }));
  const first = store.addEvent("r1", "text", { text: "a" });
  const second = store.addEvent("r1", "text", { text: "b" });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.ok(second.id > first.id);
  assert.deepEqual(store.listEvents("r1", 1).map((event) => event.data.text), ["b"]);
  store.close();
});

test("a version 4 database gains waitingOn, the ibni snapshot and gate acceptances, and keeps its runs", (t) => {
  const file = path.join(tempDir(t, "hares-store-"), "segwi.db");
  const old = openStore(file);
  old.createRun({ id: "r1", repo: "a", action: "build", task: "t" });
  old.db.exec("DROP TABLE gate_acceptances; ALTER TABLE runs DROP COLUMN waiting_on; ALTER TABLE runs DROP COLUMN snapshot; PRAGMA user_version = 4;");
  old.close();
  const store = openStore(file);
  t.after(() => store.close());
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 8);
  assert.equal(store.getRun("r1").waitingOn, null);
  const updated = store.updateRun("r1", { waitingOn: "Waiting on npm run verify", snapshot: { steps: [{ step: "prepare", outcome: "succeeded" }] } });
  assert.deepEqual([updated.waitingOn, updated.snapshot], ["Waiting on npm run verify", { steps: [{ step: "prepare", outcome: "succeeded" }] }]);
  // The first acceptance of a commit stands; another commit has none.
  store.acceptGateChange({ runId: "r1", headSha: "a".repeat(40), acceptedBy: "alex@example.com", detail: "a skipped test" });
  store.acceptGateChange({ runId: "r1", headSha: "a".repeat(40), acceptedBy: "someone@example.com", detail: "again" });
  assert.equal(store.gateAcceptance("r1", "a".repeat(40)).acceptedBy, "alex@example.com");
  assert.equal(store.gateAcceptance("r1", "b".repeat(40)), null);
});

test("the VAPID subject is empty by default, takes a real contact, and refuses placeholders push services reject", async () => {
  const withSubject = (vapidSubject) => ({ ...withRepos0([]), workflow: { ports: {} }, hares: { repositories: [], vapidSubject } });
  assert.equal((await resolveConfig({}, { home })).hares.vapidSubject, "");
  for (const good of ["", "mailto:me@example.com", "https://example.com", "https://ops.example.org/contact"]) {
    assert.equal(settingsFromConfig(withSubject(good)).hares.vapidSubject, good);
  }
  for (const bad of ["mailto:hares@localhost", "mailto:me@box", "https://localhost", "https://printer.local", "https://db.internal", "https://a.test", "https://127.0.0.1", "mailto:me@[::1]", "http://example.com", "mailto:nobody"]) {
    assert.throws(() => settingsFromConfig(withSubject(bad)), (error) => error instanceof ConfigError && error.message.startsWith(`hares.vapidSubject: "${bad}"`), bad);
  }
  assert.throws(() => settingsFromConfig(withSubject("mailto:hares@localhost")), /placeholder/);
  // The schema checks the shape; the clear message about placeholders comes from settings.
  await assert.rejects(resolveConfig({ hares: { vapidSubject: "hares@example.com" } }, { home }), /vapidSubject/);
});

test("a config that still sets segwi's runner, model, canary or run timeouts loads, drops them and names each to delete", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ hares: {
    enabled: true, runner: "claude-code", model: "sonnet", canary: { model: "haiku", maxTurns: 6 },
    limits: { concurrentRuns: 3, maxTurns: 80, idleTimeoutMinutes: 30, hardTimeoutMinutes: 120, approvalTimeoutMinutes: 60 },
    repositories: [{ name: "app", path: "/tmp/app", actions: ["build"], github: "me/app" }],
  } }));
  const warnings = [];
  const settings = await readSettings({ file, home: dir, warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
  for (const key of ["hares.runner", "hares.model", "hares.canary", "hares.limits.maxTurns", "hares.limits.idleTimeoutMinutes", "hares.limits.hardTimeoutMinutes", "hares.limits.approvalTimeoutMinutes"]) {
    assert.ok(warnings[0].includes(key), key);
  }
  assert.ok(!("runner" in settings.hares) && !("canary" in settings.hares) && !("maxTurns" in settings.hares.limits));
  assert.equal(settings.hares.limits.concurrentRuns, 3, "the caps that remain are kept");
  assert.equal(settings.hares.repositories[0].github, "me/app");
  assert.deepEqual(settings.hares.notifications.events, { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false }, "notification defaults come from the schema");
});
