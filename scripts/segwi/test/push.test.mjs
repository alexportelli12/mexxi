// Push (plan sections 6.8, 11.5 and 11.8): a stand-in push service records what the
// server sends; the test decrypts each body the way a browser would.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { endpointAllowed } from "../lib/push.mjs";
import { startServer } from "../lib/serve.mjs";
import { runVapid } from "../lib/vapid-cli.mjs";
import { initVapid, readVapid } from "../lib/vapid.mjs";
import { decryptPush, makeSubscriber } from "./push-decrypt.mjs";
import { fakeAdapter, makeRepo, makeSettings, request, tempDir, waitFor } from "./helpers.mjs";

const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;

async function standIn(t) {
  const posts = [];
  const state = { status: 201 };
  const service = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      posts.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(state.status).end();
    });
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { service.closeAllConnections(); service.close(resolve); }));
  const { port } = /** @type {import("node:net").AddressInfo} */ (service.address());
  // web-push always speaks https; this agent hands it a plain socket to the stand-in instead.
  const agent = new https.Agent();
  agent.createConnection = () => net.connect(port, "127.0.0.1");
  return { posts, state, agent, endpoint: "https://push.example.com/send/abc123" };
}

const noPr = { pr: false };
const ibni = {
  findNewWorkspace: async () => ({ sessionId: "s1", worktreePath: "/tmp/segwi-test-worktrees/s1" }),
  summary: async () => ({ branch: "agent/demo", prUrl: noPr.pr ? "https://github.com/example/my-app/pull/1" : null, verify: "pass", worktreePath: "/tmp/segwi-test-worktrees/s1" }),
  list: async () => [],
};

async function boot(t, fixture, push, stateDir) {
  process.env.FAKE_HOST_TOKEN = TOKEN;
  t.after(() => { delete process.env.FAKE_HOST_TOKEN; });
  const repo = makeRepo(t);
  const host = fakeAdapter(t, fixture);
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions: ["build", "ready", "ask"] }] });
  const server = await startServer({
    settings, dataDir: tempDir(t, "segwi-data-"), runner: host.adapter, ibni, staticRoot: null, stateDir,
    pushOptions: { allowEndpoint: () => true, agent: push.agent },
  });
  t.after(() => server.close());
  const subscriber = makeSubscriber();
  const subscribed = await request(server, "POST", "/api/push/subscriptions", { body: { endpoint: push.endpoint, keys: subscriber.keys } });
  assert.equal(subscribed.status, 201);
  return { server, subscriber, subscriptionId: subscribed.json.id };
}

const decrypted = (push, subscriber) => push.posts.map((post) => JSON.parse(decryptPush(post.body, subscriber)));

test("each transition that needs you sends exactly one encrypted push, with the documented headers and payload", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  const publicKey = initVapid(stateDir);
  const push = await standIn(t);
  noPr.pr = false;
  const { server, subscriber } = await boot(t, "push-flow", push, stateDir);
  const started = await request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task: `Look at example.com with ${TOKEN}` } });
  const runId = started.json.run.id;
  const answer = async (decision) => {
    const approval = await waitFor(async () => (await request(server, "GET", "/api/approvals?status=pending")).json.approvals[0], { what: "an approval" });
    await request(server, "POST", `/api/approvals/${approval.id}`, { body: { decision } });
    return approval;
  };
  const first = await answer("allow");
  await waitFor(() => server.store.getRun(runId).status === "running" || server.store.pendingApprovalsFor(runId).length === 0, { what: "resume" });
  const second = await waitFor(async () => {
    const pending = (await request(server, "GET", "/api/approvals?status=pending")).json.approvals[0];
    return pending && pending.id !== first.id ? pending : null;
  }, { what: "the second approval" });
  await request(server, "POST", `/api/approvals/${second.id}`, { body: { decision: "deny" } });
  await waitFor(() => server.store.getRun(runId).status === "needs_input", { what: "needs_input" });
  noPr.pr = true;
  assert.equal((await request(server, "POST", `/api/runs/${runId}/input`, { body: { text: "Go on" } })).status, 200);
  await waitFor(() => server.store.getRun(runId).status === "completed", { what: "completed" });
  await server.push.idle();

  assert.equal(push.posts.length, 4);
  for (const post of push.posts) {
    assert.equal(post.headers["content-encoding"], "aes128gcm");
    assert.equal(post.headers.ttl, "3600");
    assert.match(post.headers.topic, /^run-[0-9a-f]{12}$/);
    assert.match(post.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(post.headers.authorization.split("k=")[1], publicKey);
  }
  assert.deepEqual(push.posts.map((post) => post.headers.urgency), ["high", "high", "high", "normal"]);
  const payloads = decrypted(push, subscriber);
  assert.deepEqual(payloads.map((payload) => payload.kind), ["needs_approval", "needs_approval", "needs_input", "completed"]);
  assert.deepEqual(payloads[0], {
    v: 1, kind: "needs_approval", runId, approvalId: first.id, repo: "my-app", status: "needs_approval",
    title: "my-app needs your OK", url: `/approvals/${first.id}`, tag: `run-${runId}`,
  });
  assert.equal(payloads[1].approvalId, second.id);
  assert.deepEqual(payloads[2], { v: 1, kind: "needs_input", runId, repo: "my-app", status: "needs_input", title: "my-app needs your reply", url: `/runs/${runId}`, tag: `run-${runId}` });
  assert.equal(payloads[3].title, "my-app is done");
  assert.ok(payloads.every((payload) => payload.title.length <= 80));

  const everything = JSON.stringify(payloads) + push.posts.map((post) => post.body.toString("latin1")).join("");
  assert.ok(!everything.includes(TOKEN), "no token in a payload or a recorded body");
  assert.ok(!everything.includes("example.com"), "no task text or command in a payload");
});

test("a failed run sends one push, and a push service answering 410 removes the subscription and audits it", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  initVapid(stateDir);
  const push = await standIn(t);
  const { server, subscriber, subscriptionId } = await boot(t, "error-result", push, stateDir);
  await request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task: "Break" } });
  await waitFor(() => push.posts.length === 1, { what: "the failure push" });
  await server.push.idle();
  const [payload] = decrypted(push, subscriber);
  assert.equal(payload.kind, "failed");
  assert.equal(payload.title, "my-app failed");
  assert.equal(push.posts[0].headers.urgency, "normal");

  push.state.status = 410;
  await request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task: "Again" } });
  await waitFor(() => push.posts.length === 2, { what: "the second push" });
  await server.push.idle();
  assert.equal(server.store.getSubscription(subscriptionId), null);
  assert.ok(server.store.listAudit(100).some((row) => row.action === "push.gone" && row.target === subscriptionId));
});

test("subscribing twice keeps one id, the endpoint rule applies, and nothing sensitive reaches the audit log", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  const repo = makeRepo(t);
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions: ["ask"] }] });
  const server = await startServer({ settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "ask-completed").adapter, ibni, staticRoot: null, stateDir });
  t.after(() => server.close());
  const keys = makeSubscriber().keys;
  const endpoint = "https://fcm.googleapis.com/fcm/send/secret-device-token";
  const first = await request(server, "POST", "/api/push/subscriptions", { body: { endpoint, keys } });
  const again = await request(server, "POST", "/api/push/subscriptions", { body: { endpoint, keys } });
  assert.equal(first.status, 201);
  assert.equal(again.json.id, first.json.id);
  assert.equal(server.store.listSubscriptions().length, 1);
  for (const bad of ["http://fcm.googleapis.com/x", "https://push.example.com/x", "https://127.0.0.1.nip.io/x", "https://evil.example/fcm.googleapis.com", "https://fcm.googleapis.com.evil.example/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://box.tail1234.ts.net/x", "https://printer.local/x", "https://db.internal/x"]) {
    assert.equal((await request(server, "POST", "/api/push/subscriptions", { body: { endpoint: bad, keys } })).status, 400, bad);
    assert.equal(endpointAllowed(bad), false, bad);
  }
  assert.equal(endpointAllowed(endpoint), true);
  // The browsers' own push services, and nothing else: a public name can still resolve to an internal address.
  for (const good of ["https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://db5p.notify.windows.com/w/?token=x"]) {
    assert.equal(endpointAllowed(good), true, good);
  }
  assert.equal((await request(server, "POST", "/api/push/subscriptions", { body: { endpoint, keys, extra: 1 } })).status, 400);
  assert.equal((await request(server, "POST", "/api/push/subscriptions", { body: { endpoint: `https://fcm.googleapis.com/${"a".repeat(1000)}`, keys } })).status, 400);
  assert.equal((await request(server, "DELETE", `/api/push/subscriptions/${first.json.id}`, { headers: { Origin: `http://127.0.0.1:${server.port}` } })).status, 204);
  assert.equal(server.store.listSubscriptions().length, 0);
  const log = JSON.stringify(server.store.listAudit(200));
  assert.ok(log.includes("fcm.googleapis.com") && !log.includes("secret-device-token") && !log.includes(keys.auth) && !log.includes(keys.p256dh));
});

test("the public key route says when push isn't set up and serves the key once it is", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  const settings = makeSettings({ repos: [{ name: "my-app", path: makeRepo(t), actions: ["ask"] }] });
  const server = await startServer({ settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "ask-completed").adapter, ibni, staticRoot: null, stateDir });
  t.after(() => server.close());
  const missing = await request(server, "GET", "/api/push/key");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "Push isn't set up. To set it up, run segwi vapid init.");
  const publicKey = initVapid(stateDir);
  assert.deepEqual((await request(server, "GET", "/api/push/key")).json, { publicKey });
});

test("without segwi.vapidSubject push counts as not set up: the key route says so and nothing is sent", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  initVapid(stateDir);
  const push = await standIn(t);
  const settings = makeSettings({ repos: [{ name: "my-app", path: makeRepo(t), actions: ["build", "ready", "ask"] }] });
  settings.segwi.vapidSubject = "";
  process.env.FAKE_HOST_TOKEN = TOKEN;
  t.after(() => { delete process.env.FAKE_HOST_TOKEN; });
  const server = await startServer({
    settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "error-result").adapter, ibni, staticRoot: null, stateDir,
    pushOptions: { allowEndpoint: () => true, agent: push.agent },
  });
  t.after(() => server.close());
  const missing = await request(server, "GET", "/api/push/key");
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /segwi\.vapidSubject/);
  assert.doesNotMatch(missing.json.error, /vapid init/, "the keys exist, so only the subject is missing");
  await request(server, "POST", "/api/push/subscriptions", { body: { endpoint: push.endpoint, keys: makeSubscriber().keys } });
  const started = await request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task: "Break" } });
  await waitFor(() => server.store.getRun(started.json.run.id).status === "failed", { what: "the failure" });
  await server.push.idle();
  assert.equal(push.posts.length, 0);
});

test("the configured subject signs every push", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  initVapid(stateDir);
  const push = await standIn(t);
  const { server } = await boot(t, "error-result", push, stateDir);
  await request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task: "Break" } });
  await waitFor(() => push.posts.length === 1, { what: "the failure push" });
  await server.push.idle();
  const token = push.posts[0].headers.authorization.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+)/)[1];
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.sub, "mailto:segwi-tests@example.com");
});

test("vapid init writes a private file, refuses a second run without --force, and prints only the public key", async (t) => {
  const stateDir = tempDir(t, "segwi-state-");
  const dataDir = tempDir(t, "segwi-data-");
  const capture = () => { const out = { text: "" }; return { out, stream: { write: (chunk) => { out.text += chunk; } } }; };
  const run = async (settings, ...args) => {
    const [stdout, stderr] = [capture(), capture()];
    const previous = process.exitCode;
    await runVapid(["init", "--state-dir", stateDir, "--data-dir", dataDir, ...args], { stdout: stdout.stream, stderr: stderr.stream, settings });
    const code = process.exitCode;
    process.exitCode = previous;
    return { stdout: stdout.out.text, stderr: stderr.out.text, code };
  };
  const unset = makeSettings({ repos: [] });
  unset.segwi.vapidSubject = "";
  const first = await run(unset);
  const file = path.join(stateDir, "segwi-vapid.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(first.stdout, `${stored.publicKey}\n`);
  assert.ok(!first.stdout.includes(stored.privateKey) && !first.stderr.includes(stored.privateKey));
  assert.deepEqual(Object.keys(stored).sort(), ["privateKey", "publicKey"], "the subject is config, not part of the keys");
  assert.match(first.stderr, /set segwi\.vapidSubject/);

  const second = await run(unset);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /breaks every existing push subscription/);
  assert.equal(second.stdout, "");
  assert.deepEqual(readVapid(stateDir), stored);

  const forced = await run(makeSettings({ repos: [] }), "--force");
  assert.doesNotMatch(forced.stderr, /vapidSubject/, "no hint once the subject is set");
  assert.notEqual(forced.stdout.trim(), stored.publicKey);
  assert.equal(readVapid(stateDir).publicKey, forced.stdout.trim());
});
