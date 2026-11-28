// The ħares hook records what is pending and never decides. Each test runs the
// real hook.mjs as a process with a temporary HOME and XDG_DATA_HOME, so nothing
// here can touch the real data directory or ~/.claude.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listRecords, pendingRoot } from "../lib/pending.mjs";

const hook = fileURLToPath(new URL("../hook.mjs", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/hook/" + name + ".json", import.meta.url)), "utf8"));
const SESSION = fixture("ask-user-question").session_id;

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hares-hook-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const xdg = path.join(home, "xdg");
  const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: xdg, HERDR_PANE_ID: "p_7" };
  const options = { env: { XDG_DATA_HOME: xdg }, home };
  const run = (payload, extraEnv = {}) => {
    const input = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    return spawnSync(process.execPath, [hook], { input, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10_000 });
  };
  return { home, xdg, options, run, records: (id = SESSION) => listRecords(id, options) };
}

const EVENT_FIXTURES = [
  "ask-user-question", "exit-plan-mode", "permission-request-bash", "notification-permission", "repl-ask-literal",
  "post-tool-use", "user-prompt-submit", "stop", "session-end",
];

for (const name of EVENT_FIXTURES) {
  test("the hook exits 0 and prints nothing for " + name + " (stdout could be read as a decision)", (t) => {
    const result = sandbox(t).run(fixture(name));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });
}

for (const [label, garbage] of [["not json", "this is not json"], ["empty stdin", ""], ["a json array", "[]"], ["json null", "null"], ["a truncated object", '{"session_id": "abc'], ["binary", Buffer.from([0xff, 0xfe, 0x00, 0x01])], ["a path-like session id", JSON.stringify({ session_id: "../../x", hook_event_name: "Stop" })]]) {
  test("the hook exits 0 and prints nothing on " + label + " (a failing hook must not block the session)", (t) => {
    const box = sandbox(t);
    const result = box.run(garbage);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(pendingRoot(box.options)), false);
  });
}

test("the hook exits 0 even when the data directory cannot be written", (t) => {
  const box = sandbox(t);
  const blocker = path.join(box.home, "a-file");
  writeFileSync(blocker, "not a directory");
  const result = box.run(fixture("ask-user-question"), { XDG_DATA_HOME: blocker });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("an AskUserQuestion call becomes a question record with its questions, options and pane", (t) => {
  const box = sandbox(t);
  box.run(fixture("ask-user-question"));
  const [record] = box.records();
  assert.equal(record.kind, "question");
  assert.equal(record.sessionId, SESSION);
  assert.equal(record.paneId, "p_7");
  assert.equal(record.toolUseId, "toolu_ask1");
  assert.equal(record.cwd, "/tmp/demo");
  assert.match(record.transcriptPath, /\.jsonl$/);
  assert.deepEqual(record.input.questions[0].options.map((option) => option.label), ["Red", "Green"]);
  assert.equal(record.input.questions[0].header, "Colour");
});

test("records are private: directories 0700 and files 0600, with no temporary file left", (t) => {
  const box = sandbox(t);
  box.run(fixture("ask-user-question"));
  const dir = path.join(pendingRoot(box.options), SESSION);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(pendingRoot(box.options)).mode & 0o777, 0o700);
  const names = readdirSync(dir);
  assert.deepEqual(names.length, 1);
  assert.ok(names[0].endsWith(".json"));
  assert.equal(statSync(path.join(dir, names[0])).mode & 0o777, 0o600);
});

test("a session outside herdr still gets a record, with a null pane, keyed by session id", (t) => {
  const box = sandbox(t);
  box.run(fixture("ask-user-question"), { HERDR_PANE_ID: "" });
  const [record] = box.records();
  assert.equal(record.paneId, null);
  assert.equal(record.sessionId, SESSION);
});

test("an ExitPlanMode call becomes a plan record carrying the plan text", (t) => {
  const box = sandbox(t);
  box.run(fixture("exit-plan-mode"));
  const [record] = box.records();
  assert.equal(record.kind, "plan");
  assert.equal(record.input.plan, "1. Add the hook\n2. Test it");
});

test("a permission request becomes a permission record with its tool, input and rule suggestions", (t) => {
  const box = sandbox(t);
  box.run(fixture("permission-request-bash"));
  const [record] = box.records();
  assert.equal(record.kind, "permission");
  assert.equal(record.toolName, "Bash");
  assert.equal(record.input.command, "pnpm add left-pad");
  assert.deepEqual(record.suggestions[0].rules, [{ toolName: "Bash", ruleContent: "pnpm add:*" }]);
});

test("a permission request for AskUserQuestion or ExitPlanMode adds no second record for the same prompt", (t) => {
  const box = sandbox(t);
  box.run(fixture("exit-plan-mode"));
  box.run({ ...fixture("permission-request-bash"), tool_name: "ExitPlanMode", tool_input: { plan: "x" }, tool_use_id: "toolu_plan1" });
  box.run({ ...fixture("permission-request-bash"), tool_name: "AskUserQuestion", tool_input: { questions: [] } });
  assert.deepEqual(box.records().map((record) => record.kind), ["plan"]);
});

test("a notification becomes a hint record, and a newer one replaces it", (t) => {
  const box = sandbox(t);
  box.run(fixture("notification-permission"));
  box.run({ ...fixture("notification-permission"), notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  const hints = box.records();
  assert.equal(hints.length, 1);
  assert.equal(hints[0].kind, "hint");
  assert.equal(hints[0].notificationType, "idle_prompt");
  assert.equal(hints[0].message, "Claude is waiting for your input");
});

test("a Code Mode question is read from the REPL code as a literal: strings, comments, trailing commas, multi-select", (t) => {
  const box = sandbox(t);
  box.run(fixture("repl-ask-literal"));
  const [record] = box.records();
  assert.equal(record.kind, "question");
  assert.equal(record.via, "repl");
  assert.equal(record.unparsed, undefined);
  assert.equal(record.input.questions[0].multiSelect, true);
  assert.deepEqual(record.input.questions[0].options.map((option) => option.description), ["Quick", "Careful, 'quoted'"]);
  assert.equal(JSON.stringify(record).includes("return answer"), false);
});

test("a REPL call that never asks a question writes nothing", (t) => {
  const box = sandbox(t);
  box.run({ ...fixture("repl-ask-literal"), tool_input: { code: "return await tools.Bash({command: 'ls'})" } });
  assert.deepEqual(box.records(), []);
});

test("the REPL code is never evaluated: a side effect in the code, or in the question literal, does not run", (t) => {
  const box = sandbox(t);
  const marker = path.join(box.home, "evaluated");
  const effect = "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran')";
  const bare = "process.getBuiltinModule('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran')";
  const payloads = [
    // A side effect before the call: the literal is still read, the statement is not run.
    effect + "; " + bare + "; await tools.AskUserQuestion({questions: [{question: 'Q?', options: [{label: 'A'}]}]})",
    // A side effect inside the argument: not a literal, so unparsed, and not run.
    "await tools.AskUserQuestion({questions: [{question: (" + bare + ", 'Q?'), options: []}]})",
    // A computed value and a spread: not literals either.
    "await tools.AskUserQuestion({questions: [...(" + bare + ", [])]})",
    "await tools.AskUserQuestion({[(" + bare + ", 'questions')]: []})",
    // A template literal with an interpolation.
    "await tools.AskUserQuestion({questions: [{question: " + String.fromCharCode(96) + "x$" + "{" + bare + "}" + String.fromCharCode(96) + ", options: []}]})",
  ];
  payloads.forEach((code, index) => {
    const result = box.run({ ...fixture("repl-ask-literal"), tool_use_id: "toolu_e" + index, tool_input: { code } });
    assert.equal(result.status, 0);
  });
  assert.equal(existsSync(marker), false);
  const records = box.records();
  assert.equal(records.length, payloads.length);
  assert.equal(records[0].unparsed, undefined);
  assert.equal(records[0].input.questions[0].question, "Q?");
  for (const record of records.slice(1)) {
    assert.equal(record.unparsed, true);
    assert.equal(record.input, null);
  }
});

test("a record over 256 KB is kept as a truncated marker without its input", (t) => {
  const box = sandbox(t);
  const big = "x".repeat(300 * 1024);
  box.run({ ...fixture("permission-request-bash"), tool_input: { command: big } });
  const [record] = box.records();
  assert.equal(record.truncated, true);
  assert.equal(record.input, null);
  assert.equal(record.kind, "permission");
});

test("PostToolUse removes the record of that tool call and leaves other calls and other sessions", (t) => {
  const box = sandbox(t);
  box.run(fixture("ask-user-question"));
  box.run({ ...fixture("ask-user-question"), tool_use_id: "toolu_ask2" });
  box.run({ ...fixture("ask-user-question"), session_id: "other-session" });
  box.run(fixture("post-tool-use"));
  assert.deepEqual(box.records().map((record) => record.toolUseId), ["toolu_ask2"]);
  assert.equal(box.records("other-session").length, 1);
});

test("PostToolUseFailure also removes the record, so a failed call does not stay pending", (t) => {
  const box = sandbox(t);
  box.run(fixture("exit-plan-mode"));
  box.run({ ...fixture("post-tool-use"), hook_event_name: "PostToolUseFailure", tool_name: "ExitPlanMode", tool_use_id: "toolu_plan1" });
  assert.deepEqual(box.records(), []);
});

test("a permission record with no tool_use_id is cleared by the finished call's tool and input", (t) => {
  const box = sandbox(t);
  box.run(fixture("permission-request-bash"));
  box.run({ ...fixture("post-tool-use"), tool_name: "Bash", tool_use_id: "toolu_b9", tool_input: { command: "ls" } });
  assert.equal(box.records().length, 1, "a different command must not clear it");
  box.run({ ...fixture("post-tool-use"), tool_name: "Bash", tool_use_id: "toolu_b9", tool_input: fixture("permission-request-bash").tool_input });
  assert.deepEqual(box.records(), []);
});

for (const event of ["user-prompt-submit", "stop", "session-end"]) {
  test("the " + event + " event clears every pending record of the session and only that session", (t) => {
    const box = sandbox(t);
    box.run(fixture("ask-user-question"));
    box.run(fixture("permission-request-bash"));
    box.run(fixture("notification-permission"));
    box.run({ ...fixture("ask-user-question"), session_id: "other-session" });
    assert.equal(box.records().length, 3);
    box.run(fixture(event));
    assert.deepEqual(box.records(), []);
    assert.equal(box.records("other-session").length, 1);
  });
}

test("a session id that is not a plain id writes nothing outside the data directory", (t) => {
  const box = sandbox(t);
  box.run({ ...fixture("ask-user-question"), session_id: "../escape" });
  assert.equal(existsSync(path.join(pendingRoot(box.options), "..", "escape")), false);
  assert.equal(existsSync(pendingRoot(box.options)), false);
});
