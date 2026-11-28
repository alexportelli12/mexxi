// The caps that keep a runaway client from starting more sessions than meant:
// how many ħares-started sessions may be open at once, and how many a day.
// Interactive sessions belong to the person, so there is no idle or hard timeout.
import { HttpError } from "./errors.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Throws a 429 when starting another session would break a cap. */
export function assertWithinCaps(store, limits, now = new Date()) {
  if (store.countActive() >= limits.concurrentRuns) {
    throw new HttpError(429, `${limits.concurrentRuns} sessions ħares started are still open. End one first.`);
  }
  if (store.countSince(new Date(now.getTime() - DAY_MS).toISOString()) >= limits.runsPerDay) {
    throw new HttpError(429, `The limit of ${limits.runsPerDay} sessions a day is reached.`);
  }
}
