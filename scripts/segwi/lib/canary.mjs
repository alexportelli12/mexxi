// The canary: a small real `ask` run on a scratch repository, against the real
// host CLI, that proves segwi's assumptions still hold. The host must raise an
// approval for a blocked `curl`, the run must complete once it is denied, and
// the adapter must recognise every line the host wrote. The verdict goes to a
// state file that the health route shows and the adapter reads.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeCodeAdapter } from "../runners/claude-code.mjs";
import { redact } from "../../lib/redact.mjs";
import { audit } from "./audit.mjs";
import { canaryTestedVersions, writeCanaryState } from "./canary-state.mjs";
import { dataDir as defaultDataDir, ensurePrivateDir, stateDir as defaultStateDir } from "./paths.mjs";
import { createPushService } from "./push.mjs";
import { startServer } from "./serve.mjs";
import { openStore } from "./store.mjs";

export const CANARY_TASK = "Run `curl -sI https://example.com` and report the HTTP status line, then reply with the first line of README.md.";
const REPO_NAME = "canary";
// Waits are options so tests can use short ones; these are the real limits.
const DEFAULT_WAITS = { approvalMs: 60_000, completeMs: 4 * 60_000, pollMs: 250 };
const FIXED_SESSION = "11111111-2222-4333-8444-555555555555";

/** A scratch repository on main with a README and a `verify` script that always passes. */
export function makeScratchRepo(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "canary@example.com");
  git("config", "user.name", "segwi canary");
  writeFileSync(path.join(dir, "README.md"), "# segwi canary\n\nA scratch repository for segwi's nightly check.\n");
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "segwi-canary", private: true, scripts: { verify: 'node -e ""' } }, null, 2)}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

/** The settings the canary's own server runs with: one scratch repository, `ask` only, the canary's model and caps. */
export function canarySettings(settings, repoPath) {
  const { canary, limits } = settings.segwi;
  return {
    ...settings,
    segwi: {
      ...settings.segwi,
      enabled: true,
      // Port 0 lets the system pick a free one, which is never inside workflow.ports.
      bind: { host: "127.0.0.1", port: 0 },
      model: canary.model,
      repositories: [{ name: REPO_NAME, path: repoPath, actions: ["ask"] }],
      limits: { ...limits, concurrentRuns: 1, maxTurns: canary.maxTurns, approvalTimeoutMinutes: 2 },
    },
  };
}

/** The raw host stream with secrets redacted and this machine's paths replaced, so a person can commit it as a fixture. */
export function redactedStream(lines, { home = os.homedir(), repoPath }) {
  return lines.map((line) => {
    let text = redact(line).text;
    if (repoPath) text = text.replaceAll(repoPath, "~/workspace/my-app");
    if (home) text = text.replaceAll(home, "~");
    return text.replace(/"session_id":"[0-9a-f-]{36}"/g, `"session_id":"${FIXED_SESSION}"`);
  }).join("\n") + "\n";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, { timeoutMs, pollMs, give }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    const problem = give?.();
    if (problem) throw new Error(problem);
    if (Date.now() > deadline) return null;
    await sleep(pollMs);
  }
}

/** Starts the in-process server, drives the run and returns what it found. Throws a plain-language Error when the host misbehaves. */
async function drive({ settings, repoPath, host, onLine, unknown, waits, scratch }) {
  const adapter = createClaudeCodeAdapter({
    ...host, dataDir: path.join(scratch, "host"), onUnknown: (what) => unknown.push(what), onLine,
  });
  const detected = await adapter.detect();
  const hostVersion = detected.version;
  if (!detected.available) throw Object.assign(new Error("the host did not answer `--version`"), { hostVersion });
  const dataDir = ensurePrivateDir(path.join(scratch, "data"));
  const server = await startServer({ settings: canarySettings(settings, repoPath), dataDir, runner: adapter, staticRoot: null, stateDir: path.join(scratch, "state") });
  try {
    return { hostVersion, ...await exercise({ server, waits }) };
  } catch (error) {
    // The version is the most useful fact about a failure, so it travels with the error.
    throw Object.assign(error, { hostVersion });
  } finally {
    await server.close();
  }
}

/** The run itself: ask, wait for the approval of the blocked curl, deny it, wait for completion. */
async function exercise({ server, waits }) {
  const { run } = await server.runs.create({ repo: REPO_NAME, action: "ask", task: CANARY_TASK });
  const failure = () => {
    const current = server.store.getRun(run.id);
    return ["failed", "stopped", "timed_out"].includes(current.status) ? `the run ${current.status}: ${current.reason ?? "no reason given"}` : null;
  };
  const approval = await until(() => server.approvals.list({ status: "pending" }).find((item) => item.runId === run.id), {
    timeoutMs: waits.approvalMs, pollMs: waits.pollMs,
    give: () => failure() ?? (server.store.getRun(run.id).status === "completed" ? "the run completed without asking about the blocked curl" : null),
  });
  if (!approval) throw new Error(`no approval appeared within ${Math.round(waits.approvalMs / 1000)} s for a blocked curl`);
  if (approval.tool !== "Bash" || !approval.exact.includes("curl")) throw new Error(`the approval was for ${approval.tool} "${approval.exact.slice(0, 80)}", not the blocked curl`);
  // In process, not over HTTP: the canary is the person here.
  server.approvals.decide(approval.id, "deny", "segwi-canary");
  const finished = await until(() => server.store.getRun(run.id).status === "completed", { timeoutMs: waits.completeMs, pollMs: waits.pollMs, give: failure });
  if (!finished) throw new Error(`the run did not complete within ${Math.round(waits.completeMs / 60_000)} minutes`);
  return { costUsd: server.store.getRun(run.id).costUsd ?? undefined };
}

/** Tells the push subscribers in the real database, when there is one. Never throws. */
async function notifyFailure({ settings, dataDir, stateDir, pushOptions, problem, hostVersion }) {
  const file = path.join(dataDir, "segwi.db");
  if (!existsSync(file)) return;
  let store;
  try {
    store = openStore(file);
    audit(store, { actor: "system", origin: "system", action: "canary.failed", outcome: "error", detail: `Claude Code ${hostVersion ?? "unknown"}: ${problem}` });
    const push = createPushService({ store, settings, stateDir, ...pushOptions });
    push.notify("canary_failed", null);
    await push.idle();
  } catch {
    // The failure is already in the state file and the exit code.
  } finally {
    store?.close();
  }
}

/**
 * @param {{ settings: object, stateDir?: string, dataDir?: string, host?: { bin?: string, binArgs?: string[] },
 *   saveStream?: string, waits?: Partial<typeof DEFAULT_WAITS>, pushOptions?: object, now?: () => Date }} options
 *   `host`, `waits` and `pushOptions` are injected by tests; the CLI uses the real `claude`.
 * @returns {Promise<import("./canary-state.mjs").CanaryState>}
 */
export async function runCanary({ settings, stateDir = defaultStateDir(), dataDir = defaultDataDir(), host = {}, saveStream, waits = {}, pushOptions = {}, now = () => new Date() }) {
  const started = Date.now();
  const scratch = mkdtempSync(path.join(os.tmpdir(), "segwi-canary-"));
  const repoPath = path.join(scratch, "repo");
  const lines = [];
  const unknown = [];
  let outcome;
  try {
    ensurePrivateDir(repoPath);
    makeScratchRepo(repoPath);
    const driven = await drive({ settings, repoPath, host, onLine: (line) => lines.push(line), unknown, waits: { ...DEFAULT_WAITS, ...waits }, scratch });
    outcome = unknown.length
      ? { ok: false, hostVersion: driven.hostVersion, problem: `the adapter did not recognise ${[...new Set(unknown)].slice(0, 3).join(", ")}`, costUsd: driven.costUsd }
      : { ok: true, ...driven };
  } catch (error) {
    outcome = { ok: false, hostVersion: error.hostVersion ?? null, problem: error.message };
  } finally {
    if (saveStream && lines.length) writeFileSync(saveStream, redactedStream(lines, { repoPath }), { mode: 0o600 });
    rmSync(scratch, { recursive: true, force: true });
  }
  const passed = canaryTestedVersions(stateDir);
  const state = {
    ok: outcome.ok, at: now().toISOString(), hostVersion: outcome.hostVersion ?? null, model: settings.segwi.canary.model,
    ...(outcome.problem ? { problem: outcome.problem } : {}),
    durationMs: Date.now() - started,
    ...(typeof outcome.costUsd === "number" ? { costUsd: outcome.costUsd } : {}),
    canaryTestedVersions: outcome.ok && outcome.hostVersion && !passed.includes(outcome.hostVersion) ? [...passed, outcome.hostVersion] : passed,
  };
  writeCanaryState(stateDir, state);
  if (!state.ok) await notifyFailure({ settings, dataDir, stateDir, pushOptions, problem: state.problem, hostVersion: state.hostVersion });
  return state;
}
