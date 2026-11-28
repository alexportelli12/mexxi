// Notifications (plan §5): which events push, to whom and when, and what a push
// may carry. Delivery itself (encryption, VAPID, 410) is push.test.mjs's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initVapid } from "../lib/vapid.mjs";
import { createNotifier, inQuietHours, payloadFor } from "../lib/notify.mjs";
import { writeRecord } from "../lib/pending.mjs";
import { openStore } from "../lib/store.mjs";
import { makeSettings, request, startHares, tempDir, waitFor } from "./helpers.mjs";

const screen = (name) => readFileSync(new URL(`./fixtures/herdr/screens/${name}`, import.meta.url), "utf8");
const fruit = { kind: "question", event: "PreToolUse", toolUseId: "toolu_f1", toolName: "AskUserQuestion", recordId: "question_toolu_f1",
  input: { questions: [{ header: "Fruit", question: "Which fruit for the gate?", multiSelect: false, options: [{ label: "Apple", description: "" }, { label: "Pear", description: "" }] }] } };
const bash = { kind: "permission", event: "PermissionRequest", toolName: "Bash", input: { command: "touch gate-bash.txt" }, inputHash: "hb", recordId: "permission_hb",
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow", destination: "localSettings" }] };
const SUBSCRIPTION = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "BPub", auth: "auth" } };

/** The server with a started session, one subscribed device, and every push it sends captured. */
async function boot(t, options = {}) {
  const stateDir = tempDir(t, "hares-state-");
  initVapid(stateDir);
  const sent = [];
  const box = await startHares(t, { stateDir, pushOptions: { send: async (subscription, body) => { sent.push(JSON.parse(body)); } }, ...options });
  assert.equal((await request(box.server, "POST", "/api/push/subscriptions", { body: SUBSCRIPTION })).status, 201);
  assert.equal((await request(box.server, "POST", "/api/sessions", { body: { repo: "my-app", kind: "prompt", prompt: "Go" } })).status, 201);
  const sessionId = await waitFor(async () => { await box.server.adapter.refresh(); await box.server.sessions.sync(); return box.claude.starts[0]?.sessionId; });
  const paneId = box.fake.state.agents.find((agent) => agent.agent_session.value === sessionId).pane_id;
  return { ...box, sent, sessionId, paneId };
}

async function block(box, screenName, record) {
  const agent = box.fake.state.agents.find((candidate) => candidate.pane_id === box.paneId);
  Object.assign(agent, { agent_status: "blocked", state_change_seq: agent.state_change_seq + 1 });
  box.fake.state.screens[box.paneId] = screen(screenName);
  writeRecord({ v: 1, at: new Date().toISOString(), sessionId: box.sessionId, paneId: box.paneId, toolUseId: null, suggestions: null, ...record }, box.pendingOptions);
  await box.server.adapter.refresh();
  await box.server.sessions.sync();
}

test("a session asking a question pushes once, with a deep link to it and answer buttons that carry the expect seen then", async (t) => {
  const box = await boot(t);
  await block(box, "live-q-single-normal.txt", fruit);
  const push = await waitFor(() => box.sent.find((payload) => payload.kind === "asks"), { what: "the asks push" });
  await box.server.push.idle();
  assert.equal(box.sent.filter((payload) => payload.kind === "asks").length, 1);
  assert.equal(push.v, 1);
  assert.equal(push.url, `/s/${box.sessionId}?q=question_toolu_f1`);
  assert.deepEqual(push.actions.map((action) => action.title), ["Apple", "Pear"]);
  const answer = push.answers[push.actions[1].action];
  const agent = box.fake.state.agents.find((candidate) => candidate.pane_id === box.paneId);
  assert.deepEqual(answer, { sessionId: box.sessionId, questionId: "question_toolu_f1", expect: { terminalId: agent.terminal_id, sessionId: box.sessionId, status: "blocked", seq: agent.state_change_seq }, answers: [{ kind: "option", n: 2 }] });
  // The button's request is the web app's own answer route, so a moved session refuses it as stale.
  agent.state_change_seq += 1;
  await box.server.adapter.refresh();
  const stale = await request(box.server, "POST", `/api/sessions/${answer.sessionId}/answer`, { body: { questionId: answer.questionId, expect: answer.expect, answers: answer.answers } });
  assert.equal(stale.status, 409);
});

test("a permission prompt pushes with no buttons, so no notification can allow a call or add a rule", async (t) => {
  const box = await boot(t);
  await block(box, "live-perm-bash.txt", bash);
  const push = await waitFor(() => box.sent.find((payload) => payload.kind === "asks"), { what: "the asks push" });
  assert.equal(push.title, "my-app needs your OK");
  assert.deepEqual(push.actions, []);
  assert.deepEqual(push.answers, {});
  assert.ok(!JSON.stringify(push).includes("touch"), "the command is not in the push");
});

test("a session that stops working pushes finishes, and an identity that turned asks off gets no asks push", async (t) => {
  const box = await boot(t);
  const headers = { Origin: `http://127.0.0.1:${box.server.port}` };
  const prefs = { events: { asks: false, finishes: true, mainRed: true, prReady: false, newBump: false }, quietHours: { enabled: false, start: "23:00", end: "07:00" } };
  assert.equal((await request(box.server, "PUT", "/api/notifications/prefs", { body: prefs, headers })).status, 200);
  const agent = box.fake.state.agents.find((candidate) => candidate.pane_id === box.paneId);
  Object.assign(agent, { agent_status: "working", state_change_seq: agent.state_change_seq + 1 });
  await box.server.adapter.refresh();
  await box.server.sessions.sync();
  Object.assign(agent, { agent_status: "idle", state_change_seq: agent.state_change_seq + 1 });
  await box.server.adapter.refresh();
  await box.server.sessions.sync();
  await waitFor(() => box.sent.some((payload) => payload.kind === "finishes"), { what: "the finishes push" });
  await block(box, "live-q-single-normal.txt", fruit);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!box.sent.some((payload) => payload.kind === "asks"), "asks is off for this identity");
});

test("in quiet hours a push is held for Now instead of sent, without its answer buttons", async (t) => {
  const box = await boot(t, { now: () => new Date(2026, 10, 28, 23, 30) });
  const headers = { Origin: `http://127.0.0.1:${box.server.port}` };
  const prefs = { events: { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false }, quietHours: { enabled: true, start: "23:00", end: "07:00" } };
  await request(box.server, "PUT", "/api/notifications/prefs", { body: prefs, headers });
  await block(box, "live-q-single-normal.txt", fruit);
  const held = await waitFor(async () => (await request(box.server, "GET", "/api/notifications/prefs")).json.held[0], { what: "a held push" });
  assert.equal(held.url, `/s/${box.sessionId}?q=question_toolu_f1`);
  assert.equal(box.sent.length, 0, "nothing sent in quiet hours");
  assert.deepEqual(box.server.store.heldNotifications()[0].payload.actions, [], "a held push keeps only its link");
});

test("quiet hours that run past midnight hold at night and not in the day", () => {
  const night = { enabled: true, start: "23:00", end: "07:00" };
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 23, 30)), true);
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 6, 59)), true);
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 7, 0)), false);
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 12, 0)), false);
  assert.equal(inQuietHours({ ...night, enabled: false }, new Date(2026, 0, 1, 23, 30)), false);
  assert.equal(inQuietHours({ enabled: true, start: "09:00", end: "17:00" }, new Date(2026, 0, 1, 12, 0)), true);
});

test("main going red pushes once after the first look, ready and bump pushes are off by default, and links go to CI or the pull request", async () => {
  const store = openStore(":memory:");
  const sent = [];
  const push = { identities: () => ["me"], send: (payload, { identity }) => sent.push({ payload, identity }) };
  let board = { repos: [{ name: "app", actions: { defaultBranch: "main", main: { red: false } }, pulls: { pulls: { ready: [], bumps: [] } } }] };
  const notifier = createNotifier({ store, push, settings: makeSettings({ repos: [] }), board: { board: async () => board } });
  await notifier.pollBoard();
  assert.equal(sent.length, 0, "the first look is the baseline");
  board = { repos: [{ name: "app", actions: { defaultBranch: "main", main: { red: true } }, pulls: { pulls: { ready: [{ number: 4 }], bumps: [{ number: 9, bump: true }] } } }] };
  await notifier.pollBoard();
  await notifier.pollBoard();
  assert.deepEqual(sent.map(({ payload }) => [payload.kind, payload.url]), [["mainRed", "/ci"]], "prReady and newBump are off until turned on; red pushes once");
  store.saveNotificationPrefs("me", { events: { asks: true, finishes: true, mainRed: true, prReady: true, newBump: true } });
  board = { repos: [{ name: "app", actions: { defaultBranch: "main", main: { red: true } }, pulls: { pulls: { ready: [{ number: 4 }, { number: 5 }], bumps: [{ number: 9, bump: true }, { number: 10, bump: true }] } } }] };
  await notifier.pollBoard();
  assert.deepEqual(sent.slice(1).map(({ payload }) => [payload.kind, payload.url]), [["prReady", "/prs/app/5"], ["newBump", "/prs/app/10"]]);
  store.close();
});

test("a payload names the session or pull request and never its task, and only an answerable single question gets buttons", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const expect = { terminalId: "t", sessionId, status: "blocked", seq: 3 };
  const question = (extra) => ({ id: "toolu_q", kind: "question", answerable: true, questions: [{ multiSelect: false, options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }, { n: 3, label: "Later" }] }], ...extra });
  const asks = (item) => payloadFor("asks", { sessionId, recordId: "toolu_q", repo: "app", waiting: item.kind, item, expect, task: "secret task" });
  assert.equal(asks(question()).actions.length, 2, "at most two buttons");
  for (const item of [question({ kind: "permission" }), question({ kind: "plan" }), question({ kind: "trust" }), question({ answerable: false }), question({ step: "review" }),
    question({ questions: [{ multiSelect: true, options: [{ n: 1, label: "A" }] }] }), question({ questions: [{ options: [] }, { options: [] }] })]) {
    assert.deepEqual(asks(item).actions, [], JSON.stringify(item).slice(0, 80));
  }
  assert.ok(!JSON.stringify(asks(question())).includes("secret task"));
  assert.equal(payloadFor("prReady", { repo: "app", number: 4 }).url, "/prs/app/4");
});
