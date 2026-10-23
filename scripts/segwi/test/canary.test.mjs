// The canary (plan sections 9 and 11.15): it passes against a host that behaves,
// and fails loudly, with a state file, the health route and a push, against one
// that does not. A fake host replays recordings; no real `claude` runs here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canaryHealth, canaryStateFile, readCanaryState } from "../lib/canary-state.mjs";
import { canarySettings, CANARY_TASK, makeScratchRepo, redactedStream, runCanary } from "../lib/canary.mjs";
import { runCanaryCommand } from "../lib/canary-cli.mjs";
import { startServer } from "../lib/serve.mjs";
import { initVapid } from "../lib/vapid.mjs";
import { openStore } from "../lib/store.mjs";
import { createClaudeCodeAdapter } from "../runners/claude-code.mjs";
import { decryptPush, makeSubscriber } from "./push-decrypt.mjs";
import { fakeHost, fixturesDir, makeRepo, makeSettings, request, tempDir } from "./helpers.mjs";

const WAITS = { approvalMs: 20_000, completeMs: 20_000, pollMs: 20 };
const approvalLoop = path.join(fixturesDir, "claude-code", "approval-loop.jsonl");

function settingsWithCanary(overrides = {}) {
  const settings = makeSettings({ repos: [] });
  settings.segwi.canary = { model: "haiku", maxTurns: 6, ...overrides };
  return settings;
}

/** The canary's host: the fake host replaying `fixture`. */
function replaying(t, fixture = approvalLoop) {
  const dir = tempDir(t, "segwi-cn-host-");
  return { bin: process.execPath, binArgs: [fakeHost, fixture, path.join(dir, "report.json")] };
}

/** A host that answers `--version` and then dies on its first input, with exit code 1. */
function crashing(t) {
  const file = path.join(tempDir(t, "segwi-cn-host-"), "crash.mjs");
  writeFileSync(file, `if (process.argv.includes("--version")) { console.log("2.1.309 (Claude Code)"); process.exit(0); }
process.stdin.once("data", () => process.exit(1));`);
  return { bin: process.execPath, binArgs: [file] };
}

/** The approval-loop recording with one message type the adapter has never seen, just before the result. */
function withUnknownKind(t) {
  const lines = readFileSync(approvalLoop, "utf8").split("\n").filter(Boolean);
  const file = path.join(tempDir(t, "segwi-cn-fixture-"), "unknown.jsonl");
  writeFileSync(file, [...lines.slice(0, -1), JSON.stringify({ type: "brand_new_message", detail: "x" }), lines.at(-1)].join("\n") + "\n");
  return file;
}

const scratchDirs = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith("segwi-canary-"));

test("against a host that behaves, the canary passes, writes ok state and records the version", async (t) => {
  const before = scratchDirs();
  const stateDir = tempDir(t, "segwi-cn-state-");
  const state = await runCanary({ settings: settingsWithCanary(), stateDir, dataDir: tempDir(t, "segwi-cn-data-"), host: replaying(t), waits: WAITS });

  assert.equal(state.ok, true);
  assert.equal(state.hostVersion, "2.1.309");
  assert.equal(state.model, "haiku");
  assert.deepEqual(state.canaryTestedVersions, ["2.1.309"]);
  assert.equal(state.problem, undefined);
  assert.ok(state.durationMs > 0);
  assert.deepEqual(readCanaryState(stateDir), state);
  assert.equal(statSync(canaryStateFile(stateDir)).mode & 0o777, 0o600);
  assert.deepEqual(canaryHealth(stateDir), { ok: true, at: state.at, hostVersion: "2.1.309" });
  assert.deepEqual(scratchDirs(), before, "the scratch repository is removed");
});

test("a passing canary keeps the versions it passed before, once each", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  writeFileSync(canaryStateFile(stateDir), JSON.stringify({ ok: false, canaryTestedVersions: ["2.0.0", "2.1.309"] }));
  const state = await runCanary({ settings: settingsWithCanary(), stateDir, dataDir: tempDir(t, "segwi-cn-data-"), host: replaying(t), waits: WAITS });
  assert.deepEqual(state.canaryTestedVersions, ["2.0.0", "2.1.309"]);
});

test("the adapter treats a version the canary passed as tested, and one it did not as untested", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  const file = path.join(tempDir(t, "segwi-cn-host-"), "version.mjs");
  writeFileSync(file, 'console.log("9.9.9 (Claude Code)");');
  const adapter = (state) => createClaudeCodeAdapter({ bin: process.execPath, binArgs: [file], stateDir: state });
  const untested = await adapter(stateDir).detect();
  assert.equal(untested.version, "9.9.9");
  assert.match(untested.problems[0], /9\.9\.9 has not been tested/);
  writeFileSync(canaryStateFile(stateDir), JSON.stringify({ canaryTestedVersions: ["9.9.9"] }));
  const tested = await adapter(stateDir).detect();
  assert.deepEqual(tested.problems, []);
  assert.deepEqual(tested.testedVersions, ["2.1.309", "9.9.9"]);
});

test("the canary asks about a blocked curl in a scratch repository with the canary's own settings", () => {
  const settings = canarySettings(settingsWithCanary({ model: "sonnet", maxTurns: 4 }), "/tmp/scratch");
  assert.deepEqual(settings.segwi.repositories, [{ name: "canary", path: "/tmp/scratch", actions: ["ask"] }]);
  assert.equal(settings.segwi.model, "sonnet");
  assert.equal(settings.segwi.limits.maxTurns, 4);
  assert.equal(settings.segwi.limits.approvalTimeoutMinutes, 2);
  assert.equal(settings.segwi.bind.port, 0);
  assert.match(CANARY_TASK, /curl -sI https:\/\/example\.com/);
  assert.match(CANARY_TASK, /README\.md/);
});

test("the scratch repository has a README and a verify script that passes", (t) => {
  const dir = tempDir(t, "segwi-cn-state-");
  makeScratchRepo(dir);
  assert.match(readFileSync(path.join(dir, "README.md"), "utf8"), /^# segwi canary/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.verify, 'node -e ""');
});

test("a host that writes a message type the adapter does not know fails the canary, and the version is not recorded", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  const state = await runCanary({ settings: settingsWithCanary(), stateDir, dataDir: tempDir(t, "segwi-cn-data-"), host: replaying(t, withUnknownKind(t)), waits: WAITS });
  assert.equal(state.ok, false);
  assert.match(state.problem, /did not recognise a "brand_new_message" message/);
  assert.equal(state.hostVersion, "2.1.309");
  assert.deepEqual(state.canaryTestedVersions, []);
});

test("--save-stream writes the host's raw stream with this machine's paths and secrets gone", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  const file = path.join(tempDir(t, "segwi-cn-stream-"), "stream.jsonl");
  await runCanary({ settings: settingsWithCanary(), stateDir, dataDir: tempDir(t, "segwi-cn-data-"), host: replaying(t), waits: WAITS, saveStream: file });
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.type === "result"));
  assert.ok(lines.every((line) => !line.session_id || line.session_id === "11111111-2222-4333-8444-555555555555"));
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(os.tmpdir()) && !text.includes(os.homedir()));
  const redacted = redactedStream([`{"cwd":"/home/someone/work/x","token":"ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}"}`], { home: "/home/someone", repoPath: "/tmp/segwi-canary-1/repo" });
  assert.ok(redacted.includes('"cwd":"~/work/x"') && !redacted.includes("ghp_"));
});

// A stand-in push service, as push.test.mjs has: web-push speaks https, so the agent hands it a plain socket.
async function standIn(t) {
  const posts = [];
  const service = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => { posts.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201).end(); });
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { service.closeAllConnections(); service.close(resolve); }));
  const { port } = /** @type {import("node:net").AddressInfo} */ (service.address());
  const agent = new https.Agent();
  agent.createConnection = () => net.connect(port, "127.0.0.1");
  return { posts, agent };
}

test("a broken host fails loudly: exit code, one stderr line, ok false, the health route and one canary_failed push", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  const dataDir = tempDir(t, "segwi-cn-data-");
  const configDir = tempDir(t, "segwi-cn-config-");
  const configFile = path.join(configDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ segwi: { enabled: true, canary: { model: "haiku" }, vapidSubject: "mailto:segwi-tests@example.com" } }));

  // A person subscribed in the real database, and push is set up.
  initVapid(stateDir);
  const subscriber = makeSubscriber();
  const subscribed = openStore(path.join(dataDir, "segwi.db"));
  subscribed.saveSubscription({ id: "sub1", endpoint: "https://push.example.com/send/abc", p256dh: subscriber.keys.p256dh, auth: subscriber.keys.auth, identity: "me" });
  subscribed.close();
  const push = await standIn(t);

  const out = { stdout: "", stderr: "" };
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const state = await runCanaryCommand(["--config", configFile, "--state-dir", stateDir, "--data-dir", dataDir], {
    stdout: { write: (text) => { out.stdout += text; } }, stderr: { write: (text) => { out.stderr += text; } },
    host: crashing(t), waits: WAITS, pushOptions: { allowEndpoint: () => true, agent: push.agent },
  });

  assert.equal(process.exitCode, 1);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /^segwi canary: failed with Claude Code 2\.1\.309: the run failed: The agent stopped without finishing\.\n$/);
  assert.equal(state.ok, false);
  assert.equal(readCanaryState(stateDir).ok, false);
  assert.deepEqual(readCanaryState(stateDir).canaryTestedVersions, []);
  assert.deepEqual(canaryHealth(stateDir), { ok: false, at: state.at, hostVersion: "2.1.309", problem: "the run failed: The agent stopped without finishing." });

  assert.equal(push.posts.length, 1);
  assert.deepEqual(JSON.parse(decryptPush(push.posts[0].body, subscriber)), { v: 1, kind: "canary_failed", status: "canary_failed", title: "segwi canary failed", url: "/", tag: "canary" });
  const reopened = openStore(path.join(dataDir, "segwi.db"));
  t.after(() => reopened.close());
  assert.ok(reopened.listAudit(10).some((row) => row.action === "canary.failed" && /2\.1\.309/.test(row.detail)));
});

test("a host that is not there fails the canary with a clear reason and no version", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  const state = await runCanary({ settings: settingsWithCanary(), stateDir, dataDir: tempDir(t, "segwi-cn-data-"), host: { bin: "/nonexistent/claude" }, waits: WAITS });
  assert.equal(state.ok, false);
  assert.equal(state.hostVersion, null);
  assert.match(state.problem, /did not answer `--version`/);
});

test("the health route shows the last canary, or null before one has run", async (t) => {
  const stateDir = tempDir(t, "segwi-cn-state-");
  const settings = makeSettings({ repos: [{ name: "my-app", path: makeRepo(t), actions: ["ask"] }] });
  const server = await startServer({ settings, dataDir: tempDir(t, "segwi-cn-data-"), runner: createClaudeCodeAdapter({ ...replaying(t), stateDir }), staticRoot: null, stateDir });
  t.after(() => server.close());
  assert.equal((await request(server, "GET", "/api/health")).json.canary, null);
  writeFileSync(canaryStateFile(stateDir), JSON.stringify({ ok: false, at: "2026-10-23T03:30:00.000Z", hostVersion: "2.2.0", problem: "no approval appeared", model: "haiku", costUsd: 0.01 }));
  const health = (await request(server, "GET", "/api/health")).json;
  assert.deepEqual(health.canary, { ok: false, at: "2026-10-23T03:30:00.000Z", hostVersion: "2.2.0", problem: "no approval appeared" });
});

test("an unknown canary flag is a usage error", async () => {
  const previous = process.exitCode;
  const out = { stderr: "" };
  await runCanaryCommand(["--bogus", "x"], { stderr: { write: (text) => { out.stderr += text; } } });
  assert.equal(process.exitCode, 2);
  assert.match(out.stderr, /usage: segwi canary/);
  process.exitCode = previous;
});
