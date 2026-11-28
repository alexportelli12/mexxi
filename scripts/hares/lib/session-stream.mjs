// The web app's live stream (GET /api/stream): server-sent events that name
// what changed, so the app refetches it (core/api.ts "Live"). Events come from
// the session service: session (a status, title or link changed), question (a
// question or permission arrived or went), transcript (the session moved on).
// Nothing in an event is content: ids and a time only. A client that comes back
// with a Last-Event-ID this process never issued gets one reset and reloads.
const EVENT_MAP = {
  "session.changed": ["session", ({ id }) => ({ sessionId: id })],
  "session.finished": ["session", ({ id }) => ({ sessionId: id })],
  "question.added": ["question", ({ sessionId, recordId }) => ({ sessionId, id: recordId })],
  "question.cleared": ["question", ({ sessionId, recordId }) => ({ sessionId, id: recordId })],
};
const REPLAY_CAP = 200;

export function createSessionStream({ sessions, heartbeatMs = 20_000, now = () => new Date() }) {
  const clients = new Set();
  const recent = [];
  let nextId = 1;
  const format = ({ id, name, data }) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  function publish(name, data) {
    const message = { id: nextId++, name, data: { ...data, at: now().toISOString() } };
    recent.push(message);
    if (recent.length > REPLAY_CAP) recent.shift();
    const text = format(message);
    clients.forEach((res) => res.write(text));
  }

  const detach = Object.entries(EVENT_MAP).map(([event, [name, shape]]) => sessions.on(event, (payload) => {
    if (payload?.initial) return;
    publish(name, shape(payload));
    if (event === "session.changed") publish("transcript", { sessionId: payload.id, seq: null });
  }));
  const timer = setInterval(() => clients.forEach((res) => res.write(": heartbeat\n\n")), heartbeatMs);
  timer.unref();

  return {
    publish,
    handle(req, res) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": connected\n\n");
      const last = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
      if (Number.isInteger(last) && last >= 0) {
        const missed = recent.filter((message) => message.id > last);
        // An id this process never issued (a restart), or a gap the replay buffer no longer covers, resets the client.
        const issued = last <= nextId - 1;
        if (!issued || (missed.length && missed[0].id !== last + 1)) res.write(format({ id: nextId - 1, name: "reset", data: {} }));
        else missed.forEach((message) => res.write(format(message)));
      }
      clients.add(res);
      res.on("close", () => clients.delete(res));
    },
    close() {
      clearInterval(timer);
      detach.forEach((off) => off());
      clients.forEach((res) => res.end());
      clients.clear();
    },
  };
}
