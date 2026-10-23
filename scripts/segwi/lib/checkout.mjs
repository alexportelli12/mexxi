// ibni needs a clean control checkout on its default branch. Asking git here
// lets the server say no (409) before a run starts instead of failing inside it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(repoPath, ...args) {
  try {
    return (await execFileAsync("git", ["-C", repoPath, ...args], { timeout: 10_000, maxBuffer: 1 << 20 })).stdout.trim();
  } catch {
    return null;
  }
}

/** @returns {Promise<{ clean: boolean, branch: string|null, defaultBranch: string, onDefault: boolean, error: string|null }>} */
export async function checkoutState(repoPath) {
  const status = await git(repoPath, "status", "--porcelain");
  const branch = await git(repoPath, "symbolic-ref", "--short", "HEAD");
  const remoteHead = await git(repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  const defaultBranch = remoteHead?.replace(/^origin\//, "") || "main";
  if (status === null) {
    return { clean: false, branch, defaultBranch, onDefault: false, error: "The folder is not a readable git repository." };
  }
  return { clean: status === "", branch, defaultBranch, onDefault: branch === defaultBranch, error: null };
}

/** The plain reason a run can't start here, or null. */
export function checkoutProblem(state) {
  if (state.error) return state.error;
  if (!state.clean) return "The checkout has uncommitted changes. Commit or discard them first.";
  if (!state.onDefault) return `The checkout is on ${state.branch ?? "no branch"}, not ${state.defaultBranch}.`;
  return null;
}
