// Sessions read through segwi's legacy run shape: every MCP status of plan §7.2,
// every legacy field, get_output's entries, and send_input/stop_run/start_run
// over the real session service and a fake herdr.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHookApprovals } from "../lib/approvals.mjs";
import { createHerdrAdapter } from "../lib/herdr/adapter.mjs";
import { createLinkResolver } from "../lib/links.mjs";
import { outputWindow } from "../lib/mcp.mjs";
import { writeRecord } from "../lib/pending.mjs";
import { createRunView, eventsFromRows, legacyStatus, NEEDS_APPROVAL_MESSAGE, runFromSession, stepsFromRows } from "../lib/run-view.mjs";
import { createSessionService } from "../lib/sessions.mjs";
import { openStore } from "../lib/store.mjs";
import { projectSlug } from "../lib/transcript.mjs";
import { claudeAgent, startFakeHerdr, WRITE } from "./fake-herdr.mjs";
import { makeRepo, makeSettings, tempDir } from "./helpers.mjs";

const FAST = { debounceMs: 5, backoff: { minMs: 5, maxMs: 20 } };
const SESSION = "55555555-5555-4555-8555-555555555555";
const PANE = "wT:p1";
const liveText = (name) => readFileSync(new URL("./fixtures/herdr/screens/" + name, import.meta.url), "utf8");

/** A fake herdr, the real adapter and guard, a temp HOME for transcripts and hook records, and the service. */
async function boot(t, { agents, screens = {}, limits = {}, withApprovals = false, dirty = false } = {}) {
  const repo = makeRepo(t);
  if (dirty) writeFileSync(path.join(repo, "dirty.txt"), "x");
  const fake = await startFakeHerdr(t, { agents: agents ?? [claudeAgent({ paneId: PANE, terminalId: "term_s1", sessionId: SESSION, status: "idle", seq: 10, cwd: repo })], screens });
  for (const agent of fake.state.agents) if (agent.cwd === "/tmp/hares-fake/repo") { agent.cwd = repo; agent.foreground_cwd = repo; }
  const adapter = createHerdrAdapter({ socket: fake.socket, ...FAST });
  t.after(() => adapter.close());
  await adapter.connect();
  const home = tempDir(t, "hares-sessions-");
  const pendingOptions = { env: { XDG_DATA_HOME: path.join(home, "xdg") }, home };
  const store = openStore(":memory:");
  t.after(() => store.close());
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions: ["build", "ready", "ask"] }], limits });
  const approvals = withApprovals ? createHookApprovals({ store, adapter, settings, home, repoForSession: () => "my-app" }) : null;
  const service = createSessionService({
    adapter, store, settings, approvals, home, pendingOptions,
    links: createLinkResolver({ branchOf: async () => null }), slugFor: async () => "me/my-app", commands: ["wettaq", "lesti", "ittestja"],
  });
  t.after(() => service.close());
  const transcript = (sessionId, entries) => {
    const dir = path.join(home, ".claude", "projects", projectSlug(repo));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, sessionId + ".jsonl"), entries.map((entry) => JSON.stringify({ sessionId, cwd: repo, ...entry })).join("\n") + "\n");
  };
  const record = (extra) => writeRecord({ v: 1, at: new Date().toISOString(), sessionId: SESSION, paneId: PANE, toolUseId: null, toolName: null, input: null, suggestions: null, ...extra }, pendingOptions);
  return { fake, adapter, store, service, approvals, repo, home, pendingOptions, transcript, record };
}

const setAgent = async (box, fields, paneId = PANE) => {
  Object.assign(box.fake.state.agents.find((agent) => agent.pane_id === paneId), fields);
  await box.adapter.refresh();
};

const LEGACY_RUN_FIELDS = ["id", "repo", "action", "task", "status", "clientId", "branch", "prUrl", "verify", "costUsd", "reason", "waitingOn", "createdAt", "updatedAt", "lastActivityAt", "endedAt", "snapshot"];

test("every session state maps to the MCP status of plan §7.2", () => {
  const cases = [
    [{ status: "starting", alive: false }, "queued"],
    [{ status: "working", alive: true }, "running"],
    [{ status: "blocked", alive: true, waiting: "question" }, "needs_input"],
    [{ status: "blocked", alive: true, waiting: "permission" }, "needs_approval"],
    [{ status: "blocked", alive: true, waiting: "plan" }, "needs_approval"],
    [{ status: "blocked", alive: true, waiting: "trust" }, "needs_approval"],
    [{ status: "blocked", alive: true, waiting: "unknown" }, "needs_approval"],
    [{ status: "idle", alive: true }, "needs_input"],
    [{ status: "done", alive: true }, "needs_input"],
    [{ status: "closed", alive: false, endedBy: "hares" }, "stopped"],
    [{ status: "closed", alive: false, endedBy: "gone" }, "completed"],
    [{ status: "closed", alive: false, endedBy: null }, "completed"],
    [{ status: "failed", alive: false, endedBy: "failed" }, "failed"],
  ];
  for (const [session, status] of cases) assert.equal(legacyStatus(session), status, JSON.stringify(session));
});

test("a session keeps every legacy run field, null where the herdr era has no value", () => {
  const run = runFromSession({ id: "s", status: "idle", alive: true, title: "Fix it" });
  assert.deepEqual(Object.keys(run), LEGACY_RUN_FIELDS);
  assert.deepEqual([run.verify, run.costUsd, run.waitingOn, run.snapshot, run.branch, run.prUrl, run.clientId], [null, null, null, null, null, null, null]);
  assert.equal(run.task, "Fix it");
  assert.equal(run.action, "session");
  const linked = runFromSession({ id: "s", status: "idle", alive: true }, { branch: { name: "agent/x" }, pull: { url: "https://github.com/me/app/pull/4" } });
  assert.deepEqual([linked.branch, linked.prUrl], ["agent/x", "https://github.com/me/app/pull/4"]);
});

test("transcript rows read through get_output's window as agent text, your messages, calls and status", () => {
  const rows = [
    { seq: 1, kind: "user", data: { text: "Fix the bug" } },
    { seq: 2, kind: "assistant", data: { text: "Looking." } },
    { seq: 3, kind: "tool", data: { id: "t1", name: "Bash", title: "Check the tree", status: "done" } },
    { seq: 4, kind: "question", data: { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }], answers: { "Which?": "B" }, status: "answered" } },
    { seq: 5, kind: "interrupted", data: { text: "[Request interrupted by user]" } },
  ];
  const { entries, nextSince } = outputWindow(eventsFromRows(rows), 0, 0, 8000);
  assert.deepEqual(entries.map((entry) => [entry.seq, entry.kind, entry.text]), [
    [1, "you", "Fix the bug"], [2, "agent", "Looking."], [3, "call", "Check the tree"], [4, "agent", "Asked: Which? (A / B)\nAnswered: B"], [5, "status", "[Request interrupted by user]"],
  ]);
  assert.equal(nextSince, 5);
  assert.deepEqual(stepsFromRows(rows).map((step) => [step.type, step.ok, step.from]), [
    ["message", null, "you"], ["message", null, "agent"], ["command", true, "agent"], ["message", true, "agent"], ["message", false, "you"],
  ]);
});

async function runView(t, options) {
  const box = await boot(t, options);
  const view = createRunView({ sessions: box.service, store: box.store, settings: makeSettings({ repos: [{ name: "my-app", path: box.repo, actions: ["build", "ready", "ask"] }] }) });
  const launched = () => {
    box.store.createLaunch({ id: "aaaaaaaa-0000-4000-8000-000000000002", sessionId: SESSION, repo: "my-app", action: "build", task: "x" });
    box.store.updateLaunch("aaaaaaaa-0000-4000-8000-000000000002", { paneId: PANE });
  };
  return { ...box, view, launched };
}
const fruit = { kind: "question", event: "PreToolUse", toolUseId: "toolu_f1", toolName: "AskUserQuestion", recordId: "question_toolu_f1",
  input: { questions: [{ header: "Fruit", question: "Which fruit for the gate?", options: [{ label: "Apple" }, { label: "Pear" }] }] } };
const blockedOn = (screen) => ({ agents: [claudeAgent({ paneId: PANE, terminalId: "term_s1", sessionId: SESSION, status: "blocked", seq: 20 })], screens: { [PANE]: liveText(screen) } });

test("list_runs lists every session, including one started by hand, beside the runs from before ħares", async (t) => {
  const box = await runView(t);
  box.store.createRun({ id: "11111111-0000-4000-8000-000000000000", repo: "my-app", action: "build", task: "old" });
  box.store.updateRun("11111111-0000-4000-8000-000000000000", { status: "completed" });
  const runs = await box.view.list({});
  assert.deepEqual(runs.map((run) => [run.id, run.status]).sort(), [["11111111-0000-4000-8000-000000000000", "completed"], [SESSION, "needs_input"]].sort());
  assert.ok(runs.every((run) => !("snapshot" in run) && !("worktreePath" in run) && !("hostSessionId" in run)));
  assert.deepEqual((await box.view.list({ status: "completed" })).map((run) => run.id), ["11111111-0000-4000-8000-000000000000"]);
});

for (const reply of ["2", "Pear"]) {
  test(`send_input answers a waiting question by number or exact label ("${reply}")`, async (t) => {
    const box = await runView(t, blockedOn("live-q-single-normal.txt"));
    box.launched();
    box.record(fruit);
    assert.equal((await box.view.send(SESSION, reply)).id, SESSION);
    assert.deepEqual(box.fake.writes().map((entry) => entry.params.keys), [["2"]]);
  });
}

test("send_input names the options when the reply is none of them and free text is not offered", async (t) => {
  const box = await runView(t, blockedOn("live-perm-bash.txt"));
  box.launched();
  box.record(fruit);
  box.fake.state.screens[PANE] = liveText("live-q-single-normal.txt").replace("  3. Type something.\n", "");
  await assert.rejects(box.view.send(SESSION, "Banana"), (error) => error.status === 409 && /1\. Apple, 2\. Pear/.test(error.message));
  assert.deepEqual(box.fake.writes(), []);
});

test("send_input never answers a permission prompt: it says only a person in the web app can", async (t) => {
  const box = await runView(t, blockedOn("live-perm-bash.txt"));
  box.launched();
  box.record({ kind: "permission", event: "PermissionRequest", toolName: "Bash", input: { command: "touch gate-bash.txt" }, recordId: "permission_x" });
  for (const text of ["1", "Yes", "Yes, and always allow access to /tmp/hares-gate1/repo from this project"]) {
    await assert.rejects(box.view.send(SESSION, text), { status: 409, message: NEEDS_APPROVAL_MESSAGE });
  }
  box.fake.state.screens[PANE] = liveText("live-trust-real.txt");
  await assert.rejects(box.view.send(SESSION, "Yes, I trust this folder"), { status: 409, message: NEEDS_APPROVAL_MESSAGE });
  assert.deepEqual(box.fake.writes(), []);
});

test("send_input steers a launched session that is idle", async (t) => {
  const box = await runView(t);
  box.launched();
  box.fake.state.screens[PANE] = liveText("idle-prompt.live-redacted.txt");
  assert.deepEqual(await box.view.send(SESSION, "Now add tests"), { id: SESSION, status: "needs_input" });
  assert.deepEqual(box.fake.writes(), [{ method: WRITE.agentPrompt, params: { target: PANE, text: "Now add tests" } }]);
});

test("stop_run ends a launched session by closing its pane, and reports it stopped", async (t) => {
  const box = await runView(t);
  box.launched();
  assert.deepEqual(await box.view.stop("aaaaaaaa-0000-4000-8000-000000000002"), { id: "aaaaaaaa-0000-4000-8000-000000000002", status: "stopped" });
  assert.deepEqual(box.fake.writes(), [{ method: WRITE.paneClose, params: { pane_id: PANE } }]);
});

test("start_run's old actions start a session and return the launch id as queued", async (t) => {
  const box = await runView(t, { agents: [] });
  const { run, created } = await box.view.create({ repo: "my-app", action: "build", task: "Add a footer" });
  assert.equal(created, true);
  assert.match(run.id, /^[0-9a-f-]{36}$/);
  assert.equal(run.status, "queued");
  assert.equal((await box.view.get(run.id)).status, "queued");
});

test("a run from before ħares stays readable with its steps, and can't take a reply or a stop", async (t) => {
  const box = await runView(t);
  const id = "22222222-0000-4000-8000-000000000000";
  box.store.createRun({ id, repo: "my-app", action: "build", task: "old" });
  box.store.addEvent(id, "text", { text: "Done before" });
  box.store.updateRun(id, { status: "completed" });
  const run = await box.view.get(id);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.steps.map((step) => step.title), ["Done before"]);
  assert.equal((await box.view.events(id, 0))[0].data.text, "Done before");
  await assert.rejects(box.view.send(id, "hi"), { status: 409 });
  await assert.rejects(box.view.stop(id), { status: 409 });
});
