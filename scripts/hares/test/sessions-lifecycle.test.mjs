// Starting, ending, resuming and renaming sessions. Starts always open a new
// pane through the guard (a new tab in the ħares workspace, then the agent start),
// whose arguments these tests read from the fake herdr.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHookApprovals } from "../lib/approvals.mjs";
import { LIFECYCLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, writeTimeoutFor } from "../lib/herdr/client.mjs";
import { createHerdrAdapter } from "../lib/herdr/adapter.mjs";
import { createLinkResolver } from "../lib/links.mjs";
import { writeRecord } from "../lib/pending.mjs";
import { composeArgs, createSessionService } from "../lib/sessions.mjs";
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

const startArgs = (box) => box.fake.writes().filter((entry) => entry.method === WRITE.agentStart).map((entry) => entry.params.args);

test("a plain session starts in a new tab of the ħares workspace in the repository, never in a pane the person has", async (t) => {
  const box = await boot(t, { agents: [] });
  const { session, created } = await box.service.start({ kind: "session", repo: "my-app" }, { actor: "me" });
  assert.equal(created, true);
  assert.equal(session.status, "starting");
  assert.equal(session.startedBy, "hares");
  const methods = box.fake.writes().map((entry) => entry.method);
  assert.deepEqual(methods, [WRITE.workspaceCreate, WRITE.agentStart]);
  assert.equal(box.fake.writes()[0].params.cwd, box.repo);
  assert.deepEqual(startArgs(box), [[]]);
  assert.ok(!methods.includes(WRITE.paneSplit));
});

test("a launch answers to its ħares id at once and to its Claude id once herdr reports it", async (t) => {
  const box = await boot(t, { agents: [] });
  const { session } = await box.service.start({ kind: "session", repo: "my-app" });
  const paneId = box.fake.writes().find((entry) => entry.method === WRITE.agentStart).params.pane_id;
  box.fake.state.agents.push(claudeAgent({ paneId, terminalId: "term_new", sessionId: SESSION, status: "idle", seq: 1, cwd: box.repo }));
  await box.adapter.refresh();
  const byLaunch = (await box.service.get(session.launchId)).session;
  assert.equal(byLaunch.id, SESSION);
  assert.equal(byLaunch.launchId, session.launchId);
  assert.equal((await box.service.get(SESSION)).session.launchId, session.launchId);
});

test("each way to start composes its claude arguments: command, issue, pull request fix, build, ready and ask", async (t) => {
  const box = await boot(t, { agents: [], limits: { concurrentRuns: 10 } });
  await box.service.start({ kind: "command", repo: "my-app", command: "ittestja", args: "/login" });
  await box.service.start({ kind: "issue", repo: "my-app", issue: 12 });
  await box.service.start({ kind: "pr", repo: "my-app", pr: 7, ask: "review-comments" });
  await box.service.start({ kind: "build", repo: "my-app", task: "Add a footer" });
  await box.service.start({ kind: "ready", repo: "my-app" });
  await box.service.start({ kind: "ask", repo: "my-app", task: "Where is login handled?" });
  assert.deepEqual(startArgs(box), [
    ["/ittestja /login"],
    ["/wettaq #12 https://github.com/me/my-app/issues/12"],
    ["/wettaq https://github.com/me/my-app/pull/7\n\nAddress the review comments on it."],
    ["/wettaq Add a footer"],
    ["/lesti"],
    ["--disallowedTools", "Edit,Write,NotebookEdit", "--append-system-prompt", "This session only answers a question: read what you need and change nothing.", "Where is login handled?"],
  ]);
});

test("a first message that starts with a dash is refused, since claude would read it as a flag", () => {
  for (const kind of ["session", "ask", "build"]) {
    assert.throws(() => composeArgs({ kind, task: "--dangerously-skip-permissions" }), { status: 400 }, kind);
  }
  assert.deepEqual(composeArgs({ kind: "session", task: "Fix - the dash" }), ["Fix - the dash"]);
});

test("an unknown command, a missing issue number or an unknown ask is refused before anything starts", async (t) => {
  const box = await boot(t, { agents: [] });
  await assert.rejects(box.service.start({ kind: "command", repo: "my-app", command: "rm" }), { status: 400 });
  await assert.rejects(box.service.start({ kind: "issue", repo: "my-app" }), { status: 400 });
  await assert.rejects(box.service.start({ kind: "pr", repo: "my-app", pr: 3, ask: "merge-it" }), { status: 400 });
  await assert.rejects(box.service.start({ kind: "session", repo: "not-configured" }), { status: 400 });
  assert.deepEqual(box.fake.writes(), []);
});

test("build, ready, issue and pr need a clean checkout on its default branch; a plain session does not", async (t) => {
  const box = await boot(t, { agents: [], dirty: true });
  for (const input of [{ kind: "build", task: "x" }, { kind: "ready" }, { kind: "issue", issue: 1 }, { kind: "pr", pr: 1 }]) {
    await assert.rejects(box.service.start({ repo: "my-app", ...input }), { status: 409 });
  }
  assert.deepEqual(box.fake.writes(), []);
  await box.service.start({ kind: "session", repo: "my-app" });
  assert.equal(startArgs(box).length, 1);
});

test("a repeated clientId returns the first start and starts nothing more", async (t) => {
  const box = await boot(t, { agents: [] });
  const clientId = "0b0b0b0b-0000-4000-8000-000000000001";
  const first = await box.service.start({ kind: "session", repo: "my-app", clientId });
  const second = await box.service.start({ kind: "session", repo: "my-app", clientId });
  assert.equal(second.created, false);
  assert.equal(second.session.launchId, first.session.launchId);
  assert.equal(startArgs(box).length, 1);
});

test("the caps bound ħares launches: a second live launch over concurrentRuns gets a 429 and starts nothing", async (t) => {
  const box = await boot(t, { agents: [], limits: { concurrentRuns: 1 } });
  await box.service.start({ kind: "session", repo: "my-app" });
  await assert.rejects(box.service.start({ kind: "session", repo: "my-app" }), { status: 429 });
  assert.equal(startArgs(box).length, 1);
});

test("a start herdr refuses shows as failed with the reason, and frees its cap", async (t) => {
  const box = await boot(t, { agents: [], limits: { concurrentRuns: 1 } });
  box.fake.failNext(WRITE.agentStart, "agent_start_failed", "no claude on PATH");
  const { session } = await box.service.start({ kind: "session", repo: "my-app" });
  assert.equal(session.status, "failed");
  assert.match(session.reason, /no claude on PATH/);
  await box.service.start({ kind: "session", repo: "my-app" });
});

test("ending needs a confirmation, closes the pane through the guard and marks a launch ended by ħares", async (t) => {
  const box = await boot(t);
  box.store.createLaunch({ id: "aaaaaaaa-0000-4000-8000-000000000009", sessionId: SESSION, repo: "my-app", action: "session" });
  const idle = { terminalId: "term_s1", sessionId: SESSION, status: "idle", seq: 10 };
  await assert.rejects(box.service.end(SESSION, { expect: idle }), { status: 400 });
  assert.deepEqual(box.fake.writes(), []);
  const finished = [];
  box.service.on("session.finished", (data) => finished.push(data.reason));
  await box.service.sync();
  const ended = await box.service.end(SESSION, { confirm: true, expect: idle }, { actor: "me" });
  assert.deepEqual(box.fake.writes(), [{ method: WRITE.paneClose, params: { pane_id: PANE } }]);
  assert.equal(ended.alive, false);
  assert.equal(ended.endedBy, "hares");
  await box.service.sync();
  assert.deepEqual(finished, ["ended"], "ended once, not again as closed");
});

test("over MCP a session the person started by hand can't be ended (D3)", async (t) => {
  const box = await boot(t);
  await assert.rejects(box.service.end(SESSION, { confirm: true }, { origin: "mcp" }), { status: 409 });
  assert.deepEqual(box.fake.writes(), []);
});

test("resume opens a new pane running claude --resume <id> in the folder the session ran in", async (t) => {
  const box = await boot(t, { agents: [] });
  box.transcript(SESSION, [{ type: "user", message: { role: "user", content: "Earlier work" } }]);
  const resumed = await box.service.resume(SESSION, { actor: "me" });
  assert.deepEqual(startArgs(box), [["--resume", SESSION]]);
  assert.equal(box.fake.writes()[0].params.cwd, box.repo);
  assert.equal(resumed.id, SESSION);
  assert.equal(resumed.action, "resume");
});

test("a running session can't be resumed into a second pane", async (t) => {
  const box = await boot(t);
  await assert.rejects(box.service.resume(SESSION), { status: 409 });
  assert.deepEqual(box.fake.writes(), []);
});

test("a rename is kept by session id, shown as the title and audited", async (t) => {
  const box = await boot(t);
  const renamed = await box.service.rename(SESSION, "  Login work ", { actor: "me" });
  assert.equal(renamed.title, "Login work");
  assert.ok(box.store.listAudit().some((row) => row.action === "session.renamed" && row.detail === "Login work"));
  await assert.rejects(box.service.rename(SESSION, "two\nlines"), { status: 400 });
});

test("a launch whose pane closed is marked gone, but not while herdr is out of reach", async (t) => {
  const box = await boot(t);
  box.store.createLaunch({ id: "aaaaaaaa-0000-4000-8000-00000000000a", sessionId: SESSION, repo: "my-app", action: "session" });
  box.store.updateLaunch("aaaaaaaa-0000-4000-8000-00000000000a", { paneId: PANE });
  box.fake.state.agents = [];
  box.fake.dropSubscriptions();
  await new Promise((resolve) => setTimeout(resolve, 30));
  box.adapter.close();
  const offline = { ...box.adapter, status: () => ({ connected: false }), panes: () => [] };
  const stale = createSessionService({ adapter: offline, store: box.store, settings: makeSettings({ repos: [] }), home: box.home, pendingOptions: box.pendingOptions, links: createLinkResolver({ branchOf: async () => null }) });
  await stale.list();
  assert.equal(box.store.getLaunch("aaaaaaaa-0000-4000-8000-00000000000a").endedAt, null);
  const online = { ...offline, status: () => ({ connected: true }) };
  const fresh = createSessionService({ adapter: online, store: box.store, settings: makeSettings({ repos: [] }), home: box.home, pendingOptions: box.pendingOptions, links: createLinkResolver({ branchOf: async () => null }) });
  const [session] = await fresh.list();
  assert.equal(box.store.getLaunch("aaaaaaaa-0000-4000-8000-00000000000a").endedBy, "gone");
  assert.equal(session.status, "closed");
});

test("closing a pane, closing a workspace, creating a tab or workspace and starting an agent wait longer than a read (F3)", () => {
  for (const method of [WRITE.paneClose, WRITE.workspaceClose, WRITE.tabCreate, WRITE.workspaceCreate]) assert.ok(writeTimeoutFor(method, {}) >= LIFECYCLE_TIMEOUT_MS, method);
  assert.ok(LIFECYCLE_TIMEOUT_MS > 3000);
  assert.equal(writeTimeoutFor(WRITE.agentStart, { timeout_ms: 60_000 }), 65_000, "never cut off before herdr's own start timeout");
  assert.equal(writeTimeoutFor(WRITE.paneSendKeys, { keys: ["1"] }), REQUEST_TIMEOUT_MS);
  assert.equal(writeTimeoutFor(WRITE.agentPrompt, { text: "x" }), REQUEST_TIMEOUT_MS);
});
