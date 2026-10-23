import assert from "node:assert/strict";
import test from "node:test";
import { classifyRisk, RISK_LABELS } from "../lib/risk.mjs";

const root = "/work/trees";
const bash = (command) => ({ tool: "Bash", input: { command }, worktreeRoot: root });

const TABLE = [
  [bash("curl https://example.com"), "network"],
  [bash("wget -O- example.org"), "network"],
  [bash("ssh host ls"), "network"],
  [bash("node -e \"fetch('http://x')\""), "network"],
  [{ tool: "WebFetch", input: { url: "https://example.com" }, worktreeRoot: root }, "network"],
  [{ tool: "WebSearch", input: { query: "x" }, worktreeRoot: root }, "network"],
  [bash("git push origin main"), "git-remote"],
  [bash("git clone repo"), "git-remote"],
  [bash("gh api /user"), "git-remote"],
  [bash("git status && gh pr list"), "git-remote"],
  [{ tool: "Edit", input: { file_path: "/work/trees/app/a.ts" }, worktreeRoot: root }, "write-in-worktree"],
  [{ tool: "NotebookEdit", input: { notebook_path: "/work/trees/app/n.ipynb" }, worktreeRoot: root }, "write-in-worktree"],
  [{ tool: "Write", input: { file_path: "/work/trees/../etc/x" }, worktreeRoot: root }, "other"],
  [{ tool: "Write", input: { file_path: "/home/me/x" }, worktreeRoot: root }, "other"],
  [{ tool: "Read", input: { file_path: "/etc/hosts" }, worktreeRoot: root }, "read"],
  [{ tool: "Grep", input: { pattern: "x" }, worktreeRoot: root }, "read"],
  [bash("ls -la src"), "read"],
  [bash("cat README.md > out.txt"), "other"],
  [bash("cat a | tee b"), "other"],
  [bash("python3 script.py"), "other"],
  [{ tool: "mcp__playwright__browser_click", input: {}, worktreeRoot: root }, "other"],
];

test("the risk classifier covers each class", () => {
  for (const [call, expected] of TABLE) assert.equal(classifyRisk(call), expected, JSON.stringify(call));
});

test("every class has a plain label", () => {
  for (const [, risk] of TABLE) assert.ok(RISK_LABELS[risk]);
  assert.equal(RISK_LABELS.network, "Reaches the internet");
});
