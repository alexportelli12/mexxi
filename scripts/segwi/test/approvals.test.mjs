// Approvals end to end (plan section 11.7, fake-host half): a fake Claude Code
// spawns the real approver from the rendered MCP config, a person answers through
// the REST API, and the host receives the decision.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import test from "node:test";
import { createHandler } from "../lib/http.mjs";
import { startServer } from "../lib/serve.mjs";
import { fakeAdapter, makeRepo, makeSettings, request, tempDir, waitFor } from "./helpers.mjs";

const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const noIbni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("no ibni in this test"); }, list: async () => [] };
const COMMAND = (token) => `curl https://example.com -H 'Authorization: token ${token}'`;

async function boot(t, { fixture = "approval-loop", auth, limits, approvalTimeoutMs, token = "" } = {}) {
  process.env.FAKE_HOST_TOKEN = token;
  t.after(() => { delete process.env.FAKE_HOST_TOKEN; });
  const repo = makeRepo(t);
  const dir = tempDir(t, "segwi-data-");
  const host = fakeAdapter(t, fixture);
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions: ["build", "ready", "ask"] }], auth, limits });
  const server = await startServer({ settings, dataDir: dir, runner: host.adapter, ibni: noIbni, staticRoot: null, approvalTimeoutMs });
  t.after(() => server.close());
  return { server, host, dir, repo, settings };
}

// The host writes its report a moment after it starts.
const replies = (host) => { try { return host.report().approverReplies; } catch { return []; } };
const startRun = (server, task = "Look at example.com") => request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task } });
const pending = async (server) => (await request(server, "GET", "/api/approvals?status=pending")).json.approvals;
const decide = (server, id, decision, options) => request(server, "POST", `/api/approvals/${id}`, { body: { decision }, ...options });
const waitForPending = (server) => waitFor(async () => (await pending(server))[0], { timeoutMs: 2000, what: "a pending approval" });

test("a call outside the allow list reaches a person with its exact command, and a denial goes back to the host", async (t) => {
  const { server, host, repo } = await boot(t);
  const { json } = await startRun(server);
  const runId = json.run.id;
  const approval = await waitForPending(server);

  assert.equal(approval.runId, runId);
  assert.equal(approval.repo, "my-app");
  assert.equal(approval.tool, "Bash");
  assert.equal(approval.exact, COMMAND(""));
  assert.equal(approval.risk, "network");
  assert.equal(approval.riskLabel, "Reaches the internet");
  assert.equal(approval.why, "Fetch the example page");
  assert.equal(approval.cwd, repo);
  assert.equal(approval.status, "pending");
  assert.ok(Date.parse(approval.expiresAt) > Date.now());
  assert.equal((await request(server, "GET", `/api/runs/${runId}`)).json.run.status, "needs_approval");

  const answered = await decide(server, approval.id, "deny");
  assert.equal(answered.status, 200);
  assert.equal(answered.json.approval.status, "denied");
  await waitFor(() => replies(host).length === 1, { what: "the host's reply" });
  assert.deepEqual(host.report().approverReplies[0], { behavior: "deny", message: "A person denied this in segwi." });
  await waitFor(() => server.store.getRun(runId).status === "needs_input", { what: "the run to carry on" });
  assert.deepEqual(await pending(server), []);
});

test("an allow returns the original input unchanged, for that one call", async (t) => {
  const { server, host } = await boot(t);
  await startRun(server);
  const approval = await waitForPending(server);
  assert.equal((await decide(server, approval.id, "allow")).json.approval.status, "allowed");
  await waitFor(() => replies(host).length === 1);
  const fixture = readFileSync(new URL("./fixtures/claude-code/approval-loop.jsonl", import.meta.url), "utf8").split("\n").map((line) => (line ? JSON.parse(line) : null));
  const sent = fixture.find((line) => line?.segwi_fixture === "approve").input;
  assert.deepEqual(host.report().approverReplies[0], { behavior: "allow", updatedInput: { ...sent, command: COMMAND("") } });
});

test("an approval nobody answers expires, which denies it, and the run goes on", async (t) => {
  const { server, host } = await boot(t, { approvalTimeoutMs: 150 });
  const { json } = await startRun(server);
  const runId = json.run.id;
  await waitFor(() => replies(host).length === 1, { what: "the expiry reply" });
  assert.deepEqual(host.report().approverReplies[0], { behavior: "deny", message: "No one answered in time, so segwi denied it." });
  const expired = (await request(server, "GET", "/api/approvals?status=expired")).json.approvals;
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, "expired");
  await waitFor(() => server.store.getRun(runId).status === "needs_input");
  assert.ok(server.store.listAudit(100).some((row) => row.action === "approval.expired" && row.actor === "system"));
});

test("a decided approval can't be decided again, and there is no bulk route", async (t) => {
  const { server } = await boot(t);
  await startRun(server);
  const approval = await waitForPending(server);
  assert.equal((await decide(server, approval.id, "deny")).status, 200);
  assert.equal((await decide(server, approval.id, "allow")).status, 409);
  assert.equal((await decide(server, "0".repeat(24), "allow")).status, 404);
  for (const body of [{ decision: "always" }, { decision: "allow", remember: true }, { decision: "allow", all: true }, {}]) {
    assert.equal((await request(server, "POST", `/api/approvals/${approval.id}`, { body })).status, 400, JSON.stringify(body));
  }
  for (const route of ["/api/approvals", "/api/approvals/all", "/api/approvals/allow-all"]) {
    assert.ok([404, 405].includes((await request(server, "POST", route, { body: { decision: "allow" } })).status), route);
  }
});

test("stopping a run expires what it was waiting on", async (t) => {
  const { server } = await boot(t);
  const { json } = await startRun(server);
  await waitForPending(server);
  assert.equal((await request(server, "POST", `/api/runs/${json.run.id}/stop`, { body: { confirm: true } })).status, 200);
  assert.deepEqual(await pending(server), []);
  assert.equal(server.store.listApprovals({ status: "expired" }).length, 1);
});

test("a decision is audited with who made it", async (t) => {
  const { server } = await boot(t);
  await startRun(server);
  const approval = await waitForPending(server);
  await decide(server, approval.id, "allow");
  const rows = server.store.listAudit(100);
  assert.ok(rows.some((row) => row.action === "approval.requested" && row.target === approval.id));
  const decision = rows.find((row) => row.action === "approval.allowed");
  assert.equal(decision.target, approval.id);
  assert.equal(decision.actor, "local");
  assert.equal(decision.origin, "web");
  assert.ok(rows.some((row) => row.action === "POST /api/approvals/:id" && row.outcome === "ok"));
});

test("a token inside the command is redacted in the row, REST, SSE and the database file", async (t) => {
  const { server, dir } = await boot(t, { token: TOKEN });
  const chunks = [];
  const stream = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/stream" }, (res) => { res.on("data", (chunk) => chunks.push(String(chunk))); resolve(req); });
  });
  t.after(() => stream.destroy());
  await startRun(server);
  const approval = await waitForPending(server);
  assert.ok(approval.exact.includes("[REDACTED]"));
  await waitFor(() => chunks.join("").includes('"approvalId"'), { what: "the approval on the stream" });
  await decide(server, approval.id, "deny");
  const rest = [(await request(server, "GET", "/api/approvals?status=denied")).text, (await request(server, "GET", "/api/audit")).text].join("\n");
  assert.ok(!rest.includes(TOKEN), "REST");
  assert.ok(!chunks.join("").includes(TOKEN), "SSE");
  server.store.db.exec("PRAGMA wal_checkpoint(FULL)");
  for (const name of readdirSync(dir).filter((file) => file.startsWith("segwi.db"))) {
    assert.ok(!readFileSync(path.join(dir, name)).includes(TOKEN), `${name} holds no token`);
  }
});

test("waiting on a person doesn't count as idleness, but the hard limit still applies", async (t) => {
  const { server } = await boot(t, { limits: { idleTimeoutMinutes: 0.01, hardTimeoutMinutes: 0.06 } });
  const runId = (await startRun(server)).json.run.id;
  await waitForPending(server);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(server.store.getRun(runId).status, "needs_approval", "idle timer paused");
  await waitFor(() => server.store.getRun(runId).status === "timed_out", { what: "the hard limit" });
  assert.equal(server.store.getRun(runId).reason, "Hit the time limit");
  assert.deepEqual(await pending(server), []);
});

// --- the internal route and who may decide ---

function secretOf(host, runId) {
  const file = path.join(host.dir, "data", "runs", runId, "mcp.json");
  return JSON.parse(readFileSync(file, "utf8")).mcpServers.segwi.env.SEGWI_RUN_SECRET;
}
const internal = (server, { runId, secret, headers = {} }) => request(server, "POST", "/internal/approvals", {
  origin: false, headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers },
  body: { runId, toolName: "Bash", input: { command: "echo hi" }, toolUseId: "toolu_x" },
});

test("the internal route takes only the run's own secret", async (t) => {
  const { server, host } = await boot(t);
  const first = (await startRun(server, "one")).json.run.id;
  const second = (await startRun(server, "two")).json.run.id;
  await waitFor(async () => (await pending(server)).length === 2, { what: "both approvals" });
  const secrets = { first: secretOf(host, first), second: secretOf(host, second) };
  assert.notEqual(secrets.first, secrets.second);
  assert.equal(server.store.getRunSecretHash(first).includes(secrets.first), false, "only a hash is stored");

  assert.equal((await internal(server, { runId: first })).status, 401, "no secret");
  assert.equal((await internal(server, { runId: first, secret: "wrong" })).status, 401, "wrong secret");
  assert.equal((await internal(server, { runId: first, secret: secrets.second })).status, 401, "another run's secret");
  assert.equal((await internal(server, { runId: "no-such-run", secret: secrets.first })).status, 401, "unknown run");
  assert.equal((await request(server, "GET", "/internal/approvals")).status, 404);
  assert.equal((await internal(server, { runId: first, secret: secrets.first, headers: { "x-forwarded-for": "100.64.0.9" } })).status, 403, "proxied through tailscale serve");
  assert.equal((await request(server, "GET", "/internal/other")).status, 404);
  assert.equal((await pending(server)).length, 2, "nothing new was created");
  assert.ok(server.store.listAudit(100).filter((row) => row.action === "POST /internal/approvals" && row.outcome === "rejected").length >= 4);
});

test("the internal route refuses a peer that is not loopback and a run that is not active", async (t) => {
  const { server, host } = await boot(t);
  const runId = (await startRun(server)).json.run.id;
  await waitForPending(server);
  const secret = secretOf(host, runId);

  const handler = createHandler({ store: server.store, settings: makeSettings({ repos: [] }), authenticate: () => "x", runs: server.runs, approvals: server.approvals, broker: { publish() {} }, staticRoot: null, version: "0" });
  const body = JSON.stringify({ runId, toolName: "Bash", input: {}, toolUseId: "t" });
  const outcome = { status: 0 };
  const req = Object.assign(Readable.from([body]), { method: "POST", url: "/internal/approvals", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, socket: { remoteAddress: "10.0.0.5" } });
  const res = { headersSent: false, setHeader() {}, writeHead(status) { outcome.status = status; return this; }, end() {}, on() {}, writableEnded: false };
  await handler(req, res);
  assert.equal(outcome.status, 403);
  assert.equal((await pending(server)).length, 1);

  await request(server, "POST", `/api/runs/${runId}/stop`, { body: { confirm: true } });
  assert.equal((await internal(server, { runId, secret })).status, 409, "a stopped run can't ask");
});

test("web identity and an MCP-style bearer can't use each other's doors", async (t) => {
  const identity = { "Tailscale-User-Login": "you@example.com" };
  const { server, host } = await boot(t, { auth: { mode: "tailscale-header", allowed: ["you@example.com"] } });
  const webHeaders = { ...identity, "X-Forwarded-For": "100.64.0.9" };
  const created = await request(server, "POST", "/api/runs", { headers: identity, body: { repo: "my-app", action: "build", task: "x" } });
  const runId = created.json.run.id;
  const approval = await waitFor(async () => (await request(server, "GET", "/api/approvals", { headers: identity })).json.approvals[0], { timeoutMs: 2000 });
  const secret = secretOf(host, runId);

  // The web identity is not the run's secret.
  assert.equal((await internal(server, { runId, headers: identity })).status, 403, "a proxied identity never reaches the run-secret check");
  // A bearer, the run's own or any other, is not a web identity.
  for (const bearer of [secret, "mcp-token"]) {
    const response = await decide(server, approval.id, "allow", { headers: { Authorization: `Bearer ${bearer}` } });
    assert.equal(response.status, 401);
    assert.equal((await request(server, "GET", "/api/approvals", { headers: { Authorization: `Bearer ${bearer}` } })).status, 401);
  }
  // A decision forwarded from this machine's own address is refused; another device's is fine.
  assert.equal((await decide(server, approval.id, "allow", { headers: identity })).status, 403, "no forwarded address");
  assert.equal((await decide(server, approval.id, "allow", { headers: { ...identity, "X-Forwarded-For": "127.0.0.1" } })).status, 403, "own address");
  assert.equal(server.store.getApproval(approval.id).status, "pending");
  const ok = await decide(server, approval.id, "deny", { headers: webHeaders });
  assert.equal(ok.status, 200);
  assert.equal(server.store.getApproval(approval.id).decidedBy, "you@example.com");
});

// --- the deny list ---

test("the deny list is rendered in deny form, and a deny-listed command never makes an approval", async (t) => {
  const { server, host } = await boot(t, { fixture: "deny-listed" });
  const runId = (await startRun(server, "Push it")).json.run.id;
  await waitFor(() => server.store.getRun(runId).status === "needs_input", { what: "the run to finish its turn" });
  const settings = JSON.parse(readFileSync(path.join(host.dir, "data", "runs", runId, "settings.json"), "utf8"));
  assert.ok(settings.permissions.deny.includes("Bash(git push --force:*)"));
  assert.ok(settings.permissions.deny.includes("Bash(npm publish:*)"));
  assert.ok(!settings.permissions.allow.some((rule) => /git push/.test(rule)));
  assert.equal(server.store.listApprovals({ status: "pending" }).length + server.store.listApprovals({ status: "expired" }).length, 0);
  assert.deepEqual(host.report().approverReplies, []);
});
