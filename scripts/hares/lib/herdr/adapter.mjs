// The herdr session adapter: a cache of every Claude pane herdr knows, kept fresh
// by one subscription, with reads (screen, explain) and the guard for anything
// that acts on a pane. This module is the only importer of guard.mjs.
//
// herdr events are invalidations, never state: any pane event schedules one
// debounced agent.list, which carries state_change_seq and the Claude session.
// A broken subscription (closed, error, events_lost, a line ħares does not
// understand) marks the cache stale and reconnects with backoff: ping (the
// protocol pin), session.snapshot, then a fresh subscription.
import { HERDR_PROTOCOL, herdrRequest, herdrSubscribe } from "./client.mjs";
import { createSubscription, PANE_EVENT_KINDS } from "./events.mjs";
import { createGuard } from "./guard.mjs";

const DEBOUNCE_MS = 150;
const BACKOFF = { minMs: 500, maxMs: 10_000 };

function toPane(agent) {
  return {
    paneId: agent.pane_id,
    terminalId: agent.terminal_id,
    workspaceId: agent.workspace_id,
    tabId: agent.tab_id,
    sessionId: agent.agent_session?.value ?? null,
    status: agent.agent_status,
    seq: agent.state_change_seq ?? 0,
    cwd: agent.foreground_cwd ?? agent.cwd ?? null,
    title: agent.terminal_title_stripped ?? null,
    name: agent.name ?? null,
    revision: agent.revision ?? 0,
  };
}

function samePane(a, b) {
  return a.terminalId === b.terminalId && a.sessionId === b.sessionId && a.status === b.status
    && a.seq === b.seq && a.revision === b.revision && a.title === b.title && a.cwd === b.cwd;
}

/**
 * agent.explain is untyped in the schema. Protocol 22 answers an object whose
 * matched_rule names the detection rule (live_blocked_form for a question or the
 * trust dialog, bash_permission_prompt for a Bash approval); older text answers
 * say "rule: <id> (region=...)". Anything else is an unknown rule, which the UI
 * shows as "look at the screen".
 */
function parseExplain(explain) {
  if (explain && typeof explain === "object" && explain.matched_rule && typeof explain.matched_rule.id === "string") {
    return { rule: explain.matched_rule.id, region: explain.matched_rule.region ?? null, state: explain.state ?? explain.matched_rule.state ?? null };
  }
  if (typeof explain === "string") {
    const rule = /rule:\s*(\S+)/.exec(explain)?.[1] ?? null;
    const region = /region=([^\s)]+)/.exec(explain)?.[1] ?? null;
    const state = /state:\s*(\S+)/.exec(explain)?.[1] ?? null;
    return { rule, region, state };
  }
  return { rule: null, region: null, state: null };
}

export function createHerdrAdapter({
  socket,
  request = herdrRequest,
  subscribe = herdrSubscribe,
  debounceMs = DEBOUNCE_MS,
  backoff = BACKOFF,
  workspaceStore,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const ask = (method, params = {}) => request(method, params, { socket });
  let panes = new Map();
  const listeners = new Set();
  const state = { connected: false, protocol: null, version: null, lastSyncAt: null, error: null, stale: true };
  let refreshTimer = null;
  let reconnectTimer = null;
  let attempt = 0;
  let closed = false;
  let connecting = null;

  const emit = (paneId) => {
    for (const listener of listeners) {
      try { listener(paneId); } catch (error) { log(`herdr listener failed: ${error.message}`); }
    }
  };

  const subscription = createSubscription({
    socket,
    subscribe,
    onEvent({ kind }) {
      if (PANE_EVENT_KINDS.has(kind)) scheduleRefresh();
    },
    onBroken(reason) {
      if (closed) return;
      log(`herdr subscription broke (${reason}); resyncing`);
      markStale(reason);
    },
  });

  function markStale(reason) {
    state.connected = false;
    state.stale = true;
    // A protocol mismatch stays the reported error; it matters more than the resync.
    if (state.protocol === HERDR_PROTOCOL) state.error = `resyncing: ${reason}`;
    emit(null);
    scheduleReconnect();
  }

  function applyAgents(agents) {
    const next = new Map();
    for (const agent of agents ?? []) if (agent.agent === "claude") next.set(agent.pane_id, toPane(agent));
    const changed = [];
    for (const [paneId, pane] of next) if (!panes.has(paneId) || !samePane(panes.get(paneId), pane)) changed.push(paneId);
    for (const paneId of panes.keys()) if (!next.has(paneId)) changed.push(paneId);
    panes = next;
    return changed;
  }

  function scheduleRefresh() {
    if (closed) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refresh().catch(() => {}); }, debounceMs);
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {});
    }, delay);
  }

  async function doConnect() {
    try {
      const pong = await ask("ping");
      state.protocol = pong?.protocol ?? null;
      state.version = pong?.version ?? null;
      const { snapshot } = await ask("session.snapshot");
      const changed = applyAgents(snapshot?.agents);
      subscription.reset();
      await subscription.update([...panes.keys()]);
      state.connected = true;
      state.stale = false;
      state.lastSyncAt = now();
      // The pin: a different protocol keeps reads working, and the guard refuses every send.
      state.error = state.protocol === HERDR_PROTOCOL ? null : `herdr protocol ${state.protocol}, ħares speaks ${HERDR_PROTOCOL}`;
      attempt = 0;
      for (const paneId of changed) emit(paneId);
      emit(null);
    } catch (error) {
      state.connected = false;
      state.stale = true;
      state.error = error.message;
      emit(null);
      scheduleReconnect();
    }
    return { ...state };
  }

  /** Connects (or resyncs). Never throws: a failure shows in status() and retries with backoff. */
  function connect() {
    if (closed) return Promise.resolve({ ...state });
    connecting ??= doConnect().finally(() => { connecting = null; });
    return connecting;
  }

  /** Re-reads agent.list, follows the pane set with the subscription and reports what changed. */
  async function refresh() {
    let agents;
    try {
      ({ agents } = await ask("agent.list"));
    } catch (error) {
      markStale(`agent.list failed: ${error.message}`);
      throw error;
    }
    const changed = applyAgents(agents);
    state.lastSyncAt = now();
    if (state.connected) {
      try {
        await subscription.update([...panes.keys()]);
      } catch (error) {
        markStale(`resubscribe failed: ${error.message}`);
      }
    }
    for (const paneId of changed) emit(paneId);
    return [...panes.values()];
  }

  return {
    connect,
    refresh,
    status: () => ({ ...state }),
    panes: () => [...panes.values()],
    pane: (paneId) => panes.get(paneId) ?? null,
    /** fn(paneId) when one pane changed, fn(null) when the whole picture may have (resync). Returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async read(paneId, source = "detection", lines) {
      const result = await ask("pane.read", { pane_id: paneId, source, ...(lines ? { lines } : {}) });
      return result?.read ?? null;
    },
    async explain(paneId) {
      const result = await ask("agent.explain", { target: paneId });
      return parseExplain(result?.explain);
    },
    guard: createGuard({ socket, request, workspaceStore }),
    close() {
      closed = true;
      clearTimeout(refreshTimer);
      clearTimeout(reconnectTimer);
      subscription.close();
      listeners.clear();
    },
  };
}
