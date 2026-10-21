#!/usr/bin/env node
// The loop breaker: a post-tool hook that counts identical failing shell
// commands per agent session. When the same command fails for the
// guard.repeatedFailureLimit-th time (third by default) it exits 2, and the
// host shows the agent the reason on stderr: stop retrying, re-diagnose.
//
// A successful edit (any host's file-editing tool) clears the session's
// counts, because rerunning a check after changing the code is the normal
// fix-and-verify loop, not a retry. A success of the same command clears that
// command's count. The decision is deterministic; Phase 6 may add a Jev
// judgement for near-identical retries.
//
// Hosts report a failure differently:
//   Claude Code  PostToolUseFailure with `error` ("Exit code N\n..."); its
//                PostToolUse fires only for successes.
//   Codex        PostToolUse for every outcome; the exit status sits in
//                `tool_response`, whose shape Codex does not document, so
//                exitCode() reads the forms it is known to take and treats
//                anything else as unknown (not counted).
//   OpenCode     its plugin passes the Claude Code shape, from the bash tool's
//                metadata.exit.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardConfig, SHELL_TOOLS } from "./guard-rules.mjs";

// File-editing tools by host: Claude Code, Codex (apply_patch), OpenCode.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit", "write", "patch"]);
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function stateDirectory(home = os.homedir()) {
  return path.join(home, ".local/share/mexxi/state/loop-breaker");
}

// The exit status a host reported, or null when it cannot be told. Only the
// host's own structure counts: an exit_code field, a JSON result, or the
// header the host writes above the command's output ("Exit code N" on the
// first line, or "Process exited with code N" before "Output:"). The command's
// own output never does, so a test log that prints "Exit code 1" is not a
// failure.
export function exitCode(response) {
  if (response === null || response === undefined) return null;
  if (typeof response === "number") return response;
  if (Array.isArray(response)) {
    for (const part of response) {
      const found = exitCode(part?.text ?? (typeof part === "string" ? part : null));
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof response === "object") {
    for (const value of [response.exit_code, response.exitCode, response.metadata?.exit_code, response.metadata?.exitCode]) {
      if (Number.isInteger(value)) return value;
    }
    // Host wrappers around the output; stdout is the command's own.
    for (const value of [response.output, response.content, response.text]) {
      const found = exitCode(value);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof response !== "string") return null;
  if (response.trimStart().startsWith("{")) {
    try {
      return exitCode(JSON.parse(response));
    } catch {
      return null;
    }
  }
  const outputStart = response.search(/^Output:/m);
  const header = outputStart === -1 ? response.split("\n", 1)[0] : response.slice(0, outputStart);
  const match = header.match(/^(?:Exit code|Process exited with code)[:\s]+(-?\d+)/im);
  return match ? Number(match[1]) : null;
}

function outcome(input) {
  if (input.hook_event_name === "PostToolUseFailure") {
    if (input.is_interrupt) return "unknown";
    // Claude Code: a command that ran and exited reports "Exit code N" first.
    return /^Exit code \d+/.test(input.error ?? "") ? "failed" : "unknown";
  }
  const code = exitCode(input.tool_response);
  if (code !== null) return code === 0 ? "succeeded" : "failed";
  // Claude Code's PostToolUse fires only for a success; its Bash result is
  // { stdout, stderr, interrupted, isImage } with no exit status.
  const response = input.tool_response;
  if (response && typeof response === "object" && typeof response.interrupted === "boolean") {
    return response.interrupted ? "unknown" : "succeeded";
  }
  return "unknown";
}

function sessionFile(directory, sessionId) {
  const name = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return path.join(directory, `${name}.json`);
}

async function pruneStale(directory, now) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > STALE_AFTER_MS) await rm(file, { force: true });
  }
}

// Records one tool result and returns the message for the agent, or null.
export async function recordToolResult(input, { limit, directory = stateDirectory(), now = Date.now() } = {}) {
  const sessionId = input?.session_id;
  if (!sessionId) return null;
  const tool = input.tool_name;
  const file = sessionFile(directory, sessionId);
  const read = async () => JSON.parse(await readFile(file, "utf8").catch(() => '{"counts":{},"isNew":true}'));
  if (EDIT_TOOLS.has(tool)) {
    if (input.hook_event_name !== "PostToolUseFailure") await rm(file, { force: true });
    return null;
  }
  const command = input.tool_input?.command;
  if (!SHELL_TOOLS.has(tool) || typeof command !== "string") return null;
  const result = outcome(input);
  if (result === "unknown") return null;
  const key = createHash("sha256").update(command.trim().replace(/\s+/g, " ")).digest("hex");
  const state = await read();
  if (result === "succeeded") {
    if (!(key in state.counts)) return null;
    delete state.counts[key];
  } else {
    state.counts[key] = (state.counts[key] ?? 0) + 1;
  }
  if (!Object.keys(state.counts).length) await rm(file, { force: true });
  else {
    await mkdir(directory, { recursive: true });
    // A session's first file is when abandoned sessions' files are swept.
    if (state.isNew) await pruneStale(directory, now);
    await writeFile(file, `${JSON.stringify({ counts: state.counts })}\n`);
  }
  const count = state.counts[key] ?? 0;
  if (result !== "failed" || count < (limit ?? 3)) return null;
  return `This exact command has now failed ${count} times in this session with no file edited in between: ${command.trim().slice(0, 200)}\nStop retrying it. Re-diagnose before running anything again: read the whole error, check the assumption it contradicts, and change the approach, or report the blocker with what you tried.`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(await readStdin());
    const config = await guardConfig();
    const message = await recordToolResult(input, { limit: config.guard.repeatedFailureLimit });
    if (message) {
      process.stderr.write(`mexxi loop breaker: ${message}\n`);
      process.exit(2);
    }
  } catch (error) {
    // Counting is advisory: a broken state file must never fail the tool call.
    process.stderr.write(`mexxi loop breaker skipped: ${error.message}\n`);
  }
}
