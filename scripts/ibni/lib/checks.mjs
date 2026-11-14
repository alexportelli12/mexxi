// A pull request's CI checks as one state (decision 0026): what ci-wait waits
// for and adopt reports, read through the forge the session's remote names.
import { redact } from "../../lib/redact.mjs";
import { workspaceConfig } from "./config.mjs";
import { changeRequestForge, detectForge, requireForge } from "./forge.mjs";

// The forge that holds the session's recorded pull request; adopt and cleanup
// read it the same way.
export async function pullRequestForge(root, metadata, prUrl, needed) {
  const config = await workspaceConfig();
  const detected = await detectForge({ root, remote: metadata.remote, baseSha: metadata.baseSha, config });
  return requireForge(changeRequestForge(detected, prUrl), needed);
}

// A failure anywhere decides the state, so a fix can start before slower
// jobs end; a check still running means the round is not over.
export function checksState(checks) {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.bucket === "fail")) return "failed";
  if (checks.some((check) => check.bucket === "pending")) return "pending";
  if (checks.some((check) => check.bucket === "cancel")) return "cancelled";
  return "green";
}

export function checksSummary(checks) {
  const counts = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  for (const check of checks) counts[check.bucket] += 1;
  return {
    state: checksState(checks),
    total: checks.length,
    counts,
    failed: checks.filter((check) => check.bucket === "fail").map((check) => ({ name: check.name, url: check.link })),
  };
}

const LOG_LINES = 60;
const LOG_BYTES = 6000;

// The end of a failed job's log, redacted, small enough for one JSON line.
export function logTailOf(text) {
  const tail = text.trimEnd().split("\n").slice(-LOG_LINES).join("\n");
  return redact(tail.length > LOG_BYTES ? tail.slice(-LOG_BYTES) : tail).text;
}

// Each failed check with the end of its log where the forge keeps one (a
// GitHub Actions job, a GitLab job); an external status gives only its link.
export async function failedChecks(forge, root, checks) {
  return Promise.all(checks.filter((check) => check.bucket === "fail").map(async (check) => {
    const failure = { name: check.name, url: check.link, logTail: null };
    try {
      const log = await forge.failedLog(root, check);
      if (log !== null) failure.logTail = logTailOf(log);
    } catch (error) {
      failure.logError = error.message.split("\n")[0];
    }
    return failure;
  }));
}

