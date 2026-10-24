// The Claude Code adapter: host mechanics only. It builds the headless command
// from a fixed argument array, renders the per-run MCP config, and turns the
// host's stream-json output into normalised RunEvents. A run is the session you
// would start by hand (decision 0016): your own settings, auto mode, your checkout.
// No caller value reaches the command line: the task goes to stdin, the rest comes from config.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { playwrightArguments } from "../../lib/browser.mjs";
import { RUN_BROWSER_MARK } from "../lib/auth.mjs";
import { canaryTestedVersions } from "../lib/canary-state.mjs";

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL("../server.mjs", import.meta.url));
const testedVersions = JSON.parse(readFileSync(new URL("./claude-code.tested.json", import.meta.url), "utf8"));

// Auto mode refuses some calls and asks nobody first, so the agent is told what to do then: stop and ask, which shows
// as "Needs your reply". The same rule holds in a session you start by hand.
const REFUSAL_PROMPT = "Claude Code's auto mode reviews each tool call and may refuse it. "
  + "If an action is refused, never retry it in pieces or rephrase it, and don't reach the same result another way, even where the refusal suggests one: "
  + "stop and ask the person what to do, saying what you were trying to do and why, then wait for their reply.";
const ASK_PROMPT = " This run only answers a question: read what you need and change nothing.";
// An ask run promises to change nothing, so the tools that write files are taken away. Not plan mode: it let network
// commands such as curl run unasked and switched to a larger model than --model names (decision 0011).
const ASK_DISALLOWED_TOOLS = "Edit,Write,NotebookEdit";
const RESULT_DETAIL_MAX = 8000;
const INPUT_KEYS = ["command", "description", "file_path", "path", "pattern", "url", "query", "skill", "subagent_type", "prompt"];

/** The first stdin line for each action. `ready` appends a task only if one is given. */
export function actionMessage({ action, task }) {
  if (action === "build") return `/wettaq ${task}`;
  if (action === "ready") return task ? `/lesti\n\n${task}` : "/lesti";
  return task;
}

/** The appended system prompt for a run, from its action. */
export function systemPrompt(spec) {
  return REFUSAL_PROMPT + (spec.action === "ask" ? ASK_PROMPT : "");
}

/**
 * The host's argument array. Pure, so a test can pin it. No --settings and no --setting-sources: Claude Code reads
 * your own settings, with mexxi's guard hook, loop breaker and deny list, as in a session you start yourself.
 */
export function buildArgs({ spec, sessionId, mcpFile }) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--session-id", sessionId,
    "--permission-mode", "auto",
    "--max-turns", String(spec.limits.maxTurns),
    ...(spec.model ? ["--model", spec.model] : []),
    // ibni prepare makes the run's worktree under the worktree root, outside the checkout the run starts in.
    "--add-dir", spec.worktreeRoot,
    ...(spec.action === "ask" ? ["--disallowedTools", ASK_DISALLOWED_TOOLS] : []),
    // The rare call auto mode escalates, after its classifier has refused several in a row, goes to a person.
    "--permission-prompt-tool", "mcp__segwi__approve",
    "--mcp-config", mcpFile,
    "--strict-mcp-config",
    "--append-system-prompt", systemPrompt(spec),
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
      // segwi's own browser, not your Playwright MCP server (--strict-mcp-config), because behind tailscale serve it
      // would carry your identity: it must never reach segwi itself, or the agent could open the app and tap Approve.
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
  if (input?.run_in_background === true) summary.run_in_background = true;
  return summary;
}

const BACKGROUND_MAX = 20;
const DESCRIPTION_MAX = 200;

/**
 * What one host session still runs in the background, from the system messages Claude Code 2.1.310 wrote in a
 * recorded run (fixtures/claude-code/background-*.jsonl). `background_tasks_changed` lists every task still
 * running, a Bash command started with run_in_background and a Monitor alike; `task_started` names the call that
 * started one. When a task ends, `task_notification` arrives and the host starts a turn of its own to read it,
 * even after the agent ended its turn; only a task the agent stopped itself (status "stopped") starts none.
 */
export function createBackgroundTracker() {
  let tasks = [];
  const callFor = new Map();
  let wakePending = false;
  const event = () => ({ kind: "background", tasks: tasks.map((task) => ({ ...task, toolUseId: callFor.get(task.taskId) ?? null })) });
  return {
    get wakePending() { return wakePending; },
    /** The events a system message adds: the whole list again whenever it, or the call behind a task, changes. */
    see(message) {
      if (message.type !== "system") return [];
      if (message.subtype === "init") wakePending = false;
      if (message.subtype === "task_notification" && message.status !== "stopped") wakePending = true;
      if (message.subtype === "task_started" && typeof message.task_id === "string" && typeof message.tool_use_id === "string") {
        callFor.set(message.task_id, message.tool_use_id);
        return tasks.some((task) => task.taskId === message.task_id) ? [event()] : [];
      }
      if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
        tasks = message.tasks.filter((task) => typeof task?.task_id === "string" && task.task_id).slice(0, BACKGROUND_MAX)
          .map((task) => ({ taskId: task.task_id, description: typeof task.description === "string" ? task.description.slice(0, DESCRIPTION_MAX) : "" }));
        return [event()];
      }
      return [];
    },
  };
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
  return "";
}

// How Claude Code words a call it refused itself, as real 2.1.309 runs wrote it: the auto mode classifier, a deny
// rule (guard.deny, from your settings) and a PreToolUse hook such as mexxi's guard. A person's denial is already on
// the run as an approval, so the approval tool's own wording is not one of these.
const REFUSALS = [
  { pattern: /^Permission for this action was denied by the Claude Code auto mode classifier\. Reason: (.+?)(?:\. If you have other tasks|\s*$)/s, reason: (match) => `auto mode: ${match[1].trim().replace(/\.$/, "")}` },
  { pattern: /^Permission to use \S+(?: with command .*)? has been denied\.?\s*$/s, reason: () => "a deny rule" },
  { pattern: /^PreToolUse:\S+ hook error: (?:\[[^\]]*\]: )?(.+?)(?:;|\.\s|\n|$)/s, reason: (match) => match[1].trim() },
];
const REFUSAL_REASON_MAX = 300;

/** Why Claude Code refused a call, from its error result, or null when it ran (or a person decided). */
export function refusalReason(text) {
  for (const { pattern, reason } of REFUSALS) {
    const match = pattern.exec(text);
    if (match) return reason(match).slice(0, REFUSAL_REASON_MAX);
  }
  return null;
}

// The message types the host is known to write. A new one is not an error for a
// run, but the canary counts it, because it means the stream format moved.
const KNOWN_MESSAGE_TYPES = new Set(["system", "assistant", "user", "result", "rate_limit_event"]);

export const isKnownMessage = (message) => KNOWN_MESSAGE_TYPES.has(message?.type);

/** Maps one parsed stream-json object to RunEvents. Unknown shapes map to nothing. `background` follows one session. */
export function mapMessage(message, background = createBackgroundTracker()) {
  const events = [];
  if (message.type === "system") {
    if (message.subtype === "init" && typeof message.session_id === "string") events.push({ kind: "session", hostSessionId: message.session_id });
    events.push(...background.see(message));
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
        const text = resultText(block.content);
        events.push({ kind: "step", phase: "result", toolUseId: String(block.tool_use_id), ok: block.is_error !== true, detail: text.slice(0, RESULT_DETAIL_MAX) });
        const reason = block.is_error === true ? refusalReason(text) : null;
        if (reason) events.push({ kind: "refusal", toolUseId: String(block.tool_use_id), reason });
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
      wakePending: background.wakePending,
    });
  }
  return events;
}

/**
 * @param {{ bin?: string, binArgs?: string[], dataDir?: string, killGraceMs?: [number, number], stateDir?: string|null,
 *   onUnknown?: (what: string) => void, onLine?: (line: string) => void }} [options]
 *   `bin` and `binArgs` exist for tests and the canary only; nothing from config, a request or the environment reaches them.
 *   `stateDir` is where a canary's passed versions are read from. `onUnknown` hears each line the adapter did not
 *   recognise, and `onLine` each raw line of the host's output, both for the canary.
 */
export function createClaudeCodeAdapter({ bin = "claude", binArgs = [], dataDir = path.join(os.tmpdir(), "segwi"), killGraceMs = [10_000, 5_000], stateDir = null, onUnknown = () => {}, onLine = () => {} } = {}) {
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
    return { available: version !== null, version, testedVersions: tested, problems };
  }

  async function start(spec, emit) {
    const runDir = path.join(dataDir, "runs", spec.runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const mcpFile = path.join(runDir, "mcp.json");
    await writeFile(mcpFile, `${JSON.stringify(renderMcpConfig({ spec }), null, 2)}\n`, { mode: 0o600 });

    const sessionId = randomUUID();
    const args = [...binArgs, ...buildArgs({ spec, sessionId, mcpFile })];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SEGWI_")));
    // segwi's service runs with NODE_ENV=production, and a run is a developer's session: under it npm ci skips
    // devDependencies, so the repository's test and build tools would be missing.
    delete env.NODE_ENV;
    // The approval tool holds its call open until a person answers, so Claude
    // Code must not give up on an MCP call before segwi's own approval expiry.
    env.MCP_TOOL_TIMEOUT = String((spec.limits.approvalTimeoutMinutes + 1) * 60_000);
    // In your checkout, where you would start claude yourself and where /wettaq's ibni prepare expects to be. Its
    // own process group, so a stop reaches what the host started (MCP servers, browsers, background shells) and
    // not only the host itself.
    const child = spawn(bin, args, { cwd: spec.repoPath, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const entry = { child, closed: false, timers: [] };
    processes.set(spec.runId, entry);

    let buffer = "";
    let stderrTail = "";
    const background = createBackgroundTracker();
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
      for (const event of mapMessage(message, background)) emit(event);
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
