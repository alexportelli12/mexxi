// A fake herdr server for tests: newline-delimited JSON on a Unix socket in a
// temp dir, answering one request per connection like the real server, and
// keeping events.subscribe connections open so a test can push events, drop
// them or send garbage. It records every request, so a test can see exactly
// what would have reached a pane.
//
// This file and lib/herdr/guard.mjs are the only ones allowed to name herdr's
// write methods (test/herdr-static.test.mjs); tests refer to them through WRITE.
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** herdr methods that type into, start, split or close something. */
export const WRITE = {
  paneSendKeys: "pane.send_keys",
  paneSendText: "pane.send_text",
  paneSendInput: "pane.send_input",
  paneClose: "pane.close",
  paneSplit: "pane.split",
  agentSendKeys: "agent.send_keys",
  agentPrompt: "agent.prompt",
  agentStart: "agent.start",
  tabCreate: "tab.create",
  workspaceCreate: "workspace.create",
  workspaceClose: "workspace.close",
};
export const WRITE_METHODS = new Set(Object.values(WRITE));

/** Polls check() until it returns a truthy value; fails with `what` after timeoutMs. */
export async function waitFor(check, { timeoutMs = 5000, intervalMs = 10, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** An agent.list entry for a Claude pane, as herdr 0.9.5 reports one. */
export function claudeAgent({ paneId = "wT:p1", terminalId = "term_test_1", sessionId = "11111111-1111-4111-8111-111111111111", status = "idle", seq = 100, cwd = "/tmp/hares-fake/repo", workspaceId = "wT", title = "Test session" } = {}) {
  return {
    terminal_id: terminalId, agent: "claude", terminal_title_stripped: title, agent_status: status,
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: sessionId },
    workspace_id: workspaceId, tab_id: `${workspaceId}:t1`, pane_id: paneId, focused: false,
    state_change_seq: seq, cwd, foreground_cwd: cwd, revision: 1,
  };
}

export async function startFakeHerdr(t, { protocol = 22, agents = [], screens = {}, explains = {}, workspaces = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hares-herdr-"));
  const socket = path.join(dir, "herdr.sock");
  const state = { protocol, agents, screens, explains, workspaces, nextId: 1, failures: new Map(), afterRead: new Map() };
  const requests = [];
  const timeline = [];
  const subscriptions = [];
  const connections = new Set();

  const reply = (conn, id, result) => conn.write(`${JSON.stringify({ id, result })}\n`);
  const fail = (conn, id, code, message) => conn.write(`${JSON.stringify({ id, error: { code, message } })}\n`);

  function answer(method, params) {
    switch (method) {
      case "ping": return { type: "pong", version: "0.9.5", protocol: state.protocol };
      case "agent.list": return { type: "agent_list", agents: structuredClone(state.agents) };
      case "session.snapshot":
        return { type: "session_snapshot", snapshot: { version: "0.9.5", protocol: state.protocol, workspaces: structuredClone(state.workspaces), tabs: [], panes: [], layouts: [], agents: structuredClone(state.agents) } };
      case "pane.read": {
        const agent = state.agents.find((candidate) => candidate.pane_id === params.pane_id);
        return { type: "pane_read", read: { pane_id: params.pane_id, workspace_id: agent?.workspace_id ?? "wT", tab_id: agent?.tab_id ?? "wT:t1", source: params.source, format: "text", text: state.screens[params.pane_id] ?? "", revision: 0, truncated: false } };
      }
      case "agent.explain": return { type: "agent_explain", explain: state.explains[params.target] ?? {} };
      case WRITE.paneSendKeys: case WRITE.paneSendText: case WRITE.agentSendKeys: case WRITE.workspaceClose: return { type: "ok" };
      case WRITE.paneClose:
        state.agents = state.agents.filter((agent) => agent.pane_id !== params.pane_id);
        return { type: "ok" };
      case WRITE.agentPrompt: return { type: "agent_prompted", agent: state.agents.find((agent) => agent.pane_id === params.target) ?? {} };
      case WRITE.workspaceCreate: {
        const workspaceId = `wH${100 + state.nextId++}`;
        const workspace = { workspace_id: workspaceId, label: params.label ?? "", number: 9, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${workspaceId}:t1`, agent_status: "unknown" };
        state.workspaces.push(workspace);
        return { type: "workspace_created", workspace, tab: { tab_id: `${workspaceId}:t1`, workspace_id: workspaceId }, root_pane: { pane_id: `${workspaceId}:p1`, workspace_id: workspaceId } };
      }
      case WRITE.tabCreate: {
        const tabId = `${params.workspace_id}:t${state.nextId++}`;
        return { type: "tab_created", tab: { tab_id: tabId, workspace_id: params.workspace_id }, root_pane: { pane_id: `${params.workspace_id}:p${state.nextId++}`, workspace_id: params.workspace_id } };
      }
      case WRITE.agentStart:
        return { type: "agent_started", agent: { name: params.name, pane_id: params.pane_id, agent_status: "unknown", launch_pending: true }, argv: ["claude", ...(params.args ?? [])] };
      default: return undefined;
    }
  }

  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.on("close", () => connections.delete(conn));
    conn.on("error", () => {});
    conn.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0 || handled) return;
      handled = true;
      const message = JSON.parse(buffer.slice(0, newline));
      const { id, method, params = {} } = message;
      requests.push({ method, params });
      timeline.push(`request ${method}`);
      if (method === "events.subscribe") {
        const entry = { index: subscriptions.length, subscriptions: params.subscriptions, open: true, conn };
        subscriptions.push(entry);
        conn.on("close", () => { entry.open = false; timeline.push(`subscription ${entry.index} closed`); });
        if (state.failures.has(method)) { const { code, message: text } = state.failures.get(method); state.failures.delete(method); fail(conn, id, code, text); conn.end(); return; }
        reply(conn, id, { type: "subscription_started" });
        timeline.push(`subscription ${entry.index} started`);
        return;
      }
      if (state.failures.has(method)) {
        const { code, message: text } = state.failures.get(method);
        state.failures.delete(method);
        fail(conn, id, code, text);
      } else {
        const result = answer(method, params);
        if (result === undefined) fail(conn, id, "unknown_method", `unknown method ${method}`);
        else reply(conn, id, result);
      }
      conn.end();
      // Lets a test change the world right after a read, as a pane would between two calls.
      const after = state.afterRead.get(method);
      if (after) { state.afterRead.delete(method); after(state); }
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));

  const fake = {
    socket,
    state,
    requests,
    timeline,
    subscriptions,
    /** Requests that would have changed a pane, in order. */
    writes: () => requests.filter((entry) => WRITE_METHODS.has(entry.method)),
    openSubscriptions: () => subscriptions.filter((entry) => entry.open),
    /** Push one line to every open subscription. */
    emit(line) {
      const text = typeof line === "string" ? line : JSON.stringify(line);
      for (const entry of subscriptions) if (entry.open) entry.conn.write(`${text}\n`);
    },
    /** Drop every open subscription, as herdr does to a slow subscriber or on restart. */
    dropSubscriptions() {
      for (const entry of subscriptions) if (entry.open) entry.conn.destroy();
    },
    /** The next request for this method answers {error: {code, message}}. */
    failNext(method, code, message = code) { state.failures.set(method, { code, message }); },
    /** Run fn(state) once, right after the next answer to this method. */
    afterNext(method, fn) { state.afterRead.set(method, fn); },
    async close() {
      for (const conn of connections) conn.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
  t.after(() => fake.close());
  return fake;
}
