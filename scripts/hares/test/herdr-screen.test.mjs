// screen.mjs reads what a blocked Claude Code pane shows. Fixture names say where each
// screen came from: "spike" (captured from a real pane during the herdr spike),
// "live-redacted" (a real pane on atlas, words replaced, layout kept) or
// "synthetic" (written from Claude Code's known layout; to be replaced by a
// capture at the live proof).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseScreen } from "../lib/herdr/screen.mjs";

const screen = (name) => readFileSync(new URL(`./fixtures/herdr/screens/${name}`, import.meta.url), "utf8");
const labels = (form) => form.options.map((option) => option.label);

test("reads a single AskUserQuestion's header, question and options, keeping Type something and Chat about this apart", () => {
  const form = parseScreen(screen("question-single.spike.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.header, "Banner");
  assert.equal(form.question, "Which colour should the spike banner be?");
  assert.deepEqual(form.options, [
    { n: 1, label: "Red", description: "Red banner" },
    { n: 2, label: "Green", description: "Green banner" },
    { n: 3, label: "Blue", description: "Blue banner" },
  ]);
  assert.equal(form.freeText, 4);
  assert.equal(form.chat, 5);
  assert.equal(form.multiSelect, false);
});

test("reads a multi-select question's checkboxes as selected or not", () => {
  const form = parseScreen(screen("question-multi-select.synthetic.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.multiSelect, true);
  assert.deepEqual(form.options.map(({ label, selected }) => [label, selected]), [["Cheese", false], ["Mushrooms", true], ["Olives", false]]);
  assert.equal(form.freeText, 4);
});

test("reads the current question of a several-question form, its tabs and a question wrapped over two lines", () => {
  const form = parseScreen(screen("question-several.synthetic.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.header, "Size");
  assert.deepEqual(form.tabs, [{ label: "Colour", answered: true }, { label: "Size", answered: false }]);
  assert.equal(form.question, "What size should the banner be? This question is long enough that the pane wraps it onto a second line.");
  assert.deepEqual(labels(form), ["Small", "Large"]);
});

test("tells the Submit review step of a several-question form from a question", () => {
  const form = parseScreen(screen("question-review.synthetic.txt"));
  assert.equal(form.kind, "review");
  assert.equal(form.question, "Ready to submit your answers?");
  assert.deepEqual(labels(form), ["Submit answers", "Cancel"]);
});

test("keeps a question a question when Claude's own text says proceed or trust", () => {
  const form = parseScreen(screen("question-says-proceed.synthetic.txt"));
  assert.equal(form.kind, "question");
  assert.deepEqual(labels(form), ["Deploy now", "Wait"]);
});

test("reads a Bash permission prompt, its command, and marks the always-allow and auto-mode options", () => {
  const form = parseScreen(screen("permission-bash.spike.txt"));
  assert.equal(form.kind, "permission");
  assert.equal(form.tool, "Bash");
  assert.equal(form.detail, "touch approval-test.txt");
  assert.equal(form.question, "Do you want to proceed?");
  assert.deepEqual(form.options.map(({ n, always }) => [n, Boolean(always)]), [[1, false], [2, true], [3, true], [4, false]]);
  assert.equal(form.options[1].label, "Yes, and always allow access to /tmp/herdr-spike/repo from this project");
});

test("reads Edit and Write approvals, marking allow-all-edits as lasting", () => {
  const edit = parseScreen(screen("permission-edit.synthetic.txt"));
  assert.equal(edit.kind, "permission");
  assert.equal(edit.tool, "Edit");
  assert.equal(edit.question, "Do you want to make this edit to app.js?");
  assert.deepEqual(edit.options.filter((option) => option.always).map((option) => option.n), [2]);
  const write = parseScreen(screen("permission-write.synthetic.txt"));
  assert.equal(write.kind, "permission");
  assert.equal(write.tool, "Write");
  assert.equal(write.question, "Do you want to create todo.md?");
});

test("reads a plan approval, its plan text, and marks auto-accept as lasting", () => {
  const form = parseScreen(screen("plan-approval.synthetic.txt"));
  assert.equal(form.kind, "plan");
  assert.equal(form.plan, "1. Add the parser\n2. Write its tests");
  assert.deepEqual(form.options.map(({ label, always }) => [label, Boolean(always)]), [
    ["Yes, and auto-accept edits", true], ["Yes, and manually approve edits", false], ["No, keep planning", false],
  ]);
});

test("reads the folder-trust dialog, its folder, and counts trusting as lasting", () => {
  const form = parseScreen(screen("folder-trust.synthetic.txt"));
  assert.equal(form.kind, "trust");
  assert.equal(form.folder, "/tmp/hares-live/repo");
  assert.deepEqual(form.options.map(({ label, always }) => [label, Boolean(always)]), [["Yes, I trust this folder", true], ["No, exit", false]]);
});

test("finds no form on an idle pane whose output holds a numbered list", () => {
  assert.equal(parseScreen(screen("idle-prompt.live-redacted.txt")).kind, "unknown");
});

test("finds no form on a working pane", () => {
  assert.equal(parseScreen(screen("working.live-redacted.txt")).kind, "unknown");
});
