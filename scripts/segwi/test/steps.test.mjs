import assert from "node:assert/strict";
import test from "node:test";
import { foldEvents } from "../lib/steps.mjs";

const row = (seq, kind, data) => ({ seq, at: "2026-01-01T00:00:00.000Z", kind, data });
const call = (seq, toolUseId, tool, input) => row(seq, "step", { phase: "call", toolUseId, tool, input });
const result = (seq, toolUseId, ok, detail) => row(seq, "step", { phase: "result", toolUseId, ok, detail });

test("tools fold into edit, test, command, read and message steps", () => {
  const root = "/work/tree";
  const steps = foldEvents([
    row(1, "text", { text: "Starting." }),
    call(2, "a", "Edit", { file_path: "/work/tree/src/app.ts" }),
    result(3, "a", true, "ok"),
    call(4, "b", "Bash", { command: "npm run verify\nsecond line" }),
    result(5, "b", false, "failed"),
    call(6, "c", "Bash", { command: "git status" }),
    call(7, "d", "Bash", { command: "node --test scripts/x.test.mjs" }),
    call(8, "e", "Grep", { pattern: "needle" }),
    call(9, "f", "Skill", { skill: "verifika" }),
    row(10, "input", { text: "Use option B." }),
  ], { root, verifyCommand: "npm run verify" });
  assert.deepEqual(steps.map((step) => [step.type, step.title]), [
    ["message", "Starting."], ["edit", "src/app.ts"], ["test", "npm run verify"], ["command", "git status"],
    ["test", "node --test scripts/x.test.mjs"], ["read", "needle"], ["command", "verifika"], ["message", "Use option B."],
  ]);
  assert.equal(steps[1].ok, true);
  assert.equal(steps[2].ok, false);
  assert.equal(steps[2].detail, "failed");
  assert.equal(steps.at(-1).from, "you");
});

test("a command title is its first line cut to 120 characters, and a result's detail is redacted and cut to 2000", () => {
  const long = `echo ${"x".repeat(300)}`;
  const steps = foldEvents([call(1, "a", "Bash", { command: long }), result(2, "a", true, `${"y".repeat(3000)} ghp_${"A1b2".repeat(9)}`)], {});
  assert.equal(steps[0].title.length, 120);
  assert.equal(steps[0].detail.length, 2000);
  const redacted = foldEvents([call(1, "a", "Bash", { command: "ls" }), result(2, "a", true, `token ghp_${"A1b2".repeat(9)}`)], {});
  assert.ok(!redacted[0].detail.includes("ghp_"));
});

test("a result with no matching call is ignored", () => {
  assert.deepEqual(foldEvents([result(1, "missing", true, "x")], {}), []);
});

test("a refusal becomes its own failed step after the call, naming the command and why", () => {
  const steps = foldEvents([
    call(1, "a", "Bash", { command: "git push origin HEAD:main" }),
    result(2, "a", false, "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Push to default branch]."),
    row(3, "refusal", { toolUseId: "a", reason: "auto mode: [Push to default branch]" }),
    call(4, "b", "Write", { file_path: "/repo/x" }),
    row(5, "refusal", { toolUseId: "b", reason: "a deny rule" }),
    row(6, "refusal", { toolUseId: "missing", reason: "a deny rule" }),
  ], {});
  assert.deepEqual(steps.map((step) => [step.type, step.title, step.ok]), [
    ["command", "git push origin HEAD:main", false],
    ["refusal", "Refused: git push origin HEAD:main — auto mode: [Push to default branch]", false],
    ["edit", "/repo/x", null],
    ["refusal", "Refused: /repo/x — a deny rule", false],
    ["refusal", "Refused: a call — a deny rule", false],
  ]);
});
