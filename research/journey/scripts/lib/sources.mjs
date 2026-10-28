// Readers for each host's session store. Each yields sessions one at a time in
// one shape, so a 4 GB database never sits in memory at once:
//
//   { source, id, cwd, start, end, model, events }
//
// where start and end are epoch milliseconds and events are, in order:
//   { kind: "tool", tool, command, reads, edits, writes, output, failed, at, durationMs }
//   { kind: "prompt", text, at }   a message the person typed
//   { kind: "reply", text, at }    text the agent wrote
//   { kind: "compact", at }
//   { kind: "settle", tool, failed, at }  a background tool call finished
//
// tool is Bash, Read, Edit, Write or the host's own name for anything else.
// Only top-level sessions are read: subagent transcripts are left out, as
// scripts/retro/session_retro.py does.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT_CODE } from "./patterns.mjs";

const ms = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};

// --- Claude Code: ~/.claude/projects/<project>/<session>.jsonl --------------

const PROMPT_MARKERS = ["<command-", "<local-command", "<task-notification", "<system-reminder", "Base directory for this skill", "Caveat:", "This session is being continued"];

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item?.type === "text") return item.text ?? "";
    if (item?.type === "tool_result") return contentText(item.content);
    return "";
  }).join("\n");
}

const CLAUDE_TOOLS = { MultiEdit: "Edit", NotebookEdit: "Edit" };

function claudeTool(name, input) {
  const tool = CLAUDE_TOOLS[name] ?? name;
  const file = input?.file_path ?? input?.notebook_path;
  return {
    tool,
    command: tool === "Bash" ? String(input?.command ?? "") : null,
    reads: tool === "Read" && file ? [file] : [],
    edits: tool === "Edit" && file ? [file] : [],
    writes: tool === "Write" && file ? [file] : [],
  };
}

// One transcript's text in, one session out. Mirrors Session._ingest in
// session_retro.py: resumed sessions replay lines, so each uuid counts once.
export function parseClaudeTranscript(text, id) {
  const session = { source: "claude", id, cwd: null, start: null, end: null, model: null, events: [] };
  const seen = new Set();
  const pending = new Map();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.uuid) {
      if (seen.has(entry.uuid)) continue;
      seen.add(entry.uuid);
    }
    const at = ms(entry.timestamp);
    if (at !== null) {
      session.start = session.start === null ? at : Math.min(session.start, at);
      session.end = session.end === null ? at : Math.max(session.end, at);
    }
    session.cwd ??= entry.cwd ?? null;
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      session.events.push({ kind: "compact", at });
      continue;
    }
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (entry.type === "assistant" && Array.isArray(content)) {
      session.model ??= message.model ?? null;
      for (const item of content) {
        if (item?.type === "tool_use") {
          const event = { kind: "tool", ...claudeTool(item.name, item.input), output: "", failed: false, at, durationMs: null };
          pending.set(item.id, event);
          session.events.push(event);
        } else if (item?.type === "text" && item.text?.trim()) {
          session.events.push({ kind: "reply", text: item.text, at });
        }
      }
    } else if (entry.type === "user") {
      const results = Array.isArray(content) ? content.filter((item) => item?.type === "tool_result") : [];
      if (results.length) {
        for (const item of results) {
          const event = pending.get(item.tool_use_id);
          if (!event) continue;
          event.output = contentText(item.content);
          event.background = /running in background with ID/.test(event.output.slice(0, 200));
          event.failed = Boolean(item.is_error) || (event.tool === "Bash" && EXIT_CODE.test(event.output.slice(0, 200)));
          event.durationMs = at !== null && event.at !== null ? at - event.at : null;
        }
        continue;
      }
      const prompt = contentText(content);
      // A background command reports its outcome later, in a notification
      // that names the call it belongs to.
      const notice = prompt.match(/^\s*<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/);
      if (notice) {
        const event = pending.get(notice[1]);
        if (event) session.events.push({ kind: "settle", tool: event, failed: notice[2] !== "completed" || /exit code [1-9]/.test(prompt), at });
        continue;
      }
      if (entry.isMeta || entry.isSidechain || !prompt.trim() || /\[Request interrupted by user/.test(prompt)) continue;
      if (PROMPT_MARKERS.some((marker) => prompt.trimStart().startsWith(marker))) continue;
      session.events.push({ kind: "prompt", text: prompt, at });
    }
  }
  return session;
}

export async function* claudeSessions(projectsDir) {
  const projects = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const project of projects.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(projectsDir, project.name);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
    for (const name of files) {
      yield parseClaudeTranscript(await readFile(path.join(directory, name), "utf8"), name.slice(0, -6));
    }
  }
}

// --- OpenCode: ~/.local/share/opencode/opencode.db ------------------------

// apply_patch carries its files in the patch text; paths may be relative to
// the session's directory.
function patchFiles(patchText, cwd) {
  const edits = [];
  const writes = [];
  for (const match of String(patchText ?? "").matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)) {
    const file = path.resolve(cwd ?? "/", match[2].trim());
    (match[1] === "Add" ? writes : edits).push(file);
  }
  return { edits, writes };
}

export function openCodeTool(part, cwd) {
  const state = part.state ?? {};
  const input = state.input ?? {};
  const name = part.tool;
  const exit = state.metadata?.exit;
  const base = { output: String(state.output ?? state.error ?? ""), at: state.time?.start ?? null };
  base.durationMs = state.time?.end && state.time?.start ? state.time.end - state.time.start : null;
  base.failed = state.status === "error" || (name === "bash" && Number.isInteger(exit) && exit !== 0);
  const file = input.filePath ? path.resolve(cwd ?? "/", input.filePath) : null;
  switch (name) {
    case "bash":
      return { kind: "tool", tool: "Bash", command: String(input.command ?? ""), reads: [], edits: [], writes: [], ...base };
    case "read":
      return { kind: "tool", tool: "Read", command: null, reads: file ? [file] : [], edits: [], writes: [], ...base };
    case "edit":
      return { kind: "tool", tool: "Edit", command: null, reads: [], edits: file ? [file] : [], writes: [], ...base };
    case "write":
      return { kind: "tool", tool: "Write", command: null, reads: [], edits: [], writes: file ? [file] : [], ...base };
    case "apply_patch": {
      const { edits, writes } = patchFiles(input.patchText, cwd);
      return { kind: "tool", tool: edits.length ? "Edit" : "Write", command: null, reads: [], edits, writes, ...base };
    }
    default:
      return { kind: "tool", tool: name, command: null, reads: [], edits: [], writes: [], ...base };
  }
}

export async function* openCodeSessions(databaseFile) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }
  let db;
  try {
    db = new DatabaseSync(databaseFile, { readOnly: true });
  } catch {
    return;
  }
  const sessions = db.prepare("select id, directory, time_created, time_updated from session where parent_id is null order by time_created").all();
  const messages = db.prepare("select id, data from message where session_id = ? order by time_created, id");
  const parts = db.prepare("select message_id, time_created, data from part where session_id = ? order by time_created, id");
  try {
    for (const row of sessions) {
      const roles = new Map();
      let model = null;
      for (const message of messages.all(row.id)) {
        const data = JSON.parse(message.data);
        roles.set(message.id, data.role);
        if (data.role === "assistant") model ??= data.modelID ?? null;
      }
      const session = { source: "opencode", id: row.id, cwd: row.directory, start: row.time_created, end: row.time_updated, model, events: [] };
      for (const part of parts.all(row.id)) {
        const data = JSON.parse(part.data);
        const role = roles.get(part.message_id);
        const at = part.time_created;
        session.end = Math.max(session.end, at);
        if (data.type === "compaction") session.events.push({ kind: "compact", at });
        else if (data.type === "tool") session.events.push(openCodeTool(data, row.directory));
        else if (data.type === "text" && !data.synthetic && data.text?.trim()) {
          session.events.push({ kind: role === "user" ? "prompt" : "reply", text: data.text, at });
        }
      }
      yield session;
    }
  } finally {
    db.close();
  }
}

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl -----------------
// Only timing, place and tool-call counts are read: five sessions do not
// justify a third full parser (METHOD.md says so).

export async function* codexSessions(sessionsDir) {
  const files = (await readdir(sessionsDir, { recursive: true }).catch(() => []))
    .filter((name) => /rollout-.*\.jsonl$/.test(name)).sort();
  for (const name of files) {
    const session = { source: "codex", id: path.basename(name, ".jsonl"), cwd: null, start: null, end: null, model: null, events: [], toolCalls: 0, times: [] };
    for (const raw of (await readFile(path.join(sessionsDir, name), "utf8")).split("\n")) {
      if (!raw.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const at = ms(entry.timestamp);
      if (at !== null) {
        session.start = session.start === null ? at : Math.min(session.start, at);
        session.end = session.end === null ? at : Math.max(session.end, at);
        session.times.push(at);
      }
      if (entry.type === "session_meta") session.cwd ??= entry.payload?.cwd ?? null;
      if (entry.type === "response_item" && /^(custom_tool_call|function_call)$/.test(entry.payload?.type ?? "")) session.toolCalls += 1;
    }
    yield session;
  }
}
