// The MCP guardrails (plan §7.3, brief "MCP correction" 2): an MCP client can
// never decide a permission or add an always-allow rule, merge, submit a review,
// accept a gate change, or edit repositories or limits, and segwi's eight tools
// still answer in their old shape. Each test names the break it catches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeRecord } from "../lib/pending.mjs";
import { WRITE } from "./fake-herdr.mjs";
import { startHares, waitFor } from "./helpers.mjs";

const OLD_SNAPSHOT = JSON.parse(readFileSync(new URL("./fixtures/mcp-tools-1.3.0.json", import.meta.url), "utf8"));
// The code alone: the module's comments name what it must never import, and may.
const MCP_SOURCE = readFileSync(new URL("../lib/mcp.mjs", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const screen = (name) => readFileSync(new URL(`./fixtures/herdr/screens/${name}`, import.meta.url), "utf8");
const HAND_STARTED = "66666666-6666-4666-8666-666666666666";
const KEY_METHODS = new Set([WRITE.paneSendKeys, WRITE.paneSendText, WRITE.agentSendKeys, WRITE.agentPrompt, WRITE.paneClose]);
// Words for what MCP must never do, in a tool's name or any input field.
// ("limit" alone is list_runs' page size, and "repo" a filter: both are reads.)
const FORBIDDEN = /approve|decide|decision|allow|deny|always|rule|confirm(?!Token)|merge|review|accept|gate|limits|repositories|setting|rotate/i;

async function connect(t, server, token) {
  const client = new Client({ name: "hares-guardrails", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return client;
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const plain = (result) => JSON.parse(result.content[0].text);
const body = (result) => JSON.parse(/<untrusted source="[^"]+">\n([\s\S]*)\n<\/untrusted>$/.exec(result.content[1].text)[1]);
const keysSent = (box) => box.fake.writes().filter((entry) => KEY_METHODS.has(entry.method));

/** Starts a session over MCP and waits for its pane; returns its ids. */
async function launch(box, client) {
  const { id } = plain(await call(client, "start_run", { repo: "my-app", action: "build", task: "Do it" }));
  const sessionId = await waitFor(async () => {
    await box.server.adapter.refresh();
    await box.server.sessions.sync();
    return box.claude.starts[0]?.sessionId;
  }, { what: "the pane" });
  return { id, sessionId, paneId: box.fake.state.agents.find((agent) => agent.agent_session.value === sessionId).pane_id };
}

/** Puts a session's pane on a prompt, as herdr and the hook would report it. */
async function block(box, { sessionId, paneId }, screenName, record = null) {
  const agent = box.fake.state.agents.find((candidate) => candidate.pane_id === paneId);
  Object.assign(agent, { agent_status: "blocked", state_change_seq: agent.state_change_seq + 1 });
  box.fake.state.screens[paneId] = screen(screenName);
  if (record) writeRecord({ v: 1, at: new Date().toISOString(), sessionId, paneId, toolUseId: null, suggestions: null, ...record }, box.pendingOptions);
  await box.server.adapter.refresh();
  await box.server.sessions.sync();
}

const fruit = { kind: "question", event: "PreToolUse", toolUseId: "toolu_f1", toolName: "AskUserQuestion", recordId: "question_toolu_f1",
  input: { questions: [{ header: "Fruit", question: "Which fruit for the gate?", multiSelect: false, options: [{ label: "Apple", description: "" }, { label: "Pear", description: "" }] }] } };
const bash = { kind: "permission", event: "PermissionRequest", toolName: "Bash", input: { command: "touch gate-bash.txt" }, inputHash: "hb", recordId: "permission_hb",
  suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "touch:*" }], behavior: "allow", destination: "localSettings" }] };

test("no tool name or input field can decide a permission, add a rule, merge, review, accept a gate change or edit repos or limits", async (t) => {
  const box = await startHares(t);
  const client = await connect(t, box.server, box.token);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  for (const tool of tools) {
    assert.ok(!FORBIDDEN.test(tool.name), tool.name);
    const fields = Object.keys(tool.inputSchema.properties ?? {});
    for (const field of fields) assert.ok(!FORBIDDEN.test(field), `${tool.name}.${field}`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} takes no field it doesn't list`);
  }
});

test("segwi's tools keep their names, descriptions and input schemas; start_run only adds optional fields and actions", async (t) => {
  const box = await startHares(t);
  const client = await connect(t, box.server, box.token);
  const now = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  for (const old of OLD_SNAPSHOT) {
    assert.ok(now[old.name], `${old.name} still exists`);
    if (old.name === "start_run") continue;
    assert.deepEqual({ name: now[old.name].name, description: now[old.name].description, inputSchema: now[old.name].inputSchema }, old, `${old.name} unchanged`);
  }
  const before = OLD_SNAPSHOT.find((tool) => tool.name === "start_run").inputSchema;
  const after = now.start_run.inputSchema;
  for (const [field, schema] of Object.entries(before.properties)) {
    if (field === "action") for (const value of schema.enum) assert.ok(after.properties.action.enum.includes(value), `action ${value} kept`);
    else if (field !== "task") assert.deepEqual(after.properties[field], schema, `start_run.${field} unchanged`);
  }
  assert.deepEqual(after.properties.task.type, before.properties.task.type);
  for (const required of after.required) assert.ok(before.required.includes(required), `start_run requires nothing new (${required})`);
});

test("mcp.mjs never imports the GitHub writer or calls a decide, accept, merge or review", () => {
  assert.doesNotMatch(MCP_SOURCE, /github-write|createGithubWriter|runGh/);
  assert.doesNotMatch(MCP_SOURCE, /\.decide\(|decideApproval|\.accept\(|acceptGateChange|acceptPrGateChange/);
  assert.doesNotMatch(MCP_SOURCE, /\.merge\(|submitReview|replyToThread|rerunFailedJobs|\.comment\(/);
  assert.doesNotMatch(MCP_SOURCE, /saveNotificationPrefs|savePrefs|rotate\(/);
});

test("send_input on a permission prompt is refused as a person's, and no key reaches the pane", async (t) => {
  const box = await startHares(t);
  const client = await connect(t, box.server, box.token);
  const session = await launch(box, client);
  await block(box, session, "live-perm-bash.txt", bash);
  const before = keysSent(box).length;
  for (const text of ["1", "Yes", "Yes, and don't ask again for touch commands in this project"]) {
    const result = await call(client, "send_input", { id: session.id, text });
    assert.equal(result.isError, true, text);
    assert.match(result.content[0].text, /needs_approval\. Only a person in the web app can answer it/);
  }
  assert.equal(keysSent(box).length, before, "nothing typed into the prompt");
  const approvals = body(await call(client, "list_approvals", {})).approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending", "still waiting for the person");
});

test("send_input on a plan or folder-trust prompt is refused too", async (t) => {
  for (const name of ["live-plan-approval.txt", "live-trust-real.txt"]) {
    const box = await startHares(t);
    const client = await connect(t, box.server, box.token);
    const session = await launch(box, client);
    await block(box, session, name);
    const result = await call(client, "send_input", { id: session.id, text: "1" });
    assert.equal(result.isError, true, name);
    assert.equal(keysSent(box).length, 0, name);
  }
});

test("send_input answers a waiting question by its number, so the refusal above is about permissions, not prompts", async (t) => {
  const box = await startHares(t);
  const client = await connect(t, box.server, box.token);
  const session = await launch(box, client);
  await block(box, session, "live-q-single-normal.txt", fruit);
  const result = await call(client, "send_input", { id: session.id, text: "2" });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.deepEqual(keysSent(box).map((entry) => entry.params.keys ?? entry.params.text), [["2"]], "the digit for Pear, from the fresh screen");
});

test("list_approvals lists a pending permission in its old shape, and no field added to it decides anything", async (t) => {
  const box = await startHares(t);
  const client = await connect(t, box.server, box.token);
  const session = await launch(box, client);
  await block(box, session, "live-perm-bash.txt", bash);
  const [approval] = body(await call(client, "list_approvals", {})).approvals;
  assert.deepEqual(Object.keys(approval).sort(), ["content", "createdAt", "cwd", "decidedAt", "decidedBy", "exact", "expiresAt", "id", "repo", "risk", "riskLabel", "runId", "status", "tool", "why"]);
  assert.equal(approval.exact, "touch gate-bash.txt");
  for (const args of [{ status: "pending", decision: "allow" }, { id: approval.id, decision: "once" }, { status: "pending", rule: "Bash(touch:*)", confirm: true }]) {
    assert.equal((await call(client, "list_approvals", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(body(await call(client, "list_approvals", {})).approvals[0].status, "pending");
  assert.equal(keysSent(box).length, 0);
});

test("send_input and stop_run reach only sessions ħares started (D3); a session started by hand is the web app's", async (t) => {
  const box = await startHares(t, { agents: [{ terminal_id: "term_hand", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: HAND_STARTED }, workspace_id: "wU", tab_id: "wU:t1", pane_id: "wU:p1", state_change_seq: 5, cwd: "/tmp/hares-fake/repo", foreground_cwd: "/tmp/hares-fake/repo", revision: 1 }] });
  const client = await connect(t, box.server, box.token);
  await box.server.sessions.sync();
  const steer = await call(client, "send_input", { id: HAND_STARTED, text: "hello" });
  assert.equal(steer.isError, true);
  assert.match(steer.content[0].text, /only sessions ħares started/);
  const { confirmToken } = plain(await call(client, "stop_run", { id: HAND_STARTED }));
  const stop = await call(client, "stop_run", { id: HAND_STARTED, confirmToken });
  assert.equal(stop.isError, true);
  assert.equal(keysSent(box).length, 0, "the hand-started pane was neither typed into nor closed");
});

// Break caught: a web route accepts the MCP bearer token in place of a signed-in person, so an MCP client could
// decide a permission, merge, review, accept a gate change or change settings. The requests are otherwise valid
// (loopback Host, same Origin, JSON), so only the missing identity can refuse them.
test("no MCP call reaches a web-only route: the bearer token alone is no identity, so decisions, GitHub writes and settings answer 401", async (t) => {
  const box = await startHares(t, { auth: { mode: "tailscale-header", allowed: ["you@example.com"] } });
  const auth = { Authorization: `Bearer ${box.token}` };
  const { request } = await import("./helpers.mjs");
  const origin = { Origin: `http://127.0.0.1:${box.server.port}` };
  const routes = [
    ["POST", "/api/approvals/abc", { decision: "once" }],
    ["POST", "/api/prs/my-app/1/merge", { headSha: "a".repeat(40), method: "squash" }],
    ["POST", "/api/prs/my-app/1/review", { event: "APPROVE", body: "" }],
    ["POST", "/api/prs/my-app/1/accept-gate", { headSha: "a".repeat(40) }],
    ["PUT", "/api/notifications/prefs", {}],
  ];
  for (const [method, route, payload] of routes) {
    const answer = await request(box.server, method, route, { headers: { ...auth, ...origin }, body: payload, origin: false });
    assert.equal(answer.status, 401, `${method} ${route}`);
    assert.match(answer.json.error ?? answer.text, /Tailscale-User-Login header is missing/, `${method} ${route}`);
  }
  // The same request with a person's identity gets past the identity check (what it then does is not this test's).
  const signedIn = await request(box.server, "POST", "/api/approvals/abc", { headers: { ...origin, "Tailscale-User-Login": "you@example.com" }, body: { decision: "once" }, origin: false });
  assert.notEqual(signedIn.status, 401);
  assert.notEqual(signedIn.status, 403);
});
