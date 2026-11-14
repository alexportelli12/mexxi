// Per-session timings and gate counts, kept in the workspace metadata so a
// retrospective or a status pane reads them without parsing transcripts.
import { withRepositoryLock } from "./lock.mjs";
import { readMetadata, writeMetadata } from "./metadata.mjs";
import { sessionWorkspace } from "./session.mjs";

// Appends to one of the metadata's history arrays under the repository lock,
// re-reading the metadata so concurrent lifecycle updates are never lost.
// updatedAt is left alone: it tracks lifecycle state, not bookkeeping.
export async function appendHistory(cwd, sessionId, field, item) {
  const { repository, entry } = await sessionWorkspace(cwd, sessionId);
  return withRepositoryLock(repository.commonDirectory, async () => {
    const metadata = await readMetadata(entry.gitDirectory);
    if (metadata?.sessionId !== sessionId) return null;
    await writeMetadata(entry.gitDirectory, { ...metadata, [field]: [...(metadata[field] ?? []), item] });
    return item;
  });
}

function stepOutcome(result, error) {
  if (error) return "failed";
  if (result?.operation === "ci-wait") return result.state === "green" ? "succeeded" : `ci-${result.state}`;
  if (result?.published === false) return "requires-evidence";
  if (result?.recorded === false) return result.requiresVerify ? "requires-verify" : "not-recorded";
  if (result?.passed === false || (result?.setup?.ran && !result.setup.passed)) return "failed";
  return "succeeded";
}

// Best-effort: a step that cannot be recorded (an unknown session, a failed
// prepare that created none) never changes the command's own result.
export async function recordStep({ cwd, sessionId, step, startedAt, result, error }) {
  if (!sessionId) return;
  const item = {
    step,
    sessionId,
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: stepOutcome(result, error),
    ...(error ? { error: error.message.split("\n")[0].slice(0, 200) } : {}),
  };
  try {
    await appendHistory(cwd, sessionId, "steps", item);
  } catch {
    // The command's result or error is what the caller needs.
  }
}

export function summarizeTimings(metadata) {
  const records = metadata.records ?? [];
  const findings = (kind) => {
    const rounds = records.filter((record) => record.kind === kind);
    return {
      rounds: rounds.length,
      findings: rounds.reduce((total, record) => total + record.findings, 0),
      history: rounds.map(({ at, findings: count }) => ({ at, findings: count })),
    };
  };
  // Acceptance is optional per review; reviews recorded without it count in
  // rounds and findings but add nothing to accepted.
  const reviews = records.filter((record) => record.kind === "review");
  const accepted = reviews.reduce((total, record) => total + (record.accepted ?? 0), 0);
  const verify = records.filter((record) => record.kind === "verify");
  const ci = records.filter((record) => record.kind === "ci");
  return {
    steps: (metadata.steps ?? []).map((step) => ({
      ...step,
      durationMs: Date.parse(step.endedAt) - Date.parse(step.startedAt),
    })),
    verify: {
      attempts: verify.length,
      passed: verify.filter((record) => record.outcome === "pass").length,
      failed: verify.filter((record) => record.outcome === "fail").length,
      // What each run cost, where its scope could measure it (decision 0019).
      history: verify.map(({ at, outcome, durationMs, queuedMs, memoryPeakBytes, cpuMs }) => ({ at, outcome, durationMs, queuedMs, memoryPeakBytes, cpuMs })),
    },
    review: { ...findings("review"), accepted },
    qa: findings("qa"),
    // Each ibni ci-wait; a round is one that ended with a failed check
    // (decision 0026). state is the last wait's, null before any.
    ci: {
      waits: ci.length,
      rounds: ci.filter((record) => record.state === "failed").length,
      state: ci.at(-1)?.state ?? null,
      history: ci.map(({ at, state, headSha, failed, durationMs }) => ({ at, state, headSha, failed, durationMs })),
    },
  };
}
