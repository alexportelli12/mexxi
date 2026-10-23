// One server-sent-events stream for every run. Message ids are the events
// table's ids, so a client that reconnects with Last-Event-ID is replayed what
// it missed (up to 1000 events) before going live.
const REPLAY_CAP = 1000;

function format({ id, name, data }) {
  return `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The SSE message for a stored event row. Status rows are `run` messages, the rest `event`. */
export function messageFor(row, step = null) {
  if (row.kind === "status") return { id: row.id, name: "run", data: { runId: row.runId, at: row.at, ...row.data } };
  return { id: row.id, name: "event", data: { runId: row.runId, seq: row.seq, at: row.at, kind: row.kind, data: row.data, step } };
}

export function createBroker({ store, heartbeatMs = 20_000 }) {
  const clients = new Set();
  const timer = setInterval(() => clients.forEach((res) => res.write(": heartbeat\n\n")), heartbeatMs);
  timer.unref();
  return {
    publish(row, step) {
      const message = format(messageFor(row, step));
      clients.forEach((res) => res.write(message));
    },
    handle(req, res) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const last = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
      res.write(": connected\n\n");
      // Replay and subscription happen in one synchronous step, so nothing is missed or doubled.
      if (Number.isInteger(last) && last >= 0) store.eventsAfter(last, REPLAY_CAP).forEach((row) => res.write(format(messageFor(row))));
      clients.add(res);
      res.on("close", () => clients.delete(res));
    },
    close() {
      clearInterval(timer);
      clients.forEach((res) => res.end());
      clients.clear();
    },
  };
}
