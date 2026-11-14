import { WorkspaceError } from "../lib/errors.mjs";
import { checksState, failedChecks, pullRequestForge } from "../lib/checks.mjs";
import { cleanOutput, git, remoteBranchSha } from "../lib/git.mjs";
import { workspaceConfig } from "../lib/config.mjs";
import { appendRunLog, CI_OUTCOMES, runLogEntry } from "../lib/run-log.mjs";
import { ownedSession, sessionWorkspace } from "../lib/session.mjs";
import { appendHistory } from "../lib/timings.mjs";

export const DEFAULT_CI_TIMEOUT_MINUTES = 45;
const POLL_MS = 15_000;
// Checks register a little after a push; until then the forge reports none.
const REGISTER_GRACE_MS = 120_000;

// Why CI on the pull request cannot speak for this session's work, or null:
// it tests the head the session published, and only that.
function staleness({ request, remoteSha, head, publishedSha, sessionId }) {
  if (!publishedSha) return { reason: "the session has never published", nextAction: `Run ibni publish --session ${sessionId}.` };
  if (remoteSha !== publishedSha || request.headSha !== publishedSha) {
    return {
      reason: `the pull request's head (${request.headSha ?? "none"}) or the remote branch (${remoteSha ?? "none"}) is not the recorded publication (${publishedSha}); someone else pushed, or a publish did not finish`,
      nextAction: "Look at the remote branch before changing anything; ibni publish refuses a branch that changed outside the session.",
    };
  }
  if (head !== publishedSha) {
    return { reason: `local HEAD (${head}) has commits CI has not seen`, nextAction: `Run ibni verify, record-evidence and ibni publish --session ${sessionId}, then ibni ci-wait again.` };
  }
  return null;
}

function timeoutFrom(value) {
  if (value === undefined) return DEFAULT_CI_TIMEOUT_MINUTES * 60_000;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new WorkspaceError("--timeout-minutes must be a positive number");
  return minutes * 60_000;
}

// Waits on the forge's checks for the session's pull request, holding no lock,
// so it runs in the background while nothing else is blocked. The result is
// recorded for stats: rounds counts the waits that ended in a failure.
export async function waitForCi({ cwd = process.cwd(), sessionId, timeoutMinutes }) {
  const timeoutMs = timeoutFrom(timeoutMinutes);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const { repository, metadata } = await ownedSession(cwd, sessionId);
  const { prUrl } = metadata;
  if (!prUrl) throw new WorkspaceError("ci-wait needs the session's pull request", `Run ibni mark-pr --session ${sessionId} --url <pull-request-url> first.`);
  const root = repository.root;
  const forge = await pullRequestForge(root, metadata, prUrl, "ci-wait");

  let request = await forge.changeRequest(root, prUrl);
  if (request.state !== "OPEN") {
    throw new WorkspaceError(`the pull request is ${request.state.toLowerCase()}; there is no CI round left to wait on`);
  }
  const head = cleanOutput(await git(root, ["rev-parse", "HEAD"]));
  const finish = async (fields) => {
    const result = { operation: "ci-wait", sessionId, prUrl, headSha: request.headSha, durationMs: Date.now() - startedAt, failed: [], ...fields };
    await appendHistory(cwd, sessionId, "records", {
      kind: "ci", at: new Date().toISOString(), sessionId, state: result.state, headSha: result.headSha, failed: result.failed.length, durationMs: result.durationMs,
    }).catch(() => {});
    // A finished round goes to the run log too, which outlives the workspace.
    // Best effort: the wait's result is what the caller needs.
    if (CI_OUTCOMES[result.state]) {
      try {
        const { entry } = await sessionWorkspace(cwd, sessionId);
        const config = await workspaceConfig();
        await appendRunLog(config.paths.worktreeRoot, runLogEntry(entry.metadata, { event: "ci", outcome: CI_OUTCOMES[result.state] }));
      } catch {
        // Nothing to do: stats still has the wait.
      }
    }
    return result;
  };
  const stale = staleness({ request, remoteSha: await remoteBranchSha(root, metadata.pushUrl, metadata.branch), head, publishedSha: metadata.publishedSha, sessionId });
  if (stale) return finish({ state: "stale", ...stale });

  const pause = (until) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(POLL_MS, until - Date.now()))));
  let checks = await forge.checks(root, prUrl);
  const registered = Math.min(deadline, startedAt + REGISTER_GRACE_MS);
  while (checks.length === 0 && Date.now() < registered) {
    await pause(registered);
    checks = await forge.checks(root, prUrl);
  }
  const pending = () => checks.some((check) => check.bucket === "pending");
  if (pending() && forge.watchChecks && Date.now() < deadline) {
    await forge.watchChecks(root, prUrl, deadline - Date.now());
    checks = await forge.checks(root, prUrl);
  }
  while (pending() && Date.now() < deadline) {
    await pause(deadline);
    checks = await forge.checks(root, prUrl);
  }

  // A push during the wait moves the checks to another commit.
  const startedHead = request.headSha;
  request = await forge.changeRequest(root, prUrl);
  if (request.headSha !== startedHead) {
    return finish({
      state: "stale",
      reason: `the pull request's head moved from ${startedHead} to ${request.headSha} while CI ran`,
      nextAction: "Look at who pushed before changing anything; the checks no longer describe the session's commit.",
    });
  }
  const state = checksState(checks);
  const failed = await failedChecks(forge, root, checks);
  const nextAction = {
    green: undefined,
    failed: "Fix each failure from its logTail (or its url), commit, verify, record-evidence and publish, then ibni ci-wait again; report what blocks after three rounds.",
    pending: `Checks were still running after ${timeoutMs / 60_000} minutes; run ibni ci-wait again, or report the stuck check.`,
    none: "The forge reports no checks for this pull request; say so in the report, since nothing proves CI green.",
    cancelled: "A check was cancelled; rerun it on the forge or report it.",
  }[state];
  return finish({ state, failed, total: checks.length, ...(nextAction ? { nextAction } : {}) });
}
