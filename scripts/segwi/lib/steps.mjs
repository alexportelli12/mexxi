// Folds stored run events into the readable steps the app shows: edit, command,
// test, read and message. A tool_result attaches its outcome to the step of the
// call it answers.
import path from "node:path";
import { cleanText } from "./clean.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const TEST_COMMANDS = ["vfk", "npx vfk", "npx verifika", "node --test", "npm test", "npx vitest", "npx playwright test"];
const TITLE_MAX = 120;
const DETAIL_MAX = 2000;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class StepFolder {
  /** @param {{ root?: string|null, verifyCommand?: string }} [context] root is the worktree (or checkout) paths are shown relative to. */
  constructor({ root = null, verifyCommand = "npm run verify" } = {}) {
    this.root = root;
    this.testPattern = new RegExp(`^(?:${[verifyCommand, ...TEST_COMMANDS].map(escape).join("|")})(?:\\s|$)`);
    /** @type {Map<string, object>} */
    this.byTool = new Map();
    this.steps = [];
  }

  relative(file) {
    return this.root && file.startsWith(`${this.root}${path.sep}`) ? file.slice(this.root.length + 1) : file;
  }

  titleFor(tool, input) {
    if (EDIT_TOOLS.has(tool)) return this.relative(input.file_path ?? input.path ?? tool);
    if (tool === "Bash") return (input.command ?? "").split("\n")[0].trim().slice(0, TITLE_MAX) || tool;
    if (READ_TOOLS.has(tool)) return this.relative(input.file_path ?? input.path ?? input.pattern ?? tool);
    return input.description || input.skill || input.subagent_type || tool;
  }

  typeFor(tool, input) {
    if (EDIT_TOOLS.has(tool)) return "edit";
    if (tool === "Bash") return this.testPattern.test((input.command ?? "").trim()) ? "test" : "command";
    if (READ_TOOLS.has(tool)) return "read";
    return "command";
  }

  /** Adds a stored event row; returns the step it created or changed, or null. */
  add(row) {
    const base = { seq: row.seq, at: row.at };
    let step = null;
    if (row.kind === "text") {
      step = { ...base, id: `m${row.seq}`, type: "message", title: cleanText(row.data.text, TITLE_MAX), detail: cleanText(row.data.text, DETAIL_MAX), from: "agent" };
    } else if (row.kind === "input") {
      step = { ...base, id: `m${row.seq}`, type: "message", title: cleanText(row.data.text, TITLE_MAX), detail: cleanText(row.data.text, DETAIL_MAX), from: "you" };
    } else if (row.kind === "step" && row.data.phase === "call") {
      const input = row.data.input ?? {};
      step = {
        ...base, id: row.data.toolUseId, type: this.typeFor(row.data.tool, input), title: cleanText(this.titleFor(row.data.tool, input), TITLE_MAX),
        tool: row.data.tool, ok: null, detail: null,
      };
      this.byTool.set(row.data.toolUseId, step);
    } else if (row.kind === "step" && row.data.phase === "result") {
      step = this.byTool.get(row.data.toolUseId) ?? null;
      if (step) {
        step.ok = row.data.ok;
        step.detail = cleanText(row.data.detail, DETAIL_MAX);
        return step;
      }
      return null;
    }
    if (step) this.steps.push(step);
    return step;
  }
}

export function foldEvents(rows, context) {
  const folder = new StepFolder(context);
  rows.forEach((row) => folder.add(row));
  return folder.steps;
}
