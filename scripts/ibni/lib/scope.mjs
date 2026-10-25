// Setup and verify run in a transient systemd user scope where one exists
// (decision 0019): a lower CPU weight than interactive sessions, a memory
// ceiling so the OOM killer picks the run rather than an agent, and one
// cgroup to read the run's peak memory and CPU time from and to stop, which
// kills any server or browser the command left behind.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

// Runs inside the scope: marks that the scope started, runs the command, then
// writes the scope's own counters as labelled lines before the shell exits,
// because a scope with nothing left in it is gone. The processes still in the
// scope are counted with the shell's own read, which starts no process of its
// own. A command killed by a signal ends the shell with the same signal.
const WRAPPER = [
  'echo started > "$IBNI_SCOPE_STATS"',
  'sh -c "$IBNI_COMMAND"',
  "status=$?",
  "cgroup=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -n 1)",
  "left=0",
  'while read -r pid; do [ "$pid" = "$$" ] || left=$((left + 1)); done < "$cgroup/cgroup.procs"',
  '{ echo "left $left"; echo "peak $(cat "$cgroup/memory.peak" 2>/dev/null)"; grep "^usage_usec " "$cgroup/cpu.stat"; grep "^oom_kill " "$cgroup/memory.events"; } >> "$IBNI_SCOPE_STATS" 2>/dev/null',
  'if [ "$status" -gt 128 ]; then kill -$((status - 128)) $$; fi',
  "exit $status",
].join("; ");

function quiet(file, args, env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: "ignore", timeout: 10_000 });
    child.once("error", (error) => resolve({ code: null, missing: error.code === "ENOENT" }));
    child.once("close", (code, signal) => resolve({ code, missing: false, timedOut: signal !== null }));
  });
}

// The wrapper's labelled lines as numbers, by label.
export function parseScopeStats(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const [label, value] = line.trim().split(/\s+/);
    if (label && value !== undefined && value !== "" && Number.isFinite(Number(value))) values[label] = Number(value);
  }
  return { started: /^started$/m.test(text), ...values };
}

let probe;
// Whether systemd-run can start a user scope here: not on macOS or Windows,
// nor in a container or CI job without a user manager. Asked once per process.
export function scopeAvailability(settings, env = process.env) {
  if (!settings.enabled) return Promise.resolve({ available: false, reason: "workflow.scope.enabled is false" });
  probe ??= quiet("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], env).then(({ code, missing, timedOut }) => {
    if (code === 0) return { available: true };
    if (missing) return { available: false, reason: "systemd-run is not installed" };
    return { available: false, reason: timedOut ? "systemd-run --user did not answer within 10 s" : "systemd-run --user could not start a scope (no user manager?)" };
  });
  return probe;
}

// The child process to spawn for command, and how to finish the scope once
// it exits.
export function scopedSpawn({ command, env, settings, kind, sessionId, logPath }) {
  const unit = `ibni-${kind}-${(sessionId ?? "session").slice(0, 12)}-${randomBytes(3).toString("hex")}`;
  const statsPath = `${logPath}.scope`;
  return {
    unit,
    file: "systemd-run",
    args: [
      "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
      "-p", `CPUWeight=${settings.cpuWeight}`, "-p", `MemoryMax=${settings.memoryMax}`,
      // At the ceiling the kernel kills the largest process, not the whole
      // scope, so the wrapper lives to report it; a leftover gets 5 s to stop.
      "-p", "OOMPolicy=continue", "-p", "TimeoutStopSec=5s",
      "--", "sh", "-c", WRAPPER,
    ],
    env: { ...env, IBNI_COMMAND: command, IBNI_SCOPE_STATS: statsPath },
    // What the command left running is stopped with the scope (SIGTERM,
    // then SIGKILL). Without the start mark the scope never ran the command,
    // and the caller runs it plainly instead of recording a failure.
    finish: async () => {
      const stats = parseScopeStats(await readFile(statsPath, "utf8").catch(() => ""));
      await rm(statsPath, { force: true });
      if (!stats.started) return { scopeStarted: false };
      const leftovers = stats.left ?? 0;
      if (leftovers > 0) await quiet("systemctl", ["--user", "stop", `${unit}.scope`], env);
      return {
        scope: { unit, stoppedLeftovers: leftovers > 0, leftoverProcesses: leftovers, oomKills: stats.oom_kill ?? null },
        resources: {
          memoryPeakBytes: stats.peak ?? null,
          cpuMs: stats.usage_usec === undefined ? null : Math.round(stats.usage_usec / 1000),
        },
      };
    },
  };
}
