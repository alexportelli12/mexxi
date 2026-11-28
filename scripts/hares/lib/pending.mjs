// Pending questions, plans and permission prompts, as the hook records them.
//
// hook.mjs writes one small JSON file per pending prompt under
//   <dataDir>/pending/<session_id>/<recordId>.json
// and this module reads, folds and cleans them up. It imports only Node
// built-ins because the hook runs it on every tool call and must stay fast.
// The Claude session id is the primary key: pane ids change when a pane moves.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_RECORD_BYTES = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}

// Same location as lib/paths.mjs dataDir; duplicated so the hook loads no
// other module. (Tests pass env and home instead of touching the real ones.)
export function dataDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, ".local", "share");
  return path.join(base, "mexxi", "hares");
}

export function pendingRoot(options) {
  return path.join(dataDir(options), "pending");
}

export function sessionDir(sessionId, options) {
  if (!isSessionId(sessionId)) throw new Error("not a session id");
  return path.join(pendingRoot(options), sessionId);
}

export function hashInput(input) {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 16);
}

// Id of a record: the tool call it is about, else a hash of what it says, so
// the same prompt reported twice overwrites itself. The kind is part of the id
// because an ExitPlanMode call can produce two records for one tool_use_id.
export function recordIdFor({ kind, toolUseId, event, toolName, input }) {
  const safe = typeof toolUseId === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(toolUseId) ? toolUseId : null;
  const tail = safe ?? createHash("sha256").update(JSON.stringify([event, toolName, input ?? null])).digest("hex").slice(0, 16);
  return kind + "_" + tail;
}

function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Written as a temporary file then renamed, so a reader never sees half a record.
export function writeRecord(record, options) {
  if (!RECORD_ID.test(record.recordId ?? "")) throw new Error("bad record id");
  const dir = sessionDir(record.sessionId, options);
  privateDir(path.dirname(dir));
  privateDir(dir);
  const temporary = path.join(dir, "." + record.recordId + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp");
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, path.join(dir, record.recordId + ".json"));
}

function recordFiles(sessionId, options) {
  let dir;
  try {
    dir = sessionDir(sessionId, options);
  } catch {
    return [];
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (record && typeof record === "object" && record.v === 1) found.push({ file: path.join(dir, name), record });
    } catch {
      // A record being replaced or a stray file: skip it.
    }
  }
  return found.sort((a, b) => String(a.record.at).localeCompare(String(b.record.at)) || a.file.localeCompare(b.file));
}

export function listRecords(sessionId, options) {
  return recordFiles(sessionId, options).map((entry) => entry.record);
}

export function listSessionsWithRecords(options) {
  try {
    return readdirSync(pendingRoot(options)).filter(isSessionId);
  } catch {
    return [];
  }
}

// A tool call finished: its question, plan and permission records are stale. A
// permission record may carry no tool_use_id, so it also matches by tool and input.
export function clearForTool(sessionId, { toolUseId = null, toolName = null, input }, options) {
  const inputHash = hashInput(input);
  let removed = 0;
  for (const { file, record } of recordFiles(sessionId, options)) {
    const sameCall = toolUseId && record.toolUseId === toolUseId;
    const samePrompt = record.kind === "permission" && record.toolName === toolName && record.inputHash === inputHash;
    if (!sameCall && !samePrompt) continue;
    rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}

export function clearSession(sessionId, options) {
  if (!isSessionId(sessionId)) return;
  rmSync(sessionDir(sessionId, options), { recursive: true, force: true });
}

// The transcript is the truth: a record whose tool call already has a result is
// stale (the hook missed its PostToolUse, or the session ended elsewhere).
export function gcResolved(sessionId, resolvedToolUseIds, options) {
  let removed = 0;
  for (const { file, record } of recordFiles(sessionId, options)) {
    if (!record.toolUseId || !resolvedToolUseIds.has(record.toolUseId)) continue;
    rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}

// Rule text for the "always allow" choice, exactly as Claude Code would write it:
// {toolName:"Bash", ruleContent:"pnpm add:*"} gives Bash(pnpm add:*).
export function ruleTexts(suggestions) {
  const rules = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    if (suggestion?.type !== "addRules" || suggestion.behavior === "deny" || !Array.isArray(suggestion.rules)) continue;
    for (const rule of suggestion.rules) {
      if (typeof rule?.toolName !== "string") continue;
      const text = typeof rule.ruleContent === "string" && rule.ruleContent ? rule.toolName + "(" + rule.ruleContent + ")" : rule.toolName;
      if (!rules.includes(text)) rules.push(text);
    }
  }
  return rules;
}

function summarizeInput(input) {
  if (input && typeof input === "object") {
    if (typeof input.command === "string") return input.command;
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.notebook_path === "string") return input.notebook_path;
  }
  const text = JSON.stringify(input ?? null);
  return text.length > 500 ? text.slice(0, 500) : text;
}

const TERMINAL_ONLY = "answer in the terminal";

function fromQuestions(questions) {
  return questions.map((entry) => ({
    header: String(entry?.header ?? ""),
    question: String(entry?.question ?? ""),
    multiSelect: entry?.multiSelect === true,
    options: (Array.isArray(entry?.options) ? entry.options : []).map((option, index) => ({
      n: index + 1, label: String(option?.label ?? ""), description: String(option?.description ?? ""),
    })),
  }));
}

function itemFor(record) {
  const base = {
    id: record.recordId, sessionId: record.sessionId, kind: record.kind, at: record.at, toolUseId: record.toolUseId ?? null,
    paneId: record.paneId ?? null, questions: [], freeText: false, chat: false, answerable: true, reason: "", source: "hook",
  };
  const unreadable = record.truncated ? "too long, " + TERMINAL_ONLY : record.unparsed ? "could not read the question, " + TERMINAL_ONLY : "";
  if (record.kind === "question") {
    const questions = record.truncated || record.unparsed ? [] : fromQuestions(Array.isArray(record.input?.questions) ? record.input.questions : []);
    return { ...base, questions, answerable: questions.length > 0, reason: questions.length ? "" : unreadable || TERMINAL_ONLY };
  }
  if (record.kind === "plan") {
    return { ...base, plan: typeof record.input?.plan === "string" ? record.input.plan : "", answerable: !record.truncated, reason: record.truncated ? unreadable : "" };
  }
  if (record.kind === "permission") {
    const rules = ruleTexts(record.suggestions);
    return {
      ...base, answerable: !record.truncated, reason: record.truncated ? unreadable : "",
      permission: { tool: record.toolName ?? "", content: record.truncated ? "" : summarizeInput(record.input), rules, rule: rules[0] ?? null },
    };
  }
  return { ...base, answerable: false, reason: record.message ?? "" };
}

// Two records for one prompt become one. In Code Mode PreToolUse fires for the
// REPL call (its literal read from the code) and again for the AskUserQuestion
// inside it (tool_use_id "repl_…", the real tool_input), seen live at gate 1
// (F4): the inner record wins, and the REPL record it answers is dropped, paired
// by question text, or by time when the literal could not be read. Records of
// the same kind about the same tool and input (the same prompt reported twice)
// keep only the newest.
const questionTexts = (record) => (Array.isArray(record.input?.questions) ? record.input.questions.map((entry) => String(entry?.question ?? "").trim()) : []);
const sameTexts = (a, b) => a.length > 0 && a.length === b.length && a.every((text, index) => text === b[index]);
const promptKey = (record) => (record.kind === "hint" ? "hint" : JSON.stringify([record.kind, record.toolName ?? "", record.inputHash ?? hashInput(record.input), record.via ?? ""]));

export function dedupeRecords(records) {
  const inner = records.filter((record) => record.kind === "question" && record.via !== "repl" && /^repl_/.test(record.toolUseId ?? ""));
  const dropped = new Set();
  for (const answer of inner) {
    const texts = questionTexts(answer);
    const candidates = records.filter((record) => record.via === "repl" && record.kind === "question" && !dropped.has(record)
      && String(record.at) <= String(answer.at));
    const match = candidates.find((record) => sameTexts(questionTexts(record), texts)) ?? candidates.filter((record) => record.unparsed || record.truncated).at(-1);
    if (match) dropped.add(match);
  }
  const newest = new Map();
  // Records come oldest first, so a later one replaces an earlier one.
  for (const record of records) if (!dropped.has(record)) newest.set(promptKey(record), record);
  return records.filter((record) => newest.get(promptKey(record)) === record);
}

// Permission and hint records have no reliable end: a denied permission gets no
// PostToolUse and no Stop (F7). Once herdr says the session left "blocked" they
// are stale. A record younger than graceMs is kept while the status is not yet
// blocked, because the hook can write it a moment before herdr notices.
export const UNBLOCKED_GRACE_MS = 30_000;
export function staleWhenUnblocked(records, { status, leftBlocked = false, now = Date.now(), graceMs = UNBLOCKED_GRACE_MS }) {
  if (status === "blocked") return [];
  return records.filter((record) => (record.kind === "permission" || record.kind === "hint")
    && (leftBlocked || now - Date.parse(record.at) > graceMs));
}

/** Removes the given records' files; returns how many went. */
export function removeRecords(sessionId, records, options) {
  const ids = new Set(records.map((record) => record.recordId));
  let removed = 0;
  for (const { file, record } of recordFiles(sessionId, options)) {
    if (!ids.has(record.recordId)) continue;
    rmSync(file, { force: true });
    removed += 1;
  }
  return removed;
}

// Combines a session's records with what herdr's screen shows (screen.mjs:
// {kind, question, options:[{n,label,description}], freeText, chat, tabs?}). The
// record says what was asked; the screen says what can be pressed now, so its
// option numbers win. The screen describes only the newest prompt. With no
// record the screen alone makes the item; a hint shows only when nothing richer
// exists.
export function foldPending({ sessionId, records, screen = null }) {
  const folded = dedupeRecords(records);
  const actionable = folded.filter((record) => record.kind !== "hint");
  const items = actionable.map(itemFor);
  if (!items.length) {
    const screenKind = screen?.kind;
    if (screenKind && screenKind !== "none") return [fromScreenOnly(sessionId, screen)];
    const hint = folded.findLast((record) => record.kind === "hint");
    return hint ? [itemFor(hint)] : [];
  }
  if (screen) items[items.length - 1] = mergeScreen(items.at(-1), screen);
  return items;
}

// screen.mjs gives the option number of "Type something." / "Chat about this"
// (null when absent); older callers pass booleans.
const offered = (value) => value === true || Number.isInteger(value);

function screenQuestion(screen) {
  return {
    header: String(screen.header ?? ""), question: String(screen.question ?? ""), multiSelect: screen.multiSelect === true,
    options: (screen.options ?? []).map((option) => ({ n: option.n, label: option.label, description: option.description ?? "" })),
  };
}

function fromScreenOnly(sessionId, screen) {
  const options = screen.options ?? [];
  const readable = screen.kind !== "unknown" && options.length > 0;
  return {
    id: "screen_" + sessionId, sessionId, kind: screen.kind, at: null, toolUseId: null, paneId: null,
    questions: screen.kind === "question" ? [screenQuestion(screen)] : [], screenOptions: options,
    freeText: offered(screen.freeText), chat: offered(screen.chat), answerable: readable,
    reason: readable ? "" : TERMINAL_ONLY, source: "screen",
    ...(screen.kind === "review" ? { step: "review", answers: screen.answers ?? [] } : {}),
  };
}

// Which question of a several-question call is on screen: the tab named by the
// screen's header, else the one whose text matches, else the first.
function currentIndex(questions, screen) {
  if (questions.length < 2) return 0;
  const byHeader = questions.findIndex((entry) => entry.header && entry.header === screen.header);
  if (byHeader >= 0) return byHeader;
  const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const byText = questions.findIndex((entry) => flat(entry.question) === flat(screen.question));
  return byText >= 0 ? byText : 0;
}

function mergeScreen(item, screen) {
  const merged = { ...item, screenOptions: screen.options ?? [], source: "hook+screen" };
  if (screen.freeText !== undefined) merged.freeText = offered(screen.freeText);
  if (screen.chat !== undefined) merged.chat = offered(screen.chat);
  if (item.kind !== "question") return merged;
  // Every tab answered: the form now asks to submit what was chosen.
  if (screen.kind === "review") return { ...merged, step: "review", answers: screen.answers ?? [], freeText: false, chat: false };
  if (screen.kind !== "question") return merged;
  if (!item.questions.length && (screen.options ?? []).length) {
    return { ...merged, questions: [screenQuestion(screen)], current: 0, answerable: true, reason: "" };
  }
  const current = currentIndex(item.questions, screen);
  if (!(screen.options ?? []).length) return { ...merged, current };
  const questions = item.questions.map((entry, index) => {
    if (index !== current) return entry;
    const described = new Map(entry.options.map((option) => [option.label, option.description]));
    const options = screen.options.map((option) => ({ n: option.n, label: option.label, description: option.description || described.get(option.label) || "" }));
    return { ...entry, options };
  });
  return { ...merged, questions, current };
}

// --- A literal reader for Code Mode ------------------------------------------
// In Code Mode the question is a JavaScript call inside a REPL's code:
// tools.AskUserQuestion({questions: [...]}). The hook must never run that code,
// so this reads only literal data (strings, numbers, booleans, null, arrays,
// objects, comments, trailing commas) and throws on anything else: an
// identifier, a call, a spread, a template with an interpolation.
const MAX_DEPTH = 40;
const TICK = "\x60";
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

export function parseLiteral(source, start = 0) {
  let i = start;
  const fail = (why) => {
    throw new SyntaxError(why + " at " + i);
  };
  const skip = () => {
    for (;;) {
      const c = source[i];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") i += 1;
      else if (c === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
      } else if (c === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end < 0) fail("unterminated comment");
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const quote = source[i];
    i += 1;
    let out = "";
    for (;;) {
      const c = source[i];
      if (c === undefined) fail("unterminated string");
      if (c === quote) {
        i += 1;
        return out;
      }
      if (quote !== TICK && c === "\n") fail("newline in string");
      if (quote === TICK && c === "$" && source[i + 1] === "{") fail("template expression");
      if (c !== "\\") {
        out += c;
        i += 1;
        continue;
      }
      const e = source[i + 1];
      i += 2;
      if (e === "u" && source[i] === "{") {
        const end = source.indexOf("}", i);
        const hex = source.slice(i + 1, end);
        if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) fail("bad escape");
        out += String.fromCodePoint(parseInt(hex, 16));
        i = end + 1;
      } else if (e === "u" || e === "x") {
        const length = e === "u" ? 4 : 2;
        const hex = source.slice(i, i + length);
        if (!new RegExp("^[0-9a-fA-F]{" + length + "}$").test(hex)) fail("bad escape");
        out += String.fromCharCode(parseInt(hex, 16));
        i += length;
      } else if (e === "\n") {
        // line continuation
      } else if (e in ESCAPES) out += ESCAPES[e];
      else if (e === undefined) fail("unterminated string");
      else out += e;
    }
  };
  const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
  const set = (target, key, entry) => Object.defineProperty(target, key, { value: entry, enumerable: true, writable: true, configurable: true });
  const value = (depth) => {
    if (depth > MAX_DEPTH) fail("too deep");
    skip();
    const c = source[i];
    if (c === "{") {
      i += 1;
      const object = {};
      for (;;) {
        skip();
        if (source[i] === "}") {
          i += 1;
          return object;
        }
        let key;
        if (source[i] === '"' || source[i] === "'") key = string();
        else {
          IDENTIFIER.lastIndex = i;
          const found = IDENTIFIER.exec(source);
          if (!found) fail("expected a key");
          key = found[0];
          i += key.length;
        }
        skip();
        if (source[i] !== ":") fail("expected a colon");
        i += 1;
        set(object, key, value(depth + 1));
        skip();
        if (source[i] === ",") i += 1;
        else if (source[i] !== "}") fail("expected a comma or }");
      }
    }
    if (c === "[") {
      i += 1;
      const array = [];
      for (;;) {
        skip();
        if (source[i] === "]") {
          i += 1;
          return array;
        }
        array.push(value(depth + 1));
        skip();
        if (source[i] === ",") i += 1;
        else if (source[i] !== "]") fail("expected a comma or ]");
      }
    }
    if (c === '"' || c === "'" || c === TICK) return string();
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(source);
    if (number) {
      i += number[0].length;
      return Number(number[0]);
    }
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(source)?.[0];
    if (word === "true" || word === "false" || word === "null") {
      i += word.length;
      return word === "null" ? null : word === "true";
    }
    return fail("not a literal");
  };
  const parsed = value(0);
  return { value: parsed, end: i };
}

// {found:false} when the code never asks; {found:true, input} when the argument
// is a plain literal; {found:true, unparsed:true} when it needs running to read.
export function extractAskUserQuestion(code) {
  if (typeof code !== "string") return { found: false };
  const call = /tools\s*\.\s*AskUserQuestion\s*\(\s*/.exec(code);
  if (!call) return { found: false };
  try {
    const { value } = parseLiteral(code, call.index + call[0].length);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { found: true, unparsed: true };
    return { found: true, input: value };
  } catch {
    return { found: true, unparsed: true };
  }
}
