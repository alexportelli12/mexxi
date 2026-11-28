// Approvals (plan §1, the approver table): permission prompts recorded by the
// hook become approval rows for list_approvals and the web card, and only a
// person's decision in the web app reaches the prompt, through the guard. The
// approver MCP server and its fake-host tests were retired once every row of the
// table below had a hook-era test here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentFor, createHookApprovals, DISPLAY_MAX, displayLength, exactFor, optionForDecision } from "../lib/approvals.mjs";
import { createHerdrAdapter } from "../lib/herdr/adapter.mjs";
import { parseScreen } from "../lib/herdr/screen.mjs";
import { openStore } from "../lib/store.mjs";
import { claudeAgent, startFakeHerdr } from "./fake-herdr.mjs";

const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
const COMMAND = (token) => `curl https://example.com -H 'Authorization: token ${token}'`;

test("a call with a field of an unexpected type, or a flag such as dangerouslyDisableSandbox, is shown whole", () => {
  const odd = [
    ["Bash", { command: "ls", dangerouslyDisableSandbox: true }],
    ["Edit", { file_path: "/tmp/hares-test-worktrees/a", old_string: "a", new_string: "b", replace_all: "true" }],
    ["Write", { file_path: "/tmp/hares-test-worktrees/a", content: ["not", "text"] }],
  ];
  for (const [tool, input] of odd) {
    assert.equal(exactFor(tool, input), `${tool} ${JSON.stringify(input)}`, tool);
    assert.equal(contentFor(tool, input), null, tool);
  }
  assert.equal(displayLength("abc", { kind: "edit", oldText: "edit", newText: "xy", replaceAll: false }), 9, "the kind's own name is not text, but text equal to it is");
});

// --- Herdr era: approvals fed by hook records (plan §1 approver table) ---------
// A fake herdr serves real gate-1 screens; the guard is the real one, so every
// key that would reach a pane is visible in fake.writes().

const HOOK_SESSION = "44444444-4444-4444-8444-444444444444";
const HOOK_PANE = "wT:p1";
const liveScreenText = (name) => readFileSync(new URL("./fixtures/herdr/screens/" + name, import.meta.url), "utf8");
const seenBlocked = { terminalId: "term_a1", sessionId: HOOK_SESSION, status: "blocked", seq: 700 };
const bashRecord = (extra = {}) => ({
  v: 1, at: new Date().toISOString(), event: "PermissionRequest", kind: "permission", sessionId: HOOK_SESSION, paneId: HOOK_PANE, toolUseId: null,
  toolName: "Bash", input: { command: "touch gate-bash.txt", description: "Make the file" }, inputHash: "h1",
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow", destination: "localSettings" }],
  recordId: "permission_h1", ...extra,
});

async function hookApprovals(t, { screen = "live-perm-bash.txt", agent = {} } = {}) {
  const fake = await startFakeHerdr(t, {
    agents: [claudeAgent({ paneId: HOOK_PANE, terminalId: "term_a1", sessionId: HOOK_SESSION, status: "blocked", seq: 700, ...agent })],
    screens: { [HOOK_PANE]: typeof screen === "string" && screen.endsWith(".txt") ? liveScreenText(screen) : screen },
  });
  const adapter = createHerdrAdapter({ socket: fake.socket, debounceMs: 5, backoff: { minMs: 5, maxMs: 20 } });
  t.after(() => adapter.close());
  await adapter.connect();
  const store = openStore(":memory:");
  t.after(() => store.close());
  const notified = [];
  const service = createHookApprovals({
    store, adapter, settings: { worktreeRoot: "/tmp/hares-test-worktrees" }, home: "/home/me",
    notify: (kind, data) => notified.push([kind, data]), repoForSession: () => "my-app",
  });
  return { fake, adapter, store, service, notified };
}

const decideWeb = (service, id, decision, extra = {}) => service.decide(id, decision, { identity: "me@example.com", origin: "web", expect: seenBlocked, ...extra });

test("a permission record reaches list_approvals in the legacy shape, with no run and no expiry, and pushes once (rows 1, 11-13, 15, 16)", async (t) => {
  const { service, store, notified } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, cwd: "/home/me/my-app", records: [bashRecord()] });
  service.observe({ sessionId: HOOK_SESSION, cwd: "/home/me/my-app", records: [bashRecord()] });
  const [approval] = service.list();
  assert.deepEqual(Object.keys(approval).sort(), ["content", "createdAt", "cwd", "decidedAt", "decidedBy", "exact", "expiresAt", "id", "repo", "risk", "riskLabel", "runId", "status", "tool", "why"]);
  assert.equal(approval.runId, null);
  assert.equal(approval.expiresAt, null);
  assert.equal(approval.exact, "touch gate-bash.txt");
  assert.equal(approval.cwd, "~/my-app");
  assert.equal(approval.why, "Make the file");
  assert.equal(approval.repo, "my-app");
  assert.equal(approval.status, "pending");
  assert.equal(notified.length, 1, "one push per prompt, not per observation");
  assert.equal(store.listAudit().filter((row) => row.action === "approval.requested" && row.actor === "hook").length, 1);
});

test("Run once presses the screen's plain Yes for that one call and records it allowed (row 3)", async (t) => {
  const { service, fake } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  const decided = await decideWeb(service, id, "once");
  assert.equal(decided.status, "allowed");
  assert.equal(decided.decidedVia, "once");
  assert.deepEqual(fake.writes().map((entry) => entry.params.keys), [["1"]]);
});

test("always-allow without a person's confirmation sends nothing and returns the exact rule to confirm", async (t) => {
  const { service, fake } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  await assert.rejects(decideWeb(service, id, "always"), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.confirm.rule, "Bash(touch:*)");
    assert.match(error.confirm.label, /^Yes, and always allow/);
    return true;
  });
  assert.deepEqual(fake.writes(), []);
  assert.equal(service.list()[0].status, "pending");
});

test("confirmed always-allow presses the always option found by its label on the fresh screen, never auto mode", async (t) => {
  // The rule option and the auto-mode option trade places: an index chosen earlier would now pick auto mode.
  const lines = liveScreenText("live-perm-bash-rule.txt").split("\n");
  const rule = lines.findIndex((line) => line.includes("2. Yes, and don’t ask again"));
  const auto = lines.findIndex((line) => line.includes("3. Yes, and switch to auto mode"));
  [lines[rule], lines[auto]] = [lines[auto].replace("3.", "2."), lines[rule].replace("2.", "3.")];
  const swapped = lines.join("\n");
  assert.equal(parseScreen(swapped).options[2].label, "Yes, and don’t ask again for: ibni prepare *");
  const { service, fake } = await hookApprovals(t, { screen: swapped });
  const record = bashRecord({ input: { command: "ibni prepare --slug add-license" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ibni prepare *" }], behavior: "allow" }] });
  service.observe({ sessionId: HOOK_SESSION, records: [record] });
  const [{ id }] = service.list();
  const decided = await decideWeb(service, id, "always", { confirm: true, rule: "Bash(ibni prepare *)" });
  assert.equal(decided.decidedVia, "always");
  assert.deepEqual(fake.writes().map((entry) => entry.params.keys), [["3"]]);
});

test("a confirmation for a different rule than the one on record sends nothing", async (t) => {
  const { service, fake } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  await assert.rejects(decideWeb(service, id, "always", { confirm: true, rule: "Bash(*)" }), { status: 409 });
  assert.deepEqual(fake.writes(), []);
});

test("auto mode is never what always-allow presses", () => {
  const form = { options: [{ n: 1, label: "Yes" }, { n: 2, label: "Yes, and switch to auto mode", always: true }, { n: 3, label: "No" }] };
  assert.equal(optionForDecision(form, "always"), null);
  assert.equal(optionForDecision(parseScreen(liveScreenText("live-perm-write.txt")), "always").n, 2, "accept edits for the session is an always option");
});

test("deny presses No and records it denied", async (t) => {
  const { service, fake, store } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  assert.equal((await decideWeb(service, id, "deny")).status, "denied");
  assert.deepEqual(fake.writes().map((entry) => entry.params.keys), [["4"]]);
  assert.ok(store.listAudit().some((row) => row.action === "approval.denied" && row.actor === "me@example.com"));
});

test("a decision from anywhere but the web app is refused and sends nothing (row 19)", async (t) => {
  const { service, fake } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  for (const origin of ["mcp", "push", undefined]) {
    await assert.rejects(service.decide(id, "once", { identity: "x", origin, expect: seenBlocked }), { status: 403 });
  }
  assert.deepEqual(fake.writes(), []);
  await decideWeb(service, id, "once");
  assert.equal(fake.writes().length, 1, "the same decision from the web app goes through");
});

test("a decision for a session whose state moved since the person looked sends nothing and stays pending (row 6)", async (t) => {
  const { service, fake } = await hookApprovals(t, { agent: { seq: 701 } });
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  await assert.rejects(decideWeb(service, id, "once"), { status: 409 });
  assert.deepEqual(fake.writes(), []);
  assert.equal(service.list()[0].status, "pending");
});

test("a record whose prompt is not the one on screen can't steer keys to it (row 5)", async (t) => {
  const { service, fake } = await hookApprovals(t, { screen: "live-perm-write.txt" });
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const [{ id }] = service.list();
  await assert.rejects(decideWeb(service, id, "once"), { status: 409 });
  assert.deepEqual(fake.writes(), []);
});

test("a Bash record for another command than the one on screen can't steer keys to that prompt (row 5)", async (t) => {
  const { service, fake } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord({ input: { command: "rm -rf build" } })] });
  const [{ id }] = service.list();
  await assert.rejects(decideWeb(service, id, "once"), { status: 409 });
  assert.deepEqual(fake.writes(), []);
});

test("an approval too long to show in full makes no row and offers no Allow (row 7)", async (t) => {
  const { service, store } = await hookApprovals(t);
  const result = service.observe({ sessionId: HOOK_SESSION, records: [bashRecord({ input: { command: "x".repeat(DISPLAY_MAX + 1) } })] });
  assert.deepEqual(result.tooLong, ["permission_h1"]);
  assert.deepEqual(service.list(), []);
  assert.equal(store.listAudit().filter((row) => row.action === "approval.too_long").length, 1);
});

test("a prompt answered in the terminal or gone expires its approval (row 9)", async (t) => {
  const { service, store } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord()] });
  const result = service.observe({ sessionId: HOOK_SESSION, records: [] });
  assert.equal(result.expired.length, 1);
  const [expired] = service.list({ status: "expired" });
  assert.equal(expired.decidedBy, "system");
  assert.ok(store.listAudit().some((row) => row.action === "approval.expired"));
  assert.deepEqual(service.list(), []);
});

test("a raw secret shows to the person while pending and is redacted once decided (row 14)", async (t) => {
  const { service } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord({ input: { command: COMMAND(TOKEN) } })] });
  const [pending] = service.list();
  assert.equal(pending.exact, COMMAND(TOKEN));
  await assert.rejects(decideWeb(service, pending.id, "once"), { status: 409 }, "the screen shows another command, so it is refused");
  service.observe({ sessionId: HOOK_SESSION, records: [] });
  const [expired] = service.list({ status: "expired" });
  assert.equal(expired.exact.includes(TOKEN), false);
});

test("an always-allow that opens a folder says which folder (F6)", async (t) => {
  const { service } = await hookApprovals(t);
  service.observe({ sessionId: HOOK_SESSION, records: [bashRecord({ suggestions: [{ type: "addDirectories", directories: ["/tmp/hares-gate1/repo"], destination: "session" }] })] });
  assert.equal(service.forSession(HOOK_SESSION)[0].suggestedRule, "Allow access to /tmp/hares-gate1/repo from this project");
});
