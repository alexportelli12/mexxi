// Folding hook records and the herdr screen into the question model, cleaning
// stale records, and reading Code Mode literals without running them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearForTool, extractAskUserQuestion, foldPending, gcResolved, listRecords, parseLiteral, recordIdFor, ruleTexts, writeRecord,
} from "../lib/pending.mjs";

const SESSION = "11111111-2222-4333-8444-555555555555";

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hares-pending-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { env: { XDG_DATA_HOME: path.join(home, "xdg") }, home };
}

const question = (extra = {}) => ({
  v: 1, at: "2026-01-01T00:00:01Z", event: "PreToolUse", kind: "question", sessionId: SESSION, paneId: "p_1", toolUseId: "toolu_q", toolName: "AskUserQuestion",
  input: { questions: [{ header: "Colour", question: "Which colour?", multiSelect: false, options: [{ label: "Red", description: "Warm" }, { label: "Green", description: "Calm" }] }] },
  recordId: "question_toolu_q", ...extra,
});
const permission = (extra = {}) => ({
  v: 1, at: "2026-01-01T00:00:02Z", event: "PermissionRequest", kind: "permission", sessionId: SESSION, paneId: "p_1", toolUseId: null, toolName: "Bash",
  input: { command: "pnpm add left-pad" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm add:*" }], behavior: "allow", destination: "localSettings" }],
  recordId: "permission_abc", ...extra,
});

test("an always-allow suggestion becomes the exact rule text Claude Code writes", () => {
  assert.deepEqual(ruleTexts(permission().suggestions), ["Bash(pnpm add:*)"]);
});

test("rule text skips deny suggestions, mode changes and malformed rules, and keeps a bare tool name", () => {
  const suggestions = [
    { type: "addRules", behavior: "deny", rules: [{ toolName: "Bash", ruleContent: "rm:*" }] },
    { type: "setMode", mode: "acceptEdits" },
    { type: "addRules", behavior: "allow", rules: [{ ruleContent: "x" }, { toolName: "WebFetch" }, { toolName: "WebFetch" }] },
    null,
  ];
  assert.deepEqual(ruleTexts(suggestions), ["WebFetch"]);
  assert.deepEqual(ruleTexts(undefined), []);
});

test("a question record folds to numbered options with headers, descriptions and multi-select", () => {
  const [item] = foldPending({ sessionId: SESSION, records: [question()] });
  assert.equal(item.kind, "question");
  assert.deepEqual(item.questions[0].options, [{ n: 1, label: "Red", description: "Warm" }, { n: 2, label: "Green", description: "Calm" }]);
  assert.equal(item.questions[0].header, "Colour");
  assert.equal(item.answerable, true);
  assert.equal(item.freeText, false, "free text is only offered when the screen shows it");
});

test("the screen's option numbers win over the record's, and its free-text and chat rows are kept", () => {
  const screen = { kind: "question", question: "Which colour?", freeText: true, chat: true, options: [{ n: 1, label: "Red", description: "" }, { n: 2, label: "Green", description: "" }, { n: 3, label: "Blue", description: "" }] };
  const [item] = foldPending({ sessionId: SESSION, records: [question()], screen });
  assert.deepEqual(item.questions[0].options.map((option) => option.label), ["Red", "Green", "Blue"]);
  assert.equal(item.questions[0].options[0].description, "Warm", "the record's description is kept for a matching label");
  assert.equal(item.freeText, true);
  assert.equal(item.chat, true);
});

test("a truncated or unparsed question is not answerable here and says to use the terminal", () => {
  for (const marker of [{ truncated: true, input: null }, { unparsed: true, input: null }]) {
    const [item] = foldPending({ sessionId: SESSION, records: [question(marker)] });
    assert.equal(item.answerable, false);
    assert.match(item.reason, /terminal/);
    assert.deepEqual(item.questions, []);
  }
});

test("an unparsed question takes its options from the screen when the screen shows them", () => {
  const screen = { kind: "question", question: "Which mode?", options: [{ n: 1, label: "Fast" }, { n: 2, label: "Safe" }] };
  const [item] = foldPending({ sessionId: SESSION, records: [question({ unparsed: true, input: null })], screen });
  assert.equal(item.answerable, true);
  assert.equal(item.questions[0].question, "Which mode?");
});

test("a permission record carries the tool, the command and the rule it would add", () => {
  const [item] = foldPending({ sessionId: SESSION, records: [permission()] });
  assert.deepEqual(item.permission, { tool: "Bash", content: "pnpm add left-pad", rules: ["Bash(pnpm add:*)"], rule: "Bash(pnpm add:*)" });
});

test("a hint shows only when no richer record or screen exists", () => {
  const hint = { v: 1, at: "2026-01-01T00:00:03Z", kind: "hint", sessionId: SESSION, recordId: "hint", message: "Claude needs permission" };
  assert.equal(foldPending({ sessionId: SESSION, records: [hint] })[0].kind, "hint");
  assert.equal(foldPending({ sessionId: SESSION, records: [hint] })[0].answerable, false);
  assert.deepEqual(foldPending({ sessionId: SESSION, records: [hint, question()] }).map((item) => item.kind), ["question"]);
  const screen = { kind: "permission", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] };
  assert.equal(foldPending({ sessionId: SESSION, records: [hint], screen })[0].kind, "permission");
});

test("with no record the screen alone makes an item, and nothing makes none", () => {
  const screen = { kind: "question", question: "Pick", options: [{ n: 1, label: "A" }] };
  const [item] = foldPending({ sessionId: SESSION, records: [], screen });
  assert.equal(item.source, "screen");
  assert.equal(item.questions[0].options[0].label, "A");
  assert.deepEqual(foldPending({ sessionId: SESSION, records: [], screen: { kind: "none" } }), []);
  assert.deepEqual(foldPending({ sessionId: SESSION, records: [] }), []);
});

test("the screen is merged into the newest prompt only", () => {
  const screen = { kind: "permission", options: [{ n: 1, label: "Yes" }], freeText: false, chat: false };
  const items = foldPending({ sessionId: SESSION, records: [question(), permission()], screen });
  assert.equal(items[0].source, "hook");
  assert.equal(items[1].source, "hook+screen");
});

test("garbage collection drops a record whose tool call has a result and keeps the rest", (t) => {
  const box = sandbox(t);
  writeRecord(question(), box);
  writeRecord(question({ toolUseId: "toolu_other", recordId: "question_toolu_other" }), box);
  assert.equal(gcResolved(SESSION, new Set(["toolu_q"]), box), 1);
  assert.deepEqual(listRecords(SESSION, box).map((record) => record.toolUseId), ["toolu_other"]);
  assert.equal(gcResolved(SESSION, new Set(), box), 0);
});

test("clearing a tool call removes its plan record but not a different call's", (t) => {
  const box = sandbox(t);
  writeRecord(question({ kind: "plan", toolName: "ExitPlanMode", recordId: "plan_toolu_q" }), box);
  writeRecord(question({ toolUseId: "toolu_other", recordId: "question_toolu_other" }), box);
  assert.equal(clearForTool(SESSION, { toolUseId: "toolu_q", toolName: "ExitPlanMode", input: {} }, box), 1);
  assert.equal(listRecords(SESSION, box).length, 1);
});

test("records of one tool call keep separate ids per kind, so a plan and its permission do not overwrite each other", () => {
  const plan = recordIdFor({ kind: "plan", toolUseId: "toolu_1" });
  const permissionId = recordIdFor({ kind: "permission", toolUseId: "toolu_1" });
  assert.notEqual(plan, permissionId);
  assert.equal(recordIdFor({ kind: "permission", event: "e", toolName: "Bash", input: { a: 1 } }), recordIdFor({ kind: "permission", event: "e", toolName: "Bash", input: { a: 1 } }));
});

test("a record id from an unsafe tool_use_id is hashed instead of used as a file name", () => {
  assert.match(recordIdFor({ kind: "question", toolUseId: "../../etc/passwd", event: "e", toolName: "t", input: {} }), /^question_[0-9a-f]{16}$/);
});

test("the literal reader handles every literal form a question uses", () => {
  const bs = String.fromCharCode(92);
  const source = "{ a: 1, 'b': [true, false, null, -2.5e1,], c: \"x" + bs + "ny" + bs + "u0041" + bs + "x42" + bs + "u{1F600}\", /* note */ d: 'it" + bs + "'s' // end\n }";
  assert.deepEqual(parseLiteral(source).value, { a: 1, b: [true, false, null, -25], c: "x\nyAB" + String.fromCodePoint(0x1f600), d: "it's" });
});

test("the literal reader refuses code: calls, identifiers, spreads, computed keys, interpolation, junk", () => {
  const tick = String.fromCharCode(96);
  const refused = [
    "{a: foo()}", "{a: foo}", "{...x}", "{[k]: 1}", "{a: " + tick + "x$" + "{y}" + tick + "}", "{a: 1 + 2}", "{a: undefined}", "{a: 1", "{a: 'unterminated}", "{a: function(){}}", "{a: () => 1}", "[1, 2",
  ];
  for (const source of refused) assert.throws(() => parseLiteral(source), SyntaxError, source);
});

test("the literal reader refuses deeply nested input instead of overflowing the stack", () => {
  assert.throws(() => parseLiteral("[".repeat(5000)), SyntaxError);
});

test("a __proto__ key is kept as plain data and does not change the object's prototype", () => {
  const { value } = parseLiteral('{"__proto__": {"polluted": true}}');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("extractAskUserQuestion tells apart no call, a literal call and a call it cannot read", () => {
  assert.deepEqual(extractAskUserQuestion("return 1"), { found: false });
  assert.deepEqual(extractAskUserQuestion(undefined), { found: false });
  assert.deepEqual(extractAskUserQuestion("await tools . AskUserQuestion( {questions: []} )"), { found: true, input: { questions: [] } });
  assert.deepEqual(extractAskUserQuestion("await tools.AskUserQuestion(args)"), { found: true, unparsed: true });
  assert.deepEqual(extractAskUserQuestion("await tools.AskUserQuestion([1])"), { found: true, unparsed: true });
});
