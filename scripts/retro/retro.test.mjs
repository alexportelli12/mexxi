import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RetroError, assertPrivateOutput, goalTable, mergeSessions, renderMarkdown, retro, summarizeIbni, summarizeSession } from "./retro.mjs";

const run = promisify(execFile);
const EXTRACTOR = fileURLToPath(new URL("./session_retro.py", import.meta.url));

async function temporary(t, prefix = "mexxi-retro-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One transcript line per call, in the shape Claude Code writes.
function transcript(sessionStart, calls) {
  const lines = [];
  let n = 0;
  const at = (seconds) => new Date(Date.parse(sessionStart) + seconds * 1000).toISOString();
  const base = (seconds) => ({ uuid: `u${++n}`, timestamp: at(seconds), cwd: "/work/app" });
  let clock = 0;
  for (const { tool, input, result, isError, prompt } of calls) {
    if (prompt) {
      lines.push({ ...base(clock += 5), type: "user", message: { role: "user", content: prompt } });
      continue;
    }
    const id = `t${++n}`;
    lines.push({ ...base(clock += 5), type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: tool, input }] } });
    lines.push({ ...base(clock += 5), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(isError), content: result }] } });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const FIRST = [
  { tool: "Bash", input: { command: "grep -r foo --include=*.ts src" }, result: "(eval):1: no matches found: --include=*.ts" },
  { tool: "Edit", input: { file_path: "/work/app/a.ts" }, result: "File has not been read yet. Read it first before writing to it.", isError: true },
  { tool: "Bash", input: { command: "until grep -q done log; do sleep 5; done" }, result: "ok" },
  { prompt: "no, that's wrong sk-abcdefghijklmnopqrstuvwx is the key" },
  { prompt: "follow-up: please tidy" },
];

// A projects directory with three sessions in different months, one of them
// empty (no timestamps), plus a nested subagent transcript.
async function projects(t) {
  const dir = await temporary(t, "mexxi-projects-");
  const project = path.join(dir, "-work-app");
  await mkdir(path.join(project, "aaaa1111-0000-0000-0000-000000000000", "subagents"), { recursive: true });
  await writeFile(path.join(project, "aaaa1111-0000-0000-0000-000000000000.jsonl"), transcript("2026-09-30T10:00:00Z", FIRST));
  await writeFile(path.join(project, "bbbb2222-0000-0000-0000-000000000000.jsonl"), transcript("2026-10-10T10:00:00Z", FIRST.slice(0, 2)));
  await writeFile(path.join(project, "cccc3333-0000-0000-0000-000000000000.jsonl"), "");
  await writeFile(path.join(project, "aaaa1111-0000-0000-0000-000000000000", "subagents", "agent-1.jsonl"), "{}\n");
  return dir;
}

async function extract(projectsDir, ...args) {
  const { stdout } = await run("python3", ["-I", EXTRACTOR, "--out", "-", "--projects-dir", projectsDir, ...args]);
  return JSON.parse(stdout);
}

test("the extractor counts each signal once, redacts snippets with the shared patterns and skips excluded sessions", async (t) => {
  const dir = await projects(t);
  const signals = await extract(dir);
  assert.equal(signals.inventory.sessions, 3);
  assert.equal(signals.inventory.subagent_transcripts_not_analysed, 1);
  assert.deepEqual([signals.zsh_pitfalls.total, signals.zsh_pitfalls.sessions, signals.zsh_pitfalls.silent_in_successful_calls], [2, 2, 2]);
  assert.deepEqual([signals.error_families.edit_before_read.occurrences, signals.error_families.edit_before_read.sessions], [2, 2]);
  assert.deepEqual([signals.wait_loops.total, signals.wait_loops.sessions], [1, 1]);
  assert.equal(signals.follow_up_requests.total, 1);
  assert.equal(signals.corrections.total, 1);
  assert.match(signals.corrections.items[0].snippet, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(signals), /sk-abcdefghijklmnop/);

  const excluded = await extract(dir, "--exclude", "aaaa");
  assert.equal(excluded.inventory.sessions, 2);
  assert.equal(excluded.zsh_pitfalls.total, 1);
});

test("the extractor's redaction reads every shared pattern, a PEM block across lines and a Google API key included", async () => {
  // The module is loaded by path, so nothing beside it is imported by name.
  const program = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('session_retro', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps([len(module.SECRET_PATTERNS), module.redact(sys.argv[2])]))",
  ].join("\n");
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\nAQEFAASC+/w==\n-----END PRIVATE KEY-----";
  const google = "AIzaSyA1bCdEfGhIjKlMnOpQrStUvWxYz012345";
  const { stdout } = await run("python3", ["-I", "-c", program, EXTRACTOR, `cat key.pem\n${pem}\nuse ${google} here`]);
  const [count, text] = JSON.parse(stdout);
  const source = JSON.parse(await readFile(new URL("../lib/secret-patterns.json", import.meta.url), "utf8"));
  assert.equal(count, source.patterns.length);
  assert.equal(text, "cat key.pem\n[REDACTED]\nuse [REDACTED] here");
});

test("--since and --until select sessions by start, a bare --until date includes that day, and undated sessions fall outside", async (t) => {
  const dir = await projects(t);
  const window = async (...args) => (await extract(dir, ...args)).inventory;
  assert.equal((await window("--since", "2026-10-01")).sessions, 1);
  assert.equal((await window("--until", "2026-09-30")).sessions, 1);
  assert.equal((await window("--until", "2026-09-29")).sessions, 0);
  const both = await window("--since", "2026-09-30", "--until", "2026-10-10");
  assert.equal(both.sessions, 2);
  assert.equal(both.undated_sessions_outside_window, 1);
  assert.deepEqual(both.window, { since: "2026-09-30T00:00:00+00:00", until: "2026-10-11T00:00:00+00:00" });
});

test("retro reports are only written outside Git, or to a gitignored folder with nothing tracked", async (t) => {
  const outside = await temporary(t);
  await assertPrivateOutput(path.join(outside, "retro", "deeper"));

  const repository = await temporary(t, "mexxi-retro-repo-");
  const git = (...args) => run("git", ["-C", repository, ...args]);
  await git("init", "--quiet");
  await writeFile(path.join(repository, ".gitignore"), "/retro/\n");
  await assertPrivateOutput(path.join(repository, "retro"));
  await assertPrivateOutput(path.join(repository, "retro", "nested"));

  await assert.rejects(assertPrivateOutput(path.join(repository, "reports")), /not gitignored there/);
  await assert.rejects(assertPrivateOutput(repository), /not gitignored there/);
  await assert.rejects(assertPrivateOutput(path.join(repository, "reports")), RetroError);

  // Ignoring a folder does not help once something in it is tracked.
  await mkdir(path.join(repository, "retro"));
  await writeFile(path.join(repository, "retro", "old.json"), "{}");
  await git("add", "-f", "retro/old.json");
  await assert.rejects(assertPrivateOutput(path.join(repository, "retro")), /has tracked files/);
});

function workspace(root, sessionId, { createdAt, marked, review = [], triage = [] }) {
  const worktree = path.join(root, "app-0123456789", sessionId);
  const gitDirectory = path.join(root, "gitdirs", sessionId);
  const at = (minutes) => new Date(Date.parse(createdAt) + minutes * 60_000).toISOString();
  const metadata = {
    sessionId, createdAt, state: marked ? "pr-open" : "prepared", prUrl: marked ? "https://github.com/a/b/pull/1" : undefined,
    steps: [
      { step: "prepare", sessionId, startedAt: createdAt, endedAt: at(1), outcome: "succeeded" },
      ...(marked ? [{ step: "mark-pr", sessionId, startedAt: at(marked - 1), endedAt: at(marked), outcome: "succeeded" }] : []),
    ],
    records: [{ kind: "verify", at: at(2), outcome: "fail" }, { kind: "verify", at: at(3), outcome: "pass" }, ...review],
    triage,
  };
  return { worktree, gitDirectory, metadata };
}

async function installWorkspace(spec) {
  await mkdir(spec.worktree, { recursive: true });
  await mkdir(spec.gitDirectory, { recursive: true });
  await writeFile(path.join(spec.worktree, ".git"), `gitdir: ${spec.gitDirectory}\n`);
  await writeFile(path.join(spec.gitDirectory, "implementation-workspace.json"), JSON.stringify(spec.metadata));
}

const review = (reviewer, findings, accepted) => ({ kind: "review", at: "2026-10-21T00:00:00Z", findings, accepted, reviewer });

test("ibni sessions report prepare-to-PR time, Jev agreement and review acceptance by reviewer family", () => {
  const { metadata } = workspace("/unused", "s1", {
    createdAt: "2026-10-21T08:00:00Z", marked: 45,
    review: [review("same", 4, 2), review("cross", 5, 5)],
  });
  const first = summarizeSession(metadata);
  assert.equal(first.prepareToPrMinutes, 45);
  assert.deepEqual(first.verify, { attempts: 2, failed: 1 });
  const second = summarizeSession(workspace("/unused", "s2", { createdAt: "2026-10-21T09:00:00Z", marked: 15, review: [review("same", 6, 3)] }).metadata);
  const unfinished = summarizeSession(workspace("/unused", "s3", { createdAt: "2026-10-21T10:00:00Z" }).metadata);
  assert.equal(unfinished.prepareToPrMinutes, null);

  const summary = summarizeIbni([first, second, unfinished]);
  assert.deepEqual([summary.sessions, summary.withPullRequest, summary.prepareToPrMinutes.median], [3, 2, 15]);
  assert.deepEqual(summary.reviewAcceptance.same, { rounds: 2, findings: 10, accepted: 5, acceptedPercent: 50 });
  assert.deepEqual(summary.reviewAcceptance.cross, { rounds: 1, findings: 5, accepted: 5, acceptedPercent: 100 });
  assert.equal(summary.jevAgreement.compared, 0);

  assert.deepEqual(mergeSessions([first], [{ ...second }, { ...first, prepareToPrMinutes: 1 }]).map((session) => session.sessionId), ["s1", "s2"]);
});

test("a retro writes only to retro.output, carries ibni sessions forward and shows the change from the previous run", async (t) => {
  const home = await temporary(t, "mexxi-retro-home-");
  const projectsDir = await projects(t);
  const worktreeRoot = path.join(home, "worktrees");
  const output = path.join(home, "private-retro");
  const configFile = path.join(home, "config.json");
  await writeFile(configFile, JSON.stringify({ paths: { checkout: home, worktreeRoot }, retro: { output } }));
  await installWorkspace(workspace(worktreeRoot, "sess-one", { createdAt: "2026-10-12T08:00:00Z", marked: 30, review: [review("cross", 2, 1)] }));
  const legacy = path.join(home, ".local/share/opencode/implementation-worktrees");
  await installWorkspace(workspace(legacy, "sess-old", { createdAt: "2026-10-11T08:00:00Z", marked: 10 }));

  const saved = { HOME: process.env.HOME, MEXXI_CONFIG: process.env.MEXXI_CONFIG };
  Object.assign(process.env, { HOME: home, MEXXI_CONFIG: configFile });
  t.after(() => {
    process.env.HOME = saved.HOME;
    if (saved.MEXXI_CONFIG === undefined) delete process.env.MEXXI_CONFIG;
    else process.env.MEXXI_CONFIG = saved.MEXXI_CONFIG;
  });

  const args = ["--projects-dir", projectsDir, "--since", "2026-09-01", "--until", "2026-10-31"];
  const first = await retro(args, { now: new Date("2026-10-21T09:00:00Z") });
  assert.deepEqual(first.files.map((file) => path.relative(output, file)), ["retro-2026-10-21-0900.md", "retro-2026-10-21-0900.json"]);
  assert.equal(first.report.previous, null);
  assert.equal(first.report.ibni.sessions, 2);
  assert.equal(first.report.goalTable.zshGlobAborts.count, 2);
  assert.match(renderMarkdown(first.report), /\| zsh glob aborts \| 2 \| 2 \| 100 \| n\/a \| n\/a \|/);

  // The first workspace is swept; the next retro still has it, and sees the second transcript set shrink.
  await rm(path.join(legacy, "app-0123456789"), { recursive: true });
  await rm(path.join(projectsDir, "-work-app", "bbbb2222-0000-0000-0000-000000000000.jsonl"));
  const second = await retro(args, { now: new Date("2026-10-22T09:00:00Z") });
  assert.equal(second.report.ibni.sessions, 2);
  assert.equal(second.report.previous.generatedAt, "2026-10-21T09:00:00.000Z");
  const markdown = await readFile(second.files[0], "utf8");
  assert.match(markdown, /\| zsh glob aborts \| 1 \| 1 \| 100 \| 2 \| -1 \|/);
  assert.doesNotMatch(markdown, /sk-abcdef|REDACTED/);
  assert.deepEqual((await readdir(output)).sort(), [
    "retro-2026-10-21-0900.json", "retro-2026-10-21-0900.md", "retro-2026-10-22-0900.json", "retro-2026-10-22-0900.md",
  ]);
  // The goal table covers every signal the plan's baseline lists.
  assert.equal(Object.keys(goalTable(second.report.signals)).length, 10);
});

test("a retro refuses a folder inside a repository without writing or running anything", async (t) => {
  const home = await temporary(t, "mexxi-retro-refuse-");
  await run("git", ["-C", home, "init", "--quiet"]);
  const configFile = path.join(home, "config.json");
  await writeFile(configFile, JSON.stringify({ paths: { checkout: home }, retro: { output: "reports" } }));
  const result = await run("node", [fileURLToPath(new URL("./retro.mjs", import.meta.url)), "--projects-dir", home], {
    env: { ...process.env, HOME: home, MEXXI_CONFIG: configFile },
  }).then(() => null, (error) => error);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /refusing to write retro reports to .*reports.*not gitignored there/);
  assert.deepEqual((await readdir(home)).sort(), [".git", "config.json"]);
});
