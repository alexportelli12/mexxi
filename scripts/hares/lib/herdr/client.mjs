// The herdr socket client. herdr speaks newline-delimited JSON over a Unix socket
// (~/.config/herdr/herdr.sock, owner-only). The server answers one request per
// connection and then closes it, so every request opens its own connection; a
// subscription is the one long-lived connection.
//
// Reads go through herdrRequest, which refuses any method outside READ_METHODS.
// Anything that types into, starts or closes a pane goes through herdrWrite, and
// only guard.mjs may import it (test/herdr-static.test.mjs enforces both rules).
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** The herdr protocol this client was written and tested against (herdr 0.9.5). */
export const HERDR_PROTOCOL = 22;
export const REQUEST_TIMEOUT_MS = 3000;
/**
 * Creating and closing tabs, workspaces and panes, and starting an agent, can take
 * longer than a read: closing a workspace or a pane took over 3 s live at gate 1.
 */
export const LIFECYCLE_TIMEOUT_MS = 15_000;
// Lifecycle calls are named by their verb (create, close, start), so this module
// chooses a wait without naming a write method (test/herdr-static.test.mjs).
const LIFECYCLE_VERB = /\.(create|close|start)$/;

/** The client-side wait for one write: longer for lifecycle calls, and never shorter than herdr's own timeout_ms. */
export function writeTimeoutFor(method, params) {
  if (!LIFECYCLE_VERB.test(method)) return REQUEST_TIMEOUT_MS;
  const herdrWait = Number.isInteger(params?.timeout_ms) ? params.timeout_ms + 5_000 : 0;
  return Math.max(LIFECYCLE_TIMEOUT_MS, herdrWait);
}

/** The only methods herdrRequest sends: none of them changes a pane. */
export const READ_METHODS = new Set([
  "ping", "session.snapshot", "agent.list", "agent.get", "agent.read", "agent.explain", "pane.read", "pane.list", "workspace.list",
]);

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export function defaultSocket(home = os.homedir()) {
  return path.join(home, ".config", "herdr", "herdr.sock");
}

let nextId = 0;

/**
 * A test must never reach the real herdr: it would open real panes and start real Claude sessions
 * beside the person's own. `node --test` marks the processes it runs with NODE_TEST_CONTEXT, so there
 * the real socket is refused before anything connects, and a test that forgot its fake fails loudly.
 */
function refuseRealSocketUnderTest(socket) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (path.resolve(socket) !== path.resolve(defaultSocket())) return;
  throw new HerdrError("real_socket_in_test", "A test tried to reach the real herdr socket; give it a fake herdr (test/fake-herdr.mjs)");
}

function roundTrip(method, params, { socket = defaultSocket(), timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  try { refuseRealSocketUnderTest(socket); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const id = `hares_${process.pid}_${++nextId}`;
    const conn = net.createConnection(socket);
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new HerdrError("timeout", `herdr did not answer ${method} within ${timeoutMs} ms`)), timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`));
    conn.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(reject, new HerdrError("bad_response", `herdr sent a line that is not JSON for ${method}`)); }
        if (message?.id !== id) continue;
        if (message.error) return finish(reject, new HerdrError(String(message.error.code ?? "error"), String(message.error.message ?? "herdr refused the request")));
        return finish(resolve, message.result);
      }
    });
    conn.on("error", (error) => finish(reject, new HerdrError(error.code ?? "socket_error", `herdr socket: ${error.message}`)));
    conn.on("close", () => finish(reject, new HerdrError("closed", `herdr closed the connection before answering ${method}`)));
  });
}

/** A read-only request. Retries once when the socket refuses the connection (herdr restarting). */
export async function herdrRequest(method, params = {}, options = {}) {
  if (!READ_METHODS.has(method)) throw new HerdrError("not_read_only", `${method} is not a read; only the guard sends input`);
  try {
    return await roundTrip(method, params, options);
  } catch (error) {
    if (error.code !== "ECONNREFUSED") throw error;
    return roundTrip(method, params, options);
  }
}

/** Any request, sent once and never retried. Only guard.mjs may import this. */
export function herdrWrite(method, params, options = {}) {
  return roundTrip(method, params, { timeoutMs: writeTimeoutFor(method, params), ...options });
}

/**
 * Opens a subscription. `started` resolves on subscription_started and rejects if
 * herdr refuses or the connection drops first. Every later line goes to onLine as
 * parsed JSON (or {unparseable: text}); onClose(error|null) fires once when the
 * connection ends, unless close() ended it.
 */
export function herdrSubscribe(subscriptions, { socket = defaultSocket(), onLine, onClose, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  refuseRealSocketUnderTest(socket);
  const id = `hares_sub_${process.pid}_${++nextId}`;
  const conn = net.createConnection(socket);
  let buffer = "";
  let isStarted = false;
  let closedByUs = false;
  let ended = false;
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  started.catch(() => {});
  const timer = setTimeout(() => {
    if (!isStarted) { rejectStarted(new HerdrError("timeout", "herdr did not start the subscription")); conn.destroy(); }
  }, timeoutMs);
  const end = (error) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (!isStarted) rejectStarted(error ?? new HerdrError("closed", "herdr closed the subscription before it started"));
    if (!closedByUs) onClose?.(error ?? null);
  };
  conn.setEncoding("utf8");
  conn.on("connect", () => conn.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`));
  conn.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let message;
      try { message = JSON.parse(line); } catch { message = { unparseable: line }; }
      if (!isStarted && message?.id === id) {
        if (message.error) {
          end(new HerdrError(String(message.error.code ?? "error"), String(message.error.message ?? "herdr refused the subscription")));
          conn.destroy();
          return;
        }
        if (message.result?.type === "subscription_started") { isStarted = true; clearTimeout(timer); resolveStarted(); continue; }
      }
      if (!closedByUs) onLine?.(message);
    }
  });
  conn.on("error", (error) => end(new HerdrError(error.code ?? "socket_error", `herdr socket: ${error.message}`)));
  conn.on("close", () => end(null));
  return {
    started,
    close() { closedByUs = true; conn.destroy(); },
  };
}
