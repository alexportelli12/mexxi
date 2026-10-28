// Each test names the break it catches (decision 0015). The fixtures are
// built in the shapes Claude Code and OpenCode write, never copied from a
// real transcript.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compare, dailyConcurrency, isoWeek, percentile, summarize, verdict } from "./lib/aggregate.mjs";
import { countRules, monthEnds, skillDescription } from "./lib/git.mjs";
import { activeSpans, checkClaims, sessionMetrics } from "./lib/metrics.mjs";
import * as patterns from "./lib/patterns.mjs";
import { publicLabels, repoFromCwd, scanForLeaks } from "./lib/privacy.mjs";
import { summarizePullRequest } from "./lib/prs.mjs";
import { END, START, replaceGenerated } from "./lib/report.mjs";
import { openCodeTool, parseClaudeTranscript } from "./lib/sources.mjs";

const run = promisify(execFile);
const EXTRACTOR = fileURLToPath(new URL("../../../scripts/retro/session_retro.py", import.meta.url));

// --- Builders ---------------------------------------------------------------

const T0 = Date.parse("2026-10-10T10:00:00Z");
let clock = 0;
const at = () => T0 + (clock += 5_000);

const tool = (name, fields = {}) => ({ kind: "tool", tool: name, command: null, reads: [], edits: [], writes: [], output: "", failed: false, durationMs: 1_000, at: at(), ...fields });
const bash = (command, output = "", fields = {}) => tool("Bash", { command, output, ...fields });
const edit = (file) => tool("Edit", { edits: [file] });
const read = (file) => tool("Read", { reads: [file] });
const reply = (text) => ({ kind: "reply", text, at: at() });
const prompt = (text) => ({ kind: "prompt", text, at: at() });
const metrics = (...events) => sessionMetrics({ source: "claude", events });

// One Claude Code transcript line per call, as the retro tests write them.
function claudeTranscript(calls) {
  const lines = [];
  let n = 0;
  let seconds = 0;
  const base = () => ({ uuid: `u${++n}`, timestamp: new Date(T0 + (seconds += 5) * 1000).toISOString(), cwd: "/work/app" });
  for (const call of calls) {
    if (call.prompt) {
      lines.push({ ...base(), type: "user", message: { role: "user", content: call.prompt } });
    } else if (call.reply) {
      lines.push({ ...base(), type: "assistant", message: { role: "assistant", content: [{ type: "text", text: call.reply }] } });
    } else if (call.compact) {
      lines.push({ ...base(), type: "system", subtype: "compact_boundary" });
    } else {
      const id = call.id ?? `t${++n}`;
      lines.push({ ...base(), type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: call.tool, input: call.input }] } });
      lines.push({ ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(call.isError), content: call.result }] } });
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// --- Definitions shared with /irrifletti --------------------------------------

test("every pattern marked 'retro' matches session_retro.py's source exactly", async () => {
  // Break: someone edits a pattern here or in the retro and the two pages'
  // numbers stop meaning the same thing.
  const python = await readFile(EXTRACTOR, "utf8");
  const pySource = (name) => {
    const match = python.match(new RegExp(`${name} = re\\.compile\\(\\s*r"((?:[^"\\\\]|\\\\.)*)"(?:,\\s*re\\.I)?`));
    assert.ok(match, `${name} not found in session_retro.py`);
    return match[1];
  };
  const pairs = [
    ["ZSH_PITFALL_RE", patterns.ZSH_PITFALL], ["EXIT_CODE_RE", patterns.EXIT_CODE], ["MASKED_FAILURE_RE", patterns.MASKED_FAILURE],
    ["VERIFY_RE", patterns.VERIFY], ["FOLLOW_UP_RE", patterns.FOLLOW_UP], ["CORRECTION_RE", patterns.CORRECTION],
  ];
  for (const [name, regex] of pairs) assert.equal(regex.source, pySource(name), name);
  assert.equal(`(?i)${patterns.ERRORISH.source}`, pySource("ERRORISH_RE"));
  for (const [key, name] of [["timeout", "timeout"], ["missingPackage", "missing_package"], ["commandNotFound", "command_not_found"]]) {
    const match = python.match(new RegExp(`"${name}": re\\.compile\\(r"((?:[^"\\\\]|\\\\.)*)"`));
    assert.equal(patterns.CATEGORY[key].source, match[1], name);
  }
});

test("on the same transcript, the shared counts equal session_retro.py's", async (t) => {
  // Break: a parsing difference (deduplication, which results count as
  // failures, where patterns are matched) makes this page disagree with the
  // retro's figures even though the patterns are identical.
  const dir = await mkdtemp(path.join(os.tmpdir(), "journey-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [
    { tool: "Bash", input: { command: "grep -r foo --include=*.ts src" }, result: "(eval):1: no matches found: --include=*.ts" },
    { tool: "Edit", input: { file_path: "/work/app/a.ts" }, result: "File has not been read yet. Read it first before writing to it.", isError: true },
    { tool: "Bash", input: { command: "npm test 2>&1 | tail -3" }, result: "Tests: 2 failed, 10 passed" },
    { compact: true },
    { prompt: "follow-up: please tidy" },
  ];
  const text = claudeTranscript(calls);
  // A resumed session replays its earlier lines; both readers count them once.
  await mkdir(path.join(dir, "-work-app"));
  await writeFile(path.join(dir, "-work-app", "aaaa1111-0000-0000-0000-000000000000.jsonl"), text + text);
  const { stdout } = await run("python3", ["-I", EXTRACTOR, "--projects-dir", dir, "--out", "-"]);
  const retro = JSON.parse(stdout);
  const ours = sessionMetrics(parseClaudeTranscript(text + text, "a"));
  assert.equal(ours.globAborts, retro.zsh_pitfalls.total);
  assert.equal(ours.editRefused, retro.error_families.edit_before_read.occurrences);
  assert.equal(ours.hiddenExitCodes, retro.masked_verify_failures.total);
  assert.equal(ours.compactions, retro.compactions.total);
  assert.equal(ours.followUps, retro.follow_up_requests.total);
  assert.equal(ours.toolCalls, retro.inventory.total_tool_calls);
  assert.deepEqual([ours.globAborts, ours.editRefused, ours.hiddenExitCodes, ours.compactions, ours.followUps, ours.toolCalls], [1, 1, 1, 1, 1, 3]);
});

// --- Readers -------------------------------------------------------------------

test("a background command's later notification settles the call it names", () => {
  // Break: background verify runs (how ibni verify is meant to run) never
  // count as checks, so every claim after one reads as unverified.
  const lines = [
    { uuid: "1", timestamp: "2026-10-10T10:00:00Z", type: "assistant", message: { content: [{ type: "tool_use", id: "bg", name: "Bash", input: { command: "ibni verify --session s" } }] } },
    { uuid: "2", timestamp: "2026-10-10T10:00:01Z", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bg", content: "Command running in background with ID: b1." }] } },
    { uuid: "3", timestamp: "2026-10-10T10:09:00Z", type: "user", message: { content: "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n<summary>done (exit code 0)</summary>\n</task-notification>" } },
    { uuid: "4", timestamp: "2026-10-10T10:09:05Z", type: "assistant", message: { content: [{ type: "text", text: "Verify is green." }] } },
  ];
  const session = parseClaudeTranscript(lines.map((l) => JSON.stringify(l)).join("\n"), "s");
  assert.equal(session.events.filter((e) => e.kind === "prompt").length, 0, "a notification is not a prompt");
  assert.equal(sessionMetrics(session).unverifiedDoneClaims, 0);
  const failed = lines.map((l) => (l.uuid === "3" ? { ...l, message: { content: l.message.content.replace("completed", "failed").replace("exit code 0", "exit code 1") } } : l));
  assert.equal(sessionMetrics(parseClaudeTranscript(failed.map((l) => JSON.stringify(l)).join("\n"), "s")).unverifiedDoneClaims, 1);
});

test("an OpenCode bash part fails on a non-zero exit and apply_patch reports the files it touched", () => {
  // Break: OpenCode sessions show no failures or edits, so the early eras look
  // cleaner than they were.
  const failing = openCodeTool({ tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "x", metadata: { exit: 1 }, time: { start: 1, end: 2 } } }, "/w");
  const passing = openCodeTool({ tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "x", metadata: { exit: 0 }, time: { start: 1, end: 2 } } }, "/w");
  assert.equal(failing.failed, true);
  assert.equal(passing.failed, false);
  const patch = openCodeTool({ tool: "apply_patch", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch" } } }, "/w");
  assert.deepEqual([patch.tool, patch.edits, patch.writes], ["Edit", ["/w/src/a.ts"], ["/w/src/b.ts"]]);
});

// --- Unverified "done" claims ------------------------------------------------------

test("a checks-pass claim after an edit with no check since is unverified", () => {
  // Break: the metric's core definition, "no passing check after the last
  // edit", stops holding in either direction.
  assert.equal(metrics(edit("/w/a.ts"), reply("All tests pass.")).unverifiedDoneClaims, 1);
  assert.equal(metrics(edit("/w/a.ts"), bash("npm test", "ok"), reply("All tests pass.")).unverifiedDoneClaims, 0);
  assert.equal(metrics(bash("npm test", "ok"), edit("/w/a.ts"), reply("All tests pass.")).unverifiedDoneClaims, 1);
  assert.equal(metrics(edit("/w/a.ts"), bash("npm test", "Exit code 1\n1 failed", { failed: true }), reply("All tests pass.")).unverifiedDoneClaims, 1);
});

test("a check after a heredoc edit in the same call counts, and the heredoc edit itself counts as an edit", () => {
  // Break: agents' `python3 - <<'EOF' ... EOF` edits followed by `npx vitest`
  // are read as no check at all (the retro's skeleton cuts at <<), or the
  // scripted edit is not seen and an old pass covers new code.
  const both = bash("python3 - <<'EOF'\nopen('a.ts','w').write('x')\nEOF\nnpx vitest run a.spec.ts", "3 specs ok");
  assert.equal(metrics(both, reply("The specs pass.")).unverifiedDoneClaims, 0);
  const editOnly = bash("python3 - <<'EOF'\nopen('a.ts','w').write('x')\nEOF", "");
  assert.equal(metrics(bash("npm test", "ok"), editOnly, reply("The specs pass.")).unverifiedDoneClaims, 1);
});

test("edits to scratch, evidence and memory files leave an earlier pass standing", () => {
  // Break: writing the pull-request body after verify makes every final
  // summary read as unverified.
  const pass = bash("npm run verify", "PASS 5/5");
  assert.equal(metrics(pass, tool("Write", { writes: ["/w.evidence/qa-notes.md"] }), reply("Verify is green.")).unverifiedDoneClaims, 0);
  assert.equal(metrics(pass, tool("Write", { writes: ["/w/src/app.ts"] }), reply("Verify is green.")).unverifiedDoneClaims, 1);
});

test("a check's outcome read back from its log settles the claim", () => {
  // Break: agents that tail a background run's output file never count as
  // having seen it pass, or a failing log reads as a pass.
  const started = bash("npm run verify > log 2>&1", "", { background: true });
  assert.equal(metrics(edit("/w/a.ts"), started, bash("tail -3 log", "verifika --all PASS 20/20 (5m)"), reply("Verify is green.")).unverifiedDoneClaims, 0);
  assert.equal(metrics(edit("/w/a.ts"), started, bash("tail -3 log", "FAIL 19/20 (5m)"), reply("Verify is green.")).unverifiedDoneClaims, 1);
  assert.equal(metrics(edit("/w/a.ts"), started, bash("tail -3 log", "✓ lint ✓ test ✓ build"), reply("Verify is green.")).unverifiedDoneClaims, 0);
});

test("checks run through wrappers and local binaries count as checks", () => {
  // Break: `timeout 150 npx ng test`, node_modules/.bin/playwright and
  // `npx --no-install` runs are invisible, inflating unverified claims.
  for (const command of ["CHROME_BIN=/usr/bin/chromium timeout 150 npx ng test --watch=false", "node_modules/.bin/playwright test -c x", "npx --no-install vitest run", "fnm exec --using 24 ibni verify --session s"]) {
    assert.equal(patterns.isVerifyCommand(command), true, command);
  }
  for (const command of ["ls skills/verifika", "cat package.json | grep test", "gh pr checks 12"]) {
    assert.equal(patterns.isVerifyCommand(command), false, command);
  }
});

test("hedged, negated, partial and tabular sentences are not claims", () => {
  // Break: reports of failure or plans read as claims of success.
  for (const text of ["Tests don't pass yet.", "Then I'll confirm the test passes.", "Baseline verify passed.", "5 of 6 checks pass.", "| lint | pass |", "Tests pass, but the formatter flagged a table."]) {
    assert.deepEqual(checkClaims(text), [], text);
  }
  for (const text of ["All 209 tests pass.", "Verify is green (20/20).", "Lint is clean."]) {
    assert.equal(checkClaims(text).length, 1, text);
  }
});

// --- Friction counts ----------------------------------------------------------------

test("glob aborts count even when the call succeeded, and hidden exit codes only on check commands", () => {
  // Break: zsh aborts inside ;-joined commands (which exit 0) go uncounted, or
  // every FAIL word in any output counts as a hidden check failure.
  const m = metrics(bash("grep -r x --include=*.ts .; echo done", "(eval):1: no matches found: --include=*.ts\ndone"), bash("npm test | tail -2", "Tests: 1 failed"), bash("cat notes.md", "FAILED once"));
  assert.deepEqual([m.globAborts, m.hiddenExitCodes, m.bashFailures], [1, 1, 1]);
});

test("environmental failures are told apart from failing work", () => {
  // Break: H5's share counts every failed test as environmental, or none of
  // the timeouts, missing tools and busy ports.
  const m = metrics(
    bash("npm test", "Exit code 1\n3 failed", { failed: true }),
    bash("foo", "Exit code 127\nzsh: command not found: foo", { failed: true }),
    bash("npm run dev", "Exit code 1\nError: listen EADDRINUSE: address already in use :::4200", { failed: true }),
    bash("npm run e2e", "Exit code 1\nTimeout 30000ms exceeded", { failed: true }),
    bash("node build.mjs", "Exit code 1\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'", { failed: true }),
  );
  assert.deepEqual([m.bashFailures, m.environmentalFailures, m.commandNotFound, m.portClashes, m.timeouts, m.missingPackages], [5, 4, 1, 1, 1, 1]);
});

test("a call that ran into the Bash cap counts as a timeout", () => {
  // Break: the 10-minute cap, a known cause of lost verify runs, is missed.
  const m = metrics(bash("npm run verify", "Exit code 143", { failed: true, durationMs: 600_000 }));
  assert.deepEqual([m.bashCapHits, m.environmentalFailures], [1, 1]);
});

test("editing a file the session never read counts once per edit", () => {
  // Break: edits after a Read, or to a file the session wrote itself, count
  // as edit-before-read.
  const m = metrics(edit("/w/a.ts"), read("/w/b.ts"), edit("/w/b.ts"), tool("Write", { writes: ["/w/c.ts"] }), edit("/w/c.ts"), edit("/w/a.ts"));
  assert.equal(m.editBeforeRead, 1);
});

test("a command run three times with two failures is one failing retry", () => {
  // Break: the retry threshold drifts from the retro's RETRY_MIN, or passing
  // reruns count as failing retries.
  const fail = () => bash("npm test", "Exit code 1", { failed: true });
  assert.equal(metrics(fail(), fail(), bash("npm test", "ok")).failingRetries, 1);
  assert.equal(metrics(fail(), bash("npm test", "ok"), bash("npm test", "ok")).failingRetries, 0);
  assert.equal(metrics(fail(), fail()).failingRetries, 0, "two runs are not yet a retry cluster");
});

test("a rework prompt counts only after a reply that called the work done", () => {
  // Break: every correction counts as rework, including ones mid-task before
  // the agent claimed anything.
  assert.equal(metrics(reply("Done: the pull request is open."), prompt("the button is still broken, fix it")).reworkPrompts, 1);
  assert.equal(metrics(reply("Looking into it."), prompt("the button is still broken, fix it")).reworkPrompts, 0);
});

// --- Aggregation -------------------------------------------------------------------

test("percentiles are nearest-rank, so every reported size was measured", () => {
  // Break: interpolated medians report byte counts no check run produced.
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
  assert.equal(percentile([], 50), null);
});

test("concurrency counts overlapping active spans per day, and a span over midnight counts on both days", () => {
  // Break: idle gaps count as activity, or a session that runs past midnight
  // vanishes from the second day.
  const hour = 3_600_000;
  const day = Date.parse("2026-10-10T00:00:00Z");
  assert.deepEqual(activeSpans([day, day + 10 * 60_000, day + 2 * hour]), [[day, day + 10 * 60_000], [day + 2 * hour, day + 2 * hour]]);
  const result = dailyConcurrency([
    [[day + 1 * hour, day + 3 * hour]],
    [[day + 2 * hour, day + 4 * hour]],
    [[day + 5 * hour, day + 6 * hour]],
    [[day + 23 * hour, day + 25 * hour]],
  ]);
  assert.deepEqual(result, { "2026-10-10": 2, "2026-10-11": 1 });
});

test("group rates come from totals, not averages of session rates", () => {
  // Break: a one-call session with one glob abort weighs as much as a
  // 500-call session.
  const row = (toolCalls, globAborts) => ({ metrics: { ...metrics(), toolCalls, globAborts, checkRunBytes: [] } });
  assert.equal(summarize([row(1, 1), row(99, 0)]).metrics.globAborts, 1);
});

test("a comparison needs 20 sessions a side, and verdicts follow the stated thresholds", () => {
  // Break: a verdict is printed from a handful of sessions, or a 5% wobble
  // reads as an improvement.
  const side = (sessions, value) => ({ sessions, metrics: { x: value } });
  assert.equal(compare(side(19, 10), side(50, 1), "x").reading, "insufficient data");
  assert.equal(compare(side(20, 10), side(20, 7), "x").reading, "improved");
  assert.equal(compare(side(20, 10), side(20, 8.5), "x").reading, "slightly improved");
  assert.equal(compare(side(20, 10), side(20, 9.5), "x").reading, "no change");
  assert.equal(compare(side(20, 10), side(20, 12), "x").reading, "worse");
  assert.equal(compare(side(20, 1), side(20, 2), "x", { better: "higher" }).reading, "improved");
  assert.equal(verdict([{ reading: "improved" }, { reading: "improved" }]), "supported");
  assert.equal(verdict([{ reading: "improved" }, { reading: "worse" }]), "mixed");
  assert.equal(verdict([{ reading: "worse" }, { reading: "no change" }]), "not supported");
  assert.equal(verdict([{ reading: "insufficient data" }]), "insufficient data");
  assert.equal(verdict([{ reading: "improved" }], { forceInsufficient: true }), "insufficient data");
});

test("ISO weeks start on Monday and the year turns with its first Thursday", () => {
  // Break: weekly rows split a week in two or merge across a year boundary.
  assert.equal(isoWeek(Date.parse("2026-10-25T23:00:00Z")), "2026-W43");
  assert.equal(isoWeek(Date.parse("2026-10-26T00:00:00Z")), "2026-W44");
  assert.equal(isoWeek(Date.parse("2027-01-01T12:00:00Z")), "2026-W53");
});

test("a pull request's commits after its first review count as follow-up commits", () => {
  // Break: commits made before any review count as review follow-ups.
  const pr = { createdAt: "2026-10-10T10:00:00Z", mergedAt: "2026-10-10T12:00:00Z", reviews: [{ submittedAt: "2026-10-10T11:00:00Z" }], commits: [{ committedDate: "2026-10-10T09:59:00Z" }, { committedDate: "2026-10-10T11:30:00Z" }] };
  assert.deepEqual(summarizePullRequest(pr), { createdAt: pr.createdAt, merged: true, hoursToMerge: 2, reviews: 1, commits: 2, commitsAfterFirstReview: 1 });
});

// --- Backpack --------------------------------------------------------------------

test("rules are directive lines outside code fences and headings", () => {
  // Break: example code or section titles inflate the backpack.
  const text = "# Never stop\n\n- Always run verify.\n- The repo uses Angular.\n\n```bash\n# never do this\nnpm test\n```\nPrefer small changes.";
  assert.deepEqual(countRules(text), { lines: 4, rules: 2 });
});

test("a skill's always-loaded text is its description, folded or plain", () => {
  // Break: folded YAML descriptions count as empty, or the whole skill body
  // counts as always loaded.
  assert.equal(skillDescription("---\nname: a\ndescription: >-\n  Verify changes\n  before done.\n---\nBody text"), "Verify changes before done.");
  assert.equal(skillDescription("---\nname: a\ndescription: \"Plain one.\"\n---\n"), "Plain one.");
});

test("monthly snapshots run from the first month's end to the last day", () => {
  // Break: a month is skipped or the series stops short of today.
  assert.deepEqual(monthEnds("2025-12-18", "2026-02-10"), ["2025-12-31", "2026-01-31", "2026-02-10"]);
});

// --- Privacy -------------------------------------------------------------------

test("sessions map to their repository from workspaces, worktrees and renamed checkouts", () => {
  // Break: worktree sessions land in "unknown", so per-repository adoption
  // dates never apply to them.
  const known = ["mexxi", "eduline-ai-shop", "acme-shop"];
  const cases = [
    ["/h/workspace/mexxi/scripts", "mexxi"],
    ["/h/.local/share/mexxi/worktrees/eduline-ai-shop-7230a8a934/phase-9", "eduline-ai-shop"],
    ["/h/.local/share/opencode/implementation-worktrees/acme-shop-0123456789/x", "acme-shop"],
    ["/h/workspace/acme-shop-2", "acme-shop"],
    ["/h/workspace/mexxi-upgrade", "mexxi"],
    ["/h/.config/opencode", "global-config"],
    ["/tmp/segwi-canary-x/repo", "scratch"],
    ["/h", "home"],
  ];
  for (const [cwd, repo] of cases) assert.equal(repoFromCwd(cwd, "/h", known), repo, cwd);
});

test("unlisted repositories get letters in first-commit order, listed ones keep their names", () => {
  // Break: a private repository's name is published, or letters shuffle
  // between runs so the deck's labels stop matching.
  const labels = publicLabels([{ name: "zeta", firstCommit: "2025-01-01" }, { name: "mexxi", firstCommit: "2026-08-20" }, { name: "alpha", firstCommit: "2026-01-01" }]);
  assert.deepEqual([labels.get("zeta"), labels.get("alpha"), labels.get("mexxi")], ["private repo A", "private repo B", "mexxi"]);
});

test("the leak scan stops paths, addresses, secrets and private names, but not the owner's handle", () => {
  // Break: the last gate before writing lets a home path, an IP, a token or a
  // private repository name into a public pull request.
  assert.deepEqual(scanForLeaks("clean text from octo12/mexxi", ["octo"]), []);
  assert.ok(scanForLeaks("see /home/someone/x", []).includes("home path"));
  assert.ok(scanForLeaks("host 10.1.2.3", []).includes("IPv4 address"));
  // Built at run time so the committed file holds no token-shaped string.
  assert.ok(scanForLeaks(`key sk-${"a".repeat(24)}`, []).includes("secret pattern"));
  assert.ok(scanForLeaks("work in acme-shop today", ["acme-shop"]).includes("private repository name acme-shop"));
});

test("a refresh rewrites only the generated block of REPORT.md", () => {
  // Break: rerunning before the talk wipes the hand-written summary.
  const text = `# Report\n\nMy words.\n\n${START}\nold\n${END}\n\nMore words.\n`;
  assert.equal(replaceGenerated(text, `${START}\nnew\n${END}`), `# Report\n\nMy words.\n\n${START}\nnew\n${END}\n\nMore words.\n`);
});
