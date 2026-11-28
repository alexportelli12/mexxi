// Claude Code's session transcript (~/.claude/projects/<slug>/<id>.jsonl): find
// it, tail it as it grows, and fold it into rows a person can read.
//
// Rows are {seq, kind, data} and a row can change after it is first emitted (a
// tool step gains its result), so push() returns every row it added or updated.
// Kinds: user, assistant, tool (a collapsed step with a short title), question
// (the ask and, once answered, the answers), interrupted.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSessionId } from "./pending.mjs";

// Claude Code names a project folder after its cwd with every character that
// is not a letter or digit replaced by a dash.
export function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

// The hook's transcript_path is the best source; the slug rule is the fallback;
// searching every project folder for <id>.jsonl is the last resort (a session
// that was moved or resumed from another directory).
export function locateTranscript({ sessionId, transcriptPath = null, cwd = null, home = os.homedir() }) {
  if (!isSessionId(sessionId)) return null;
  if (transcriptPath && path.basename(transcriptPath) === sessionId + ".jsonl" && existsSync(transcriptPath)) return transcriptPath;
  const projects = path.join(home, ".claude", "projects");
  if (cwd) {
    const guess = path.join(projects, projectSlug(cwd), sessionId + ".jsonl");
    if (existsSync(guess)) return guess;
  }
  let folders;
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = path.join(projects, folder, sessionId + ".jsonl");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Reads what was appended since the last read. A line is handed over only when
// it is complete, so a write caught half-way is read next time. A file that got
// shorter (rewritten) is read again from the start.
export function openTail(file) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  return {
    read() {
      let size;
      try {
        size = statSync(file).size;
      } catch {
        return [];
      }
      if (size < offset) {
        offset = 0;
        pending = Buffer.alloc(0);
      }
      if (size === offset) return [];
      const fd = openSync(file, "r");
      let chunk;
      try {
        chunk = Buffer.alloc(size - offset);
        const got = readSync(fd, chunk, 0, chunk.length, offset);
        chunk = chunk.subarray(0, got);
      } finally {
        closeSync(fd);
      }
      offset += chunk.length;
      const data = Buffer.concat([pending, chunk]);
      const end = data.lastIndexOf(10);
      pending = end < 0 ? data : data.subarray(end + 1);
      if (end < 0) return [];
      const entries = [];
      for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // A damaged line is skipped; the rest of the transcript still reads.
        }
      }
      return entries;
    },
  };
}

const TITLE_LIMIT = 80;
const PROMPT_LIMIT = 200;
const INTERRUPTED = "[Request interrupted by user";

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

// A short title for a collapsed step: what it touched, not its whole input.
export function toolTitle(name, input = {}) {
  const base = (value) => (typeof value === "string" && value ? path.basename(value) : "");
  switch (name) {
    case "Bash":
      return clip(input.description || String(input.command ?? "").split("\n")[0] || "Bash", TITLE_LIMIT);
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return name + " " + (base(input.file_path) || "file");
    case "NotebookEdit":
      return "NotebookEdit " + (base(input.notebook_path) || "notebook");
    case "Grep":
    case "Glob":
      return name + " " + clip(input.pattern ?? "", 40);
    case "Task":
    case "Agent":
      return clip(input.description || name, TITLE_LIMIT);
    case "REPL":
      return "Code Mode";
    case "ExitPlanMode":
      return "Plan";
    default:
      return clip(name || "tool", TITLE_LIMIT);
  }
}

function userText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

export class TranscriptFolder {
  constructor() {
    this.rows = [];
    this.title = null;
    this.firstPrompt = null;
    this.steps = new Map();
  }

  #add(kind, data) {
    const row = { seq: this.rows.length + 1, kind, data };
    this.rows.push(row);
    return row;
  }

  // Folds one transcript entry; returns the rows it added or changed.
  push(entry) {
    if (!entry || typeof entry !== "object") return [];
    if (entry.type === "ai-title" || entry.type === "custom-title" || entry.type === "summary") {
      const title = entry.aiTitle ?? entry.customTitle ?? entry.summary;
      if (typeof title === "string" && title) this.title = title;
      return [];
    }
    if (entry.isSidechain || (entry.type !== "user" && entry.type !== "assistant")) return [];
    const content = entry.message?.content;
    return entry.type === "assistant" ? this.#assistant(content, entry.timestamp) : this.#user(entry, content);
  }

  #assistant(content, at) {
    const touched = [];
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "text" && block.text?.trim()) {
        touched.push(this.#add("assistant", { text: block.text, at }));
      } else if (block?.type === "tool_use") {
        const row = block.name === "AskUserQuestion"
          ? this.#add("question", { id: block.id, questions: block.input?.questions ?? [], answers: null, status: "asked", at })
          : this.#add("tool", { id: block.id, name: block.name, title: toolTitle(block.name, block.input), status: "running", at });
        this.steps.set(block.id, row);
        touched.push(row);
      }
    }
    return touched;
  }

  #user(entry, content) {
    const touched = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const row = this.steps.get(block.tool_use_id);
        if (!row) continue;
        const result = entry.toolUseResult;
        if (row.kind === "question") {
          const answers = result && typeof result === "object" && result.answers && typeof result.answers === "object" ? result.answers : null;
          row.data.answers = answers;
          row.data.status = answers ? "answered" : "declined";
        } else {
          row.data.status = result?.interrupted ? "interrupted" : block.is_error ? "error" : "done";
        }
        touched.push(row);
      }
    }
    if (entry.isMeta) return touched;
    const text = userText(content).trim();
    if (!text) return touched;
    if (text.startsWith(INTERRUPTED)) {
      touched.push(this.#add("interrupted", { text, at: entry.timestamp }));
      return touched;
    }
    if (this.firstPrompt === null) this.firstPrompt = clip(text, PROMPT_LIMIT);
    touched.push(this.#add("user", { text, at: entry.timestamp }));
    return touched;
  }
}

// What a viewer shows as the session's name when nobody renamed it.
export function displayTitle(folder) {
  return folder.title ?? folder.firstPrompt ?? null;
}

// Tool calls that already have a result, for pending.gcResolved.
export function resolvedToolUseIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (entry?.type !== "user" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content) if (block?.type === "tool_result" && block.tool_use_id) ids.add(block.tool_use_id);
  }
  return ids;
}
