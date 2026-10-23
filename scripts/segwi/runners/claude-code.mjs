// The Claude Code adapter: host mechanics only. It builds the headless command
// from a fixed argument array, renders the per-run settings and MCP config, and
// turns the host's stream-json output into normalised RunEvents. No caller value
// reaches the command line: the task goes to stdin, the rest comes from config.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { playwrightArguments } from "../../lib/browser.mjs";
import { isPlainVerifyCommand, renderSettings, VERIFY_NOT_ALLOWED } from "../lib/allow-list.mjs";

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

const ownOrigins = (port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].join(";");

export function renderMcpConfig({ spec }) {
  return {
    mcpServers: {
      segwi: {
        command: process.execPath,
        args: [serverEntry, "approver", "--run", spec.runId],
        env: { SEGWI_URL: spec.serverUrl ?? "", SEGWI_RUN_SECRET: spec.runSecret ?? "" },
      },
      // The run's browser must never reach segwi itself, or the agent could open the app and tap Approve.
      playwright: { command: "npx", args: ["-y", ...playwrightArguments(spec.browser), ...(spec.bindPort ? [`--blocked-origins=${ownOrigins(spec.bindPort)}`] : [])] },
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
 * @param {{ bin?: string, binArgs?: string[], dataDir?: string, killGraceMs?: [number, number] }} [options]
 *   `bin` and `binArgs` exist for tests only; nothing from config, a request or the environment reaches them.
 */
export function createClaudeCodeAdapter({ bin = "claude", binArgs = [], dataDir = path.join(os.tmpdir(), "segwi"), killGraceMs = [10_000, 5_000] } = {}) {
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
    if (version && !testedVersions.includes(version)) {
      problems.push(`Claude Code ${version} has not been tested with segwi (tested: ${testedVersions.join(", ")}).`);
    }
    const missing = ["bwrap", "socat"].filter((name) => !onPath(name));
    const sandboxProblems = missing.length ? ["Claude Code's sandbox can't start: install bubblewrap and socat."] : [];
    return { available: version !== null, version, testedVersions, problems, sandbox: { available: !missing.length, problems: sandboxProblems } };
  }

  async function start(spec, emit) {
    const runDir = path.join(dataDir, "runs", spec.runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const settingsFile = path.join(runDir, "settings.json");
    const mcpFile = path.join(runDir, "mcp.json");
    const settings = renderSettings({
      worktreeRoot: spec.worktreeRoot, verifyCommand: spec.verifyCommand, denyPatterns: spec.denyPatterns,
      tempDir: `/tmp/claude-${process.getuid?.() ?? 0}`,
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
    const child = spawn(bin, args, { cwd: spec.repoPath, env, stdio: ["pipe", "pipe", "pipe"] });
    const entry = { child, closed: false, timers: [] };
    processes.set(spec.runId, entry);

    let buffer = "";
    let stderrTail = "";
    const handleLine = (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        emit({ kind: "error", message: `Unreadable line from the host: ${line.slice(0, 120)}` });
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        emit({ kind: "error", message: `Unexpected line from the host: ${line.slice(0, 120)}` });
        return;
      }
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
      entry.timers.forEach(clearTimeout);
      processes.delete(spec.runId);
      if (code !== 0 && stderrTail.trim()) emit({ kind: "error", message: `Host said: ${stderrTail.trim().slice(-300)}` });
      emit({ kind: "exit", code, signal });
    });

    writeUserLine(child, actionMessage(spec));
    emit({ kind: "session", hostSessionId: sessionId });
    return { hostSessionId: sessionId };
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
      entry.child.kill("SIGINT");
      entry.timers.push(
        setTimeout(() => entry.child.kill("SIGTERM"), killGraceMs[0]),
        setTimeout(() => entry.child.kill("SIGKILL"), killGraceMs[0] + killGraceMs[1]),
      );
      entry.timers.forEach((timer) => timer.unref());
    },
  };
}
