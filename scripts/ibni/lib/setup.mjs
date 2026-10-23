// Dependency setup for a workspace (decision 0014). The command is `setup` in
// the base commit's .mexxi.json, or the one install command a root lockfile
// names. A lockfile is mapped by its name to a fixed command and never read,
// so nothing in it can change what runs; anything ambiguous installs nothing.
import path from "node:path";
import { OPT_IN_FILE } from "./baseline.mjs";
import { WorkspaceError } from "./errors.mjs";
import { cleanOutput, git } from "./git.mjs";
import { logTail, runLogged } from "./logged-run.mjs";

export const LOCKFILE_SETUP = {
  "package-lock.json": "npm ci --prefer-offline --no-audit --no-fund",
  "pnpm-lock.yaml": "pnpm install --frozen-lockfile --prefer-offline",
};
// Yarn's classic and Berry lockfiles share a name but not an install flag, so
// yarn.lock is recognised (to refuse a guess) without naming a command.
const LOCKFILES = [...Object.keys(LOCKFILE_SETUP), "yarn.lock"];
export const SETUP_LOG = "setup.log";

// `setup` from .mexxi.json, checked the way `verify` is: absent is null, and
// anything but a non-empty string stops rather than falling back to a lockfile.
export function setupCommandFrom({ settings }) {
  if (!settings || settings.setup === undefined) return null;
  if (typeof settings.setup !== "string" || !settings.setup.trim()) {
    throw new WorkspaceError(`${OPT_IN_FILE} names a setup that is not a non-empty command string`, "Set \"setup\" to the command that installs the repository's dependencies, or remove it to use its lockfile.");
  }
  return settings.setup.trim();
}

// The root lockfiles at ref, as { name: blobSha }. adopt compares them with
// the ones the last setup installed from.
export async function lockfilesAt(root, ref) {
  const listing = cleanOutput(await git(root, ["ls-tree", ref, "--", ...LOCKFILES]));
  return Object.fromEntries(listing.split("\n").filter(Boolean).map((line) => {
    const [meta, name] = line.split("\t");
    return [name, meta.split(" ")[2]];
  }));
}

export function setupPlan(settings, lockfiles) {
  const configured = setupCommandFrom(settings);
  if (configured) return { command: configured, source: OPT_IN_FILE };
  const names = Object.keys(lockfiles);
  if (names.length === 0) return { command: null, reason: `no lockfile and no setup in ${OPT_IN_FILE}; nothing was installed` };
  if (names.length > 1) return { command: null, reason: `more than one lockfile (${names.join(", ")}); set setup in ${OPT_IN_FILE} to say which install runs` };
  const [name] = names;
  if (!LOCKFILE_SETUP[name]) return { command: null, reason: `${name} does not name one install command; set setup in ${OPT_IN_FILE}` };
  return { command: LOCKFILE_SETUP[name], source: name };
}

const setupNextAction = (sessionId) => `Run ibni setup --session ${sessionId} to install dependencies in the worktree.`;

// Runs the plan in the worktree and returns what metadata and JSON report.
// A plan without a command reports why nothing ran.
export async function runSetup({ plan, worktreePath, evidenceDir, lockfiles }) {
  if (!plan.command) return { ran: false, command: null, reason: plan.reason, lockfiles };
  const logPath = path.join(evidenceDir, SETUP_LOG);
  const ranAt = new Date().toISOString();
  const outcome = await runLogged({ command: plan.command, cwd: worktreePath, logPath });
  return {
    ran: true,
    command: plan.command,
    source: plan.source,
    passed: outcome.passed,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    logPath,
    ranAt,
    lockfiles,
    ...(outcome.passed ? {} : { logTail: await logTail(logPath) }),
  };
}

export function deferredSetup(plan, sessionId, lockfiles) {
  return {
    ran: false,
    deferred: true,
    command: plan.command,
    source: plan.source,
    reason: "IBNI_DEFER_SETUP is set, so setup runs inside the caller's sandbox instead",
    nextAction: setupNextAction(sessionId),
    lockfiles,
  };
}

const sameLockfiles = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Whether a retained worktree's dependencies were installed from the lockfiles
// it now holds. current is null when ibni cannot tell; adopt reports this and
// never reinstalls on its own.
export function dependencyState(setup, lockfiles, sessionId) {
  const stale = (reason) => ({ current: false, reason, nextAction: setupNextAction(sessionId) });
  if (!setup) {
    return {
      current: null,
      reason: "this workspace was prepared before ibni recorded its setup",
      nextAction: `If its dependencies may be out of date, run ibni setup --session ${sessionId}.`,
    };
  }
  if (setup.deferred) return stale("setup was deferred and has not run");
  if (setup.ran && !setup.passed) return stale("the last setup failed");
  if (!setup.ran && setup.command) return stale("setup did not finish");
  if (!sameLockfiles(setup.lockfiles, lockfiles)) return stale("the lockfiles changed since the last setup");
  return setup.ran
    ? { current: true, reason: `installed from ${setup.source} at ${setup.ranAt}` }
    : { current: true, reason: setup.reason };
}
