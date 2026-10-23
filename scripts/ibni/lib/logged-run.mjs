import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";

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
export async function runLogged({ command, cwd, logPath, env = process.env }) {
  const log = await open(logPath, "w", 0o600);
  const startedAt = Date.now();
  try {
    const { exitCode, signal, error } = await new Promise((resolve) => {
      const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", log.fd, log.fd] });
      child.once("error", (spawnError) => resolve({ exitCode: null, signal: null, error: spawnError.message }));
      child.once("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
    });
    if (error) await log.write(`\nibni could not start the command: ${error}\n`);
    return { exitCode, signal: signal ?? null, passed: exitCode === 0, durationMs: Date.now() - startedAt };
  } finally {
    await log.close();
  }
}
