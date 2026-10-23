// The Claude Code adapter: host mechanics only. It builds the headless command
// from a fixed argument array, renders the per-run settings and MCP config, and
// turns the host's stream-json output into normalised RunEvents. No caller value
// reaches the command line: the task goes to stdin, the rest comes from config.
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { playwrightArguments } from "../../lib/browser.mjs";
import { gitWritePaths, isPlainVerifyCommand, renderSettings, VERIFY_NOT_ALLOWED } from "../lib/allow-list.mjs";
import { RUN_BROWSER_MARK } from "../lib/auth.mjs";
import { canaryTestedVersions } from "../lib/canary-state.mjs";

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL("../server.mjs", import.meta.url));
const testedVersions = JSON.parse(readFileSync(new URL("./claude-code.tested.json", import.meta.url), "utf8"));

// Concrete on purpose: with a vaguer prompt, a real build run edited files through heredocs and sed, and each edit waited on a person.
const SYSTEM_PROMPT = "A person must approve any tool call outside this run's allow list, and the run waits until they answer from their phone. "
  + "Change files only with the Edit and Write tools, never with shell redirection, heredocs, tee or sed -i. "
  + "Keep each Bash call to plain commands, without variable assignments or subshells. "
  + "This holds even where other guidance suggests editing through the shell.";
const ASK_PROMPT = " This run only answers a question: read what you need and change nothing.";
const RESULT_DETAIL_MAX = 8000;
// What Claude Code's sandbox needs on Linux. Without them it runs commands unsandboxed and says nothing.
const SANDBOX_TOOLS = ["bwrap", "socat"];
// Credentials nothing inside the sandbox needs; gh's own config stays readable, because gh pr view needs it.
const SECRET_PATHS = [".ssh", ".gnupg", ".aws", ".netrc", ".git-credentials", ".npmrc", ".docker", ".codex", ".claude/.credentials.json", ".claude.json"];
const INPUT_KEYS = ["command", "description", "file_path", "path", "pattern", "url", "query", "skill", "subagent_type", "prompt"];

function onPath(name) {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    try {
      accessSync(path.join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Why Claude Code's sandbox can't start here, or nothing. Having bubblewrap is not enough: some systems
 * (Ubuntu 24.04, for one) forbid the user namespaces it needs, and a seccomp filter on segwi's own process
 * can block it too, so this starts a throwaway sandbox to see and passes on bubblewrap's own reason.
 */
export function probeSandbox() {
  const missing = SANDBOX_TOOLS.filter((name) => !onPath(name));
  if (missing.length) return [`Claude Code's sandbox can't start: install bubblewrap and socat (missing: ${missing.join(", ")}).`];
  const trial = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "true"], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 5000 });
  if (trial.status !== 0) {
    const reason = trial.error?.message ?? (trial.stderr.trim().split("\n").at(-1).slice(0, 300) || `exit ${trial.status ?? trial.signal}`);
    return [`Claude Code's sandbox can't start: bubblewrap is installed but can't create a sandbox here (${reason}).`];
  }
  return [];
}

/**
 * Everything in the worktree root when the run starts that isn't for it: other repositories' folders whole, and
 * in this repository's folders (where its worktrees already are) every existing worktree and evidence folder.
 * Those are other sessions', your own included, and planting files there would reach git commands you run later.
 * The run's own worktree doesn't exist yet: ibni prepare makes it.
 */
async function existingWorkspaces(worktreeRoot, repoPath) {
  let listing = "";
  try {
    ({ stdout: listing } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], { timeout: 5000 }));
  } catch {
    // No worktree list: every folder counts as another repository's.
  }
  // The first entry is the control checkout itself, which isn't one of the worktree root's folders.
  const linked = listing.split("\n").filter((line) => line.startsWith("worktree ")).slice(1);
  const ownFolders = new Set(linked.map((line) => path.dirname(path.resolve(line.slice(9)))));
  // Real entries only: the sandbox resolves a symlink, so denying one would deny wherever it points.
  const list = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name); } catch { return []; } };
  return list(worktreeRoot).flatMap((name) => {
    const folder = path.join(worktreeRoot, name);
    return ownFolders.has(folder) ? list(folder).map((leaf) => path.join(folder, leaf)) : [folder];
  });
}

/** The control checkout's shared git directory, where a linked worktree's commits land. */
async function gitCommonDir(repoPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 });
    return stdout.trim() || path.join(repoPath, ".git");
  } catch {
    return path.join(repoPath, ".git");
  }
}

/** The first stdin line for each action. `ready` appends a task only if one is given. */
export function actionMessage({ action, task }) {
  if (action === "build") return `/wettaq ${task}`;
  if (action === "ready") return task ? `/lesti\n\n${task}` : "/lesti";
  return task;
}

/** The host's argument array. Pure, so a test can pin it. */
export function buildArgs({ spec, sessionId, settingsFile, mcpFile }) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--session-id", sessionId,
    "--setting-sources", "user",
    // Not plan mode for ask: it lets network commands such as curl run unasked
    // and switches to a larger model than --model names (see the plan's Spike results).
    "--permission-mode", "default",
    "--settings", settingsFile,
    "--max-turns", String(spec.limits.maxTurns),
    ...(spec.model ? ["--model", spec.model] : []),
    "--add-dir", spec.worktreeRoot,
    "--permission-prompt-tool", "mcp__segwi__approve",
    "--mcp-config", mcpFile,
    "--strict-mcp-config",
    "--append-system-prompt", spec.action === "ask" ? SYSTEM_PROMPT + ASK_PROMPT : SYSTEM_PROMPT,
  ];
}

// The run's browser says so in every request (see RUN_BROWSER_MARK in lib/auth.mjs).
const RUN_BROWSER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${RUN_BROWSER_MARK}`;

/** Every origin segwi answers on: loopback at its port and, behind tailscale serve, the tailnet name. */
const ownOrigins = ({ bindPort, tailnetName }) => [
  ...(bindPort ? [`http://127.0.0.1:${bindPort}`, `http://localhost:${bindPort}`, `http://[::1]:${bindPort}`] : []),
  ...(tailnetName ? [`https://${tailnetName}`, `http://${tailnetName}`] : []),
].join(";");

export function renderMcpConfig({ spec }) {
  return {
    mcpServers: {
      segwi: {
        command: process.execPath,
        args: [serverEntry, "approver", "--run", spec.runId],
        env: { SEGWI_URL: spec.serverUrl ?? "", SEGWI_RUN_SECRET: spec.runSecret ?? "" },
      },
      // The browser runs outside the sandbox, and behind tailscale serve it would carry your identity,
      // so it must never reach segwi itself, or the agent could open the app and tap Approve.
      playwright: {
        command: "npx",
        args: ["-y", ...playwrightArguments(spec.browser), `--user-agent=${RUN_BROWSER_AGENT}`, ...(ownOrigins(spec) ? [`--blocked-origins=${ownOrigins(spec)}`] : [])],
      },
    },
  };
}

function summariseInput(input) {
  const summary = {};
  for (const key of INPUT_KEYS) {
    if (typeof input?.[key] === "string") summary[key] = input[key].slice(0, 2000);
  }
  return summary;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
  return "";
}

// The message types the host is known to write. A new one is not an error for a
// run, but the canary counts it, because it means the stream format moved.
const KNOWN_MESSAGE_TYPES = new Set(["system", "assistant", "user", "result", "rate_limit_event"]);

export const isKnownMessage = (message) => KNOWN_MESSAGE_TYPES.has(message?.type);

/** Maps one parsed stream-json object to RunEvents. Unknown shapes map to nothing. */
export function mapMessage(message) {
  const events = [];
  if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
    events.push({ kind: "session", hostSessionId: message.session_id });
  } else if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text) events.push({ kind: "text", text: block.text });
      else if (block.type === "tool_use") {
        events.push({ kind: "step", phase: "call", toolUseId: String(block.id), tool: String(block.name), input: summariseInput(block.input) });
      }
    }
  } else if (message.type === "user" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block.type === "tool_result") {
        events.push({
          kind: "step", phase: "result", toolUseId: String(block.tool_use_id), ok: block.is_error !== true,
          detail: resultText(block.content).slice(0, RESULT_DETAIL_MAX),
        });
      }
    }
  } else if (message.type === "result") {
    events.push({
      kind: "result",
      ok: message.subtype === "success" && message.is_error !== true,
      subtype: String(message.subtype ?? "unknown"),
      costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
      hostSessionId: typeof message.session_id === "string" ? message.session_id : null,
      durationMs: typeof message.duration_ms === "number" ? message.duration_ms : null,
    });
  }
  return events;
}

/**
 * @param {{ bin?: string, binArgs?: string[], dataDir?: string, killGraceMs?: [number, number], stateDir?: string|null,
 *   onUnknown?: (what: string) => void, onLine?: (line: string) => void, sandboxProblems?: () => string[] }} [options]
 *   `bin` and `binArgs` exist for tests and the canary only; nothing from config, a request or the environment reaches them.
 *   `sandboxProblems` lets tests decide whether the sandbox can start, whatever this machine has installed.
 *   `stateDir` is where a canary's passed versions are read from. `onUnknown` hears each line the adapter did not
 *   recognise, and `onLine` each raw line of the host's output, both for the canary.
 */
export function createClaudeCodeAdapter({ bin = "claude", binArgs = [], dataDir = path.join(os.tmpdir(), "segwi"), killGraceMs = [10_000, 5_000], stateDir = null, onUnknown = () => {}, onLine = () => {},
  sandboxProblems = probeSandbox } = {}) {
  /** @type {Map<string, { child: import("node:child_process").ChildProcess, closed: boolean, timers: NodeJS.Timeout[] }>} */
  const processes = new Map();

  async function detect() {
    const problems = [];
    let version = null;
    try {
      const { stdout } = await execFileAsync(bin, [...binArgs, "--version"], { timeout: 5000 });
      version = stdout.trim().split(/\s+/)[0] || null;
    } catch {
      problems.push("Claude Code did not answer `claude --version`.");
    }
    // The repository file is the reviewed baseline; a passing canary adds the version it ran against.
    const tested = [...new Set([...testedVersions, ...canaryTestedVersions(stateDir)])];
    if (version && !tested.includes(version)) {
      problems.push(`Claude Code ${version} has not been tested with segwi (tested: ${tested.join(", ")}).`);
    }
    const sandbox = sandboxProblems();
    return { available: version !== null, version, testedVersions: tested, problems, sandbox: { available: !sandbox.length, problems: sandbox } };
  }

  async function start(spec, emit) {
    const runDir = path.join(dataDir, "runs", spec.runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const settingsFile = path.join(runDir, "settings.json");
    const mcpFile = path.join(runDir, "mcp.json");
    const tempDir = `/tmp/claude-${process.getuid?.() ?? 0}`;
    const commonDir = await gitCommonDir(spec.repoPath);
    const branchPrefix = spec.branchPrefix ?? "agent/";
    // The sandbox can only open a path that exists, and ibni prepare makes the first branch under the prefix later.
    if (spec.action !== "ask") await Promise.all(gitWritePaths(commonDir, branchPrefix).map((dir) => mkdir(dir, { recursive: true })));
    const home = os.homedir();
    const secrets = [...SECRET_PATHS.map((name) => path.join(home, name)), dataDir, ...(stateDir ? [stateDir] : [])].filter((file) => existsSync(file));
    const existingGit = spec.action === "ask" ? [] : [
      ...["worktrees", path.join("refs", "heads", branchPrefix.replace(/\/+$/, ""))]
        .flatMap((part) => readdirSync(path.join(commonDir, part)).map((name) => path.join(commonDir, part, name))),
      ...await existingWorkspaces(spec.worktreeRoot, spec.repoPath),
    ];
    const settings = renderSettings({
      action: spec.action, worktreeRoot: spec.worktreeRoot, verifyCommand: spec.verifyCommand, denyPatterns: spec.denyPatterns, repoPath: spec.repoPath,
      tempDir, gitCommonDir: commonDir, branchPrefix, controlEntries: readdirSync(spec.repoPath), existingGit, denyRead: secrets,
    });
    await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await writeFile(mcpFile, `${JSON.stringify(renderMcpConfig({ spec }), null, 2)}\n`, { mode: 0o600 });

    if (!isPlainVerifyCommand(spec.verifyCommand)) emit({ kind: "text", text: VERIFY_NOT_ALLOWED });
    const sessionId = randomUUID();
    const args = [...binArgs, ...buildArgs({ spec, sessionId, settingsFile, mcpFile })];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SEGWI_")));
    // The approval tool holds its call open until a person answers, so Claude
    // Code must not give up on an MCP call before segwi's own approval expiry.
    env.MCP_TOOL_TIMEOUT = String((spec.limits.approvalTimeoutMinutes + 1) * 60_000);
    // The sandbox can't write the home npm cache, so npm keeps one in the run's temporary directory.
    env.npm_config_cache = path.join(tempDir, "npm-cache");
    // Every git command in the run, ibni prepare's outside the sandbox too, uses only your own hooks: a hooks path
    // set to a folder in the repository (as husky does) would run hooks the agent can edit. Added after any
    // GIT_CONFIG_* entries you set yourself, never in their place.
    const configCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
    Object.assign(env, { GIT_CONFIG_COUNT: String(configCount + 1), [`GIT_CONFIG_KEY_${configCount}`]: "core.hooksPath", [`GIT_CONFIG_VALUE_${configCount}`]: path.join(commonDir, "hooks") });
    // The run's ibni commands are sandboxed and can't lock the checkout's git directory, so they lock here.
    env.IBNI_LOCK_ROOT = path.join(tempDir, "ibni-locks");
    // ibni prepare runs outside the sandbox, and its sweep would run git in worktrees this run could rewrite.
    env.IBNI_SKIP_SWEEP = "1";
    // A build or ready run starts outside the control checkout (see allow-list.mjs), so ibni prepare is told where it is.
    const startDir = spec.action === "ask" ? spec.repoPath : spec.worktreeRoot;
    if (spec.action !== "ask") {
      env.IBNI_LAUNCH_CHECKOUT = spec.repoPath;
      await mkdir(startDir, { recursive: true });
    }
    // Its own process group, so a stop reaches what the host started (MCP servers, browsers, background
    // shells) and not only the host itself.
    const child = spawn(bin, args, { cwd: startDir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const entry = { child, closed: false, timers: [] };
    processes.set(spec.runId, entry);

    let buffer = "";
    let stderrTail = "";
    const handleLine = (line) => {
      if (!line.trim()) return;
      onLine(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        onUnknown("an unreadable line");
        emit({ kind: "error", message: `Unreadable line from the host: ${line.slice(0, 120)}` });
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        onUnknown("a line that is not an object");
        emit({ kind: "error", message: `Unexpected line from the host: ${line.slice(0, 120)}` });
        return;
      }
      if (!isKnownMessage(message)) onUnknown(`a "${String(message.type).slice(0, 40)}" message`);
      for (const event of mapMessage(message)) emit(event);
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-500); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      emit({ kind: "error", message: `Could not start the host: ${error.code ?? error.message}` });
      emit({ kind: "exit", code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      if (buffer.trim()) handleLine(buffer);
      processes.delete(spec.runId);
      // The host is gone; anything it left in its group is ended too, with the same grace a stop gives.
      if (groupAlive(child.pid)) {
        if (!entry.timers.length) escalate(entry, ["SIGTERM", "SIGKILL"], [0, killGraceMs[1]]);
      } else {
        entry.timers.forEach(clearTimeout);
      }
      if (code !== 0 && stderrTail.trim()) emit({ kind: "error", message: `Host said: ${stderrTail.trim().slice(-300)}` });
      emit({ kind: "exit", code, signal });
    });

    writeUserLine(child, actionMessage(spec));
    emit({ kind: "session", hostSessionId: sessionId });
    return { hostSessionId: sessionId };
  }

  /** Signals the host's whole process group; false once the group is gone. */
  function signalGroup(pid, signal) {
    if (!pid) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  const groupAlive = (pid) => signalGroup(pid, 0);

  /** Sends each signal to the group after its delay, stopping early once the group is gone. */
  function escalate(entry, signals, delays) {
    let at = 0;
    signals.forEach((signal, index) => {
      at += delays[index];
      const timer = setTimeout(() => {
        if (!signalGroup(entry.child.pid, signal)) entry.timers.forEach(clearTimeout);
      }, at);
      timer.unref();
      entry.timers.push(timer);
    });
  }

  function writeUserLine(child, text) {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
  }

  function entryFor(runId) {
    const entry = processes.get(runId);
    if (!entry) throw new Error("The host is not running.");
    return entry;
  }

  return {
    id: "claude-code",
    capabilities: { input: true, approvals: true, cost: true },
    detect,
    start,
    send(runId, text) {
      const entry = entryFor(runId);
      if (entry.closed) throw new Error("The host's input is closed.");
      writeUserLine(entry.child, text);
    },
    answer() {
      throw new Error("Approvals arrive in a later version.");
    },
    close(runId) {
      const entry = processes.get(runId);
      if (!entry || entry.closed) return;
      entry.closed = true;
      entry.child.stdin.end();
    },
    stop(runId) {
      const entry = processes.get(runId);
      if (!entry) return;
      entry.closed = true;
      entry.timers.forEach(clearTimeout);
      entry.timers = [];
      signalGroup(entry.child.pid, "SIGINT");
      escalate(entry, ["SIGTERM", "SIGKILL"], killGraceMs);
    },
    /**
     * segwi is exiting and its timers won't outlive it, so every host's group gets SIGTERM now and
     * SIGKILL after `graceMs`. Resolves once every group is gone.
     */
    async shutdown(graceMs = 2000) {
      const pids = [...processes.values()].map((entry) => entry.child.pid).filter(Boolean);
      pids.forEach((pid) => signalGroup(pid, "SIGTERM"));
      const deadline = Date.now() + graceMs;
      while (pids.some(groupAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      pids.forEach((pid) => signalGroup(pid, "SIGKILL"));
    },
  };
}
