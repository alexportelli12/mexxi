// The security rejection tests (plan sections 11.4 and 11.5): the real server on
// a loopback port, a temporary data directory and repository, and the fake host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BindRefusedError, PortCollisionError } from "../lib/bind.mjs";
import { AuthConfigError } from "../lib/auth.mjs";
import { startServer } from "../lib/serve.mjs";
import { openStore } from "../lib/store.mjs";
import { fakeAdapter, fixturesDir, makeRepo, makeSettings, tempDir, waitFor } from "./helpers.mjs";

const serverEntry = fileURLToPath(new URL("../server.mjs", import.meta.url));
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const noIbni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("no ibni in this test"); }, list: async () => [] };

/** Starts a server over a fresh repo. `fixture` names a recording or a file path. */
async function boot(t, { fixture = "ask-completed", auth, limits, actions = ["build", "ready", "ask"], repoPath, dataDir, adapterOptions, staticRoot = null, settingsPatch = {} } = {}) {
  const repo = repoPath ?? makeRepo(t);
  const dir = dataDir ?? tempDir(t, "segwi-data-");
  const { adapter } = fakeAdapter(t, fixture, adapterOptions);
  const settings = { ...makeSettings({ repos: [{ name: "my-app", path: repo, actions }], auth, limits }), ...settingsPatch };
  const server = await startServer({ settings, dataDir: dir, runner: adapter, ibni: noIbni, staticRoot });
  t.after(() => server.close());
  return { server, repo, dir, settings };
}

function request(server, method, urlPath, { headers = {}, body, raw, origin = true, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const base = { ...(method === "POST" && origin ? { Origin: `http://127.0.0.1:${server.port}` } : {}), ...(payload !== undefined && json ? { "Content-Type": "application/json" } : {}) };
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: urlPath, headers: { ...base, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const startRun = (server, extra = {}, options) => request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "ask", task: "What is here?", ...extra }, ...options });
const rejected = (server, action) => server.store.listAudit(200).filter((row) => row.outcome === "rejected" && row.action === action);
const lastRejected = (server) => server.store.listAudit(1)[0];

test("a non-loopback bind is refused in both auth modes, and the refusal is audited", async (t) => {
  for (const auth of [{ mode: "localhost-only" }, { mode: "tailscale-header", allowed: ["you@example.com"] }]) {
    const dir = tempDir(t, "segwi-data-");
    const settings = makeSettings({ repos: [], auth, host: "0.0.0.0" });
    await assert.rejects(startServer({ settings, dataDir: dir, runner: fakeAdapter(t, "ask-completed").adapter, staticRoot: null }), BindRefusedError);
    const store = openStore(path.join(dir, "segwi.db"));
    assert.equal(store.listAudit(1)[0].outcome, "rejected");
    assert.match(store.listAudit(1)[0].detail, /loopback/);
    store.close();
  }
});

test("the serve command exits 2 and says why when the configured host is not loopback", (t) => {
  const dir = tempDir(t, "segwi-cli-");
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ segwi: { enabled: true, bind: { host: "0.0.0.0" } } }));
  const result = spawnSync(process.execPath, [serverEntry, "serve"], { encoding: "utf8", env: { ...process.env, MEXXI_CONFIG: config, XDG_DATA_HOME: dir } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only listens on loopback/);
  const store = openStore(path.join(dir, "mexxi", "segwi", "segwi.db"));
  assert.equal(store.listAudit(1)[0].outcome, "rejected");
  store.close();
});

test("tailscale-header mode refuses to start with nobody allowed", async (t) => {
  const dir = tempDir(t, "segwi-data-");
  const settings = makeSettings({ repos: [], auth: { mode: "tailscale-header", allowed: [] } });
  await assert.rejects(startServer({ settings, dataDir: dir, runner: fakeAdapter(t, "ask-completed").adapter, staticRoot: null }), AuthConfigError);
});

test("localhost-only rejects a request that carries a proxy identity, or a non-loopback Host", async (t) => {
  const { server } = await boot(t);
  assert.equal((await request(server, "GET", "/api/health")).status, 200);
  for (const headers of [{ "Tailscale-User-Login": "you@example.com" }, { "Tailscale-User-Name": "You" }, { "X-Forwarded-For": "100.64.0.1" }, { Forwarded: "for=1.2.3.4" }, { Host: "evil.example" }]) {
    const response = await request(server, "GET", "/api/repos", { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.equal(rejected(server, "GET /api/repos").length, 5);
  assert.equal((await request(server, "GET", "/api/repos")).status, 200);
});

test("tailscale-header: a missing header is 401, an unlisted login 403, a listed one works", async (t) => {
  const { server } = await boot(t, { auth: { mode: "tailscale-header", allowed: ["You@Example.com"] } });
  assert.equal((await request(server, "GET", "/api/repos")).status, 401);
  assert.equal((await request(server, "GET", "/api/repos", { headers: { "Tailscale-User-Login": "other@example.com" } })).status, 403);
  assert.equal((await request(server, "GET", "/api/repos", { headers: { "Tailscale-User-Login": "you@example.com" } })).status, 200);
  assert.equal(rejected(server, "GET /api/repos").length, 2);
  assert.equal(server.store.listAudit(1)[0].actor, "you@example.com");
});

test("tailscale-header: only loopback names and the configured tailnet name are accepted as Host, so DNS rebinding gets 403", async (t) => {
  const { server } = await boot(t, { auth: { mode: "tailscale-header", allowed: ["you@example.com"] } });
  const identity = { "Tailscale-User-Login": "you@example.com" };
  // A page on evil.example that rebound its name to 127.0.0.1: its own name as Host and Origin, and a real identity.
  const rebound = { ...identity, Host: "evil.example", Origin: "http://evil.example" };
  assert.equal((await request(server, "GET", "/api/repos", { headers: rebound })).status, 403);
  const post = await request(server, "POST", "/api/runs", { headers: rebound, body: { repo: "my-app", action: "ask", task: "x" } });
  assert.equal(post.status, 403);
  assert.match(post.json.error, /neither a loopback name nor segwi.auth.web.hostname/);
  assert.equal((await request(server, "GET", "/", { headers: rebound })).status, 403, "the app shell too");
  for (const host of ["my-machine.example.ts.net.evil.example", "evil.my-machine.example.ts.net", "100.64.0.7"]) {
    assert.equal((await request(server, "GET", "/api/repos", { headers: { ...identity, Host: host } })).status, 403, host);
  }
  for (const host of ["my-machine.example.ts.net", "MY-MACHINE.example.ts.net.", "my-machine.example.ts.net:443", "127.0.0.1", "localhost:4280", "[::1]"]) {
    assert.equal((await request(server, "GET", "/api/repos", { headers: { ...identity, Host: host } })).status, 200, host);
  }
  assert.equal(server.store.listRuns().length, 0);
});

test("tailscale-header mode refuses to start without a tailnet name", async (t) => {
  const settings = makeSettings({ repos: [], auth: { mode: "tailscale-header", allowed: ["you@example.com"], hostname: "" } });
  await assert.rejects(startServer({ settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "ask-completed").adapter, staticRoot: null }), /auth.web.hostname is empty/);
});

test("writes need the app's own origin and a JSON content type", async (t) => {
  const { server } = await boot(t);
  const attempts = [
    [{ headers: { Origin: "http://evil.example" } }, 403],
    [{ origin: false }, 403],
    [{ origin: false, headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
    [{ headers: { "Content-Type": "text/plain" } }, 415],
    [{ json: false }, 415],
  ];
  for (const [options, status] of attempts) {
    const response = await startRun(server, {}, options);
    assert.equal(response.status, status, JSON.stringify(options));
    assert.equal(lastRejected(server).outcome, "rejected");
  }
  assert.equal(server.store.listRuns().length, 0);
  assert.equal((await startRun(server, {}, { origin: false, headers: { "Sec-Fetch-Site": "same-origin" } })).status, 201);
});

test("an unlisted repo or action, an extra field, and over-length input are 400 and audited", async (t) => {
  const { server } = await boot(t, { actions: ["ask"], limits: { taskMaxChars: 20, inputMaxChars: 10 } });
  const cases = [
    { repo: "other-app" },
    { action: "build" },
    { action: "deploy" },
    { extra: "field" },
    { task: "x".repeat(21) },
    { task: "" },
    { clientId: "not-a-uuid" },
  ];
  for (const change of cases) {
    const response = await startRun(server, change);
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.equal(lastRejected(server).action, "POST /api/runs");
    assert.ok(!lastRejected(server).detail.includes("x".repeat(21)), "the audit never holds the body");
  }
  assert.equal((await request(server, "POST", "/api/runs", { raw: "{not json" })).status, 400);
  assert.equal(server.store.listRuns().length, 0);

  const { run } = (await startRun(server)).json;
  await waitFor(() => server.store.getRun(run.id).status === "completed");
  const sendTo = (id, body, urlPath = "input") => request(server, "POST", `/api/runs/${id}/${urlPath}`, { body });
  assert.equal((await sendTo(run.id, { text: "x".repeat(11) })).status, 400);
  assert.equal((await sendTo(run.id, { text: "hi", extra: 1 })).status, 400);
  assert.equal((await sendTo(run.id, { confirm: false }, "stop")).status, 400);
  assert.equal((await sendTo(run.id, {}, "stop")).status, 400);
  assert.equal((await request(server, "GET", "/api/runs?limit=51")).status, 400);
  assert.equal((await request(server, "GET", "/api/runs?bogus=1")).status, 400);
  assert.equal((await request(server, "GET", `/api/runs/${run.id}/events?since=-1`)).status, 400);
  assert.equal((await request(server, "GET", "/api/audit?limit=201")).status, 400);
  assert.equal((await request(server, "POST", "/api/runs", { raw: JSON.stringify({ task: "x".repeat(70 * 1024) }) })).status, 413);
});

test("a dirty checkout, or one off its default branch, is 409 and audited", async (t) => {
  const { server, repo } = await boot(t);
  writeFileSync(path.join(repo, "untracked.txt"), "x");
  const dirty = await startRun(server);
  assert.equal(dirty.status, 409);
  assert.match(dirty.json.error, /uncommitted/);
  assert.equal(lastRejected(server).outcome, "rejected");
  spawnSync("git", ["-C", repo, "clean", "-fdq"]);
  spawnSync("git", ["-C", repo, "checkout", "-q", "-b", "feature"]);
  const off = await startRun(server);
  assert.equal(off.status, 409);
  assert.match(off.json.error, /feature/);
  assert.equal(server.store.listRuns().length, 0);
  const repos = (await request(server, "GET", "/api/repos")).json.repos;
  assert.equal(repos[0].onDefault, false);
  assert.ok(!JSON.stringify(repos).includes(repo), "the repository path is never shown");
});

test("without a working sandbox a run is refused, health says why, and allowUnsandboxed lets it start with a warning", async (t) => {
  const noSandbox = { sandboxProblems: () => ["Claude Code's sandbox can't start: install bubblewrap and socat (missing: bwrap)."] };
  const { server } = await boot(t, { adapterOptions: noSandbox });
  const refused = await startRun(server);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /sandbox can't start, so segwi won't start a run/);
  assert.equal(server.store.listRuns().length, 0);
  assert.match(lastRejected(server).detail, /^409 .*sandbox/);
  const health = (await request(server, "GET", "/api/health")).json;
  assert.equal(health.ok, false);
  assert.deepEqual({ available: health.sandbox.available, required: health.sandbox.required }, { available: false, required: true });
  assert.match(health.sandbox.problems.join(" "), /missing: bwrap.*won't start a run/);

  const repo = makeRepo(t);
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions: ["ask"] }] });
  settings.segwi.allowUnsandboxed = true;
  const loose = await startServer({ settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "ask-completed", noSandbox).adapter, ibni: noIbni, staticRoot: null });
  t.after(() => loose.close());
  assert.equal((await startRun(loose)).status, 201);
  const warned = (await request(loose, "GET", "/api/health")).json;
  assert.equal(warned.ok, true);
  assert.deepEqual({ available: warned.sandbox.available, required: warned.sandbox.required }, { available: false, required: false });
  assert.match(warned.sandbox.problems.at(-1), /without Claude Code's sandbox, because segwi.allowUnsandboxed is on/);
});

test("over the concurrent-runs cap, or the daily cap, is 429 and audited", async (t) => {
  const concurrent = await boot(t, { fixture: "build-needs-input", limits: { concurrentRuns: 1 } });
  assert.equal((await startRun(concurrent.server, { action: "build" })).status, 201);
  const blocked = await startRun(concurrent.server, { action: "build", task: "another" });
  assert.equal(blocked.status, 429);
  assert.equal(lastRejected(concurrent.server).outcome, "rejected");

  const daily = await boot(t, { limits: { runsPerDay: 1 } });
  const { run } = (await startRun(daily.server)).json;
  await waitFor(() => daily.server.store.getRun(run.id).status === "completed");
  assert.equal((await startRun(daily.server, { task: "second" })).status, 429);
  assert.equal(daily.server.store.listRuns().length, 1);
});

test("an ask run completes, shows readable steps, and a repeated clientId returns the same run", async (t) => {
  const { server } = await boot(t);
  const clientId = "0b8e3c2e-5a4b-4a53-9a0e-1d2f3a4b5c6d";
  const created = await startRun(server, { clientId });
  assert.equal(created.status, 201);
  const id = created.json.run.id;
  await waitFor(() => server.store.getRun(id).status === "completed");
  const again = await startRun(server, { clientId });
  assert.equal(again.status, 200);
  assert.equal(again.json.run.id, id);
  assert.equal(server.store.listRuns().length, 1);

  const run = (await request(server, "GET", `/api/runs/${id}`)).json.run;
  assert.equal(run.status, "completed");
  assert.equal(typeof run.costUsd, "number");
  assert.ok(!("worktreePath" in run) && !("hostSessionId" in run));
  assert.deepEqual(run.steps.map((step) => step.type), ["command", "message"]);
  assert.equal(run.steps[0].ok, true);
  assert.equal(run.steps[0].detail, "README.md\nnotes.txt");
  const events = (await request(server, "GET", `/api/runs/${id}/events?since=1`)).json.events;
  assert.ok(events.every((event) => event.seq > 1));
  assert.deepEqual((await request(server, "GET", "/api/runs?status=completed&limit=5")).json.runs.map((entry) => entry.id), [id]);
  assert.equal((await request(server, "POST", `/api/runs/${id}/stop`, { body: { confirm: true } })).status, 409);
  assert.equal((await request(server, "POST", `/api/runs/${id}/input`, { body: { text: "more" } })).status, 409);
  assert.equal((await request(server, "GET", "/api/runs/00000000-0000-4000-8000-000000000000")).status, 404);

  const health = (await request(server, "GET", "/api/health")).json;
  assert.equal(health.runner.id, "claude-code");
  assert.equal(health.runner.tested, true);
  assert.deepEqual(health.sandbox, { available: true, required: true, problems: [] });
  for (const header of ["content-security-policy", "x-content-type-options", "referrer-policy"]) assert.ok(health[header] === undefined && (await request(server, "GET", "/api/health")).headers[header]);
  assert.match((await request(server, "GET", "/api/health")).headers["cache-control"], /no-store/);
  assert.match((await request(server, "GET", "/")).text, /Build the web app/);
  assert.ok(server.store.listAudit(200).some((row) => row.action === "POST /api/runs" && row.outcome === "ok"));
});

test("a build run that asks a question waits for a reply, takes it, and can be stopped", async (t) => {
  const { server } = await boot(t, { fixture: "build-needs-input" });
  const id = (await startRun(server, { action: "build", task: "add a flag" })).json.run.id;
  await waitFor(() => server.store.getRun(id).status === "needs_input");
  assert.equal((await request(server, "POST", `/api/runs/${id}/input`, { body: { text: "Default to off." } })).status, 200);
  await waitFor(() => server.store.listEvents(id).filter((event) => event.kind === "result").length === 2);
  assert.equal(server.store.getRun(id).status, "needs_input");
  const stopped = await request(server, "POST", `/api/runs/${id}/stop`, { body: { confirm: true } });
  assert.equal(stopped.json.run.status, "stopped");
  assert.ok(server.store.listAudit(50).some((row) => row.action === "POST /api/runs/:id/stop" && row.outcome === "ok"));
});

test("a run that goes quiet is stopped as timed out, and the hard limit stops a busy one", async (t) => {
  const idle = await boot(t, { fixture: "build-needs-input", limits: { idleTimeoutMinutes: 0.004 } });
  const idleId = (await startRun(idle.server, { action: "build" })).json.run.id;
  await waitFor(() => idle.server.store.getRun(idleId).status === "timed_out");
  assert.match(idle.server.store.getRun(idleId).reason, /No activity/);

  const hard = await boot(t, { fixture: "build-needs-input", limits: { hardTimeoutMinutes: 0.004 } });
  const hardId = (await startRun(hard.server, { action: "build" })).json.run.id;
  await waitFor(() => hard.server.store.getRun(hardId).status === "timed_out");
  assert.equal(hard.server.store.getRun(hardId).reason, "Hit the time limit");
});

test("a run left active by a previous process is marked failed on start", async (t) => {
  const dir = tempDir(t, "segwi-data-");
  const repo = makeRepo(t);
  const first = await boot(t, { fixture: "build-needs-input", dataDir: dir, repoPath: repo });
  const id = (await startRun(first.server, { action: "build" })).json.run.id;
  await waitFor(() => first.server.store.getRun(id).status === "needs_input");
  await first.server.close();
  const second = await boot(t, { dataDir: dir, repoPath: repo });
  const run = second.server.store.getRun(id);
  assert.equal(run.status, "failed");
  assert.equal(run.reason, "segwi restarted while this run was active");
});

test("audit rows can't be updated or deleted", async (t) => {
  const { server } = await boot(t);
  await request(server, "GET", "/api/health");
  assert.throws(() => server.store.db.exec("UPDATE audit SET outcome = 'ok'"), /append-only/);
  assert.throws(() => server.store.db.exec("DELETE FROM audit"), /append-only/);
  assert.ok(server.store.listAudit(1).length === 1);
});

test("a seeded token in the task and in tool output is absent from the database, REST, SSE and replay", async (t) => {
  const recording = readFileSync(path.join(fixturesDir, "claude-code", "ask-completed.jsonl"), "utf8");
  const seeded = path.join(tempDir(t, "segwi-fixture-"), "seeded.jsonl");
  writeFileSync(seeded, recording.replace("README.md\\nnotes.txt", `leaked ${TOKEN} here`));
  const { server, dir } = await boot(t, { fixture: seeded });

  const chunks = [];
  const stream = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/stream" }, (res) => { res.on("data", (chunk) => chunks.push(String(chunk))); resolve(req); });
  });
  t.after(() => stream.destroy());
  const created = await startRun(server, { task: `Use ${TOKEN} to look around` });
  const id = created.json.run.id;
  await waitFor(() => server.store.getRun(id).status === "completed");
  await waitFor(() => chunks.join("").includes('"completed"'));

  const rest = [created.text, (await request(server, "GET", `/api/runs/${id}`)).text, (await request(server, "GET", `/api/runs/${id}/events`)).text,
    (await request(server, "GET", "/api/runs")).text, (await request(server, "GET", "/api/audit")).text].join("\n");
  assert.ok(rest.includes("[REDACTED]"));
  assert.ok(!rest.includes(TOKEN), "REST");
  assert.ok(chunks.join("").includes("event: event") && chunks.join("").includes("event: run"));
  assert.ok(!chunks.join("").includes(TOKEN), "SSE");

  const replay = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/stream", headers: { "Last-Event-ID": "0" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; if (text.includes('"completed"')) { req.destroy(); resolve(text); } });
    });
  });
  assert.ok(replay.includes("event: event") && !replay.includes(TOKEN), "replay");

  server.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  for (const name of readdirSync(dir).filter((file) => file.startsWith("segwi.db"))) {
    assert.ok(!readFileSync(path.join(dir, name)).includes(TOKEN), `${name} holds no token`);
  }
});

test("a bind port inside workflow.ports is refused and audited, and the CLI exits 2", async (t) => {
  const dir = tempDir(t, "segwi-data-");
  const settings = { ...makeSettings({ repos: [] }), workflowPorts: { first: 3000, last: 3999 } };
  settings.segwi.bind.port = 3500;
  await assert.rejects(startServer({ settings, dataDir: dir, runner: fakeAdapter(t, "ask-completed").adapter, staticRoot: null }), PortCollisionError);
  const store = openStore(path.join(dir, "segwi.db"));
  assert.equal(store.listAudit(1)[0].outcome, "rejected");
  assert.match(store.listAudit(1)[0].detail, /workflow\.ports/);
  store.close();

  const cliDir = tempDir(t, "segwi-cli-");
  const config = path.join(cliDir, "config.json");
  writeFileSync(config, JSON.stringify({ segwi: { enabled: true, bind: { port: 4280 } }, workflow: { ports: { first: 4200, last: 4300 } } }));
  const result = spawnSync(process.execPath, [serverEntry, "serve"], { encoding: "utf8", env: { ...process.env, MEXXI_CONFIG: config, XDG_DATA_HOME: cliDir } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /workflow\.ports/);
});

test("a malformed percent escape in a static path is 400, not 500", async (t) => {
  const root = tempDir(t, "segwi-static-");
  writeFileSync(path.join(root, "index.html"), "<p>app</p>");
  const { server } = await boot(t, { staticRoot: root });
  assert.equal((await request(server, "GET", "/%E0%A4%A")).status, 400);
  assert.equal((await request(server, "GET", "/anything")).status, 200);
});
