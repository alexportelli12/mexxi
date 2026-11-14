// The test-design nudge (decision 0025): the first time a session edits a
// test file, the agent is told to load the test-design skill before going on.
// It fires once per session and never blocks the edit. /wettaq's instruction to
// load the skill stays the rule; this hook only backs it up.
//
// What counts as a test file is a path pattern, so a test in an unusual place
// is missed; the reviewer's question (which bug does this test catch?) still
// applies to it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { exitCode, EDIT_TOOLS } from "./loop-breaker.mjs";
import { pruneStale, sessionFile, sessionStateDirectory } from "./session-state.mjs";

// Paths that hold tests, matched against the path with forward slashes.
export const TEST_FILE_PATTERNS = [
  /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/, // a.test.ts, a.spec.js, hooks.test.mjs
  /(?:^|\/)[^/]+[._-](?:test|spec)s?\.[cm]?[jt]sx?$/, // a-test.js, a_spec.ts
  /(?:^|\/)test_[^/]+\.py$/, // test_app.py
  /(?:^|\/)[^/]+_test\.(?:py|go|rb|exs?)$/, // app_test.py, app_test.go
  /(?:^|\/)[^/]+_spec\.rb$/, // app_spec.rb
  /(?:^|\/)[^/]+Tests?\.(?:java|kt|cs|swift)$/, // AppTest.java, AppTests.swift
  /(?:^|\/)(?:__tests__|tests?|e2e|spec|specs)\/(?:.+\/)?[^/]+$/, // anything under a test directory
];

export function isTestFile(file) {
  const normalized = String(file).replace(/\\/g, "/");
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

// The files an apply_patch patch adds, updates, deletes or moves to.
export function patchPaths(patch) {
  if (typeof patch !== "string") return [];
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
    .map((match) => (match[1] ?? match[2]).trim());
}

// The files an edit tool call changed, from each host's tool input: Claude
// Code's file_path (notebook_path for NotebookEdit), OpenCode's filePath, and
// the patch text of Codex's apply_patch (tool_input.command) or OpenCode's
// patch tools (patchText).
export function editedFiles(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const direct = [toolInput.file_path, toolInput.notebook_path, toolInput.filePath].filter((value) => typeof value === "string");
  const patch = [toolInput.patchText, toolInput.patch, toolInput.command, toolInput.input].find((value) => typeof value === "string" && value.includes("*** Begin Patch"));
  return [...direct, ...patchPaths(patch)];
}

export function nudgeDirectory(home = os.homedir()) {
  return sessionStateDirectory("test-design", home);
}

export const nudgeMessage = (file) => `You just edited a test file (${file}). Load the test-design skill now, before writing or changing more tests: it decides which tests the change needs and how to see each one fail.`;

// The message for the agent the first time this session edits a test file,
// or null. A failed edit (Codex reports apply_patch's exit status) changed
// nothing, so it does not count.
export async function firstTestEdit(input, { directory = nudgeDirectory(), now = Date.now() } = {}) {
  const sessionId = input?.session_id;
  if (!sessionId || !EDIT_TOOLS.has(input.tool_name) || input.hook_event_name === "PostToolUseFailure") return null;
  const code = exitCode(input.tool_response);
  if (code !== null && code !== 0) return null;
  const file = editedFiles(input.tool_input).find(isTestFile);
  if (!file) return null;
  const state = sessionFile(directory, sessionId);
  if (await readFile(state, "utf8").then(() => true, () => false)) return null;
  await mkdir(directory, { recursive: true });
  await pruneStale(directory, now);
  await writeFile(state, `${JSON.stringify({ nudgedAt: new Date(now).toISOString() })}\n`);
  return nudgeMessage(file);
}
