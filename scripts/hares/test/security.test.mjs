// The security rejection tests (plan sections 11.4 and 11.5): the real server on
// a loopback port, a temporary data directory and repository, a fake herdr and
// the fake claude it starts (helpers.mjs startHares).
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
import { createSessionStream } from "../lib/session-stream.mjs";
import { makeSettings, startHares, tempDir, waitFor } from "./helpers.mjs";

const serverEntry = fileURLToPath(new URL("../server.mjs", import.meta.url));
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;

/** Starts a server over a fresh repo and a fake herdr. `scenario` names what the fake claude says. */
async function boot(t, { scenario = "completed", actions = ["build", "ready", "ask"], ...options } = {}) {
  const box = await startHares(t, { scenario, actions, ...options });
  return { ...box, dir: box.dataDir };
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
    const dir = tempDir(t, "hares-data-");
    const settings = makeSettings({ repos: [], auth, host: "0.0.0.0" });
    await assert.rejects(startServer({ settings, dataDir: dir, staticRoot: null }), BindRefusedError);
    const store = openStore(path.join(dir, "segwi.db"));
    assert.equal(store.listAudit(1)[0].outcome, "rejected");
    assert.match(store.listAudit(1)[0].detail, /loopback/);
    store.close();
  }
});

test("the serve command exits 2 and says why when the configured host is not loopback", (t) => {
  const dir = tempDir(t, "hares-cli-");
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ hares: { enabled: true, bind: { host: "0.0.0.0" } } }));
  const result = spawnSync(process.execPath, [serverEntry, "serve"], { encoding: "utf8", env: { ...process.env, MEXXI_CONFIG: config, XDG_DATA_HOME: dir } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only listens on loopback/);
  const store = openStore(path.join(dir, "mexxi", "hares", "segwi.db"));
  assert.equal(store.listAudit(1)[0].outcome, "rejected");
  store.close();
});

test("tailscale-header mode refuses to start with nobody allowed", async (t) => {
  const dir = tempDir(t, "hares-data-");
  const settings = makeSettings({ repos: [], auth: { mode: "tailscale-header", allowed: [] } });
  await assert.rejects(startServer({ settings, dataDir: dir, staticRoot: null }), AuthConfigError);
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
  assert.match(post.json.error, /neither a loopback name nor hares.auth.web.hostname/);
  assert.equal((await request(server, "GET", "/", { headers: rebound })).status, 403, "the app shell too");
  for (const host of ["my-machine.example.ts.net.evil.example", "evil.my-machine.example.ts.net", "100.64.0.7", "my-machine.example.ts.net.", "localhost.", "127.0.0.1."]) {
    assert.equal((await request(server, "GET", "/api/repos", { headers: { ...identity, Host: host } })).status, 403, host);
  }
  for (const host of ["my-machine.example.ts.net", "MY-MACHINE.example.ts.net", "my-machine.example.ts.net:443", "127.0.0.1", "localhost:4280", "[::1]"]) {
    assert.equal((await request(server, "GET", "/api/repos", { headers: { ...identity, Host: host } })).status, 200, host);
  }
  assert.equal(server.store.listLaunches().length, 0);
});

test("a run's own browser is refused everywhere, whatever the Host, identity or origin", async (t) => {
  for (const auth of [{ mode: "localhost-only" }, { mode: "tailscale-header", allowed: ["you@example.com"] }]) {
    const { server } = await boot(t, { auth });
    const agent = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36 hares-run-browser", ...(auth.mode === "tailscale-header" ? { "Tailscale-User-Login": "you@example.com" } : {}) };
    for (const [method, route] of [["GET", "/"], ["GET", "/approvals"], ["GET", "/api/approvals"], ["GET", "/api/questions"], ["GET", "/api/stream"], ["POST", "/api/approvals/0123456789abcdef01234567"], ["POST", "/api/sessions/abc/answer"], ["POST", "/api/prs/my-app/1/merge"], ["POST", "/mcp"], ["POST", "/internal/approvals"], ["GET", "/ext/tokens.css"]]) {
      const response = await request(server, method, route, { headers: agent, body: method === "POST" ? { decision: "allow" } : undefined });
      assert.equal(response.status, 403, `${auth.mode} ${method} ${route}`);
    }
    assert.ok(server.store.listAudit(20).some((row) => row.detail === "403 a run's own browser"));
  }
});

test("tailscale-header mode refuses to start without a tailnet name", async (t) => {
  const settings = makeSettings({ repos: [], auth: { mode: "tailscale-header", allowed: ["you@example.com"], hostname: "" } });
  await assert.rejects(startServer({ settings, dataDir: tempDir(t, "hares-data-"), staticRoot: null }), /auth.web.hostname is empty/);
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
  assert.equal(server.store.listLaunches().length, 0);
  assert.equal((await startRun(server, {}, { origin: false, headers: { "Sec-Fetch-Site": "same-origin" } })).status, 201);
});


/** Waits for the session behind a legacy run id to show its pane and transcript. */
async function launched(server, id) {
  return waitFor(async () => {
    await server.adapter.refresh();
    await server.sessions.sync();
    const run = (await request(server, "GET", `/api/runs/${id}`)).json?.run;
    return run && run.status !== "queued" && run.steps.length ? run : null;
  }, { what: "the session to start" });
}

// Break caught: the web app's start (and the old run route) skip the repository's actions for the new ways to
// start, so a plain session, a mexxi command, an issue or a pull request fix runs on an ask-only repository.
test("on an ask-only repository the web app refuses a session, a command, an issue and a pull request fix with an audited 400", async (t) => {
  const { server, fake } = await boot(t, { actions: ["ask"] });
  const sessionStarts = [
    { repo: "my-app", kind: "prompt", prompt: "Hi" },
    { repo: "my-app", kind: "command", command: "wettaq", args: "do it" },
    { repo: "my-app", kind: "command", command: "lesti" },
    { repo: "my-app", kind: "issue", issue: 3 },
    { repo: "my-app", kind: "pr", pr: 4, ask: "failing-check" },
  ];
  for (const body of sessionStarts) {
    assert.equal((await request(server, "POST", "/api/sessions", { body })).status, 400, JSON.stringify(body));
    assert.equal(lastRejected(server).action, "POST /api/sessions");
    assert.match(lastRejected(server).detail, /^400 Invalid kind/);
  }
  for (const change of [{ action: "session", task: "Hi" }, { action: "command", command: "wettaq" }, { action: "issue", issue: 3, task: undefined }, { action: "pr", pr: 4, task: undefined }]) {
    assert.equal((await startRun(server, change)).status, 400, JSON.stringify(change));
    assert.equal(lastRejected(server).action, "POST /api/runs");
  }
  assert.equal(server.store.listLaunches().length, 0);
  assert.equal(fake.writes().length, 0, "nothing reached herdr");
  assert.equal((await startRun(server)).status, 201, "ask, which the repository allows, still starts");
});

test("an unlisted repo or action, an extra field, and over-length input are 400 and audited", async (t) => {
  const { server, fake } = await boot(t, { actions: ["ask"], limits: { taskMaxChars: 20, inputMaxChars: 10 } });
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
  for (const body of [{ repo: "other-app", kind: "prompt", prompt: "x" }, { repo: "my-app", kind: "deploy" }, { repo: "my-app", kind: "prompt", prompt: "x", extra: 1 }]) {
    assert.equal((await request(server, "POST", "/api/sessions", { body })).status, 400, JSON.stringify(body));
  }
  assert.equal(server.store.listLaunches().length, 0);
  assert.equal(fake.writes().length, 0, "nothing reached herdr");

  const { run } = (await startRun(server)).json;
  await launched(server, run.id);
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
  const session = (await request(server, "GET", "/api/sessions")).json.sessions[0];
  const expect = { terminalId: session.terminalId, sessionId: session.id, status: session.status, seq: session.seq };
  assert.equal((await request(server, "POST", `/api/sessions/${session.id}/steer`, { body: { expect, text: "x".repeat(11) } })).status, 400);
  assert.equal((await request(server, "POST", `/api/sessions/${session.id}/end`, { body: { expect } })).status, 400, "ending needs confirm: true");
});

test("a dirty checkout, or one off its default branch, is 409 for work that commits, and audited", async (t) => {
  const { server, repo, fake } = await boot(t);
  writeFileSync(path.join(repo, "untracked.txt"), "x");
  const dirty = await startRun(server, { action: "build" });
  assert.equal(dirty.status, 409);
  assert.match(dirty.json.error, /uncommitted/);
  assert.equal(lastRejected(server).outcome, "rejected");
  spawnSync("git", ["-C", repo, "clean", "-fdq"]);
  spawnSync("git", ["-C", repo, "checkout", "-q", "-b", "feature"]);
  const off = await startRun(server, { action: "build" });
  assert.equal(off.status, 409);
  assert.match(off.json.error, /feature/);
  assert.equal(server.store.listLaunches().length, 0);
  assert.equal(fake.writes().length, 0);
});

test("over the concurrent-sessions cap, or the daily cap, is 429 and audited", async (t) => {
  const concurrent = await boot(t, { limits: { concurrentRuns: 1 } });
  assert.equal((await startRun(concurrent.server, { action: "build" })).status, 201);
  const blocked = await startRun(concurrent.server, { action: "build", task: "another" });
  assert.equal(blocked.status, 429);
  assert.equal(lastRejected(concurrent.server).outcome, "rejected");

  const daily = await boot(t, { limits: { runsPerDay: 1, concurrentRuns: 5 } });
  assert.equal((await request(daily.server, "POST", "/api/sessions", { body: { repo: "my-app", kind: "prompt", prompt: "first" } })).status, 201);
  assert.equal((await request(daily.server, "POST", "/api/sessions", { body: { repo: "my-app", kind: "prompt", prompt: "second" } })).status, 429);
  assert.equal(daily.server.store.listLaunches().length, 1);
});

test("an ask session shows readable steps through the old routes, and a repeated clientId returns the same run", async (t) => {
  const { server, claude } = await boot(t);
  const clientId = "0b8e3c2e-5a4b-4a53-9a0e-1d2f3a4b5c6d";
  const created = await startRun(server, { clientId });
  assert.equal(created.status, 201);
  const id = created.json.run.id;
  const run = await launched(server, id);
  const again = await startRun(server, { clientId });
  assert.equal(again.status, 200);
  assert.equal(again.json.run.id, id);
  assert.equal(server.store.listLaunches().length, 1);
  assert.ok(claude.starts[0].args.includes("--disallowedTools"), "an ask can't write files");

  assert.equal(run.status, "needs_input");
  assert.ok(!("worktreePath" in run) && !("hostSessionId" in run) && !("cwd" in run));
  assert.deepEqual(run.steps.map((step) => step.type), ["message", "command", "message"]);
  const events = (await request(server, "GET", `/api/runs/${id}/events?since=1`)).json.events;
  assert.ok(events.length > 0 && events.every((event) => event.seq > 1));
  assert.equal((await request(server, "GET", "/api/runs/00000000-0000-4000-8000-000000000000")).status, 404);

  const health = (await request(server, "GET", "/api/health")).json;
  assert.equal(health.ok, true);
  assert.equal(health.herdr.connected, true);
  assert.equal(health.herdr.protocol, 22);
  assert.ok(!("canary" in health) && !("runner" in health), "the retired canary and runner are gone from health");
  for (const header of ["content-security-policy", "x-content-type-options", "referrer-policy"]) assert.ok((await request(server, "GET", "/api/health")).headers[header]);
  assert.match((await request(server, "GET", "/api/health")).headers["cache-control"], /no-store/);
  assert.match((await request(server, "GET", "/")).text, /Build the web app/);
  assert.ok(server.store.listAudit(200).some((row) => row.action === "POST /api/runs" && row.outcome === "ok"));
});

test("a session that waits takes a reply through the old input route, and stop ends its pane", async (t) => {
  const { server, fake } = await boot(t, { scenario: "asks" });
  const id = (await startRun(server, { action: "build", task: "add a flag" })).json.run.id;
  await launched(server, id);
  assert.equal((await request(server, "POST", `/api/runs/${id}/input`, { body: { text: "Default to off." } })).status, 200);
  assert.ok(fake.writes().some((entry) => entry.params.text === "Default to off."));
  const stopped = await request(server, "POST", `/api/runs/${id}/stop`, { body: { confirm: true } });
  assert.equal(stopped.json.run.status, "stopped");
  assert.equal(fake.state.agents.length, 0, "the pane is closed");
  assert.ok(server.store.listAudit(50).some((row) => row.action === "POST /api/runs/:id/stop" && row.outcome === "ok"));
});

test("audit rows can't be updated or deleted", async (t) => {
  const { server } = await boot(t);
  await request(server, "GET", "/api/health");
  assert.throws(() => server.store.db.exec("UPDATE audit SET outcome = 'ok'"), /append-only/);
  assert.throws(() => server.store.db.exec("DELETE FROM audit"), /append-only/);
  assert.ok(server.store.listAudit(1).length === 1);
});

test("a seeded token in the task and in the transcript is absent from the database, REST and SSE", async (t) => {
  process.env.FAKE_HOST_TOKEN = TOKEN;
  t.after(() => { delete process.env.FAKE_HOST_TOKEN; });
  const scenario = path.join(tempDir(t, "hares-fixture-"), "seeded.json");
  writeFileSync(scenario, JSON.stringify([{ tool: "Bash", input: { command: "ls" }, result: "x" }, { say: "leaked __FAKE_TOKEN__ here" }]));
  const { server, dir } = await boot(t, { scenario });

  const chunks = [];
  const stream = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/stream" }, (res) => { res.on("data", (chunk) => chunks.push(String(chunk))); resolve(req); });
  });
  t.after(() => stream.destroy());
  const created = await startRun(server, { task: `Use ${TOKEN} to look around` });
  const id = created.json.run.id;
  const run = await launched(server, id);
  await waitFor(() => chunks.join("").includes("event: session"), { what: "a session event" });

  const rest = [created.text, (await request(server, "GET", `/api/runs/${id}`)).text, (await request(server, "GET", `/api/runs/${id}/events`)).text,
    (await request(server, "GET", "/api/runs")).text, (await request(server, "GET", "/api/audit")).text, (await request(server, "GET", "/api/sessions")).text,
    (await request(server, "GET", `/api/sessions/${run.id}`)).text].join("\n");
  assert.ok(rest.includes("[REDACTED]"));
  assert.ok(!rest.includes(TOKEN), "REST");
  assert.ok(!chunks.join("").includes(TOKEN), "SSE");
  server.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  for (const name of readdirSync(dir).filter((file) => file.startsWith("segwi.db"))) {
    assert.ok(!readFileSync(path.join(dir, name)).includes(TOKEN), `${name} holds no token`);
  }
});

test("a bind port inside workflow.ports is refused and audited, and the CLI exits 2", async (t) => {
  const dir = tempDir(t, "hares-data-");
  const settings = { ...makeSettings({ repos: [] }), workflowPorts: { first: 3000, last: 3999 } };
  settings.hares.bind.port = 3500;
  await assert.rejects(startServer({ settings, dataDir: dir, staticRoot: null }), PortCollisionError);
  const store = openStore(path.join(dir, "segwi.db"));
  assert.equal(store.listAudit(1)[0].outcome, "rejected");
  assert.match(store.listAudit(1)[0].detail, /workflow\.ports/);
  store.close();

  const cliDir = tempDir(t, "hares-cli-");
  const config = path.join(cliDir, "config.json");
  writeFileSync(config, JSON.stringify({ hares: { enabled: true, bind: { port: 4280 } }, workflow: { ports: { first: 4200, last: 4300 } } }));
  const result = spawnSync(process.execPath, [serverEntry, "serve"], { encoding: "utf8", env: { ...process.env, MEXXI_CONFIG: config, XDG_DATA_HOME: cliDir } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /workflow\.ports/);
});

test("a malformed percent escape in a static path is 400, not 500", async (t) => {
  const root = tempDir(t, "hares-static-");
  writeFileSync(path.join(root, "index.html"), "<p>app</p>");
  const { server } = await boot(t, { staticRoot: root });
  assert.equal((await request(server, "GET", "/%E0%A4%A")).status, 400);
  assert.equal((await request(server, "GET", "/anything")).status, 200);
});

test("concurrent starts with one clientId make one session: the first gets 201, the rest 200 with the same id", async (t) => {
  const { server, fake } = await boot(t);
  const clientId = "4c1d6a3e-2b7f-4e8a-9c0d-1e2f3a4b5c6d";
  const responses = await Promise.all(Array.from({ length: 5 }, () => request(server, "POST", "/api/sessions", { body: { repo: "my-app", kind: "prompt", prompt: "hi", clientId } })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(responses.map((response) => response.json.session.id)).size, 1);
  assert.equal(server.store.listLaunches().length, 1);
  assert.equal(fake.writes().filter((entry) => entry.method.endsWith(".start")).length, 1);
});

test("the live stream names what changed and never carries content, and a client too far behind gets one reset", () => {
  const listeners = new Map();
  const sessions = { on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } };
  const stream = createSessionStream({ sessions, heartbeatMs: 60_000 });
  const connect = (lastEventId) => {
    let text = "";
    const res = { writeHead() {}, write(chunk) { text += chunk; }, on() {}, end() {} };
    stream.handle({ headers: lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) } }, res);
    return () => text;
  };
  const live = connect();
  listeners.get("question.added")({ sessionId: "s1", recordId: "toolu_1", text: "secret question text", initial: false });
  listeners.get("session.changed")({ id: "s1", status: "blocked", initial: false });
  listeners.get("session.changed")({ id: "s2", initial: true });
  assert.match(live(), /event: question\ndata: \{"sessionId":"s1","id":"toolu_1","at":/);
  assert.match(live(), /event: session\ndata: \{"sessionId":"s1","at":/);
  assert.doesNotMatch(live(), /secret question text|blocked|s2/, "ids only; the initial sync is not news");
  assert.match(connect(1)(), /event: session/, "a client one event behind is replayed what it missed");
  assert.match(connect(9999)(), /event: reset/, "an id this process never issued resets the client");
  stream.close();
});

