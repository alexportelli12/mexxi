// The caps that keep a run, or a runaway client, from costing more than meant.
import { HttpError } from "./errors.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Throws a 429 when starting another run would break a cap. */
export function assertWithinCaps(store, limits, now = new Date()) {
  if (store.countActive() >= limits.concurrentRuns) {
    throw new HttpError(429, `${limits.concurrentRuns} runs are already working. Wait for one to finish or stop one.`);
  }
  if (store.countSince(new Date(now.getTime() - DAY_MS).toISOString()) >= limits.runsPerDay) {
    throw new HttpError(429, `The limit of ${limits.runsPerDay} runs a day is reached.`);
  }
}

/**
 * One idle timer (reset by activity) and one hard timer per run. `onTimeout`
 * receives the run id and the plain reason.
 */
export function createWatchdog(limits, onTimeout) {
  const timers = new Map();
  const minutes = (value) => value * 60_000;
  function clear(runId) {
    const entry = timers.get(runId);
    if (!entry) return;
    clearTimeout(entry.idle);
    clearTimeout(entry.hard);
    timers.delete(runId);
  }
  function arm(runId) {
    const entry = timers.get(runId) ?? {};
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => { clear(runId); onTimeout(runId, `No activity for ${limits.idleTimeoutMinutes} min`); }, minutes(limits.idleTimeoutMinutes));
    entry.idle.unref();
    if (!entry.hard) {
      entry.hard = setTimeout(() => { clear(runId); onTimeout(runId, "Hit the time limit"); }, minutes(limits.hardTimeoutMinutes));
      entry.hard.unref();
    }
    timers.set(runId, entry);
  }
  return { watch: arm, touch: arm, clear, stopAll: () => [...timers.keys()].forEach(clear) };
}
