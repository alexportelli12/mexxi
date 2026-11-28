// Folding hook records and the herdr screen into the question model, cleaning
// stale records, and reading Code Mode literals without running them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseScreen } from "../lib/herdr/screen.mjs";
import {
  clearForTool, extractAskUserQuestion, foldPending, gcResolved, listRecords, parseLiteral, recordIdFor, removeRecords, ruleTexts, staleWhenUnblocked, writeRecord,
} from "../lib/pending.mjs";

const liveScreen = (name) => parseScreen(readFileSync(new URL("./fixtures/herdr/screens/" + name, import.meta.url), "utf8"));

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

// --- Gate 1 findings -----------------------------------------------------------

const replLiteral = (extra = {}) => question({ at: "2026-01-01T00:00:01Z", via: "repl", toolUseId: "toolu_repl", toolName: "REPL", recordId: "question_toolu_repl", ...extra });
const replInner = (extra = {}) => question({ at: "2026-01-01T00:00:02Z", toolUseId: "repl_abc", recordId: "question_repl_abc", ...extra });

test("a Code Mode question reported by both the REPL call and its inner AskUserQuestion shows once, from the inner record (F4)", () => {
  const items = foldPending({ sessionId: SESSION, records: [replLiteral(), replInner()] });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "question_repl_abc");
});

test("an unreadable REPL literal is still folded into the inner record that arrived after it (F4)", () => {
  const items = foldPending({ sessionId: SESSION, records: [replLiteral({ unparsed: true, input: null }), replInner()] });
  assert.deepEqual(items.map((item) => [item.id, item.answerable]), [["question_repl_abc", true]]);
});

test("a REPL question with no inner record yet still shows, and a different later question does not swallow it", () => {
  assert.equal(foldPending({ sessionId: SESSION, records: [replLiteral()] })[0].id, "question_toolu_repl");
  const other = replInner({ input: { questions: [{ question: "Something else?", options: [{ label: "A" }] }] } });
  assert.deepEqual(foldPending({ sessionId: SESSION, records: [replLiteral(), other] }).map((item) => item.id), ["question_toolu_repl", "question_repl_abc"]);
});

test("the same permission prompt recorded twice shows once, as the newest record", () => {
  const items = foldPending({ sessionId: SESSION, records: [permission({ recordId: "permission_a", inputHash: "h1" }), permission({ at: "2026-01-01T00:00:09Z", recordId: "permission_b", inputHash: "h1" })] });
  assert.deepEqual(items.map((item) => item.id), ["permission_b"]);
  const two = foldPending({ sessionId: SESSION, records: [permission({ recordId: "permission_a", inputHash: "h1" }), permission({ recordId: "permission_b", inputHash: "h2" })] });
  assert.equal(two.length, 2, "two different commands are two prompts");
});

test("permission and hint records go once the session leaves blocked, and questions stay (F7)", () => {
  const hint = { v: 1, at: "2026-01-01T00:00:03Z", kind: "hint", sessionId: SESSION, recordId: "hint" };
  const records = [question(), permission(), hint];
  const now = Date.parse("2026-01-01T00:00:05Z");
  assert.deepEqual(staleWhenUnblocked(records, { status: "working", leftBlocked: true, now }).map((record) => record.recordId), ["permission_abc", "hint"]);
  assert.deepEqual(staleWhenUnblocked(records, { status: "blocked", leftBlocked: true, now }), [], "nothing goes while still blocked");
});

test("a permission record written a moment before herdr reports blocked is kept, and an old one with no blocked state goes (F7)", () => {
  const recent = staleWhenUnblocked([permission()], { status: "working", now: Date.parse("2026-01-01T00:00:10Z") });
  assert.deepEqual(recent, []);
  const old = staleWhenUnblocked([permission()], { status: "idle", now: Date.parse("2026-01-01T00:05:00Z") });
  assert.deepEqual(old.map((record) => record.recordId), ["permission_abc"]);
});

test("removing records deletes exactly the named files", (t) => {
  const box = sandbox(t);
  writeRecord(question(), box);
  writeRecord(permission(), box);
  assert.equal(removeRecords(SESSION, [permission()], box), 1);
  assert.deepEqual(listRecords(SESSION, box).map((record) => record.kind), ["question"]);
});

test("a real screen's Type something and Chat rows, given as option numbers, are offered on the item", () => {
  const record = question({ input: { questions: [{ header: "Fruit", question: "Which fruit for the gate?", options: [{ label: "Apple" }, { label: "Pear" }] }] } });
  const [item] = foldPending({ sessionId: SESSION, records: [record], screen: liveScreen("live-q-single-normal.txt") });
  assert.equal(item.freeText, true);
  assert.equal(item.chat, true);
  const [noRows] = foldPending({ sessionId: SESSION, records: [permission()], screen: liveScreen("live-perm-bash.txt") });
  assert.equal(noRows.freeText, false);
});

test("a several-question call points at the question on screen, and the review step shows what will be sent", () => {
  const record = question({ input: { questions: [
    { header: "Size", question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] },
    { header: "Shape", question: "Which shape?", options: [{ label: "Round" }, { label: "Square" }] },
  ] } });
  const second = parseScreen(readFileSync(new URL("./fixtures/herdr/screens/live-q-two-questions.txt", import.meta.url), "utf8").replace("☐ Size  ☐ Shape", "☒ Size  ☐ Shape").replace("Which size?", "Which shape?"));
  assert.equal(foldPending({ sessionId: SESSION, records: [record], screen: second })[0].current, 1);
  assert.equal(foldPending({ sessionId: SESSION, records: [record], screen: liveScreen("live-q-two-questions.txt") })[0].current, 0);
  const [review] = foldPending({ sessionId: SESSION, records: [record], screen: liveScreen("live-q-review-two.txt") });
  assert.equal(review.step, "review");
  assert.deepEqual(review.answers, [{ question: "Which size?", answer: "Large" }, { question: "Which shape?", answer: "Round" }]);
});

test("a screen ħares cannot read makes a terminal-only item, never answerable buttons", () => {
  const [item] = foldPending({ sessionId: SESSION, records: [], screen: { kind: "unknown", raw: "" } });
  assert.equal(item.answerable, false);
  assert.match(item.reason, /terminal/);
});
