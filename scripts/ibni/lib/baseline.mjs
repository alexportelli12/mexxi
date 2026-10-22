import { WorkspaceError } from "./errors.mjs";
import { git } from "./git.mjs";

// A repository's committed .mexxi.json holds the few settings mexxi reads from
// it: `verify`, the command that defines "mechanically healthy" (default
// `npm run verify`), `ciCheck`, the CI check that runs that full command,
// which opts in to baseline reuse, and `forge` (see forge.mjs). Verifika's own
// schema rejects extra keys, so these live in this small file instead; it is
// read from the base commit, so only what the default branch already holds
// counts.
export const OPT_IN_FILE = ".mexxi.json";
export const DEFAULT_VERIFY_COMMAND = "npm run verify";

const SHA = /^[0-9a-f]{40}$/i;

// Returns { settings } from the base commit's .mexxi.json, or { settings: null,
// reason } when it is absent. A file that is present but not a JSON object is
// an error: it may name the verify command, and guessing the default instead
// could run the wrong gate.
export async function repositorySettings(root, baseSha) {
  const result = await git(root, ["show", `${baseSha}:${OPT_IN_FILE}`], { allowedExitCodes: [0, 128] });
  if (result.code !== 0) return { settings: null, reason: `${OPT_IN_FILE} is not committed on the default branch` };
  let settings;
  try {
    settings = JSON.parse(result.stdout);
  } catch {
    settings = undefined;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new WorkspaceError(`${OPT_IN_FILE} on the default branch is not a JSON object`, "Fix it on the default branch, then prepare again.");
  }
  return { settings };
}

// The repository's verify command: `verify` from .mexxi.json, or the default.
export function verifyCommandFrom({ settings }) {
  if (!settings || settings.verify === undefined) return DEFAULT_VERIFY_COMMAND;
  if (typeof settings.verify !== "string" || !settings.verify.trim()) {
    throw new WorkspaceError(`${OPT_IN_FILE} names a verify that is not a non-empty command string`, "Set \"verify\" to the command that checks the whole repository, or remove it to use npm run verify.");
  }
  return settings.verify.trim();
}

function namedCheck({ settings, reason }) {
  if (!settings) return { reason };
  const { ciCheck } = settings;
  if (typeof ciCheck === "string" && ciCheck.trim()) return { check: ciCheck.trim() };
  return { reason: `${OPT_IN_FILE} does not name a ciCheck` };
}

// Decides whether the baseline verify run can be cited instead of rerun.
// Only a completed, successful run of the named check on exactly baseSha
// qualifies. Everything else (no opt-in, no known forge, a forge CLI failure,
// a pending, failed or differently-pinned run) reports why and leaves the
// baseline to run locally. forge is detectForge's result.
export async function provenBaseline(root, baseSha, committedSettings, forge) {
  const { check, reason } = namedCheck(committedSettings);
  if (!check) return { reused: false, reason };
  if (!forge.name) return { reused: false, check, reason: `CI check state unavailable: ${forge.reason}` };
  let runs;
  try {
    runs = await forge.checkRuns(root, baseSha, check);
  } catch (error) {
    return { reused: false, check, reason: `CI check state unavailable: ${error.message.split("\n")[0]}` };
  }
  const latest = runs
    .filter((candidate) => candidate.name === check && SHA.test(candidate.sha ?? "")
      && candidate.sha.toLowerCase() === baseSha.toLowerCase())
    .sort((a, b) => b.id - a.id)[0];
  if (!latest) return { reused: false, check, reason: `no ${check} run on ${baseSha}` };
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    return { reused: false, check, reason: `${check} on ${baseSha} is ${latest.status === "completed" ? latest.conclusion : latest.status}` };
  }
  return { reused: true, check, sha: latest.sha, url: latest.url, runId: latest.id, completedAt: latest.completedAt };
}
