#!/usr/bin/env node
// The ħares hook for Claude Code. It only records what is pending; it never
// decides anything. Every path ends in exit 0 with nothing on stdout, because
// Claude Code reads stdout JSON from PreToolUse and PermissionRequest hooks as a
// decision, and a hook that failed must not block the session.
//
// Events (see lib/pending.mjs for the files):
//   PreToolUse AskUserQuestion / ExitPlanMode / REPL  -> question or plan record
//   PermissionRequest                                 -> permission record
//   Notification                                      -> hint record
//   PostToolUse / PostToolUseFailure                  -> clear that tool call
//   UserPromptSubmit / Stop / SessionEnd              -> clear the session
import { pathToFileURL } from "node:url";
import {
  MAX_RECORD_BYTES, clearForTool, clearSession, extractAskUserQuestion, hashInput, isSessionId, recordIdFor, writeRecord,
} from "./lib/pending.mjs";

const STDIN_MS = 1000;
const STDIN_MAX_BYTES = 8 * 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_MS);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > STDIN_MAX_BYTES) return finish();
      chunks.push(chunk);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

function baseRecord(input, env, kind, extra) {
  return {
    v: 1,
    at: new Date().toISOString(),
    event: input.hook_event_name,
    kind,
    sessionId: input.session_id,
    paneId: env.HERDR_PANE_ID || null,
    cwd: typeof input.cwd === "string" ? input.cwd : null,
    transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : null,
    toolName: typeof input.tool_name === "string" ? input.tool_name : null,
    input: input.tool_input ?? null,
    inputHash: hashInput(input.tool_input),
    suggestions: null,
    ...extra,
  };
}

function store(record, options) {
  record.recordId = recordIdFor({ kind: record.kind, toolUseId: record.toolUseId, event: record.event, toolName: record.toolName, input: record.input });
  // A record too big to show is kept as a marker, so the card can say so.
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) {
    Object.assign(record, { input: null, suggestions: null, message: null, truncated: true });
  }
  writeRecord(record, options);
}

// Exported so a test can drive it without a process.
export function handleHookInput(input, { env = process.env, home } = {}) {
  if (!input || typeof input !== "object" || !isSessionId(input.session_id)) return;
  const options = { env, ...(home ? { home } : {}) };
  const sessionId = input.session_id;
  switch (input.hook_event_name) {
    case "PreToolUse": {
      if (input.tool_name === "AskUserQuestion") store(baseRecord(input, env, "question"), options);
      else if (input.tool_name === "ExitPlanMode") store(baseRecord(input, env, "plan"), options);
      else if (input.tool_name === "REPL") {
        const asked = extractAskUserQuestion(input.tool_input?.code);
        if (!asked.found) return;
        // The record keeps the literal, never the code around it.
        const record = baseRecord(input, env, "question", { via: "repl" });
        if (asked.unparsed) Object.assign(record, { input: null, inputHash: hashInput(null), unparsed: true });
        else Object.assign(record, { input: asked.input, inputHash: hashInput(asked.input) });
        store(record, options);
      }
      return;
    }
    case "PermissionRequest": {
      // These two tools' prompts are their question and plan records; a second
      // permission record would show the same prompt twice.
      if (input.tool_name === "AskUserQuestion" || input.tool_name === "ExitPlanMode") return;
      store(baseRecord(input, env, "permission", { suggestions: input.permission_suggestions ?? null }), options);
      return;
    }
    case "Notification": {
      const record = baseRecord(input, env, "hint", {
        notificationType: typeof input.notification_type === "string" ? input.notification_type : null,
        message: typeof input.message === "string" ? input.message.slice(0, 2000) : null,
      });
      // One hint per session: the latest replaces the last.
      record.recordId = "hint";
      writeRecord(record, options);
      return;
    }
    case "PostToolUse":
    case "PostToolUseFailure":
      clearForTool(sessionId, { toolUseId: input.tool_use_id ?? null, toolName: input.tool_name ?? null, input: input.tool_input }, options);
      return;
    case "UserPromptSubmit":
    case "Stop":
    case "SessionEnd":
      clearSession(sessionId, options);
      return;
    default:
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  handleHookInput(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
