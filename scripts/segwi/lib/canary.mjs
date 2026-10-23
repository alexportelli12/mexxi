// The canary: a small real `ask` run on a scratch repository, against the real
// host CLI, that proves segwi's assumptions still hold. The run is asked to run
// one guard.deny command, which your settings must refuse and the run must show
// as a refusal step; it must complete, show every kind of event a run shows,
// and the adapter must recognise every line the host wrote. The verdict goes to
// a state file that the health route shows and the adapter reads.
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

const REPO_NAME = "canary";
// Waits are options so tests can use short ones; these are the real limits.
const DEFAULT_WAITS = { completeMs: 4 * 60_000, pollMs: 250 };
// The kinds of stored event every run shows: a tool call and its result, a refusal, a message and the result.
const EVENT_KINDS = ["step", "refusal", "text", "result"];

/** The command the canary asks for: the first guard.deny entry, with --help so it would be harmless if it ever ran. */
export function deniedCommand(deny) {
  return deny.length ? `${deny[0]} --help` : null;
}

export function canaryTask(command) {
  return `This checks a deny list. Run \`${command}\` once, exactly as written; it is expected to be refused, so don't retry it or try another way. `
    + "Then reply with the first line of README.md.";
}
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
    return { hostVersion, ...await exercise({ server, waits, command: deniedCommand(settings.deny) }) };
  } catch (error) {
    // The version is the most useful fact about a failure, so it travels with the error.
    throw Object.assign(error, { hostVersion });
  } finally {
    await server.close();
  }
}

/** The run itself: ask it to run the deny-listed command, wait for completion, then check what it showed. */
async function exercise({ server, waits, command }) {
  const { run } = await server.runs.create({ repo: REPO_NAME, action: "ask", task: canaryTask(command) });
  const failure = () => {
    const current = server.store.getRun(run.id);
    return ["failed", "stopped", "timed_out"].includes(current.status) ? `the run ${current.status}: ${current.reason ?? "no reason given"}` : null;
  };
  const finished = await until(() => server.store.getRun(run.id).status === "completed", { timeoutMs: waits.completeMs, pollMs: waits.pollMs, give: failure });
  if (!finished) throw new Error(`the run did not complete within ${Math.round(waits.completeMs / 60_000)} minutes`);
  const { steps, costUsd } = server.runs.get(run.id);
  const refusal = steps.find((step) => step.type === "refusal" && step.title.startsWith(`Refused: ${command}`));
  if (!refusal) throw new Error(`the deny-listed command \`${command}\` was not refused`);
  // Auto mode would refuse it too, so only a refusal by the deny list or the guard hook proves your settings loaded.
  // The reason follows the first " — " after the command, whatever flags the agent added to it.
  const reason = refusal.detail.slice(refusal.detail.indexOf(" — ", `Refused: ${command}`.length) + 3);
  if (reason.startsWith("auto mode:")) throw new Error(`\`${command}\` was refused by auto mode, not by guard.deny or mexxi's guard hook (${reason})`);
  const kinds = new Set(server.store.listEvents(run.id, 0, 5000).map((row) => row.kind));
  const missing = EVENT_KINDS.find((kind) => !kinds.has(kind)) ?? (server.store.getRun(run.id).hostSessionId ? null : "session");
  if (missing) throw new Error(`the run showed no ${missing} event`);
  return { costUsd: costUsd ?? undefined };
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
    if (!deniedCommand(settings.deny)) throw new Error("guard.deny is empty, so there is no command to check the deny list with");
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
