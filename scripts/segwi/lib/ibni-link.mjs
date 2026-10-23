// segwi reads mexxi only through ibni's JSON. This module pins which fields it
// reads, and the contract test runs the real ibni to prove they still exist.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The fields segwi reads, per command. The contract test fails if ibni drops one.
export const IBNI_FIELDS = {
  prepare: ["sessionId", "worktreePath", "branch"],
  list: ["sessionId", "worktreePath", "branch", "createdAt"],
  info: ["sessionId", "worktreePath", "branch", "prUrl"],
  stats: ["verify.history"],
};

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
    /** @returns {Promise<{ branch: string, prUrl: string|null, verify: "pass"|"fail"|null, worktreePath: string }>} */
    async summary(repoPath, sessionId) {
      const info = await run(repoPath, ["info", "--session", sessionId]);
      let verify = null;
      try {
        const stats = await run(repoPath, ["stats", "--session", sessionId]);
        verify = stats.verify?.history?.at(-1)?.outcome ?? null;
      } catch {
        // No stats yet is the same as no verify result.
      }
      return { branch: info.branch, prUrl: info.prUrl ?? null, verify: verify === "pass" || verify === "fail" ? verify : null, worktreePath: info.worktreePath };
    },
  };
}
