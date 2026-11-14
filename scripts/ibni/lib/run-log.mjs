// The run log: one JSON line per finished CI wait and per removed workspace,
// in <paths.worktreeRoot>/.ibni/runs.jsonl. Workspace metadata goes with its
// worktree, so this is what a retrospective (scripts/retro) still reads once
// cleanup has run. The field names are that reader's contract; change them
// only together with it.
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { MACHINE_STATE_DIRECTORY, withMachineLock } from "./lock.mjs";
import { summarizeTimings } from "./timings.mjs";

export const RUN_LOG_FILE = "runs.jsonl";

// Stable across adopt, since adopt keeps the metadata's runId. A workspace
// from before runIds has none; its first session id stands in, and the reader
// matches it by worktreePath and startedAt (its createdAt) instead.
export function runIdOf(metadata) {
  return metadata.runId
    ?? metadata.adoptions?.[0]?.previousSessionId
    ?? metadata.steps?.[0]?.sessionId
    ?? metadata.sessionId
    ?? `${metadata.worktreePath}@${metadata.createdAt}`;
}

// outcome: green, ci-failed or ci-blocked for a ci event; merged, closed or
// abandoned (pruned without a pull request) for a removal.
export function runLogEntry(metadata, { event, outcome, recordedAt = new Date().toISOString() }) {
  const timings = summarizeTimings(metadata);
  const steps = {};
  for (const step of timings.steps) {
    if (Number.isFinite(step.durationMs)) steps[step.step] = (steps[step.step] ?? 0) + step.durationMs;
  }
  return {
    version: 1,
    runId: runIdOf(metadata),
    recordedAt,
    event,
    repository: metadata.controlWorktreePath ? path.basename(metadata.controlWorktreePath) : null,
    branch: metadata.branch ?? null,
    worktreePath: metadata.worktreePath ?? null,
    prUrl: metadata.prUrl ?? null,
    // When prepare made the workspace: the reader takes live metadata's
    // createdAt as a run's start, and matches a log line without a runId of
    // its own by worktreePath and this.
    startedAt: metadata.createdAt ?? null,
    outcome,
    steps,
    verify: { attempts: timings.verify.attempts, failed: timings.verify.failed },
    review: { passes: timings.review.rounds, findings: timings.review.findings, accepted: timings.review.accepted },
    qa: { passes: timings.qa.rounds, findings: timings.qa.findings },
    // A round here is one CI run that finished (the reader counts a green
    // first wait as one round); stats' ci.rounds counts only failed ones.
    ci: { rounds: timings.ci.history.filter((wait) => Object.hasOwn(CI_OUTCOMES, wait.state)).length, state: timings.ci.state },
  };
}

// Under the machine-wide lock, so lines from concurrent runs in any
// repository never interleave.
export async function appendRunLog(worktreeRoot, entry) {
  await withMachineLock(worktreeRoot, "runs", () => appendFile(
    path.join(worktreeRoot, MACHINE_STATE_DIRECTORY, RUN_LOG_FILE),
    `${JSON.stringify(entry)}\n`,
    { mode: 0o600 },
  ));
}

export const CI_OUTCOMES = { green: "green", failed: "ci-failed", none: "ci-blocked", cancelled: "ci-blocked" };
