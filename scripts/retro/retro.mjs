#!/usr/bin/env node
// Session retrospective: runs the transcript extractor (session_retro.py) over
// interactive sessions, adds what ibni recorded about its runs (live workspace
// metadata and the run log that outlives cleanup), compares the goal-table
// signals with a baseline retro and writes the report to retro.output.
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
import { readMetadata } from "../ibni/lib/metadata.mjs";
import { summarizeTimings } from "../ibni/lib/timings.mjs";

const run = promisify(execFile);
const EXTRACTOR = fileURLToPath(new URL("./session_retro.py", import.meta.url));
const REPORT_PATTERN = /^retro-(\d{4}-\d{2}-\d{2}-\d{4})\.json$/;
const REPORT_STEM = /^retro-\d{4}-\d{2}-\d{2}-\d{4}(\.json)?$/;
// ibni's append-only run log, under paths.worktreeRoot so it outlives cleanup.
export const RUN_LOG = path.join(".ibni", "runs.jsonl");

export class RetroError extends Error {}

// Signals from the first retro's goal table, with the upgrade's target for
// each. `from` reads the figure and the number of sessions it occurred in out
// of the extractor's output.
export const GOAL_SIGNALS = [
  { key: "zshGlobAborts", target: "near 0", label: "zsh glob aborts", from: (s) => [s.zsh_pitfalls.total, s.zsh_pitfalls.sessions] },
  { key: "editBeforeRead", target: "under 10", label: "Edit/Write refused before Read", from: (s) => family(s, "edit_before_read") },
  { key: "bashCapHits", target: "0", label: "Bash 10-minute cap hits", from: (s) => [s.slow_tool_calls.bash_hit_10_minute_cap, null] },
  { key: "waitLoops", target: "under 10 (with sleep blocks)", label: "Hand-rolled wait loops and bare sleeps", from: (s) => [s.wait_loops.total, s.wait_loops.sessions] },
  { key: "sleepBlocks", target: "under 10 (with wait loops)", label: "Sleep blocks refused by the harness", from: (s) => family(s, "harness_sleep_block") },
  { key: "ibniErrors", target: "under 5", label: "ibni (implementation-workspace) usage errors", from: (s) => family(s, "implementation_workspace") },
  { key: "playwrightPathErrors", target: "0", label: "Playwright evidence-path errors", from: (s) => family(s, "playwright_outside_allowed_roots") },
  { key: "compactions", target: "half the baseline (14)", label: "Compactions mid-PR", from: (s) => [s.compactions.total, s.compactions.sessions] },
  { key: "followUpPrompts", target: "half the baseline (8)", label: "Follow-up rework prompts", from: (s) => [s.follow_up_requests.total, s.follow_up_requests.sessions] },
  { key: "hiddenExitStatus", target: "0", label: "Exit status hidden by pipes", from: (s) => [s.masked_verify_failures.total, s.masked_verify_failures.sessions] },
];

function family(signals, name) {
  const { occurrences, sessions } = signals.error_families[name];
  return [occurrences, sessions];
}

export function goalTable(signals) {
  const sessions = signals.inventory.sessions;
  return Object.fromEntries(GOAL_SIGNALS.map(({ key, label, target, from }) => {
    const [count, inSessions] = from(signals);
    return [key, { label, target, count, sessions: inSessions, per100Sessions: sessions ? Math.round((count / sessions) * 1000) / 10 : null }];
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
// metadata with them; the run log and earlier retros keep what they recorded.
async function workspaceMetadata(roots) {
  const directories = async (parent) => (await readdir(parent, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".evidence") && !entry.name.startsWith("."))
    .map((entry) => path.join(parent, entry.name));
  const found = [];
  for (const root of roots) {
    for (const repository of await directories(root)) {
      for (const worktree of await directories(repository)) {
        try {
          const pointer = (await readFile(path.join(worktree, ".git"), "utf8")).match(/^gitdir: (.+)$/m);
          const metadata = pointer ? await readMetadata(path.resolve(worktree, pointer[1].trim())) : null;
          if (metadata) found.push({ metadata, worktreePath: worktree });
        } catch {
          // A half-removed workspace has nothing to report.
        }
      }
    }
  }
  return found;
}

const minutes = (milliseconds) => Math.round(milliseconds / 6000) / 10;
const count = (value) => (Number.isFinite(value) ? value : 0);

// One run as the retro keeps it, whichever source it came from: timings and
// counts, never the request text, answers' payloads or file contents.
// prepareToPrMinutes is known only from live metadata, which has the steps' ends.
function runRecord(fields) {
  return {
    runId: null, sessionId: null, startedAt: null, repository: null, worktreePath: null, prUrl: null,
    outcome: null, prepareToPrMinutes: null, steps: {}, verify: { attempts: 0, failed: 0 },
    review: { passes: 0, findings: 0, accepted: 0 }, ci: null, source: null, ...fields,
  };
}

export function liveRun(metadata, worktreePath = null) {
  const timings = summarizeTimings(metadata);
  const markedPr = timings.steps.find((step) => step.step === "mark-pr" && step.outcome === "succeeded");
  const toPr = markedPr ? Date.parse(markedPr.endedAt) - Date.parse(metadata.createdAt) : null;
  const steps = {};
  for (const { step, durationMs } of timings.steps) {
    if (Number.isFinite(durationMs)) steps[step] = (steps[step] ?? 0) + durationMs;
  }
  return runRecord({
    runId: metadata.runId ?? null,
    sessionId: metadata.sessionId ?? null,
    startedAt: metadata.createdAt ?? null,
    repository: worktreePath ? path.basename(path.dirname(worktreePath)) : null,
    worktreePath,
    prUrl: metadata.prUrl ?? null,
    prepareToPrMinutes: Number.isFinite(toPr) && toPr >= 0 ? minutes(toPr) : null,
    steps,
    verify: { attempts: timings.verify.attempts, failed: timings.verify.failed },
    review: { passes: timings.review.rounds, findings: timings.review.findings, accepted: timings.review.accepted },
    source: "live",
  });
}

export function logRun(line) {
  const steps = Object.fromEntries(Object.entries(line.steps ?? {}).filter(([, value]) => Number.isFinite(value)));
  return runRecord({
    runId: line.runId ?? null,
    startedAt: line.startedAt ?? null,
    repository: line.repository ?? null,
    worktreePath: line.worktreePath ?? null,
    prUrl: line.prUrl ?? null,
    outcome: line.outcome ?? null,
    steps,
    verify: { attempts: count(line.verify?.attempts), failed: count(line.verify?.failed) },
    review: { passes: count(line.review?.passes), findings: count(line.review?.findings), accepted: count(line.review?.accepted) },
    ci: line.ci ? { rounds: count(line.ci.rounds), state: line.ci.state ?? null } : null,
    source: "log",
  });
}

// A run an earlier retro kept: ibniRuns from this version, or the ibniSessions
// of retros written before the run log, whose review acceptance was split by
// reviewer family.
export function carriedRun(saved) {
  if (!("createdAt" in saved)) return runRecord({ ...saved, source: "carried" });
  const steps = {};
  for (const { step, minutes: spent } of saved.steps ?? []) {
    if (Number.isFinite(spent)) steps[step] = (steps[step] ?? 0) + spent * 60_000;
  }
  const byReviewer = Object.values(saved.review?.byReviewer ?? {});
  return runRecord({
    sessionId: saved.sessionId ?? null,
    startedAt: saved.createdAt,
    prUrl: saved.prUrl ?? null,
    prepareToPrMinutes: saved.prepareToPrMinutes ?? null,
    steps,
    verify: { attempts: count(saved.verify?.attempts), failed: count(saved.verify?.failed) },
    review: {
      passes: count(saved.review?.rounds),
      findings: count(saved.review?.findings),
      accepted: saved.review?.accepted ?? byReviewer.reduce((total, reviewer) => total + count(reviewer.accepted), 0),
    },
    source: "carried",
  });
}

// The run log has one line per event; a run's last line is its state. Lines
// that do not parse, or name no run, are skipped and counted.
export async function readRunLog(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { file, found: false, lines: 0, unreadable: 0, runs: [] };
    throw new RetroError(`the ibni run log ${file} is unreadable: ${error.message}`);
  }
  const latest = new Map();
  let lines = 0;
  let unreadable = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    lines += 1;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      unreadable += 1;
      continue;
    }
    const key = line && typeof line === "object" && !Array.isArray(line)
      ? line.runId ?? (line.worktreePath && line.startedAt ? `${line.worktreePath}|${line.startedAt}` : null)
      : null;
    if (!key) {
      unreadable += 1;
      continue;
    }
    latest.delete(key);
    latest.set(key, line);
  }
  return { file, found: true, lines, unreadable, runs: [...latest.values()].map(logRun) };
}

// Layers in rising precedence (earlier retros, the run log, live metadata).
// A run is the same run when its runId matches, else its worktree path and
// start, else its ibni session; a later layer's known values replace earlier
// ones, so live metadata wins and the log still supplies CI state and outcome.
export function mergeRuns(...layers) {
  const identities = (record) => [
    record.runId && `run:${record.runId}`,
    record.worktreePath && record.startedAt && `path:${record.worktreePath}|${record.startedAt}`,
    record.sessionId && `session:${record.sessionId}`,
  ].filter(Boolean);
  const overlay = (target, record) => {
    for (const [key, value] of Object.entries(record)) if ((value !== null && value !== undefined) || !(key in target)) target[key] = value;
  };
  let merged = [];
  const index = new Map();
  for (const layer of layers) {
    for (const record of layer) {
      // A live run can join two earlier entries (a carried session and a
      // logged runId); they fold together in the order they arrived.
      const found = merged.filter((entry) => identities(record).some((identity) => index.get(identity) === entry));
      const target = {};
      for (const entry of found) overlay(target, entry);
      overlay(target, record);
      merged = [...merged.filter((entry) => !found.includes(entry)), target];
      for (const identity of identities(target)) index.set(identity, target);
    }
  }
  return merged.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

const median = (values) => percentile(values, 50);
function percentile(values, rank) {
  const sorted = values.filter((value) => value !== null && value !== undefined).sort((a, b) => a - b);
  // Nearest rank; for the median that is the lower middle value.
  return sorted.length ? sorted[Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)] : null;
}
const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const perRun = (total, runs) => (runs ? Math.round((total / runs) * 10) / 10 : null);

export function summarizeRuns(runs) {
  const sum = (pick) => runs.reduce((total, record) => total + pick(record), 0);
  const outcomes = {};
  const sources = {};
  for (const record of runs) {
    outcomes[record.outcome ?? "open"] = (outcomes[record.outcome ?? "open"] ?? 0) + 1;
    sources[record.source] = (sources[record.source] ?? 0) + 1;
  }
  const green = (record) => record.ci.state === "green" || record.outcome === "green";
  const waited = runs.filter((record) => record.ci?.rounds > 0);
  const greenFirst = waited.filter((record) => record.ci.rounds === 1 && green(record)).length;
  const greenAfterFixes = waited.filter((record) => record.ci.rounds > 1 && green(record)).length;
  const stepTimes = {};
  for (const record of runs) {
    for (const [step, milliseconds] of Object.entries(record.steps)) (stepTimes[step] ??= []).push(minutes(milliseconds));
  }
  const toPr = runs.map((record) => record.prepareToPrMinutes).filter(Number.isFinite);
  const findings = sum((record) => record.review.findings);
  const accepted = sum((record) => record.review.accepted);
  return {
    runs: runs.length,
    sources,
    withPullRequest: runs.filter((record) => record.prUrl).length,
    outcomes,
    ci: {
      waited: waited.length,
      greenFirst,
      greenFirstPercent: share(greenFirst, waited.length),
      greenAfterFixes,
      greenAfterFixesPercent: share(greenAfterFixes, waited.length),
    },
    prepareToPrMinutes: { median: median(toPr), max: toPr.length ? Math.max(...toPr) : null },
    steps: Object.fromEntries(Object.entries(stepTimes).sort(([a], [b]) => a.localeCompare(b))
      .map(([step, values]) => [step, { runs: values.length, medianMinutes: median(values), p90Minutes: percentile(values, 90) }])),
    verify: { attemptsPerRun: perRun(sum((record) => record.verify.attempts), runs.length), failed: sum((record) => record.verify.failed) },
    review: {
      passesPerRun: perRun(sum((record) => record.review.passes), runs.length),
      findingsPerRun: perRun(findings, runs.length),
      findings,
      accepted,
      acceptedPercent: share(accepted, findings),
    },
  };
}

async function readReport(file, what) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new RetroError(error.code === "ENOENT" ? `${what} ${file} does not exist` : `${what} ${file} is unreadable: ${error.message}`);
  }
}

async function latestReport(output) {
  const names = (await readdir(output).catch(() => [])).filter((name) => REPORT_PATTERN.test(name)).sort();
  if (!names.length) return null;
  const file = path.join(output, names.at(-1));
  return { file, report: await readReport(file, "the previous retro") };
}

// The report to compare with: the one --baseline names (a path, or a stem
// resolved inside retro.output), else the latest in retro.output.
export async function baselineReport(output, named) {
  if (!named) {
    const latest = await latestReport(output);
    return latest && { ...latest, named: false };
  }
  const file = REPORT_STEM.test(named) ? path.join(output, named.endsWith(".json") ? named : `${named}.json`) : path.resolve(named);
  if (!REPORT_PATTERN.test(path.basename(file))) {
    throw new RetroError(`--baseline takes a retro-<date>-<time>.json report or its stem, such as retro-2026-11-10-2132; got ${named}`);
  }
  return { file, report: await readReport(file, "the baseline retro"), named: true };
}

const cell = (value) => (value === null || value === undefined ? "n/a" : String(value));
const signed = (value) => (value > 0 ? `+${value}` : String(value));
const percent = (value) => (value === null ? "n/a" : `${value}%`);
const SOURCE_LABELS = { live: "live workspaces", log: "the run log", carried: "earlier retros" };

export function renderMarkdown(report) {
  const { goalTable: table, baseline, ibni, runLog, signals } = report;
  const excluded = signals.inventory.excluded_non_interactive ?? {};
  const lines = [
    `# Session retrospective, ${report.generatedAt.slice(0, 10)}`,
    "",
    `Interactive sessions analysed: ${signals.inventory.sessions} (${signals.inventory.date_range[0]?.slice(0, 10) ?? "n/a"} to ${signals.inventory.date_range[1]?.slice(0, 10) ?? "n/a"}); ` +
      `tool calls: ${signals.inventory.total_tool_calls}. ` +
      `Not counted: ${excluded.skill_eval ?? 0} skill-eval runs and ${excluded.temp_directory ?? 0} sessions under a temporary directory (segwi canaries, probes).`,
    baseline
      ? `Baseline: ${baseline.report} of ${baseline.generatedAt.slice(0, 10)} (${baseline.sessions} sessions), ${baseline.named ? "named with --baseline" : "the latest earlier retro"}.` +
        (baseline.interactiveOnly ? "" : " It counted every session, skill evals and temporary-directory runs included, so per-session figures are not like for like.")
      : "No baseline retro to compare with.",
    "",
    "## Goal signals",
    "",
    "| Signal | Now | In sessions | Per 100 sessions | Baseline | Change | Target |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [key, row] of Object.entries(table)) {
    const before = baseline?.goalTable[key];
    lines.push(`| ${row.label} | ${row.count} | ${cell(row.sessions)} | ${cell(row.per100Sessions)} | ${cell(before?.count)} | ${before ? signed(row.count - before.count) : "n/a"} | ${row.target} |`);
  }
  const sources = Object.entries(ibni.sources).map(([source, runs]) => `${SOURCE_LABELS[source] ?? source} ${runs}`).join(", ");
  const outcomes = Object.entries(ibni.outcomes).map(([outcome, runs]) => `${outcome} ${runs}`).join(", ");
  lines.push(
    "",
    "## ibni runs",
    "",
    `Runs: ${ibni.runs}${sources ? ` (${sources})` : ""}; with a pull request: ${ibni.withPullRequest}.`,
    `Outcomes: ${outcomes || "none"}.`,
    `CI: of ${ibni.ci.waited} runs that waited on CI, ${ibni.ci.greenFirst} (${percent(ibni.ci.greenFirstPercent)}) were green at the first wait and ${ibni.ci.greenAfterFixes} (${percent(ibni.ci.greenAfterFixesPercent)}) after fix rounds.`,
    `Prepare to pull request, median minutes: ${cell(ibni.prepareToPrMinutes.median)} (longest ${cell(ibni.prepareToPrMinutes.max)}).`,
    `Verify attempts per run: ${cell(ibni.verify.attemptsPerRun)} (${ibni.verify.failed} failed in all).`,
    `Review: ${cell(ibni.review.passesPerRun)} passes and ${cell(ibni.review.findingsPerRun)} findings per run; ${ibni.review.accepted} of ${ibni.review.findings} findings accepted (${percent(ibni.review.acceptedPercent)}).`,
    runLog.found
      ? `Run log: ${runLog.lines} lines${runLog.unreadable ? `, ${runLog.unreadable} unreadable and skipped` : ""}.`
      : "Run log: none yet.",
  );
  if (Object.keys(ibni.steps).length) {
    lines.push("", "| Step | Runs | Median minutes | p90 minutes |", "| --- | --- | --- | --- |");
    for (const [step, row] of Object.entries(ibni.steps)) lines.push(`| ${step} | ${row.runs} | ${cell(row.medianMinutes)} | ${cell(row.p90Minutes)} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`.replace(/\n{3,}$/, "\n");
}

const USAGE = "Usage: node scripts/retro/retro.mjs [--since <date>] [--until <date>] [--baseline <retro-report>] [--exclude <session-prefix>]... [--projects-dir <dir>]";

function parseArguments(args) {
  const options = { exclude: [] };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--since", "--until", "--baseline", "--exclude", "--projects-dir"].includes(key) || value === undefined) {
      throw new RetroError(`invalid argument ${key ?? ""}\n${USAGE}`);
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
  // Both before the extractor's long run, so a wrong --baseline fails at once.
  const baseline = await baselineReport(output, options.baseline);
  const latest = options.baseline ? await latestReport(output) : baseline;

  const signals = await extractSignals(options);
  const roots = [config.paths.worktreeRoot, ...legacyWorktreeRoots.map((root) => path.resolve(expandHome(root, os.homedir())))];
  // The same window as the extractor's: a bare --until date includes that day.
  const bound = (value, end) => new Date(end && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value) + 86_400_000 : value).toISOString();
  const inWindow = ({ startedAt }) => (!options.since && !options.until) || (Boolean(startedAt) &&
    (!options.since || startedAt >= bound(options.since, false)) && (!options.until || startedAt < bound(options.until, true)));
  const runLog = await readRunLog(path.join(config.paths.worktreeRoot, RUN_LOG));
  const carried = (latest?.report.ibniRuns ?? latest?.report.ibniSessions ?? []).map(carriedRun);
  const live = (await workspaceMetadata(roots)).map(({ metadata, worktreePath }) => liveRun(metadata, worktreePath));
  const runs = mergeRuns(carried, runLog.runs, live).filter(inWindow);

  const report = {
    generatedAt: now.toISOString(),
    window: { since: options.since ?? null, until: options.until ?? null },
    goalTable: goalTable(signals),
    baseline: baseline ? {
      report: path.basename(baseline.file, ".json"),
      named: baseline.named,
      generatedAt: baseline.report.generatedAt,
      sessions: baseline.report.signals.inventory.sessions,
      interactiveOnly: "excluded_non_interactive" in baseline.report.signals.inventory,
      goalTable: baseline.report.goalTable,
    } : null,
    ibni: summarizeRuns(runs),
    runLog: { found: runLog.found, lines: runLog.lines, unreadable: runLog.unreadable },
    ibniRuns: runs,
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
