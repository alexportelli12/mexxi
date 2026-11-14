import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { REDACTION, redact } from "../lib/redact.mjs";
import { RUN_LOG, RetroError, assertPrivateOutput, carriedRun, goalTable, liveRun, logRun, mergeRuns, readRunLog, renderMarkdown, retro, summarizeRuns } from "./retro.mjs";

const run = promisify(execFile);
const EXTRACTOR = fileURLToPath(new URL("./session_retro.py", import.meta.url));

async function temporary(t, prefix = "mexxi-retro-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One transcript line per call, in the shape Claude Code writes. skills lists
// the names a skill_listing attachment carries, as Claude Code records them.
function transcript(sessionStart, calls, { cwd = "/work/app", entrypoint = "cli", skills } = {}) {
  const lines = [];
  let n = 0;
  const at = (seconds) => new Date(Date.parse(sessionStart) + seconds * 1000).toISOString();
  const base = (seconds) => ({ uuid: `u${++n}`, timestamp: at(seconds), cwd, entrypoint });
  let clock = 0;
  if (skills) lines.push({ ...base(clock), type: "attachment", attachment: { type: "skill_listing", names: skills } });
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

test("only interactive sessions count: a skill-eval run and a session under /tmp are excluded by reason, a stale eval command in an interactive session is not", async (t) => {
  const dir = await temporary(t, "mexxi-projects-");
  const write = async (project, id, options) => {
    await mkdir(path.join(dir, project), { recursive: true });
    await writeFile(path.join(dir, project, `${id}-0000-0000-0000-000000000000.jsonl`), transcript("2026-10-10T10:00:00Z", FIRST, options));
  };
  const evalSkill = "wettaq-skill-1a2b3c4d";
  // Breaks caught: an eval's `claude -p` session counted as interactive; a segwi
  // canary under /tmp counted; a cwd-less canary counted because only cwd is read.
  await write("-work-app", "eeee0001", { entrypoint: "sdk-cli", skills: ["wettaq", evalSkill] });
  await write("-tmp-segwi-canary-AbC123-repo", "ffff0001", { cwd: "/tmp/segwi-canary-AbC123/repo", entrypoint: "sdk-cli" });
  // No line names a cwd and no sibling session lends one, so only the project directory's name tells.
  await mkdir(path.join(dir, "-tmp-tmp-XyZ123"));
  await writeFile(path.join(dir, "-tmp-tmp-XyZ123", "ffff0002-0000-0000-0000-000000000000.jsonl"), "");
  // Breaks caught: every print-mode session dropped (other front ends drive
  // interactive work through it), or any session listing a leftover eval command dropped.
  await write("-work-app", "aaaa0001", { entrypoint: "sdk-cli", skills: ["wettaq"] });
  await write("-work-app", "aaaa0002", { entrypoint: "cli", skills: ["wettaq", evalSkill] });

  const signals = await extract(dir);
  assert.equal(signals.inventory.sessions, 2);
  assert.deepEqual(signals.inventory.excluded_non_interactive, { skill_eval: 1, temp_directory: 2 });
  assert.equal(signals.zsh_pitfalls.total, 2);
  assert.deepEqual(Object.keys(signals.inventory.projects), ["/work/app"]);
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

test("the extractor redacts URL credentials, Basic headers, Stripe and GitLab keys and quoted fields exactly as ibni does", async () => {
  const program = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('session_retro', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps([module.redact(text) for text in json.loads(sys.argv[2])]))",
  ].join("\n");
  const texts = [
    "postgres://u:p@db.internal:5432/app",
    "https://deploy:s3cr@t@example.com/x",
    "curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA=='",
    "STRIPE=sk_test_0123456789abcdefABCD and sk_live_0123456789abcdefABCD",
    "https://oauth2:glpat-abcdefghij0123456789@gitlab.com/a/b",
    '{"apiKey": "q1w2e3r4", "client_secret":"a b", "password": "it\'s", "name": "x"}',
    "{'auth': 'user:pass'}",
    "https://example.com:8443/settings?tab=general and postgres://localhost:5432/app",
    "Use basic authentication; the API key lives in the vault",
    '{"name": "settings", "keyboard": "qwerty", "input_tokens": 900}',
  ];
  const { stdout } = await run("python3", ["-I", "-c", program, EXTRACTOR, JSON.stringify(texts)]);
  const expected = texts.map((text) => redact(text).text);
  assert.ok(expected[0].includes(REDACTION) && !expected[0].includes("u:p@"), "the JavaScript redactor covers URL credentials");
  assert.deepEqual(JSON.parse(stdout), expected);
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

function workspace(root, sessionId, { createdAt, marked, review = [], runId }) {
  const worktree = path.join(root, "app-0123456789", sessionId);
  const gitDirectory = path.join(root, "gitdirs", sessionId);
  const at = (minutes) => new Date(Date.parse(createdAt) + minutes * 60_000).toISOString();
  const metadata = {
    sessionId, createdAt, runId, state: marked ? "pr-open" : "prepared", prUrl: marked ? "https://github.com/a/b/pull/1" : undefined,
    steps: [
      { step: "prepare", sessionId, startedAt: createdAt, endedAt: at(1), outcome: "succeeded" },
      ...(marked ? [{ step: "mark-pr", sessionId, startedAt: at(marked - 1), endedAt: at(marked), outcome: "succeeded" }] : []),
    ],
    records: [{ kind: "verify", at: at(2), outcome: "fail" }, { kind: "verify", at: at(3), outcome: "pass" }, ...review],
  };
  return { worktree, gitDirectory, metadata };
}

async function installWorkspace(spec) {
  await mkdir(spec.worktree, { recursive: true });
  await mkdir(spec.gitDirectory, { recursive: true });
  await writeFile(path.join(spec.worktree, ".git"), `gitdir: ${spec.gitDirectory}\n`);
  await writeFile(path.join(spec.gitDirectory, "implementation-workspace.json"), JSON.stringify(spec.metadata));
}

const review = (findings, accepted) => ({ kind: "review", at: "2026-10-21T00:00:00Z", findings, accepted });

// One run-log line in ibni's contract shape; fields override the defaults.
const logLine = (fields) => JSON.stringify({
  version: 1, runId: "r1", recordedAt: "2026-10-21T10:00:00Z", event: "ci", repository: "app", branch: "agent/x",
  worktreePath: "/w/app/x", prUrl: null, startedAt: "2026-10-21T08:00:00Z", outcome: "ci-failed",
  steps: { prepare: 60_000 }, verify: { attempts: 1, failed: 0 }, review: { passes: 1, findings: 2, accepted: 1 },
  qa: { passes: 0, findings: 0 }, ci: { rounds: 1, state: "ci-failed" }, ...fields,
});

test("the run log keeps each run's last line, skips unreadable lines and counts them", async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, "runs.jsonl");
  await writeFile(file, [
    logLine({ outcome: "ci-failed", ci: { rounds: 1, state: "ci-failed" } }),
    "{not json",
    "[1, 2]",
    logLine({ runId: undefined, worktreePath: "/w/app/y", startedAt: "2026-10-22T08:00:00Z", outcome: "green", ci: { rounds: 1, state: "green" }, extra: { unknown: true } }),
    logLine({ outcome: "green", ci: { rounds: 2, state: "green" } }),
    logLine({ event: "removed", outcome: "merged", recordedAt: "2026-10-21T12:00:00Z", ci: { rounds: 2, state: "green" } }),
    "",
  ].join("\n"));
  // Breaks caught: an earlier line winning over a later one; a malformed line
  // crashing the report or counting as a run; a line without runId dropped.
  const log = await readRunLog(file);
  assert.deepEqual([log.found, log.lines, log.unreadable], [true, 6, 2]);
  assert.deepEqual(log.runs.map((run) => [run.runId, run.worktreePath, run.outcome, run.ci.rounds]),
    [[null, "/w/app/y", "green", 1], ["r1", "/w/app/x", "merged", 2]]);
  assert.deepEqual(await readRunLog(path.join(dir, "missing.jsonl")), { file: path.join(dir, "missing.jsonl"), found: false, lines: 0, unreadable: 0, runs: [] });
});

test("runs merge by runId, else worktree path and start, else session, with live metadata winning and the log supplying CI", () => {
  const live = liveRun(workspace("/unused", "s1", { createdAt: "2026-10-21T08:00:00Z", marked: 45, runId: "r1", review: [review(4, 3)] }).metadata, "/w/app/x");
  const logged = logRun(JSON.parse(logLine({ outcome: "green", ci: { rounds: 2, state: "green" }, review: { passes: 9, findings: 9, accepted: 0 } })));
  const byPath = logRun(JSON.parse(logLine({ runId: undefined, worktreePath: "/w/app/z", startedAt: "2026-10-23T08:00:00Z" })));
  const liveByPath = liveRun(workspace("/unused", "s3", { createdAt: "2026-10-23T08:00:00Z" }).metadata, "/w/app/z");
  const carried = carriedRun({ sessionId: "s1", createdAt: "2026-10-21T08:00:00Z", steps: [], verify: { attempts: 7, failed: 7 }, review: { rounds: 1, findings: 1 } });
  // Breaks caught: a run counted twice across sources; the log's older counts
  // replacing live ones; live's missing CI state erasing the log's.
  const runs = mergeRuns([carried], [logged, byPath], [live, liveByPath]);
  assert.equal(runs.length, 2);
  const [first, second] = runs;
  assert.deepEqual([first.source, first.outcome, first.ci, first.review, first.verify, first.prepareToPrMinutes],
    ["live", "green", { rounds: 2, state: "green" }, { passes: 1, findings: 4, accepted: 3 }, { attempts: 2, failed: 1 }, 45]);
  // Break caught: a field unknown in every source dropped from the merged run (it read as NaN in the report).
  assert.deepEqual([second.source, second.outcome, second.sessionId, second.prepareToPrMinutes], ["live", "ci-failed", "s3", null]);
});

test("run summaries split green at the first CI wait from green after fix rounds, and give step medians, p90s and acceptance", () => {
  const run = (id, fields) => logRun(JSON.parse(logLine({ runId: id, ...fields })));
  const runs = [
    run("a", { outcome: "merged", ci: { rounds: 1, state: "green" }, steps: { verify: 60_000 } }),
    run("b", { outcome: "green", ci: { rounds: 3, state: "green" }, steps: { verify: 120_000 } }),
    run("c", { outcome: "ci-failed", ci: { rounds: 2, state: "ci-failed" }, steps: { verify: 180_000 } }),
    run("d", { outcome: undefined, ci: undefined, steps: { verify: 600_000 }, review: { passes: 2, findings: 4 } }),
  ];
  // Breaks caught: a run green only after fixes counted as green first; a
  // failed run counted green; runs without a CI wait in the denominator.
  const summary = summarizeRuns(runs);
  assert.deepEqual(summary.outcomes, { merged: 1, green: 1, "ci-failed": 1, open: 1 });
  assert.deepEqual(summary.ci, { waited: 3, greenFirst: 1, greenFirstPercent: 33.3, greenAfterFixes: 1, greenAfterFixesPercent: 33.3 });
  assert.deepEqual(summary.steps.verify, { runs: 4, medianMinutes: 2, p90Minutes: 10 });
  assert.deepEqual(summary.review, { passesPerRun: 1.3, findingsPerRun: 2.5, findings: 10, accepted: 3, acceptedPercent: 30 });
  // A retro from before the run log split acceptance by reviewer family; its accepted findings still count.
  const old = carriedRun({ sessionId: "o", createdAt: "2026-10-01T00:00:00Z", prepareToPrMinutes: 12, steps: [{ step: "verify", minutes: 1.5 }],
    verify: { attempts: 2, failed: 1 }, review: { rounds: 2, findings: 5, byReviewer: { same: { accepted: 2 }, cross: { accepted: 1 } } } });
  assert.deepEqual([old.review, old.steps], [{ passes: 2, findings: 5, accepted: 3 }, { verify: 90_000 }]);
});

test("a retro writes only to retro.output, carries ibni runs forward, reads the run log in its window and compares with the baseline it is given", async (t) => {
  const home = await temporary(t, "mexxi-retro-home-");
  const projectsDir = await projects(t);
  const worktreeRoot = path.join(home, "worktrees");
  const output = path.join(home, "private-retro");
  const configFile = path.join(home, "config.json");
  await writeFile(configFile, JSON.stringify({ paths: { checkout: home, worktreeRoot }, retro: { output } }));
  await installWorkspace(workspace(worktreeRoot, "sess-one", { createdAt: "2026-10-12T08:00:00Z", marked: 30, review: [review(2, 1)] }));
  // One run inside the window, logged twice, and one that started after it.
  await mkdir(path.join(worktreeRoot, ".ibni"), { recursive: true });
  await writeFile(path.join(worktreeRoot, RUN_LOG), `${[
    logLine({ runId: "in", startedAt: "2026-10-15T08:00:00Z", worktreePath: "/gone/in", ci: { rounds: 1, state: "ci-failed" } }),
    logLine({ runId: "in", startedAt: "2026-10-15T08:00:00Z", worktreePath: "/gone/in", outcome: "green", ci: { rounds: 2, state: "green" } }),
    "{truncated",
    logLine({ runId: "out", startedAt: "2026-11-05T08:00:00Z", worktreePath: "/gone/out", outcome: "green", ci: { rounds: 1, state: "green" } }),
  ].join("\n")}\n`);
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
  assert.equal(first.report.baseline, null);
  // Break caught: a run that started outside --since/--until counted.
  assert.equal(first.report.ibni.runs, 3);
  assert.deepEqual(first.report.ibni.ci, { waited: 1, greenFirst: 0, greenFirstPercent: 0, greenAfterFixes: 1, greenAfterFixesPercent: 100 });
  assert.deepEqual(first.report.runLog, { found: true, lines: 4, unreadable: 1 });
  assert.equal(first.report.goalTable.zshGlobAborts.count, 2);
  assert.match(renderMarkdown(first.report), /\| zsh glob aborts \| 2 \| 2 \| 100 \| n\/a \| n\/a \|/);

  // The first workspace is swept; the next retro still has it, and sees the second transcript set shrink.
  await rm(path.join(legacy, "app-0123456789"), { recursive: true });
  await rm(path.join(projectsDir, "-work-app", "bbbb2222-0000-0000-0000-000000000000.jsonl"));
  const second = await retro(args, { now: new Date("2026-10-22T09:00:00Z") });
  assert.equal(second.report.ibni.runs, 3);
  assert.deepEqual([second.report.baseline.report, second.report.baseline.named], ["retro-2026-10-21-0900", false]);
  const markdown = await readFile(second.files[0], "utf8");
  assert.match(markdown, /\| zsh glob aborts \| 1 \| 1 \| 100 \| 2 \| -1 \|/);
  assert.match(markdown, /Baseline: retro-2026-10-21-0900 .*the latest earlier retro/);
  assert.doesNotMatch(markdown, /sk-abcdef|REDACTED/);
  assert.deepEqual((await readdir(output)).sort(), [
    "retro-2026-10-21-0900.json", "retro-2026-10-21-0900.md", "retro-2026-10-22-0900.json", "retro-2026-10-22-0900.md",
  ]);

  // Break caught: --baseline ignored in favour of the latest report (which had 1, not 2).
  const third = await retro([...args, "--baseline", "retro-2026-10-21-0900"], { now: new Date("2026-10-23T09:00:00Z") });
  assert.equal(third.report.baseline.named, true);
  const named = await readFile(third.files[0], "utf8");
  assert.match(named, /\| zsh glob aborts \| 1 \| 1 \| 100 \| 2 \| -1 \|/);
  assert.match(named, /Baseline: retro-2026-10-21-0900 of 2026-10-21 \(\d+ sessions\), named with --baseline\./);
  const byPath = await retro([...args, "--baseline", path.join(output, "retro-2026-10-22-0900.json")], { now: new Date("2026-10-24T09:00:00Z") });
  assert.equal(byPath.report.baseline.report, "retro-2026-10-22-0900");
  // Break caught: a missing baseline silently replaced by the latest report.
  await assert.rejects(retro([...args, "--baseline", "retro-2026-01-01-0000"]), /baseline retro .*retro-2026-01-01-0000\.json does not exist/);
  await assert.rejects(retro([...args, "--baseline", "notes.json"]), RetroError);
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
