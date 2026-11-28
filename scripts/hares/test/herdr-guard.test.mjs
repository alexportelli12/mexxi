// The guard is the only way ħares acts on a herdr pane. Each refusal test checks
// two things: the typed 409 comes back, and nothing reached the fake herdr.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGuard, STALE_MESSAGE, StaleStateError } from "../lib/herdr/guard.mjs";
import { claudeAgent, startFakeHerdr, WRITE } from "./fake-herdr.mjs";

const screen = (name) => readFileSync(new URL(`./fixtures/herdr/screens/${name}`, import.meta.url), "utf8");
const SESSION = "22222222-2222-4222-8222-222222222222";
const PANE = "wT:p1";
const seen = { terminalId: "term_t1", sessionId: SESSION, status: "blocked", seq: 500 };
const question = { kind: "question", question: "Which colour should the spike banner be?", optionLabel: "Green" };

async function blockedOnQuestion(t, overrides = {}) {
  const fake = await startFakeHerdr(t, {
    agents: [claudeAgent({ paneId: PANE, terminalId: "term_t1", sessionId: SESSION, status: "blocked", seq: 500, ...overrides })],
    screens: { [PANE]: screen("question-single.spike.txt") },
  });
  return { fake, guard: createGuard({ socket: fake.socket }) };
}

async function assertRefused(promise, reason, fake) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof StaleStateError, `expected StaleStateError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.status, 409);
    assert.equal(error.reason, reason);
    return true;
  });
  assert.deepEqual(fake.writes(), [], "nothing may reach the pane after a refusal");
}

// "Type something.": what the row shows after the text is typed decides whether Enter goes.
const MOTTO = "What should the gate motto be?";
async function typingInto(t, rowAfterTyping) {
  const fake = await startFakeHerdr(t, {
    agents: [claudeAgent({ paneId: PANE, terminalId: "term_t1", sessionId: SESSION, status: "blocked", seq: 500 })],
    screens: { [PANE]: screen("live-q-type-something.txt") },
  });
  fake.afterNext(WRITE.paneSendText, (state) => {
    state.screens[PANE] = screen("live-q-type-something.txt").replace("❯ 1. Fast", "  1. Fast").replace("  3. Type something.", rowAfterTyping);
  });
  return { fake, guard: createGuard({ socket: fake.socket }) };
}
const enterSent = (fake) => fake.writes().some((entry) => entry.params.keys?.includes("enter"));

// Break caught: an empty row passes the check (every text starts with ""), or the match runs on into the next
// line, so Enter submits whatever the row really holds.
test("a typed answer is not submitted when the row shows nothing, or only part of a text that fits on it", async (t) => {
  for (const row of ["❯ 3. ", "❯ 3.", "❯ 3. Be"]) {
    const { fake, guard } = await typingInto(t, row);
    await assert.rejects(guard.answerText({ paneId: PANE, expect: seen, answer: { question: MOTTO, text: "Be kind" } }), (error) => error.reason === "typed_text_missing");
    assert.equal(enterSent(fake), false, JSON.stringify(row));
  }
});

test("a typed answer is submitted when the row shows all of it, or at least its first 20 characters when it is too long for the row", async (t) => {
  const whole = await typingInto(t, "❯ 3. Be  kind");
  await whole.guard.answerText({ paneId: PANE, expect: seen, answer: { question: MOTTO, text: "Be kind" } });
  assert.equal(enterSent(whole.fake), true);
  const long = "Always leave the codebase a little better than you found it, and say why";
  const cut = await typingInto(t, `❯ 3. ${long.slice(0, 30)}…`);
  await cut.guard.answerText({ paneId: PANE, expect: seen, answer: { question: MOTTO, text: long } });
  assert.equal(enterSent(cut.fake), true);
  const tooLittle = await typingInto(t, `❯ 3. ${long.slice(0, 12)}`);
  await assert.rejects(tooLittle.guard.answerText({ paneId: PANE, expect: seen, answer: { question: MOTTO, text: long } }), (error) => error.reason === "typed_text_missing");
  assert.equal(enterSent(tooLittle.fake), false);
});

test("answers by label with the digit of that option on the fresh screen", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  const result = await guard.answer({ paneId: PANE, expect: seen, answer: question });
  assert.equal(result.n, 2);
  assert.deepEqual(fake.writes(), [{ method: WRITE.paneSendKeys, params: { pane_id: PANE, keys: ["2"] } }]);
});

test("uses the option number on the screen now, not the one the person saw, when the options moved", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.screens[PANE] = screen("question-single.spike.txt")
    .replace("❯ 1. Red\n     Red banner\n  2. Green\n     Green banner", "❯ 1. Green\n     Green banner\n  2. Red\n     Red banner");
  await guard.answer({ paneId: PANE, expect: seen, answer: question });
  assert.deepEqual(fake.writes().map((entry) => entry.params.keys), [["1"]]);
});

test("refuses with the 409 message when state_change_seq moved", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t, { seq: 501 });
  await assert.rejects(guard.answer({ paneId: PANE, expect: seen, answer: question }), { message: STALE_MESSAGE });
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "seq_moved", fake);
});

test("refuses when the session is no longer blocked", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t, { status: "working" });
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "status_changed", fake);
});

test("refuses an answer when the person saw a session that was not blocked", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t, { status: "idle" });
  await assertRefused(guard.answer({ paneId: PANE, expect: { ...seen, status: "idle" }, answer: question }), "not_blocked", fake);
});

test("refuses when the pane now holds a different terminal", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t, { terminalId: "term_other" });
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "terminal_changed", fake);
});

test("refuses when the pane now runs a different Claude session", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t, { sessionId: "33333333-3333-4333-8333-333333333333" });
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "session_changed", fake);
});

test("refuses when the pane is gone", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.agents = [];
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "pane_gone", fake);
});

test("refuses when the pane no longer runs Claude", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.agents[0].agent = null;
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "not_claude", fake);
});

test("refuses when the chosen label is no longer on the screen", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.screens[PANE] = screen("question-single.spike.txt").replace("Green", "Purple");
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "option_missing", fake);
});

test("refuses when the screen shows another question with the same labels", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.screens[PANE] = screen("question-single.spike.txt").replace("Which colour should the spike banner be?", "Which colour should the footer be?");
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "question_changed", fake);
});

test("refuses when the screen now shows a permission prompt instead of the question", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.screens[PANE] = screen("permission-bash.spike.txt");
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: { kind: "question", question: "Do you want to proceed?", optionLabel: "Yes" } }), "form_changed", fake);
});

test("refuses when the screen holds no form any more", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.screens[PANE] = screen("idle-prompt.live-redacted.txt");
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "screen_unreadable", fake);
});

test("refuses when the seq moves while the screen is being read", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.afterNext("pane.read", (state) => { state.agents[0].state_change_seq = 501; });
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "seq_moved", fake);
});

test("refuses every send when herdr speaks another protocol", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  fake.state.protocol = 23;
  await assertRefused(guard.answer({ paneId: PANE, expect: seen, answer: question }), "protocol", fake);
  await assertRefused(guard.sendKeys({ paneId: PANE, expect: seen, keys: ["esc"] }), "protocol", fake);
  await assertRefused(guard.startSession({ cwd: "/tmp/hares-fake/repo" }), "protocol", fake);
});

test("refuses when the caller did not say what the person saw", async (t) => {
  const { fake, guard } = await blockedOnQuestion(t);
  await assertRefused(guard.sendKeys({ paneId: PANE, expect: { terminalId: "term_t1", status: "blocked", seq: 500 }, keys: ["esc"] }), "incomplete_expectation", fake);
});

test("chooses an always-allow option only with the person's confirmation", async (t) => {
  const fake = await startFakeHerdr(t, {
    agents: [claudeAgent({ paneId: PANE, terminalId: "term_t1", sessionId: SESSION, status: "blocked", seq: 500 })],
    screens: { [PANE]: screen("permission-bash.spike.txt") },
  });
  const guard = createGuard({ socket: fake.socket });
  const always = { kind: "permission", question: "Do you want to proceed?", optionLabel: "Yes, and always allow access to /tmp/herdr-spike/repo from this project" };
  await assert.rejects(guard.answer({ paneId: PANE, expect: seen, answer: always }), { status: 409 });
  assert.deepEqual(fake.writes(), []);
  await guard.answer({ paneId: PANE, expect: seen, answer: { ...always, confirmAlways: true } });
  assert.deepEqual(fake.writes().map((entry) => entry.params.keys), [["2"]]);
});

test("sends nothing for a multi-select question, whose keys are not proven", async (t) => {
  const fake = await startFakeHerdr(t, {
    agents: [claudeAgent({ paneId: PANE, terminalId: "term_t1", sessionId: SESSION, status: "blocked", seq: 500 })],
    screens: { [PANE]: screen("question-multi-select.synthetic.txt") },
  });
  const guard = createGuard({ socket: fake.socket });
  await assert.rejects(guard.answer({ paneId: PANE, expect: seen, answer: { kind: "question", question: "Which toppings should go on the pizza?", optionLabel: "Cheese" } }), { status: 422 });
  assert.deepEqual(fake.writes(), []);
});

test("steers a working session by prompting its pane, and refuses once its seq moved", async (t) => {
  const fake = await startFakeHerdr(t, { agents: [claudeAgent({ paneId: PANE, terminalId: "term_t1", sessionId: SESSION, status: "working", seq: 7 })] });
  const guard = createGuard({ socket: fake.socket });
  const working = { terminalId: "term_t1", sessionId: SESSION, status: "working", seq: 7 };
  await guard.steer({ paneId: PANE, expect: working, text: "Also run the tests" });
  assert.deepEqual(fake.writes(), [{ method: WRITE.agentPrompt, params: { target: PANE, text: "Also run the tests" } }]);
  fake.state.agents[0].state_change_seq = 8;
  await assert.rejects(guard.steer({ paneId: PANE, expect: working, text: "again" }), { name: "StaleStateError" });
  assert.equal(fake.writes().length, 1);
});

test("closes a pane only while it is the session the person saw", async (t) => {
  const fake = await startFakeHerdr(t, { agents: [claudeAgent({ paneId: PANE, terminalId: "term_t1", sessionId: SESSION, status: "idle", seq: 9 })] });
  const guard = createGuard({ socket: fake.socket });
  const idle = { terminalId: "term_t1", sessionId: SESSION, status: "idle", seq: 9 };
  await assertRefused(guard.close({ paneId: PANE, expect: { ...idle, seq: 8 } }), "seq_moved", fake);
  await guard.close({ paneId: PANE, expect: idle });
  assert.deepEqual(fake.writes(), [{ method: WRITE.paneClose, params: { pane_id: PANE } }]);
});

test("starts sessions in one ħares-owned workspace: its first pane, then new tabs, never a split", async (t) => {
  const fake = await startFakeHerdr(t, { workspaces: [{ workspace_id: "w1", label: "work" }] });
  const guard = createGuard({ socket: fake.socket });
  const first = await guard.startSession({ cwd: "/tmp/hares-fake/repo", args: ["/wettaq #12"] });
  const second = await guard.startSession({ cwd: "/tmp/hares-fake/other" });
  assert.equal(first.state, "started");
  assert.equal(first.workspaceId, second.workspaceId);
  assert.notEqual(first.paneId, second.paneId);
  const methods = fake.writes().map((entry) => entry.method);
  assert.deepEqual(methods, [WRITE.workspaceCreate, WRITE.agentStart, WRITE.tabCreate, WRITE.agentStart]);
  assert.equal(fake.writes()[0].params.label, "ħares");
  assert.deepEqual(fake.writes()[1].params.args, ["/wettaq #12"]);
  assert.equal(fake.writes()[1].params.kind, "claude");
});

test("makes a new ħares workspace when the remembered id now belongs to someone else's workspace", async (t) => {
  const fake = await startFakeHerdr(t, { workspaces: [{ workspace_id: "wH1", label: "someone else's" }] });
  let remembered = "wH1";
  const guard = createGuard({ socket: fake.socket, workspaceStore: { get: () => remembered, set: (id) => { remembered = id; } } });
  await guard.startSession({ cwd: "/tmp/hares-fake/repo" });
  assert.deepEqual(fake.writes().map((entry) => entry.method), [WRITE.workspaceCreate, WRITE.agentStart]);
  assert.notEqual(remembered, "wH1");
});

test("reports a start that stopped at Claude's folder-trust dialog instead of failing", async (t) => {
  const fake = await startFakeHerdr(t);
  const guard = createGuard({ socket: fake.socket });
  fake.failNext(WRITE.agentStart, "agent_not_ready", "agent is not ready");
  const result = await guard.startSession({ cwd: "/tmp/hares-fake/new" });
  assert.equal(result.state, "needs_trust");
  assert.ok(result.paneId);
});
