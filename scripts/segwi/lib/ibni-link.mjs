// segwi reads mexxi only through ibni's JSON. This module pins which fields it
// reads, and the contract test runs the real ibni to prove they still exist.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The fields segwi reads, per command. The contract test fails if ibni drops one. info and stats give the
// run's snapshot: the fields the run pane draws its journey from (claude/mods/run-pane/hooks/journey.ts).
export const IBNI_FIELDS = {
  prepare: ["sessionId", "worktreePath", "branch"],
  list: ["sessionId", "worktreePath", "branch", "createdAt"],
  info: ["sessionId", "worktreePath", "branch", "prUrl", "state", "createdAt"],
  stats: [
    "verify.history", "verify.history.0.at", "verify.attempts", "verify.passed", "verify.failed",
    "steps.0.step", "steps.0.outcome", "steps.0.durationMs", "steps.0.endedAt",
    "review.rounds", "review.findings", "review.byReviewer.cross.rounds", "qa.rounds", "qa.findings",
  ],
};

const STEPS_KEPT = 60;
const object = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : null);
const text = (value) => (typeof value === "string" ? value : undefined);
const count = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// The journey reads "Workspace ready" from the prepare or adopt step, so a long run keeps its latest one
// when older steps are dropped.
const SETS_UP = new Set(["prepare", "adopt"]);
function keptSteps(steps) {
  if (steps.length <= STEPS_KEPT) return steps;
  const setUp = steps.findLast((step) => SETS_UP.has(step.step) && step.outcome === "succeeded");
  const recent = steps.slice(-STEPS_KEPT);
  return setUp && !recent.includes(setUp) ? [setUp, ...recent.slice(1)] : recent;
}

/**
 * The run's snapshot from `ibni info` and `ibni stats` (stats wins where both carry a field, as in the run pane):
 * only the IBNI_FIELDS above, in ibni's own shape, so the app reads it with the run pane's own snapshotFrom. No
 * filesystem path: the snapshot is shown in the app and over MCP.
 */
export function ibniSnapshot(info, stats) {
  const merged = { ...object(info), ...object(stats) };
  const verify = object(merged.verify);
  const review = object(merged.review);
  const qa = object(merged.qa);
  return {
    branch: text(merged.branch), state: text(merged.state), prUrl: text(merged.prUrl) ?? null, createdAt: text(merged.createdAt),
    steps: keptSteps(Array.isArray(merged.steps) ? merged.steps.map(object).filter(Boolean) : []).map((step) => ({
      step: String(step.step ?? "?"), outcome: String(step.outcome ?? "?"),
      ...(typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}), ...(text(step.endedAt) ? { endedAt: step.endedAt } : {}),
    })),
    ...(verify ? {
      verify: {
        attempts: count(verify.attempts), passed: count(verify.passed), failed: count(verify.failed),
        history: (Array.isArray(verify.history) ? verify.history : []).map(object).filter(Boolean).map((entry) => ({ outcome: String(entry.outcome ?? "?"), ...(text(entry.at) ? { at: entry.at } : {}) })),
      },
    } : {}),
    ...(review ? { review: { rounds: count(review.rounds), findings: count(review.findings), byReviewer: { cross: { rounds: count(object(object(review.byReviewer)?.cross)?.rounds) } } } } : {}),
    ...(qa ? { qa: { rounds: count(qa.rounds), findings: count(qa.findings) } } : {}),
  };
}

/** The workspace `ibni prepare` printed, from the text of a tool result, or null. */
export function parsePrepareOutput(text, worktreeRoot) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const { sessionId, worktreePath, branch } = value ?? {};
  if (value?.operation !== "prepare" || typeof sessionId !== "string" || typeof worktreePath !== "string" || typeof branch !== "string") return null;
  // A path outside the worktree root is not one segwi should work with.
  if (!path.resolve(worktreePath).startsWith(`${path.resolve(worktreeRoot)}${path.sep}`)) return null;
  return { sessionId, worktreePath, branch };
}

/** @param {{ command?: string[], timeoutMs?: number }} [options] `command` lets the contract test run the repo's own ibni. */
export function createIbniLink({ command = ["ibni"], timeoutMs = 20_000 } = {}) {
  async function run(repoPath, args) {
    const [bin, ...prefix] = command;
    const { stdout } = await execFileAsync(bin, [...prefix, ...args], { cwd: repoPath, timeout: timeoutMs, maxBuffer: 4 << 20 });
    return JSON.parse(stdout);
  }
  return {
    async list(repoPath) {
      return (await run(repoPath, ["list"])).workspaces ?? [];
    },
    /** A workspace created at or after `sinceIso` whose worktree no other run already uses. */
    async findNewWorkspace(repoPath, sinceIso, excludePaths = []) {
      const workspaces = await this.list(repoPath);
      return workspaces.find((entry) => entry.createdAt >= sinceIso && !excludePaths.includes(entry.worktreePath)) ?? null;
    },
    /**
     * @returns {Promise<{ branch: string, prUrl: string|null, verify: "pass"|"fail"|null, worktreePath: string,
     *   snapshot: ReturnType<typeof ibniSnapshot> }>}
     */
    async summary(repoPath, sessionId) {
      const info = await run(repoPath, ["info", "--session", sessionId]);
      let stats = null;
      try {
        stats = await run(repoPath, ["stats", "--session", sessionId]);
      } catch {
        // No stats yet is the same as no verify result.
      }
      const verify = stats?.verify?.history?.at(-1)?.outcome ?? null;
      return {
        branch: info.branch, prUrl: info.prUrl ?? null, verify: verify === "pass" || verify === "fail" ? verify : null, worktreePath: info.worktreePath,
        snapshot: ibniSnapshot(info, stats),
      };
    },
  };
}
