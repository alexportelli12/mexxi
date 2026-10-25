import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { withRunSlot } from "./lock.mjs";
import { scopeAvailability, scopedSpawn } from "./scope.mjs";

// Where the run's scope and its resources are recorded: setup, verify, stats.
export const scopeFields = ({ scope, scopeReason, resources }) => ({
  scope: scope ?? null,
  ...(scopeReason ? { scopeReason } : {}),
  resources: resources ?? null,
});

const TAIL_LINES = 40;
const TAIL_BYTES = 4000;

// The end of a log, small enough to print in one JSON line, so an agent sees
// why a run failed without reading the whole log.
export async function logTail(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  const tail = text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_BYTES ? tail.slice(-TAIL_BYTES) : tail;
}

// Runs a repository's own command line (setup or verify) through the shell,
// writing its output straight to logPath rather than holding it in memory or
// printing it: ibni's stdout stays one line of JSON, however long the run.
// With scoped (from scopedSpawn), the command runs in that systemd scope and
// the result adds the scope and the resources it used.
export async function runLogged({ command, cwd, logPath, env = process.env, scoped = null }) {
  const log = await open(logPath, "w", 0o600);
  const startedAt = Date.now();
  try {
    const { exitCode, signal, error } = await new Promise((resolve) => {
      const child = scoped
        ? spawn(scoped.file, scoped.args, { cwd, env: scoped.env, stdio: ["ignore", log.fd, log.fd] })
        : spawn(command, { cwd, env, shell: true, stdio: ["ignore", log.fd, log.fd] });
      child.once("error", (spawnError) => resolve({ exitCode: null, signal: null, error: spawnError.message }));
      child.once("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
    });
    const durationMs = Date.now() - startedAt;
    if (error) await log.write(`\nibni could not start the command: ${error}\n`);
    const finished = scoped ? await scoped.finish() : {};
    return { exitCode, signal: signal ?? null, passed: exitCode === 0, durationMs, ...finished };
  } finally {
    await log.close();
  }
}

// runLogged once one of the machine's workflow.verifySlots is free. about
// (sessionId, kind) is what the slot and the queue show; queuedMs is how long
// the run waited, and durationMs still counts only the run. beforeRun checks
// what the wait may have changed, inside the slot, and throws to stop.
// Where no scope can start, it runs as a plain child, and scopeReason says why.
export async function runLoggedInSlot(config, about, options, { beforeRun = async () => {} } = {}) {
  const settings = config.workflow.scope;
  const availability = await scopeAvailability(settings, options.env);
  const { queuedMs, result } = await withRunSlot(config.paths.worktreeRoot, config.workflow.verifySlots, about, async () => {
    await beforeRun();
    if (availability.available) {
      const scoped = await runLogged({ ...options, scoped: scopedSpawn({ ...options, env: options.env ?? process.env, settings, kind: about.kind, sessionId: about.sessionId }) });
      if (scoped.scopeStarted !== false) return scoped;
      return { ...await runLogged(options), scope: null, scopeReason: "systemd-run could not start this run's scope, so it ran as a plain child" };
    }
    return { ...await runLogged(options), scope: null, scopeReason: availability.reason };
  });
  return { ...result, queuedMs };
}
