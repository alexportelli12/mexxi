#!/usr/bin/env node
// Session retrospective: runs the transcript extractor (session_retro.py), adds
// what ibni recorded about its own sessions, compares the goal-table signals
// with the previous retro and writes the report to retro.output.
//
// Reports hold transcript-derived text, so they never go to a repository that
// could be public: the output folder must be outside any Git repository, or be
// gitignored there with nothing tracked in it (assertPrivateOutput).
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigError, expandHome, loadConfig } from "../lib/config.mjs";
import { legacyWorktreeRoots } from "../lib/render.mjs";
import { summarizeTriage } from "../ibni/commands/triage.mjs";
import { readMetadata } from "../ibni/lib/metadata.mjs";
import { summarizeTimings } from "../ibni/lib/timings.mjs";

const run = promisify(execFile);
const EXTRACTOR = fileURLToPath(new URL("./session_retro.py", import.meta.url));
const REPORT_PATTERN = /^retro-(\d{4}-\d{2}-\d{2}-\d{4})\.json$/;

export class RetroError extends Error {}

// Signals from the first retro's goal table. `from` reads the figure and the
// number of sessions it occurred in out of the extractor's output.
export const GOAL_SIGNALS = [
  { key: "zshGlobAborts", label: "zsh glob aborts", from: (s) => [s.zsh_pitfalls.total, s.zsh_pitfalls.sessions] },
  { key: "editBeforeRead", label: "Edit/Write refused before Read", from: (s) => family(s, "edit_before_read") },
  { key: "bashCapHits", label: "Bash 10-minute cap hits", from: (s) => [s.slow_tool_calls.bash_hit_10_minute_cap, null] },
  { key: "waitLoops", label: "Hand-rolled wait loops and bare sleeps", from: (s) => [s.wait_loops.total, s.wait_loops.sessions] },
  { key: "sleepBlocks", label: "Sleep blocks refused by the harness", from: (s) => family(s, "harness_sleep_block") },
  { key: "ibniErrors", label: "ibni (implementation-workspace) usage errors", from: (s) => family(s, "implementation_workspace") },
  { key: "playwrightPathErrors", label: "Playwright evidence-path errors", from: (s) => family(s, "playwright_outside_allowed_roots") },
  { key: "compactions", label: "Compactions mid-PR", from: (s) => [s.compactions.total, s.compactions.sessions] },
  { key: "followUpPrompts", label: "Follow-up rework prompts", from: (s) => [s.follow_up_requests.total, s.follow_up_requests.sessions] },
  { key: "hiddenExitStatus", label: "Exit status hidden by pipes", from: (s) => [s.masked_verify_failures.total, s.masked_verify_failures.sessions] },
];

function family(signals, name) {
  const { occurrences, sessions } = signals.error_families[name];
  return [occurrences, sessions];
}

export function goalTable(signals) {
  const sessions = signals.inventory.sessions;
  return Object.fromEntries(GOAL_SIGNALS.map(({ key, label, from }) => {
    const [count, inSessions] = from(signals);
    return [key, { label, count, sessions: inSessions, per100Sessions: sessions ? Math.round((count / sessions) * 1000) / 10 : null }];
  }));
}

// A report is private only if Git cannot publish it: outside every repository,
// or ignored there with nothing tracked beneath it. Whether the repository is
// public cannot be known offline, so this is the stricter, deterministic rule.
export async function assertPrivateOutput(output) {
  let existing = output;
  for (;;) {
    try {
      await readdir(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  const git = async (args, allowed = [0]) => {
    try {
      return { code: 0, stdout: (await run("git", ["-C", existing, ...args])).stdout };
    } catch (error) {
      if (typeof error.code === "number" && allowed.includes(error.code)) return { code: error.code, stdout: error.stdout ?? "" };
      throw error;
    }
  };
  const inside = await git(["rev-parse", "--is-inside-work-tree"], [128]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return;
  const relative = path.relative(existing, output) || ".";
  const probe = path.join(relative, "retro-probe.json");
  const ignored = await git(["check-ignore", "-q", "--", probe], [1]);
  const tracked = await git(["ls-files", "--", relative]);
  if (ignored.code !== 0 || tracked.stdout.trim()) {
    throw new RetroError(
      `refusing to write retro reports to ${output}: it is inside a Git repository and ${ignored.code !== 0 ? "not gitignored there" : "has tracked files"}. ` +
      "Set retro.output in ~/.config/mexxi/config.json to a gitignored folder or a folder outside any repository.",
    );
  }
}

async function extractSignals({ projectsDir, since, until, exclude }) {
  const args = ["-I", EXTRACTOR, "--out", "-"];
  if (projectsDir) args.push("--projects-dir", projectsDir);
  if (since) args.push("--since", since);
  if (until) args.push("--until", until);
  for (const prefix of exclude) args.push("--exclude", prefix);
  try {
    const { stdout } = await run("python3", args, { maxBuffer: 512 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new RetroError(`the transcript extractor failed: ${(error.stderr || error.message).trim().split("\n").slice(-3).join(" | ")}`);
  }
}

// Every workspace ibni still holds metadata for: <root>/<repository>/<leaf>
// under paths.worktreeRoot and the retired roots. Swept workspaces take their
// metadata with them, so a retro carries earlier ones forward (mergeSessions).
async function workspaceMetadata(roots) {
  const directories = async (parent) => (await readdir(parent, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".evidence"))
    .map((entry) => path.join(parent, entry.name));
  const found = [];
  for (const root of roots) {
    for (const repository of await directories(root)) {
      for (const worktree of await directories(repository)) {
        try {
          const pointer = (await readFile(path.join(worktree, ".git"), "utf8")).match(/^gitdir: (.+)$/m);
          const metadata = pointer ? await readMetadata(path.resolve(worktree, pointer[1].trim())) : null;
          if (metadata) found.push(metadata);
        } catch {
          // A half-removed workspace has nothing to report.
        }
      }
    }
  }
  return found;
}

const minutes = (milliseconds) => Math.round(milliseconds / 6000) / 10;

// What the retro keeps of one ibni session: timings and counts, never the
// request text, answers' payloads or file contents.
export function summarizeSession(metadata) {
  const timings = summarizeTimings(metadata);
  const markedPr = timings.steps.find((step) => step.step === "mark-pr" && step.outcome === "succeeded");
  const toPr = markedPr ? Date.parse(markedPr.endedAt) - Date.parse(metadata.createdAt) : null;
  const triage = summarizeTriage(metadata);
  return {
    sessionId: metadata.sessionId,
    createdAt: metadata.createdAt,
    prUrl: metadata.prUrl ?? null,
    adopted: (metadata.adoptions ?? []).length > 0,
    prepareToPrMinutes: Number.isFinite(toPr) && toPr >= 0 ? minutes(toPr) : null,
    steps: timings.steps.map(({ step, outcome, durationMs }) => ({ step, outcome, minutes: minutes(durationMs) })),
    verify: { attempts: timings.verify.attempts, failed: timings.verify.failed },
    review: timings.review,
    qa: { rounds: timings.qa.rounds, findings: timings.qa.findings },
    triage: { status: triage.status, compared: triage.agreement.compared, agreed: triage.agreement.agreed, gates: triage.agreement.gates },
  };
}

export function mergeSessions(previous, current) {
  const byId = new Map(previous.map((session) => [session.sessionId, session]));
  for (const session of current) byId.set(session.sessionId, session);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export function summarizeIbni(sessions) {
  const toPr = sessions.map((session) => session.prepareToPrMinutes);
  const reviewer = (kind) => sessions.reduce((total, { review }) => ({
    rounds: total.rounds + review.byReviewer[kind].rounds,
    findings: total.findings + review.byReviewer[kind].findings,
    accepted: total.accepted + review.byReviewer[kind].accepted,
  }), { rounds: 0, findings: 0, accepted: 0 });
  const withShare = (value) => ({ ...value, acceptedPercent: share(value.accepted, value.findings) });
  const gates = {};
  for (const { triage } of sessions) {
    for (const [gate, result] of Object.entries(triage.gates)) {
      if (result.agree === null) continue;
      gates[gate] ??= { compared: 0, agreed: 0 };
      gates[gate].compared += 1;
      gates[gate].agreed += result.agree ? 1 : 0;
    }
  }
  const compared = Object.values(gates).reduce((total, gate) => total + gate.compared, 0);
  const agreed = Object.values(gates).reduce((total, gate) => total + gate.agreed, 0);
  return {
    sessions: sessions.length,
    withPullRequest: toPr.filter((value) => value !== null).length,
    prepareToPrMinutes: { median: median(toPr), max: toPr.filter((value) => value !== null).reduce((a, b) => Math.max(a, b), 0) || null },
    verifyAttemptsPerSession: sessions.length ? Math.round((sessions.reduce((total, { verify }) => total + verify.attempts, 0) / sessions.length) * 10) / 10 : null,
    jevAgreement: { compared, agreed, agreedPercent: share(agreed, compared), gates },
    reviewAcceptance: { same: withShare(reviewer("same")), cross: withShare(reviewer("cross")) },
  };
}

async function previousReport(output) {
  const names = (await readdir(output).catch(() => [])).filter((name) => REPORT_PATTERN.test(name)).sort();
  if (!names.length) return null;
  const file = path.join(output, names.at(-1));
  try {
    return { file, report: JSON.parse(await readFile(file, "utf8")) };
  } catch (error) {
    throw new RetroError(`the previous retro ${file} is unreadable: ${error.message}`);
  }
}

const cell = (value) => (value === null || value === undefined ? "n/a" : String(value));
const signed = (value) => (value > 0 ? `+${value}` : String(value));

export function renderMarkdown(report) {
  const { goalTable: table, previous, ibni, signals } = report;
  const lines = [
    `# Session retrospective, ${report.generatedAt.slice(0, 10)}`,
    "",
    `Sessions analysed: ${signals.inventory.sessions} (${signals.inventory.date_range[0]?.slice(0, 10) ?? "n/a"} to ${signals.inventory.date_range[1]?.slice(0, 10) ?? "n/a"}); ` +
      `tool calls: ${signals.inventory.total_tool_calls}.`,
    previous ? `Compared with the retro of ${previous.generatedAt.slice(0, 10)} (${previous.sessions} sessions).` : "No previous retro to compare with.",
    "",
    "## Goal signals",
    "",
    "| Signal | Now | In sessions | Per 100 sessions | Previous | Change |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const [key, row] of Object.entries(table)) {
    const before = previous?.goalTable[key];
    lines.push(`| ${row.label} | ${row.count} | ${cell(row.sessions)} | ${cell(row.per100Sessions)} | ${cell(before?.count)} | ${before ? signed(row.count - before.count) : "n/a"} |`);
  }
  lines.push(
    "",
    "## ibni sessions",
    "",
    `Sessions with metadata: ${ibni.sessions}; with a pull request: ${ibni.withPullRequest}.`,
    `Prepare to pull request, median minutes: ${cell(ibni.prepareToPrMinutes.median)} (longest ${cell(ibni.prepareToPrMinutes.max)}).`,
    `Verify attempts per session: ${cell(ibni.verifyAttemptsPerSession)}.`,
    `Jev triage agreement: ${ibni.jevAgreement.agreed} of ${ibni.jevAgreement.compared} gate comparisons (${cell(ibni.jevAgreement.agreedPercent)}%).`,
    "",
    "| Reviewer | Rounds | Findings | Accepted | Accepted share |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const kind of ["same", "cross"]) {
    const row = ibni.reviewAcceptance[kind];
    lines.push(`| ${kind}-family | ${row.rounds} | ${row.findings} | ${row.accepted} | ${row.acceptedPercent === null ? "n/a" : `${row.acceptedPercent}%`} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`.replace(/\n{3,}$/, "\n");
}

function parseArguments(args) {
  const options = { exclude: [] };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--since", "--until", "--exclude", "--projects-dir"].includes(key) || value === undefined) {
      throw new RetroError(`invalid argument ${key ?? ""}\nUsage: node scripts/retro/retro.mjs [--since <date>] [--until <date>] [--exclude <session-prefix>]... [--projects-dir <dir>]`.trim());
    }
    if (key === "--exclude") options.exclude.push(value);
    else options[key.slice(2).replace(/-(\w)/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

export async function retro(args, { now = new Date() } = {}) {
  const options = parseArguments(args);
  const { config } = await loadConfig();
  const output = config.retro.output;
  await assertPrivateOutput(output);

  const signals = await extractSignals(options);
  const roots = [config.paths.worktreeRoot, ...legacyWorktreeRoots.map((root) => path.resolve(expandHome(root, os.homedir())))];
  // The same window as the extractor's: a bare --until date includes that day.
  const bound = (value, end) => new Date(end && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) + 86_400_000 : value).toISOString();
  const inWindow = (metadata) => (!options.since || metadata.createdAt >= bound(options.since, false)) &&
    (!options.until || metadata.createdAt < bound(options.until, true));
  const previous = await previousReport(output);
  const current = (await workspaceMetadata(roots)).filter(inWindow).map(summarizeSession);
  const sessions = mergeSessions(previous?.report.ibniSessions ?? [], current);

  const report = {
    generatedAt: now.toISOString(),
    window: { since: options.since ?? null, until: options.until ?? null },
    goalTable: goalTable(signals),
    previous: previous ? { generatedAt: previous.report.generatedAt, sessions: previous.report.signals.inventory.sessions, goalTable: previous.report.goalTable } : null,
    ibni: summarizeIbni(sessions),
    ibniSessions: sessions,
    signals,
  };
  await mkdir(output, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const base = path.join(output, `retro-${stamp}`);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${base}.md`, renderMarkdown(report));
  return { report, files: [`${base}.md`, `${base}.json`] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, files } = await retro(process.argv.slice(2));
    process.stdout.write(renderMarkdown(report));
    process.stdout.write(`Written to ${files.join(" and ")}\n`);
  } catch (error) {
    if (!(error instanceof RetroError || error instanceof ConfigError)) throw error;
    process.stderr.write(`retro: ${error.message}\n`);
    process.exitCode = 2;
  }
}
