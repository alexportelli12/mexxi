// screen.mjs reads what a blocked Claude Code pane shows. Every form is tested on
// a real capture: "live-*" files were captured from real panes at gate 1 (Claude
// Code 2.1.332, herdr 0.9.5; paths and names redacted, layout kept), "spike"
// files during the herdr spike, "live-redacted" from a real pane on atlas. The
// synthetic fixtures that disagreed with the live captures were removed;
// question-multi-select.synthetic.txt stays only because herdr-guard.test.mjs
// still uses it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseScreen } from "../lib/herdr/screen.mjs";

const screen = (name) => readFileSync(new URL(`./fixtures/herdr/screens/${name}`, import.meta.url), "utf8");
const labels = (form) => form.options.map((option) => option.label);
const lasting = (form) => form.options.filter((option) => option.always).map((option) => option.n);

test("reads a single question's header, question and options, keeping Type something and Chat about this apart", () => {
  const form = parseScreen(screen("live-q-single-normal.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.header, "Fruit");
  assert.equal(form.question, "Which fruit for the gate?");
  assert.deepEqual(form.options, [{ n: 1, label: "Apple", description: "An apple" }, { n: 2, label: "Pear", description: "A pear" }]);
  assert.equal(form.freeText, 3);
  assert.equal(form.chat, 4);
  assert.equal(form.multiSelect, false);
});

test("reads a Code Mode question the same way as a normal one", () => {
  const form = parseScreen(screen("live-q-single-codemode.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.question, "Which colour should the gate banner be?");
  assert.deepEqual(labels(form), ["Red", "Green", "Blue"]);
  assert.equal(form.freeText, 4);
});

test("offers Type something as the free-text row, never as an ordinary option", () => {
  const form = parseScreen(screen("live-q-type-something.txt"));
  assert.deepEqual(labels(form), ["Fast", "Safe"]);
  assert.equal(form.freeText, 3);
});

test("reads a multi-select question's checkboxes, its unnumbered Submit row and its unboxed free-text row", () => {
  const form = parseScreen(screen("live-q-multiselect.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.multiSelect, true);
  assert.equal(form.header, "Toppings");
  assert.deepEqual(form.options.map(({ label, selected }) => [label, selected]), [["Olives", false], ["Basil", false], ["Chilli", false]]);
  assert.equal(form.freeText, 4);
  assert.equal(form.submit, "unnumbered");
});

test("reads a ticked box as selected, so a multi-select answer toggles only what differs", () => {
  const form = parseScreen(screen("live-q-multiselect.txt").replace("2. [ ] Basil", "2. [✔] Basil"));
  assert.deepEqual(form.options.map(({ selected }) => selected), [false, true, false]);
});

test("reads the current question of a several-question form and its tabs", () => {
  const form = parseScreen(screen("live-q-two-questions.txt"));
  assert.equal(form.kind, "question");
  assert.equal(form.header, "Size");
  assert.deepEqual(form.tabs, [{ label: "Size", answered: false }, { label: "Shape", answered: false }]);
  assert.equal(form.question, "Which size?");
  assert.deepEqual(labels(form), ["Small", "Large"]);
});

test("names the next unanswered tab as the header once the first is answered", () => {
  const form = parseScreen(screen("live-q-two-questions.txt").replace("☐ Size  ☐ Shape", "☒ Size  ☐ Shape"));
  assert.equal(form.header, "Shape");
});

test("tells the review step of a several-question form from a question, with what each answer will be", () => {
  const form = parseScreen(screen("live-q-review-two.txt"));
  assert.equal(form.kind, "review");
  assert.deepEqual(form.answers, [{ question: "Which size?", answer: "Large" }, { question: "Which shape?", answer: "Round" }]);
  assert.deepEqual(labels(form), ["Submit answers", "Cancel"]);
});

test("reads the review step of a multi-select question with every chosen option", () => {
  const form = parseScreen(screen("live-q-review-multiselect.txt"));
  assert.equal(form.kind, "review");
  assert.deepEqual(form.answers, [{ question: "Which toppings should the gate pizza have?", answer: "Olives, Chilli" }]);
});

test("keeps a question a question when Claude's own text says proceed or trust", () => {
  // The real capture's layout, with the question worded like a permission prompt.
  const text = screen("live-q-single-normal.txt").replace("\nWhich fruit for the gate?\n", "\nDo you want to proceed, or trust this folder's defaults?\n");
  const form = parseScreen(text);
  assert.equal(form.kind, "question");
  assert.equal(form.question, "Do you want to proceed, or trust this folder's defaults?");
  assert.deepEqual(labels(form), ["Apple", "Pear"]);
});

test("reads a Bash permission prompt and its command, and marks the always-allow-access and auto-mode options as lasting", () => {
  const form = parseScreen(screen("live-perm-bash.txt"));
  assert.equal(form.kind, "permission");
  assert.equal(form.tool, "Bash");
  assert.equal(form.detail, "touch gate-bash.txt");
  assert.equal(form.question, "Do you want to proceed?");
  assert.deepEqual(lasting(form), [2, 3]);
  assert.deepEqual(form.options.map((option) => option.label).filter((label) => /^(Yes|No)$/.test(label)), ["Yes", "No"]);
});

test("marks the don't-ask-again rule option of a Bash prompt as lasting", () => {
  const form = parseScreen(screen("live-perm-bash-rule.txt"));
  assert.equal(form.detail, "ibni prepare --slug add-license");
  assert.equal(form.options[1].label, "Yes, and don’t ask again for: ibni prepare *");
  assert.deepEqual(lasting(form), [2, 3]);
});

test("reads the spike's Bash prompt the same way", () => {
  const form = parseScreen(screen("permission-bash.spike.txt"));
  assert.equal(form.kind, "permission");
  assert.equal(form.detail, "touch approval-test.txt");
  assert.deepEqual(lasting(form), [2, 3]);
});

test("reads a Write approval, marking switch-to-accept-edits as lasting", () => {
  const form = parseScreen(screen("live-perm-write.txt"));
  assert.equal(form.kind, "permission");
  assert.equal(form.tool, "Write");
  assert.equal(form.question, "Do you want to create notes.txt?");
  assert.deepEqual(labels(form).map((label) => label.slice(0, 33)), ["Yes", "Yes, and switch to accept edits (", "No"]);
  assert.deepEqual(lasting(form), [2]);
});

test("reads a plan approval and marks use-auto-mode as lasting, leaving the plan text to the hook record", () => {
  const form = parseScreen(screen("live-plan-approval.txt"));
  assert.equal(form.kind, "plan");
  assert.deepEqual(form.options.map(({ label, always }) => [label, Boolean(always)]), [
    ["Yes, and use auto mode", true], ["Yes, manually approve edits", false], ["Tell Claude what to change", false],
  ]);
});

test("reads the real folder-trust dialog: unnumbered options, each with the keys that reach it, trusting as lasting", () => {
  const form = parseScreen(screen("live-trust-real.txt"));
  assert.equal(form.kind, "trust");
  assert.equal(form.folder, "/tmp/hares-gate1/repo");
  assert.deepEqual(form.options.map(({ label, keys, always }) => [label, keys, Boolean(always)]), [
    ["No, exit", ["enter"], false], ["Yes, I trust this folder", ["down", "enter"], true],
  ]);
});

test("finds no form on an idle pane whose output holds a numbered list", () => {
  assert.equal(parseScreen(screen("idle-prompt.live-redacted.txt")).kind, "unknown");
});

test("finds no form on a working pane", () => {
  assert.equal(parseScreen(screen("working.live-redacted.txt")).kind, "unknown");
});
