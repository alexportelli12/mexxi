// The adapter keeps ħares's picture of herdr's Claude panes fresh. Events are
// invalidations: each test changes the fake's state first, then shows that the
// event (or the resync) is what made the adapter see the change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHerdrAdapter } from "../lib/herdr/adapter.mjs";
import { claudeAgent, startFakeHerdr, waitFor } from "./fake-herdr.mjs";

const FAST = { debounceMs: 5, backoff: { minMs: 5, maxMs: 20 } };

async function connected(t, agents = [claudeAgent({ paneId: "wT:p1", status: "idle", seq: 1 })], options = {}) {
  const fake = await startFakeHerdr(t, { agents, ...options });
  const adapter = createHerdrAdapter({ socket: fake.socket, ...FAST });
  t.after(() => adapter.close());
  await adapter.connect();
  return { fake, adapter };
}

const statusOf = (adapter, paneId = "wT:p1") => adapter.pane(paneId)?.status;

for (const [spelling, line] of [
  ["the dot spelling of a live subscription", { event: "pane.agent_status_changed", data: { pane_id: "wT:p1", workspace_id: "wT", agent_status: "blocked", agent: "claude" } }],
  ["the underscore spelling", { event: "pane_agent_status_changed", data: { type: "pane_agent_status_changed", pane_id: "wT:p1", workspace_id: "wT", agent_status: "blocked" } }],
  ["a kind named only in data.type", { data: { type: "pane.agent_status_changed", pane_id: "wT:p1", workspace_id: "wT", agent_status: "blocked" } }],
]) {
  test(`sees a pane become blocked from ${spelling}`, async (t) => {
    const { fake, adapter } = await connected(t);
    fake.state.agents[0].agent_status = "blocked";
    fake.state.agents[0].state_change_seq = 2;
    const changes = [];
    adapter.onChange((paneId) => changes.push(paneId));
    fake.emit(line);
    await waitFor(() => statusOf(adapter) === "blocked", { what: "the blocked status" });
    assert.equal(adapter.pane("wT:p1").seq, 2);
    assert.ok(changes.includes("wT:p1"));
    // Understood as an event, not mistaken for an unknown line that forces a resync.
    assert.equal(fake.requests.filter((entry) => entry.method === "session.snapshot").length, 1);
  });
}

test("treats an event as an invalidation and keeps agent.list's status, not the event's", async (t) => {
  const { fake, adapter } = await connected(t);
  fake.emit({ event: "pane.agent_status_changed", data: { pane_id: "wT:p1", workspace_id: "wT", agent_status: "blocked" } });
  const before = fake.requests.filter((entry) => entry.method === "agent.list").length;
  await waitFor(() => fake.requests.filter((entry) => entry.method === "agent.list").length > before, { what: "a refresh" });
  assert.equal(statusOf(adapter), "idle");
});

test("resyncs from session.snapshot after herdr drops the subscription", async (t) => {
  const { fake, adapter } = await connected(t);
  fake.state.agents.push(claudeAgent({ paneId: "wT:p2", terminalId: "term_2", sessionId: "44444444-4444-4444-8444-444444444444" }));
  const snapshots = () => fake.requests.filter((entry) => entry.method === "session.snapshot").length;
  assert.equal(snapshots(), 1);
  fake.dropSubscriptions();
  await waitFor(() => adapter.pane("wT:p2"), { what: "the pane added while disconnected" });
  assert.equal(snapshots(), 2);
  await waitFor(() => adapter.status().connected && fake.openSubscriptions().length === 1, { what: "a fresh subscription" });
});

test("resyncs after herdr says events were lost", async (t) => {
  const { fake, adapter } = await connected(t);
  fake.state.agents[0].agent_status = "done";
  fake.emit({ event: "events_lost", data: { type: "events_lost" } });
  await waitFor(() => statusOf(adapter) === "done", { what: "the resync" });
  assert.equal(fake.requests.filter((entry) => entry.method === "session.snapshot").length, 2);
});

test("resyncs after a line it cannot read rather than guessing", async (t) => {
  const { fake, adapter } = await connected(t);
  fake.state.agents[0].agent_status = "working";
  fake.emit("this is not json");
  await waitFor(() => statusOf(adapter) === "working", { what: "the resync" });
  assert.equal(fake.requests.filter((entry) => entry.method === "session.snapshot").length, 2);
});

test("subscribes to a new pane's status before closing the old subscription", async (t) => {
  const { fake, adapter } = await connected(t);
  assert.deepEqual(fake.subscriptions[0].subscriptions.filter((entry) => entry.pane_id).map((entry) => entry.pane_id), ["wT:p1"]);
  fake.state.agents.push(claudeAgent({ paneId: "wT:p2", terminalId: "term_2", sessionId: "44444444-4444-4444-8444-444444444444" }));
  fake.emit({ event: "pane_created", data: { type: "pane_created", pane: { pane_id: "wT:p2" } } });
  await waitFor(() => fake.subscriptions.length === 2 && !fake.subscriptions[0].open, { what: "the new subscription to replace the old" });
  assert.deepEqual(fake.subscriptions[1].subscriptions.filter((entry) => entry.pane_id).map((entry) => entry.pane_id), ["wT:p1", "wT:p2"]);
  assert.ok(fake.timeline.indexOf("subscription 1 started") < fake.timeline.indexOf("subscription 0 closed"), "the old subscription closed before the new one started");
  assert.ok(adapter.pane("wT:p2"));
});

test("keeps reading but reports the error when herdr speaks another protocol", async (t) => {
  const { adapter } = await connected(t, undefined, { protocol: 23, screens: { "wT:p1": "hello" } });
  assert.equal(adapter.status().protocol, 23);
  assert.match(adapter.status().error, /protocol 23/);
  assert.equal(adapter.panes().length, 1);
  assert.equal((await adapter.read("wT:p1", "visible")).text, "hello");
});

test("reports herdr as unreachable and connects once it answers", async (t) => {
  const fake = await startFakeHerdr(t, { agents: [claudeAgent({ paneId: "wT:p1" })] });
  fake.failNext("ping", "starting", "server starting");
  const adapter = createHerdrAdapter({ socket: fake.socket, ...FAST });
  t.after(() => adapter.close());
  const first = await adapter.connect();
  assert.equal(first.connected, false);
  await waitFor(() => adapter.status().connected, { what: "the retry" });
  assert.equal(adapter.panes().length, 1);
});

test("names the detection rule from a real agent.explain answer, and none from an unknown shape", async (t) => {
  const explain = JSON.parse(readFileSync(new URL("./fixtures/herdr/explain-working.live-redacted.json", import.meta.url), "utf8"));
  const { fake, adapter } = await connected(t, undefined, { explains: { "wT:p1": explain } });
  assert.deepEqual(await adapter.explain("wT:p1"), { rule: "osc_title_working", region: "osc_title", state: "working" });
  fake.state.explains["wT:p1"] = { something: "else" };
  assert.equal((await adapter.explain("wT:p1")).rule, null);
});
