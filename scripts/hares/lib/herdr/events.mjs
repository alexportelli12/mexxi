// herdr events, read as invalidations. herdr spells event names two ways: a live
// subscription sends "pane.agent_status_changed" with a dot, the other events and
// events.wait use underscores ("pane_agent_detected"), and some lines carry the
// name only in data.type. Everything is normalised to the underscore form.
//
// The subscription set has to grow and shrink with the panes, because herdr
// requires a pane_id on pane.agent_status_changed. A change opens the new
// subscription first and closes the old one only once the new one has started
// ("make before break"), so no event falls in a gap.
import { herdrSubscribe } from "./client.mjs";

/** Every event kind in the protocol 22 schema. Anything else means ħares no longer understands herdr: resync. */
export const KNOWN_EVENT_KINDS = new Set([
  "workspace_created", "workspace_updated", "workspace_metadata_updated", "workspace_closed", "workspace_renamed",
  "workspace_moved", "workspace_reordered", "workspace_focused", "worktree_created", "worktree_opened", "worktree_removed",
  "tab_created", "tab_closed", "tab_renamed", "tab_moved", "tab_focused", "pane_created", "pane_closed", "pane_updated",
  "pane_focused", "pane_moved", "pane_output_changed", "pane_exited", "pane_agent_detected", "pane_agent_status_changed",
  "layout_updated",
]);

/** The kinds that can change which Claude panes exist or what state they are in. */
export const PANE_EVENT_KINDS = new Set([
  "pane_created", "pane_closed", "pane_updated", "pane_exited", "pane_moved", "pane_agent_detected", "pane_agent_status_changed",
]);

const BASE_SUBSCRIPTIONS = ["pane.created", "pane.closed", "pane.updated", "pane.exited", "pane.moved", "pane.agent_detected"];

/** The subscription set for these Claude panes: the pane-wide events plus one status subscription per pane. */
export function buildSubscriptions(paneIds) {
  const ids = [...new Set(paneIds)].sort();
  return [
    ...BASE_SUBSCRIPTIONS.map((type) => ({ type })),
    ...ids.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
  ];
}

export function normalizeKind(name) {
  return typeof name === "string" ? name.replace(/\./g, "_") : "";
}

/**
 * What one line from a subscription means:
 * {type:"event", kind, data} | {type:"lost"} | {type:"error", error} | {type:"unknown", line}.
 * Accepts a bare envelope {event, data}, an events.wait answer {result:{type:"wait_matched", event}},
 * and an envelope that names the kind only in data.type.
 */
export function classifyLine(line) {
  if (!line || typeof line !== "object" || "unparseable" in line) return { type: "unknown", line };
  if (line.error) {
    if (line.error.code === "events_lost") return { type: "lost" };
    return { type: "error", error: line.error };
  }
  const envelope = line.result?.type === "wait_matched" ? line.result.event : line;
  const kind = normalizeKind(envelope?.event ?? envelope?.data?.type ?? envelope?.type);
  if (kind === "events_lost") return { type: "lost" };
  if (KNOWN_EVENT_KINDS.has(kind)) return { type: "event", kind, data: envelope?.data ?? {} };
  return { type: "unknown", line };
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Keeps one live subscription whose pane set follows update(paneIds).
 * onEvent({kind, data}) gets each understood event; onBroken(reason) fires once per
 * broken subscription (close, error, events_lost, an unparseable or unknown line),
 * after which the caller resyncs and calls update() again.
 */
export function createSubscription({ socket, onEvent, onBroken, subscribe = herdrSubscribe }) {
  let current = null; // { ids, handle }
  let pending = Promise.resolve();
  let closed = false;

  function open(ids) {
    let broken = false;
    const holder = { ids, handle: null };
    const breakWith = (reason) => {
      if (broken || closed) return;
      if (current !== holder) { holder.deadReason = reason; return; }
      broken = true;
      current = null;
      holder.handle?.close();
      onBroken?.(reason);
    };
    holder.handle = subscribe(buildSubscriptions(ids), {
      socket,
      onLine(line) {
        const meaning = classifyLine(line);
        if (meaning.type === "event") onEvent?.({ kind: meaning.kind, data: meaning.data });
        else breakWith(meaning.type === "lost" ? "events_lost" : meaning.type === "error" ? `error: ${meaning.error.code}` : "unknown line");
      },
      onClose(error) { breakWith(error ? `closed: ${error.code ?? error.message}` : "closed"); },
    });
    return holder;
  }

  async function swap(paneIds) {
    const ids = [...new Set(paneIds)].sort();
    if (closed) return;
    if (current && sameSet(current.ids, ids)) return;
    const previous = current;
    const next = open(ids);
    current = next;
    try {
      await next.handle.started;
    } catch (error) {
      if (current === next) {
        next.handle.close();
        current = previous;
        // The old subscription may have dropped while the new one was starting.
        if (previous?.deadReason) { current = null; previous.handle.close(); onBroken?.(previous.deadReason); }
      }
      throw error;
    }
    previous?.handle.close();
  }

  return {
    /** Resolves once a subscription covering exactly these panes has started. */
    update(paneIds) {
      pending = pending.catch(() => {}).then(() => swap(paneIds));
      return pending;
    },
    /** Forget the current subscription so the next update opens a fresh one (used after a resync). */
    reset() {
      current?.handle.close();
      current = null;
    },
    paneIds() { return current ? [...current.ids] : null; },
    close() {
      closed = true;
      current?.handle.close();
      current = null;
    },
  };
}
