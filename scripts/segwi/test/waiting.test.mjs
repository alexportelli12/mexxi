// A run whose agent waits on its own background work (a Bash command started with run_in_background, a Monitor)
// is still working: it says what it waits on and nobody is notified, until the host comes back to it by itself.
// Driven through the real server and the fake host replaying runs recorded from Claude Code 2.1.310.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { startServer } from "../lib/serve.mjs";
import { initVapid } from "../lib/vapid.mjs";
import { fakeAdapter, makeRepo, makeSettings, request, tempDir, waitFor } from "./helpers.mjs";

const noIbni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("no ibni here"); }, list: async () => [] };

/** A server replaying `fixture`, with push set up and every push it sends kept as its decoded payload. */
async function boot(t, fixture, { limits, settleMs, ibni = noIbni } = {}) {
  const stateDir = tempDir(t, "segwi-state-");
  initVapid(stateDir);
  const host = fakeAdapter(t, fixture);
  const pushes = [];
  const settings = makeSettings({ repos: [{ name: "my-app", path: makeRepo(t), actions: ["build", "ready", "ask"] }], limits });
  const server = await startServer({
    settings, dataDir: tempDir(t, "segwi-data-"), runner: host.adapter, ibni, staticRoot: null, stateDir, settleMs,
    pushOptions: { allowEndpoint: () => true, send: async (_subscription, body) => { pushes.push(JSON.parse(body)); } },
  });
  t.after(() => server.close());
  const subscribed = await request(server, "POST", "/api/push/subscriptions", { body: { endpoint: "https://push.example.com/send/1", keys: { p256dh: "BPub", auth: "auth" } } });
  assert.equal(subscribed.status, 201);
  const start = async () => (await request(server, "POST", "/api/runs", { body: { repo: "my-app", action: "build", task: "run the checks" } })).json.run.id;
  const run = async (id) => (await request(server, "GET", `/api/runs/${id}`)).json.run;
  return { server, host, pushes, start, run, sent: async () => { await server.push.idle(); return pushes.map((push) => push.status); } };
}

/** The `run` messages the SSE stream replays for one run, as a reconnecting app would get them. */
function streamedRuns(server, runId) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/stream", headers: { "Last-Event-ID": "0" } }, (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
        if (text.includes(": connected")) setTimeout(() => { req.destroy(); resolve(messages(text)); }, 100);
      });
    });
    req.on("error", (error) => (error.code === "ECONNRESET" ? null : reject(error)));
  });
  function messages(text) {
    return text.split("\n\n").filter((block) => block.includes("event: run")).map((block) => JSON.parse(block.split("\ndata: ")[1])).filter((message) => message.runId === runId);
  }
}

test("a turn that ends while its background command runs stays Working, says what it waits on, and sends no push", async (t) => {
  const { server, host, start, run, sent } = await boot(t, "background-wait");
  const id = await start();
  await waitFor(() => server.store.listEvents(id).some((event) => event.kind === "result"), { what: "the first turn's end" });
  await waitFor(() => server.store.getRun(id).waitingOn, { what: "waitingOn" });
  const waiting = await run(id);
  assert.equal(waiting.status, "running");
  assert.equal(waiting.waitingOn, "Waiting on npm run verify 2>&1 | tail -n 50");
  assert.ok((await streamedRuns(server, id)).some((message) => message.status === "running" && message.waitingOn === "Waiting on npm run verify 2>&1 | tail -n 50"), "SSE carries it");
  assert.deepEqual(await sent(), [], "no push while it waits on its own command");

  // The command ends; the host starts a turn by itself, reads the output and finishes with no pull request.
  host.release();
  await waitFor(() => server.store.getRun(id).status === "needs_input", { what: "the second turn's end" });
  assert.equal((await run(id)).waitingOn, null);
  assert.equal(server.store.listEvents(id).filter((event) => event.kind === "result").length, 2);
  assert.deepEqual(await sent(), ["needs_input"], "the one real turn end that needs you is still notified");
});

test("a run waiting on its background command is not stopped as idle, but one waiting on you still is", async (t) => {
  const { server, host, start } = await boot(t, "background-wait", { limits: { idleTimeoutMinutes: 0.02 } });
  const id = await start();
  await waitFor(() => server.store.getRun(id).waitingOn, { what: "waitingOn" });
  // Well past the 1.2 s idle limit (long enough for the fake host to start), with the host silent.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(server.store.getRun(id).status, "running");
  host.release();
  await waitFor(() => server.store.getRun(id).status === "timed_out", { what: "the idle timeout once it needs a reply" });
  assert.match(server.store.getRun(id).reason, /No activity/);
});

test("when a monitor's notice arrives during the agent's turn, the run stays Working through the host's own next turn", async (t) => {
  const { server, host, start, run, sent } = await boot(t, "background-monitor");
  const id = await start();
  // The first turn ends with two tasks running: the 15 s command and the monitor that watches for its file.
  await waitFor(() => server.store.getRun(id).waitingOn, { what: "waitingOn" });
  assert.equal((await run(id)).waitingOn, "Waiting on sleep 15 && touch ready.flag and 1 more");
  host.release();
  await waitFor(() => server.store.listEvents(id).filter((event) => event.kind === "result").length === 3, { what: "the third turn's end" });
  await waitFor(() => server.store.getRun(id).status === "needs_input", { what: "needs_input" });
  const statuses = server.store.listEvents(id).filter((event) => event.kind === "status").map((event) => event.data.status);
  assert.ok(!statuses.slice(0, -1).includes("needs_input"), `never needs you before the last turn: ${statuses.join(", ")}`);
  assert.deepEqual(await sent(), ["needs_input"]);
});

const line = (value) => JSON.stringify(value);
const init = line({ type: "system", subtype: "init", session_id: "11111111-2222-4333-8444-555555555555" });
const say = (text) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const done = line({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, session_id: "11111111-2222-4333-8444-555555555555", duration_ms: 10 });
const notice = line({ type: "system", subtype: "task_notification", task_id: "b1", tool_use_id: "toolu_1", status: "completed", summary: "Background command completed" });
const marker = (name) => line({ segwi_fixture: name });

function fixture(t, lines) {
  const file = path.join(tempDir(t, "segwi-fixture-"), "run.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("a run that needs your reply goes back to Working when the agent carries on by itself", async (t) => {
  const { server, host, start, run, sent } = await boot(t, fixture(t, [init, say("Is the default on or off?"), done, marker("await_release"), init, say("The check finished, so I carried on."), marker("await_input")]));
  const id = await start();
  await waitFor(() => server.store.getRun(id).status === "needs_input", { what: "needs_input" });
  assert.deepEqual(await sent(), ["needs_input"], "a turn ending on a question is notified");
  host.release();
  await waitFor(() => server.store.getRun(id).status === "running", { what: "running again" });
  assert.equal((await run(id)).status, "running");
});

test("a finished task's notice with no turn after it ends in needs_input once the settle time passes", async (t) => {
  const { server, start, sent } = await boot(t, fixture(t, [init, notice, say("Waiting for the notice."), done, marker("await_input")]), { settleMs: 150 });
  const id = await start();
  await waitFor(() => server.store.listEvents(id).some((event) => event.kind === "result"), { what: "the turn's end" });
  assert.equal(server.store.getRun(id).status, "running", "the host may still start its own turn");
  await waitFor(() => server.store.getRun(id).status === "needs_input", { what: "needs_input after the settle time" });
  assert.deepEqual(await sent(), ["needs_input"]);
});

test("every ibni call refreshes the run's snapshot, which the run shows without paths and the list leaves out", async (t) => {
  let calls = 0;
  const ibni = {
    findNewWorkspace: async () => ({ sessionId: "s1", worktreePath: "/tmp/segwi-test-worktrees/s1" }),
    summary: async () => {
      calls += 1;
      return { branch: "agent/demo", prUrl: null, verify: "pass", worktreePath: "/tmp/segwi-test-worktrees/s1", snapshot: { branch: "agent/demo", steps: [{ step: "verify", outcome: "succeeded" }], verify: { attempts: calls, passed: calls, failed: 0, history: [] } } };
    },
    list: async () => [],
  };
  const call = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ibni record --session s1 --verify pass" } }] } });
  const result = line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "{}" }] } });
  const { server, host, start, run } = await boot(t, fixture(t, [init, done, marker("await_release"), call, result, marker("await_input")]), { ibni });
  const id = await start();
  // The turn's end finds the workspace and reads it once.
  await waitFor(() => server.store.getRun(id).ibni?.verify?.attempts === 1, { what: "the snapshot at the turn's end" });
  host.release();
  await waitFor(() => server.store.getRun(id).ibni?.verify?.attempts === 2, { what: "the snapshot after the ibni call" });
  const shown = await run(id);
  assert.deepEqual(shown.ibni.steps, [{ step: "verify", outcome: "succeeded" }]);
  assert.ok(!("worktreePath" in shown), "no path on the run");
  assert.ok((await streamedRuns(server, id)).some((message) => message.ibni?.verify?.attempts === 2), "SSE carries it");
  const listed = (await request(server, "GET", "/api/runs")).json.runs.find((entry) => entry.id === id);
  assert.ok(listed && !("ibni" in listed), "the list stays small");
});
