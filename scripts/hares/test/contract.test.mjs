// The REST contract with the web app (web/src/app/core/api.ts and
// pages/github/github-api.ts are the contract): the real server over a fake
// herdr, its fake claude and a fake gh. Each test names the break it catches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { writeRecord } from "../lib/pending.mjs";
import { WRITE } from "./fake-herdr.mjs";
import { request, startHares, waitFor } from "./helpers.mjs";

const screen = (name) => readFileSync(new URL(`./fixtures/herdr/screens/${name}`, import.meta.url), "utf8");
const SESSION_KEYS = ["alive", "endedAt", "id", "lastActivityAt", "line", "links", "pendingCount", "repo", "seq", "startedAt", "startedBy", "status", "terminalId", "title", "waitingOn"];
const PENDING_KEYS = ["answerable", "askedAt", "asker", "chat", "expect", "freeText", "id", "items", "kind", "reason", "sessionId"];
const keys = (box) => box.fake.writes().filter((entry) => [WRITE.paneSendKeys, WRITE.agentSendKeys, WRITE.paneSendText].includes(entry.method));
const fruit = { kind: "question", event: "PreToolUse", toolUseId: "toolu_f1", toolName: "AskUserQuestion", recordId: "question_toolu_f1",
  input: { questions: [{ header: "Fruit", question: "Which fruit for the gate?", multiSelect: false, options: [{ label: "Apple", description: "" }, { label: "Pear", description: "" }] }] } };
const bash = { kind: "permission", event: "PermissionRequest", toolName: "Bash", input: { command: "touch gate-bash.txt" }, inputHash: "hb", recordId: "permission_hb",
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow", destination: "localSettings" }] };

/** The server with one session started from the web app, waited for until herdr shows it. */
async function withSession(t, options = {}) {
  const gh = [];
  const box = await startHares(t, { ghExec: async (argv, { input }) => { gh.push({ argv, input: JSON.parse(input) }); return { stdout: "{\"merged\":true,\"id\":1}" }; }, ...options });
  const started = await request(box.server, "POST", "/api/sessions", { body: { repo: "my-app", kind: "prompt", prompt: "Look around" } });
  assert.equal(started.status, 201);
  const sessionId = await waitFor(async () => {
    await box.server.adapter.refresh();
    await box.server.sessions.sync();
    return box.claude.starts[0]?.sessionId;
  });
  const paneId = box.fake.state.agents.find((agent) => agent.agent_session.value === sessionId).pane_id;
  return { ...box, gh, sessionId, paneId, launchId: started.json.session.id };
}

async function block(box, screenName, record) {
  const agent = box.fake.state.agents.find((candidate) => candidate.pane_id === box.paneId);
  Object.assign(agent, { agent_status: "blocked", state_change_seq: agent.state_change_seq + 1 });
  box.fake.state.screens[box.paneId] = screen(screenName);
  if (record) writeRecord({ v: 1, at: new Date().toISOString(), sessionId: box.sessionId, paneId: box.paneId, toolUseId: null, suggestions: null, ...record }, box.pendingOptions);
  await box.server.adapter.refresh();
  await box.server.sessions.sync();
  const [pending] = (await request(box.server, "GET", "/api/questions")).json.questions;
  return pending;
}

test("sessions list and detail answer in the app's Session shape, with the transcript folded and the app's own start marked", async (t) => {
  const box = await withSession(t);
  const { sessions } = (await request(box.server, "GET", "/api/sessions")).json;
  assert.equal(sessions.length, 1);
  assert.deepEqual(Object.keys(sessions[0]).sort(), SESSION_KEYS);
  assert.equal(sessions[0].startedBy, "app");
  assert.equal(sessions[0].id, box.sessionId);
  assert.deepEqual(Object.keys(sessions[0].links).sort(), ["branch", "issue", "pr"]);
  const detail = (await request(box.server, "GET", `/api/sessions/${box.launchId}`)).json.session;
  assert.equal(detail.id, box.sessionId, "a launch id opens the session it became");
  assert.deepEqual(detail.transcript.map((entry) => entry.kind), ["you", "steps", "agent"]);
  assert.equal(detail.transcript[1].steps.length, 1);
  assert.deepEqual(detail.pending, []);
  assert.equal(typeof detail.nextSince, "number");
});

test("the four ways to start each open a new pane with the right first prompt and answer {session: {id}}", async (t) => {
  const box = await startHares(t, { github: "me/my-app", actions: ["build", "ready", "ask"], limits: { concurrentRuns: 5 } });
  const starts = [
    [{ kind: "prompt", prompt: "Hello" }, ["Hello"]],
    [{ kind: "command", command: "lesti", args: "" }, ["/lesti"]],
    [{ kind: "issue", issue: 12 }, ["/wettaq #12 https://github.com/me/my-app/issues/12"]],
    [{ kind: "pr", pr: 7, ask: "failing-check" }, ["/wettaq https://github.com/me/my-app/pull/7\n\nFix its failing checks."]],
  ];
  for (const [body] of starts) {
    const answer = await request(box.server, "POST", "/api/sessions", { body: { repo: "my-app", ...body } });
    assert.equal(answer.status, 201, JSON.stringify(answer.json));
    assert.deepEqual(Object.keys(answer.json), ["session"]);
    assert.match(answer.json.session.id, /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(box.claude.starts.map((entry) => entry.args), starts.map(([, args]) => args));
  assert.ok(!box.fake.writes().some((entry) => entry.method === WRITE.paneSplit), "never a split of a pane you have open");
});

test("an answer picks the option by its number from the fresh screen, and a moved session is refused as stale with nothing sent", async (t) => {
  const box = await withSession(t);
  const pending = await block(box, "live-q-single-normal.txt", fruit);
  assert.deepEqual(Object.keys(pending).filter((key) => key !== "topic").sort(), PENDING_KEYS);
  assert.equal(pending.kind, "question");
  assert.deepEqual(pending.items[0].options.map((option) => option.label), ["Apple", "Pear"]);
  const stale = await request(box.server, "POST", `/api/sessions/${box.sessionId}/answer`, { body: { questionId: pending.id, expect: { ...pending.expect, seq: pending.expect.seq - 1 }, answers: [{ kind: "option", n: 2 }] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale");
  assert.equal(keys(box).length, 0);
  const answered = await request(box.server, "POST", `/api/sessions/${box.sessionId}/answer`, { body: { questionId: pending.id, expect: pending.expect, answers: [{ kind: "option", n: 2 }] } });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  assert.deepEqual(keys(box).map((entry) => entry.params.keys), [["2"]]);
  assert.deepEqual(Object.keys(answered.json.session).sort(), SESSION_KEYS);
});

test("a permission shows the exact call and its rule; always needs confirm and that rule, once presses the plain Yes", async (t) => {
  const box = await withSession(t);
  const pending = await block(box, "live-perm-bash.txt", bash);
  assert.equal(pending.kind, "permission");
  assert.equal(pending.permission.exact, "touch gate-bash.txt");
  assert.equal(pending.permission.verb, "run a command");
  assert.deepEqual(pending.permission.always, { text: "Bash(touch:*)", scope: "rule" });
  const decide = (body) => request(box.server, "POST", `/api/approvals/${pending.id}`, { body: { expect: pending.expect, ...body } });
  const unconfirmed = await decide({ decision: "always", rule: "Bash(touch:*)" });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.json.code, "confirm");
  assert.equal((await decide({ decision: "always", confirm: true })).status, 400, "always without the rule the person saw");
  assert.equal((await decide({ decision: "always", confirm: true, rule: "Bash(rm:*)" })).status, 409, "a different rule than the one on record");
  assert.equal(keys(box).length, 0, "nothing pressed until confirmed");
  const once = await decide({ decision: "once" });
  assert.equal(once.status, 200, JSON.stringify(once.json));
  assert.equal(keys(box).length, 1);
  const [approval] = (await request(box.server, "GET", "/api/approvals?status=allowed")).json.approvals;
  assert.equal(approval.decidedBy, "local");
});

test("raw keys use the app's names (shift-tab, ctrl-c), type the text first, and refuse a key the row doesn't offer", async (t) => {
  const box = await withSession(t);
  const session = (await request(box.server, "GET", "/api/sessions")).json.sessions[0];
  const expect = { terminalId: session.terminalId, sessionId: session.id, status: session.status, seq: session.seq };
  assert.equal((await request(box.server, "POST", `/api/sessions/${session.id}/keys`, { body: { expect, keys: ["rm"] } })).status, 400);
  const sent = await request(box.server, "POST", `/api/sessions/${session.id}/keys`, { body: { expect, text: "hi", keys: ["shift-tab", "ctrl-c"] } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.deepEqual(keys(box).map((entry) => entry.params.text ?? entry.params.keys), ["hi", ["shift+tab", "ctrl+c"]]);
});

test("notification settings round-trip per identity, and held pushes are listed until seen", async (t) => {
  const box = await startHares(t);
  const first = (await request(box.server, "GET", "/api/notifications/prefs")).json;
  assert.deepEqual(first.prefs.events, { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false });
  assert.deepEqual(first.held, []);
  const prefs = { events: { ...first.prefs.events, prReady: true }, quietHours: { enabled: true, start: "22:00", end: "06:30" } };
  const saved = await request(box.server, "PUT", "/api/notifications/prefs", { body: prefs, headers: { Origin: `http://127.0.0.1:${box.server.port}` } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json.prefs, prefs);
  box.server.store.holdNotification("asks", { v: 1, title: "my-app is asking", body: "", url: "/s/abc", identity: "local" });
  box.server.store.holdNotification("asks", { v: 1, title: "someone else's", body: "", url: "/s/def", identity: "other" });
  const held = (await request(box.server, "GET", "/api/notifications/prefs")).json.held;
  assert.deepEqual(held.map((entry) => entry.title), ["my-app is asking"], "only this identity's held pushes");
  const seen = await request(box.server, "POST", "/api/notifications/held/seen", { body: { ids: [held[0].id] } });
  assert.deepEqual(seen.json.held, []);
});

test("GitHub writes go through gh only from the web app: merge carries the confirmed head, and a review can start a session", async (t) => {
  const box = await withSession(t, { github: "me/my-app" });
  const sha = "a".repeat(40);
  const merged = await request(box.server, "POST", "/api/prs/my-app/7/merge", { body: { headSha: sha, method: "squash" } });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  assert.deepEqual(box.gh[0].input, { sha, merge_method: "squash" });
  assert.ok(box.gh[0].argv.includes("repos/me/my-app/pulls/7/merge"));
  const reviewed = await request(box.server, "POST", "/api/prs/my-app/7/review", { body: { event: "REQUEST_CHANGES", body: "Please split it", startSession: true } });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  assert.match(reviewed.json.session.id, /^[0-9a-f-]{36}$/);
  assert.match(box.claude.starts.at(-1).args[0], /pull\/7\n\nAddress the review comments/);
  assert.equal((await request(box.server, "POST", "/api/prs/my-app/7/merge", { body: { headSha: "nope", method: "squash" } })).status, 400);
  assert.equal((await request(box.server, "POST", "/api/prs/other/7/merge", { body: { headSha: sha, method: "squash" } })).status, 404);
  const audit = (await request(box.server, "GET", "/api/audit?limit=50")).json.audit;
  assert.ok(audit.some((row) => row.action === "github.merge" && row.kind === "merge"));
});
