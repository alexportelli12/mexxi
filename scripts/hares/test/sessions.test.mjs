// The session service over a fake herdr with the real adapter and guard. Every
// key that would reach a pane shows in fake.writes(); hook records and
// transcripts live in a temporary HOME.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHookApprovals, DISPLAY_MAX } from "../lib/approvals.mjs";
import { createHerdrAdapter } from "../lib/herdr/adapter.mjs";
import { createLinkResolver } from "../lib/links.mjs";
import { listRecords, writeRecord } from "../lib/pending.mjs";
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

const fruitRecord = { kind: "question", event: "PreToolUse", toolUseId: "toolu_f1", toolName: "AskUserQuestion", recordId: "question_toolu_f1",
  input: { questions: [{ header: "Fruit", question: "Which fruit for the gate?", multiSelect: false, options: [{ label: "Apple", description: "An apple" }, { label: "Pear", description: "A pear" }] }] } };
const bashRecord = { kind: "permission", event: "PermissionRequest", toolName: "Bash", input: { command: "touch gate-bash.txt" }, inputHash: "hb", recordId: "permission_hb",
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow" }] };
const blocked = (screen) => ({ agents: [claudeAgent({ paneId: PANE, terminalId: "term_s1", sessionId: SESSION, status: "blocked", seq: 20 })], screens: { [PANE]: liveText(screen) } });
const seen = { terminalId: "term_s1", sessionId: SESSION, status: "blocked", seq: 20 };
const launchFor = (box) => { box.store.createLaunch({ id: "aaaaaaaa-0000-4000-8000-000000000001", sessionId: SESSION, repo: "my-app", action: "build", task: "x" }); box.store.updateLaunch("aaaaaaaa-0000-4000-8000-000000000001", { paneId: PANE }); };

test("lists every Claude pane as a session keyed by its Claude id, named by a rename over the transcript's title", async (t) => {
  const box = await boot(t);
  box.transcript(SESSION, [{ type: "user", message: { role: "user", content: "Fix the login bug" }, timestamp: "2026-01-01T10:00:00Z" }]);
  let [session] = await box.service.list();
  assert.equal(session.id, SESSION);
  assert.equal(session.repo, "my-app");
  assert.equal(session.startedBy, "you");
  assert.equal(session.title, "Fix the login bug");
  assert.deepEqual(session.expect, { terminalId: "term_s1", sessionId: SESSION, status: "idle", seq: 10 });
  box.store.setSessionName(SESSION, "Login work", "me");
  [session] = await box.service.list();
  assert.equal(session.title, "Login work");
});

test("a session's page carries a transcript page and its queue numbered 1 of N", async (t) => {
  const box = await boot(t, blocked("live-perm-bash.txt"));
  box.transcript(SESSION, [
    { type: "user", message: { role: "user", content: "First" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Second" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Third" }] } },
  ]);
  box.record({ ...fruitRecord, at: "2026-01-01T00:00:01Z" });
  box.record({ ...bashRecord, at: "2026-01-01T00:00:02Z" });
  const page = await box.service.get(SESSION, { since: 1, limit: 1 });
  assert.deepEqual(page.transcript.rows.map((row) => row.data.text), ["Second"]);
  assert.equal(page.transcript.total, 3);
  assert.deepEqual(page.pending.items.map((item) => [item.kind, item.position.n, item.position.of]), [["question", 1, 2], ["permission", 2, 2]]);
  assert.equal(page.pending.items[1].personOnly, true);
});

test("answers a question by its label with the digit from the fresh screen", async (t) => {
  const box = await boot(t, blocked("live-q-single-normal.txt"));
  box.record(fruitRecord);
  await box.service.answer(SESSION, { recordId: "question_toolu_f1", kind: "question", optionLabel: "Pear", expect: seen }, { actor: "me" });
  assert.deepEqual(box.fake.writes(), [{ method: WRITE.paneSendKeys, params: { pane_id: PANE, keys: ["2"] } }]);
  assert.ok(box.store.listAudit().some((row) => row.action === "session.answered" && row.detail === "question: Pear"));
});

test("a forged record whose question is not the one on screen can't steer keys to it", async (t) => {
  const box = await boot(t, blocked("live-q-single-normal.txt"));
  box.record({ ...fruitRecord, input: { questions: [{ question: "Delete everything?", options: [{ label: "Pear" }] }] } });
  await assert.rejects(box.service.answer(SESSION, { recordId: "question_toolu_f1", kind: "question", optionLabel: "Pear", expect: seen }), { status: 409 });
  assert.deepEqual(box.fake.writes(), []);
});

test("a key sent after the session's state moved is refused and nothing reaches the pane", async (t) => {
  const box = await boot(t, blocked("live-q-single-normal.txt"));
  box.record(fruitRecord);
  await assert.rejects(box.service.answer(SESSION, { recordId: "question_toolu_f1", kind: "question", optionLabel: "Pear", expect: { ...seen, seq: 19 } }), { status: 409 });
  assert.deepEqual(box.fake.writes(), []);
});

test("MCP can't answer a permission, a plan or trust, or confirm an always option, even on a session ħares started", async (t) => {
  const box = await boot(t, blocked("live-perm-bash.txt"));
  launchFor(box);
  box.record(bashRecord);
  for (const kind of ["permission", "plan", "trust"]) {
    await assert.rejects(box.service.answer(SESSION, { recordId: "permission_hb", kind, optionLabel: "Yes", expect: seen }, { origin: "mcp" }), { status: 403 });
  }
  await assert.rejects(box.service.answer(SESSION, { recordId: "permission_hb", kind: "question", optionLabel: "Yes", confirmAlways: true, expect: seen }, { origin: "mcp" }), { status: 403 });
  assert.deepEqual(box.fake.writes(), []);
});

test("MCP reaches only sessions ħares started (D3): a hand-started session's question is refused, a launched one's answered", async (t) => {
  const box = await boot(t, blocked("live-q-single-normal.txt"));
  box.record(fruitRecord);
  const answer = { recordId: "question_toolu_f1", kind: "question", optionLabel: "Apple", expect: seen };
  await assert.rejects(box.service.answer(SESSION, answer, { origin: "mcp" }), { status: 409 });
  assert.deepEqual(box.fake.writes(), []);
  launchFor(box);
  await box.service.answer(SESSION, answer, { origin: "mcp" });
  assert.deepEqual(box.fake.writes().map((entry) => entry.params.keys), [["1"]]);
});

test("a multi-select answer toggles the chosen boxes, then moves to the review step", async (t) => {
  const box = await boot(t, blocked("live-q-multiselect.txt"));
  box.record({ ...fruitRecord, input: { questions: [{ header: "Toppings", question: "Which toppings should the gate pizza have?", multiSelect: true, options: [{ label: "Olives" }, { label: "Basil" }, { label: "Chilli" }] }] } });
  await box.service.answer(SESSION, { recordId: "question_toolu_f1", kind: "question", labels: ["Olives", "Chilli"], expect: seen });
  assert.deepEqual(box.fake.writes().map((entry) => entry.params.keys), [["1", "3", "right"]]);
});

test("a typed answer picks Type something, types the text, and presses Enter once the row shows it", async (t) => {
  const box = await boot(t, blocked("live-q-type-something.txt"));
  box.record({ ...fruitRecord, input: { questions: [{ header: "Motto", question: "What should the gate motto be?", options: [{ label: "Fast" }, { label: "Safe" }] }] } });
  box.fake.afterNext(WRITE.paneSendText, (state) => {
    state.screens[PANE] = liveText("live-q-type-something.txt").replace("❯ 1. Fast", "  1. Fast").replace("  3. Type something.", "❯ 3. Be kind");
  });
  await box.service.answer(SESSION, { recordId: "question_toolu_f1", kind: "question", text: "Be kind", expect: seen });
  assert.deepEqual(box.fake.writes().map((entry) => [entry.method, entry.params.keys ?? entry.params.text]), [
    [WRITE.paneSendKeys, ["3"]], [WRITE.paneSendText, "Be kind"], [WRITE.paneSendKeys, ["enter"]],
  ]);
});

test("a permission answered in the web app goes through its approval, which records the decision", async (t) => {
  const box = await boot(t, { ...blocked("live-perm-bash.txt"), withApprovals: true });
  box.record(bashRecord);
  await box.service.sync();
  await box.service.answer(SESSION, { recordId: "permission_hb", kind: "permission", optionLabel: "Yes", expect: seen }, { actor: "me@example.com" });
  assert.deepEqual(box.fake.writes().map((entry) => entry.params.keys), [["1"]]);
  assert.equal(box.approvals.list({ status: "allowed" })[0].decidedBy, "me@example.com");
});

test("a permission too long to show in full is not answerable here and says to use the terminal (D2)", async (t) => {
  const box = await boot(t, blocked("live-perm-bash.txt"));
  box.record({ ...bashRecord, input: { command: "x".repeat(DISPLAY_MAX + 1) } });
  const { pending } = await box.service.get(SESSION);
  assert.equal(pending.items[0].answerable, false);
  assert.match(pending.items[0].reason, /terminal/);
  await assert.rejects(box.service.answer(SESSION, { recordId: "permission_hb", kind: "permission", optionLabel: "Yes", expect: seen }), { status: 422 });
  assert.deepEqual(box.fake.writes(), []);
});

test("steering an idle session that shows a dialog is refused; a plain idle session gets the message", async (t) => {
  const box = await boot(t, { screens: { [PANE]: liveText("live-q-single-normal.txt") } });
  const idle = { terminalId: "term_s1", sessionId: SESSION, status: "idle", seq: 10 };
  launchFor(box);
  await assert.rejects(box.service.steer(SESSION, { text: "carry on", expect: idle }), { status: 409 });
  assert.deepEqual(box.fake.writes(), []);
  box.fake.state.screens[PANE] = liveText("idle-prompt.live-redacted.txt");
  await box.service.steer(SESSION, { text: "carry on", expect: idle }, { origin: "mcp" });
  assert.deepEqual(box.fake.writes(), [{ method: WRITE.agentPrompt, params: { target: PANE, text: "carry on" } }]);
});

test("raw keys and Esc come only from the web app, and only the terminal row's keys", async (t) => {
  const box = await boot(t);
  const idle = { terminalId: "term_s1", sessionId: SESSION, status: "idle", seq: 10 };
  await assert.rejects(box.service.keys(SESSION, { keys: ["1"], expect: idle }, { origin: "mcp" }), { status: 403 });
  await assert.rejects(box.service.esc(SESSION, { expect: idle }, { origin: "mcp" }), { status: 403 });
  await assert.rejects(box.service.keys(SESSION, { keys: ["f12"], expect: idle }), { status: 400 });
  assert.deepEqual(box.fake.writes(), []);
  await box.service.esc(SESSION, { expect: idle });
  await box.service.keys(SESSION, { keys: ["ctrl+c", "down"], expect: idle });
  assert.deepEqual(box.fake.writes().map((entry) => entry.params.keys), [["escape"], ["ctrl+c", "down"]]);
});

test("a permission record goes when the session leaves blocked, and a question record stays (F7)", async (t) => {
  const box = await boot(t, blocked("live-perm-bash.txt"));
  box.record({ ...fruitRecord, at: "2026-01-01T00:00:01Z" });
  box.record(bashRecord);
  await box.service.sync();
  await setAgent(box, { agent_status: "working", state_change_seq: 21 });
  await box.service.sync();
  assert.deepEqual(listRecords(SESSION, box.pendingOptions).map((record) => record.kind), ["question"]);
});

test("a new record and its clearing are announced, and a turn's end and a closed pane finish the session", async (t) => {
  const box = await boot(t, { agents: [claudeAgent({ paneId: PANE, terminalId: "term_s1", sessionId: SESSION, status: "working", seq: 10 })] });
  const seenEvents = [];
  for (const name of ["question.added", "question.cleared", "session.finished"]) box.service.on(name, (data) => seenEvents.push([name, data.reason ?? data.recordId]));
  await box.service.sync();
  box.record(fruitRecord);
  await box.service.sync();
  await setAgent(box, { agent_status: "idle", state_change_seq: 11 });
  await box.service.sync();
  box.fake.state.agents = [];
  await box.adapter.refresh();
  await box.service.sync();
  assert.deepEqual(seenEvents, [["question.added", "question_toolu_f1"], ["session.finished", "idle"], ["question.cleared", "question_toolu_f1"], ["session.finished", "closed"]]);
});
