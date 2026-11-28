// Finding, tailing and folding a Claude Code transcript. Fixtures are synthetic.
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TranscriptFolder, displayTitle, locateTranscript, openTail, projectSlug, resolvedToolUseIds, toolTitle } from "../lib/transcript.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/transcript/session.jsonl", import.meta.url));
const SESSION = "11111111-2222-4333-8444-555555555555";

function tempHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hares-transcript-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function foldAll(entries) {
  const folder = new TranscriptFolder();
  for (const entry of entries) folder.push(entry);
  return folder;
}

const fixtureEntries = () => readFileSync(FIXTURE, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("the slug turns every non-alphanumeric character in the cwd into a dash", () => {
  assert.equal(projectSlug("/home/alex/work space/my.repo_x"), "-home-alex-work-space-my-repo-x");
});

test("a transcript is found by the hook's path, then by the cwd slug, then by searching every project", (t) => {
  const home = tempHome(t);
  const place = (folder) => {
    const dir = path.join(home, ".claude", "projects", folder);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, SESSION + ".jsonl");
    writeFileSync(file, "");
    return file;
  };
  assert.equal(locateTranscript({ sessionId: SESSION, home }), null);
  const moved = place("-somewhere-else");
  assert.equal(locateTranscript({ sessionId: SESSION, cwd: "/tmp/demo", home }), moved, "search by id when the slug folder is missing");
  const slugged = place("-tmp-demo");
  assert.equal(locateTranscript({ sessionId: SESSION, cwd: "/tmp/demo", home }), slugged, "the cwd slug beats a search");
  assert.equal(locateTranscript({ sessionId: SESSION, transcriptPath: moved, cwd: "/tmp/demo", home }), moved, "the hook's path beats the slug");
});

test("a transcript path that is another session's file, or a session id that is a path, is not trusted", (t) => {
  const home = tempHome(t);
  const other = path.join(home, "other.jsonl");
  writeFileSync(other, "");
  assert.equal(locateTranscript({ sessionId: SESSION, transcriptPath: other, home }), null);
  assert.equal(locateTranscript({ sessionId: "../../x", home }), null);
});

test("the tail returns only new lines, holds back a half-written line, and re-reads a rewritten file", (t) => {
  const file = path.join(tempHome(t), "t.jsonl");
  writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const tail = openTail(file);
  assert.deepEqual(tail.read().map((entry) => entry.n), [1, 2]);
  assert.deepEqual(tail.read(), []);
  appendFileSync(file, '{"n":3}\n{"n"');
  assert.deepEqual(tail.read().map((entry) => entry.n), [3]);
  appendFileSync(file, ':4}\nnot json\n{"n":5}\n');
  assert.deepEqual(tail.read().map((entry) => entry.n), [4, 5], "the held-back line completes, a damaged line is skipped");
  writeFileSync(file, '{"n":9}\n');
  assert.deepEqual(tail.read().map((entry) => entry.n), [9]);
});

test("the tail of a file that does not exist yet reads nothing", (t) => {
  assert.deepEqual(openTail(path.join(tempHome(t), "missing.jsonl")).read(), []);
});

test("folding keeps the user's prompts and Claude's text and drops thinking, reminders, attachments and subagent chatter", () => {
  const folder = foldAll(fixtureEntries());
  const texts = folder.rows.filter((row) => row.kind === "user" || row.kind === "assistant").map((row) => row.kind + ": " + row.data.text);
  assert.deepEqual(texts, ["user: Fix the login bug", "assistant: Let me look."]);
});

test("a tool step is one collapsed row with a short title that gains its result", () => {
  const folder = foldAll(fixtureEntries());
  const step = folder.rows.find((row) => row.data.id === "toolu_b1");
  assert.equal(step.kind, "tool");
  assert.equal(step.data.title, "Check the tree");
  assert.equal(step.data.status, "done");
  assert.equal(folder.rows.find((row) => row.data.id === "toolu_open").data.status, "running");
});

test("push returns the rows a result updated, not only new ones", () => {
  const entries = fixtureEntries();
  const folder = new TranscriptFolder();
  const touched = entries.slice(0, 6).flatMap((entry) => folder.push(entry));
  assert.equal(touched.filter((row) => row.data.id === "toolu_b1").length, 2, "added, then updated by its result");
});

test("an AskUserQuestion shows the question and the answer taken from toolUseResult", () => {
  const folder = foldAll(fixtureEntries());
  const asked = folder.rows.find((row) => row.kind === "question");
  assert.equal(asked.data.status, "answered");
  assert.deepEqual(asked.data.answers, { "Which colour?": "Green" });
  assert.equal(asked.data.questions[0].options[1].label, "Green");
});

test("a question answered with a rejection reads as declined, not as an answer", () => {
  const folder = new TranscriptFolder();
  folder.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [] } }] } });
  folder.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "no" }] }, toolUseResult: "Error: rejected" });
  assert.equal(folder.rows[0].data.status, "declined");
  assert.equal(folder.rows[0].data.answers, null);
});

test("an interrupted tool and the interruption notice are marked, and the notice is not a prompt", () => {
  const folder = foldAll(fixtureEntries());
  assert.equal(folder.rows.find((row) => row.data.id === "toolu_s1").data.status, "interrupted");
  assert.equal(folder.rows.filter((row) => row.kind === "interrupted").length, 1);
  assert.equal(folder.rows.some((row) => row.kind === "user" && row.data.text.startsWith("[Request interrupted")), false);
});

test("the title comes from a title entry, else the first prompt; the first prompt is the first real user message", () => {
  const entries = fixtureEntries();
  const withoutTitle = foldAll(entries.filter((entry) => entry.type !== "ai-title"));
  assert.equal(withoutTitle.firstPrompt, "Fix the login bug");
  assert.equal(displayTitle(withoutTitle), "Fix the login bug");
  assert.equal(displayTitle(foldAll(entries)), "Fix login bug");
});

test("row numbers count up from 1 in the order rows were first added", () => {
  const folder = foldAll(fixtureEntries());
  assert.deepEqual(folder.rows.map((row) => row.seq), folder.rows.map((_, index) => index + 1));
});

test("step titles name what a tool touched: the file's name, the pattern, the description, else the first command line", () => {
  assert.equal(toolTitle("Edit", { file_path: "/a/b/login.js" }), "Edit login.js");
  assert.equal(toolTitle("Grep", { pattern: "TODO" }), "Grep TODO");
  assert.equal(toolTitle("Bash", { command: "ls -la\nrm x" }), "ls -la");
  assert.equal(toolTitle("Bash", { command: "x", description: "Do x" }), "Do x");
  assert.equal(toolTitle("REPL", { code: "secret()" }), "Code Mode");
  assert.ok(toolTitle("Bash", { command: "y".repeat(500) }).length <= 80);
});

test("resolved tool ids list every tool call that already has a result", () => {
  assert.deepEqual([...resolvedToolUseIds(fixtureEntries())].sort(), ["toolu_a1", "toolu_b1", "toolu_s1"]);
});

test("a fixture copied into a project folder is located by session id and read whole", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".claude", "projects", "-tmp-demo");
  mkdirSync(dir, { recursive: true });
  copyFileSync(FIXTURE, path.join(dir, SESSION + ".jsonl"));
  const found = locateTranscript({ sessionId: SESSION, home });
  assert.equal(openTail(found).read().length, fixtureEntries().length);
});
