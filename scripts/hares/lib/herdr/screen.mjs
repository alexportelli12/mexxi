// Reads what a blocked Claude Code pane shows (pane.read text) and says which
// form it is and what its options are. herdr reports a question and a
// permission prompt both as "blocked", and while a question waits its options
// exist only on screen, so the screen is the source of truth for what is
// pending now. The guard re-parses a fresh screen before every answer.
//
// parseScreen(text) returns
//   {kind: "question"|"review"|"permission"|"plan"|"trust", header, question,
//    options: [{n, label, description, selected?, always?}], freeText, chat, raw, ...}
// or {kind: "unknown", raw}. freeText and chat are the option numbers of
// "Type something." and "Chat about this" (null when absent); they are left out
// of options. `always: true` marks an option that grants more than this one
// call (an always-allow rule, all edits this session, auto mode), which the UI
// must confirm and MCP must never choose.

const FOOTER = /(enter to select|enter to confirm|esc to cancel|esc to exit|tab to amend|ctrl[-+]g to edit)/i;
const OPTION = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(.*\S)\s*$/;
const RULE = /^\s*[─━]{3,}\s*$/;
const DASHED = /^\s*[╌┄┈]{3,}\s*$/;
const CHECKBOX = /^(?:\[( |x|X|✓|✔|×)\]|([☐☒]))\s+/;
const TAB_LINE = /^\s*(?:←\s*)?[☐☒✔✓]\s+\S/;
const FREE_TEXT = /^type something\.?$/i;
const CHAT = /^chat about this$/i;
const MAX_FORM_LINES = 80;

const TOOL_HEADERS = new Map([
  ["bash command", "Bash"],
  ["edit file", "Edit"],
  ["create file", "Write"],
  ["write file", "Write"],
  ["read file", "Read"],
  ["fetch", "WebFetch"],
  ["web search", "WebSearch"],
  ["notebook edit", "NotebookEdit"],
]);

const ALWAYS_LABEL = /^yes, and (always allow|don['’]t ask again)|allow all edits|auto-accept|switch to auto mode|use auto mode|switch to accept edits|bypass permissions/i;
const TRUST_OPTION = /^\s*(❯\s*)?(no, exit|yes, i trust this folder)\s*$/i;
const REVIEW_TITLE = /^\s*(review your answers|ready to submit your answers\?)\s*$/i;

const squash = (text) => text.replace(/\s+/g, " ").trim();

function unknown(raw) {
  return { kind: "unknown", raw };
}

function readOptions(lines, from, to) {
  const options = [];
  let expected = 1;
  let current = null;
  let unnumberedSubmit = false;
  for (let index = from; index < to; index += 1) {
    const line = lines[index];
    const match = OPTION.exec(line);
    if (match && Number(match[1]) === expected) {
      let label = match[2].trim();
      let selected;
      const box = CHECKBOX.exec(label);
      if (box) {
        selected = box[2] ? box[2] === "☒" : box[1] !== " ";
        label = label.slice(box[0].length).trim();
      }
      current = { n: expected, label, description: "" };
      if (selected !== undefined) current.selected = selected;
      options.push(current);
      expected += 1;
      continue;
    }
    if (line.trim() === "" || RULE.test(line) || DASHED.test(line)) { current = null; continue; }
    if (/^\s*(?:❯\s*)?submit\s*$/i.test(line)) { unnumberedSubmit = true; current = null; continue; }
    if (current) current.description = squash(`${current.description} ${line}`);
  }
  return { options, unnumberedSubmit };
}

function readTabs(line) {
  const tokens = line.replace(/[←→]/g, " ").trim().split(/\s{2,}/);
  const tabs = [];
  let submit = false;
  for (const token of tokens) {
    const match = /^([☐☒✔✓])\s+(.+)$/.exec(token.trim());
    if (!match) continue;
    if (/^submit$/i.test(match[2].trim())) { submit = true; continue; }
    tabs.push({ label: match[2].trim(), answered: match[1] !== "☐" });
  }
  return { tabs, submit };
}

function splitSpecial(options) {
  let freeText = null;
  let chat = null;
  let submit = null;
  const rest = [];
  for (const option of options) {
    if (FREE_TEXT.test(option.label)) freeText = option.n;
    else if (CHAT.test(option.label)) chat = option.n;
    else if (/^submit( answers)?$/i.test(option.label)) submit = option.n;
    else rest.push(option);
  }
  return { freeText, chat, submit, rest };
}

function markAlways(options) {
  return options.map((option) => (ALWAYS_LABEL.test(option.label) ? { ...option, always: true } : option));
}

/**
 * The review step of a question form ends with "1. Submit answers / 2. Cancel" and,
 * on Claude Code 2.1.332, no key-hint footer (captured live at gate 1). The lines
 * "● <question>" / "→ <answer>" above it say what will be sent.
 */
function parseReview(lines, raw) {
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last -= 1;
  let title = -1;
  for (let index = last; index >= 0 && index >= last - 40; index -= 1) {
    if (REVIEW_TITLE.test(lines[index])) { title = index; break; }
    if (RULE.test(lines[index])) break;
  }
  if (title < 0) return null;
  const { options } = readOptions(lines, title + 1, last + 1);
  if (!options.some((option) => /^submit answers$/i.test(option.label))) return null;
  const answers = [];
  for (const line of lines.slice(title + 1, last + 1)) {
    const asked = /^\s*●\s+(.*\S)\s*$/.exec(line);
    const given = /^\s*→\s+(.*\S)\s*$/.exec(line);
    if (asked) answers.push({ question: squash(asked[1]), answer: "" });
    else if (given && answers.length > 0) answers[answers.length - 1].answer = squash(given[1]);
  }
  return { kind: "review", header: "Review your answers", question: "Review your answers", answers, options, freeText: null, chat: null, raw };
}

/**
 * The folder-trust dialog lists its two choices without numbers ("❯ No, exit" /
 * "Yes, I trust this folder"), so each option carries the arrow keys that reach
 * it from the cursor, then Enter (captured live at gate 1).
 */
function parseTrust(lines, raw) {
  const text = lines.join("\n");
  if (!/quick safety check|trust this folder/i.test(text)) return null;
  const rows = [];
  lines.forEach((line, index) => { const match = TRUST_OPTION.exec(line); if (match) rows.push({ index, cursor: Boolean(match[1]), label: match[2].trim() }); });
  if (rows.length !== 2) return null;
  const cursor = Math.max(0, rows.findIndex((row) => row.cursor));
  const options = rows.map((row, position) => {
    const moves = position - cursor;
    const keys = [...Array(Math.abs(moves)).fill(moves > 0 ? "down" : "up"), "enter"];
    const option = { n: position + 1, label: row.label, description: "", keys };
    return /^yes\b/i.test(row.label) ? { ...option, always: true } : option;
  });
  const folder = lines.map((line) => line.trim()).find((line) => /^[~/]/.test(line)) ?? null;
  return { kind: "trust", header: "Accessing workspace", question: "Is this a project you created or one you trust?", folder, options, freeText: null, chat: null, raw };
}

/** Parses the form at the bottom of a pane, or returns {kind:"unknown"}. */
export function parseScreen(text) {
  const raw = typeof text === "string" ? text : "";
  const lines = raw.replace(/\r/g, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  const review = parseReview(lines, raw);
  if (review) return review;
  const trust = parseTrust(lines, raw);
  if (trust) return trust;

  // Every Claude Code dialog ends with a key-hint footer; without one this is not a form.
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last -= 1;
  let footer = -1;
  for (let index = last; index >= 0 && index >= last - 12; index -= 1) {
    if (FOOTER.test(lines[index])) { footer = index; break; }
  }
  if (footer < 0) return unknown(raw);
  // A prompt box below the footer means the dialog is gone and this is ordinary output.
  if (lines.slice(footer + 1).some((line) => /^\s*❯(\s|$)/.test(line) && !OPTION.test(line))) return unknown(raw);

  let first = -1;
  for (let index = footer - 1; index >= 0 && index >= footer - MAX_FORM_LINES; index -= 1) {
    const match = OPTION.exec(lines[index]);
    if (match && match[1] === "1") { first = index; break; }
  }
  if (first < 0) return unknown(raw);

  let top = Math.max(-1, first - MAX_FORM_LINES - 1);
  for (let index = first - 1; index > top; index -= 1) {
    if (RULE.test(lines[index])) { top = index; break; }
  }
  const region = lines.slice(top + 1, first);
  const head = region.filter((line) => line.trim() !== "");
  // Paragraphs keep a wrapped sentence together: lines between blank lines, joined.
  const paragraphs = region.join("\n").split(/\n\s*\n/).map(squash).filter(Boolean);
  const headText = head.join("\n");
  const { options: allOptions, unnumberedSubmit } = readOptions(lines, first, footer);
  if (allOptions.length === 0) return unknown(raw);
  const { freeText, chat, submit, rest } = splitSpecial(allOptions);
  // A question form (it has the ☐ tab header) wins over every keyword below: its text is Claude's, and may say anything.
  const tabLine = head.find((line) => TAB_LINE.test(line));
  // The review step of a several-question form also has the tab header; its fixed lines tell it apart.
  if (head.some((line) => /^\s*(review your answers|ready to submit your answers\?)\s*$/i.test(line))) {
    const question = head.find((line) => /^\s*ready to submit/i.test(line)) ?? "Review your answers";
    return { kind: "review", header: "Review your answers", question: squash(question), options: allOptions, freeText: null, chat: null, raw };
  }
  const asQuestion = () => {
    const { tabs, submit: submitTab } = tabLine ? readTabs(tabLine) : { tabs: [], submit: false };
    const questionLines = head.filter((line) => line !== tabLine);
    const multiSelect = rest.some((option) => "selected" in option);
    const header = tabs.length === 1 ? tabs[0].label : (tabs.find((tab) => !tab.answered)?.label ?? null);
    const result = {
      kind: "question", header, question: squash(questionLines.join(" ")), options: rest, freeText, chat,
      multiSelect, raw,
    };
    if (tabs.length > 1 || submitTab) result.tabs = tabs;
    if (submit !== null) result.submit = submit;
    else if (unnumberedSubmit) result.submit = "unnumbered";
    return result;
  };
  if (tabLine) return asQuestion();

  if (/trust (the files in )?this folder|quick safety check|do you trust/i.test(headText)) {
    const question = paragraphs.find((paragraph) => /trust/i.test(paragraph)) ?? "";
    const folder = head.map((line) => line.trim()).find((line) => /^[~/]/.test(line)) ?? null;
    // Trusting a folder is lasting (Claude Code records it), so the accepting option counts as "always".
    const options = allOptions.map((option) => (/^yes\b/i.test(option.label) ? { ...option, always: true } : option));
    return { kind: "trust", header: squash(head[0] ?? ""), question, folder, options, freeText: null, chat: null, raw };
  }

  if (/ready to code\?|here is claude['’]s plan/i.test(headText) || (/would you like to proceed\?/i.test(headText) && /plan/i.test(headText))) {
    const question = head.find((line) => /would you like to proceed\?/i.test(line)) ?? "";
    const plan = head
      .filter((line) => /^\s*│/.test(line))
      .map((line) => line.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, ""))
      .join("\n")
      .trim();
    return { kind: "plan", header: squash(head[0] ?? ""), question: squash(question), plan, options: markAlways(allOptions), freeText: null, chat: null, raw };
  }

  const firstHead = squash(head[0] ?? "");
  const tool = TOOL_HEADERS.get(firstHead.toLowerCase()) ?? null;
  const askLine = head.find((line) => /do you want to (proceed|make this edit|create|overwrite|allow|run)/i.test(line));
  if (askLine || tool) {
    const dashed = [];
    lines.slice(top + 1, first).forEach((line, offset) => { if (DASHED.test(line)) dashed.push(top + 1 + offset); });
    const detail = dashed.length >= 2
      ? lines.slice(dashed[0] + 1, dashed[1]).map((line) => line.trim()).filter(Boolean).join("\n")
      : head.slice(1, askLine ? head.indexOf(askLine) : head.length).map((line) => line.trim()).join("\n");
    return {
      kind: "permission", header: firstHead, tool: tool ?? firstHead, detail, question: squash(askLine ?? ""),
      options: markAlways(allOptions), freeText: null, chat: null, raw,
    };
  }

  // No tab header: still a question when it offers Claude's own "Type something." or "Chat about this" rows.
  if (freeText !== null || chat !== null) return asQuestion();
  return unknown(raw);
}
