#!/usr/bin/env node
// Re-measures the journey: reads this machine's agent sessions and the Git
// history of the repositories under ~/workspace, then writes
// research/journey/journey-data.json and the generated tables in REPORT.md.
//
//   node research/journey/scripts/run.mjs [--offline] [--until YYYY-MM-DD]
//
// --offline skips GitHub (pull requests and the clone of a public repository
// that has no local checkout). Only aggregates are written, and every written
// file passes scanForLeaks first; a leak stops the run with nothing written.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DAY_MS, compare, dailyConcurrency, daysBetween, isoWeek, summarize, verdict } from "./lib/aggregate.mjs";
import { CONCERNS, backpackAt, git, mexxiToolDates, monthEnds, repoMilestones } from "./lib/git.mjs";
import { activeSpans, sessionMetrics } from "./lib/metrics.mjs";
import { PUBLIC_REPOS, publicLabels, repoFromCwd, scanForLeaks } from "./lib/privacy.mjs";
import { AGENT_BRANCH, listPullRequests, summarizeGroup, summarizePullRequest } from "./lib/prs.mjs";
import { claudeSessions, codexSessions, openCodeSessions } from "./lib/sources.mjs";
import { renderTables, replaceGenerated } from "./lib/report.mjs";

const execute = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..");
const HOME = os.homedir();
const WORKSPACE = path.join(HOME, "workspace");
// Public repositories with history worth reading but no checkout here.
const REMOTE_ONLY = [{ name: "constitution-explained", slug: "alexportelli12/constitution-explained" }];
const CACHE = path.join(os.homedir(), ".cache", "mexxi-journey");

const options = { offline: process.argv.includes("--offline"), until: null };
const untilIndex = process.argv.indexOf("--until");
if (untilIndex > 0) options.until = process.argv[untilIndex + 1];
const today = options.until ?? new Date().toISOString().slice(0, 10);
const untilMs = Date.parse(today) + DAY_MS;

const log = (message) => process.stderr.write(`${message}\n`);

async function isRepo(dir) {
  return stat(path.join(dir, ".git")).then(() => true, () => false);
}

async function collectRepos() {
  const repos = [];
  for (const name of (await readdir(WORKSPACE).catch(() => [])).sort()) {
    const dir = path.join(WORKSPACE, name);
    if (!(await isRepo(dir))) continue;
    const remote = (await git(dir, ["remote", "get-url", "origin"])).trim();
    const slug = remote.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? null;
    // A second checkout of a repository already listed (same remote, longer
    // name, as in mexxi-upgrade) adds nothing; its sessions map by prefix.
    if (slug && repos.some((repo) => repo.slug?.toLowerCase() === slug.toLowerCase())) continue;
    repos.push({ name, dir, slug });
  }
  if (!options.offline) {
    for (const { name, slug } of REMOTE_ONLY) {
      const dir = path.join(CACHE, name);
      await mkdir(CACHE, { recursive: true });
      if (await isRepo(dir)) await git(dir, ["fetch", "--quiet", "origin"]).then(() => git(dir, ["reset", "--quiet", "--hard", "origin/HEAD"]));
      else await execute("gh", ["repo", "clone", slug, dir, "--", "--quiet"]).catch(() => null);
      if (await isRepo(dir)) repos.push({ name, dir, slug });
    }
  }
  for (const repo of repos) {
    repo.milestones = await repoMilestones(repo.dir);
    repo.firstCommit = repo.milestones.firstCommit?.date ?? null;
  }
  return repos;
}

// The earliest of one milestone across repositories.
function earliest(repos, key, filter = () => true) {
  return repos.filter(filter).map((repo) => ({ repo: repo.name, ...repo.milestones[key] }))
    .filter((m) => m.date).sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo))[0] ?? null;
}

// --- Sessions ---------------------------------------------------------------

const IBNI_USE = /(?:^|[\s;&|(])ibni (?:prepare|verify|publish)\b/m;
const WORKTREE_CLI_USE = /(?:^|[\s;&|(])implementation-workspace (?:prepare|verify|publish)\b/m;

async function readSessions(repoNames) {
  const sources = {
    claude: claudeSessions(path.join(HOME, ".claude", "projects")),
    opencode: openCodeSessions(path.join(HOME, ".local", "share", "opencode", "opencode.db")),
    codex: codexSessions(path.join(HOME, ".codex", "sessions")),
  };
  const rows = [];
  const coverage = {};
  const firstUse = { ibni: null, worktreeCli: null };
  for (const [source, sessions] of Object.entries(sources)) {
    const cover = { sessions: 0, analysed: 0, excluded: { scratch: 0, undated: 0, afterUntil: 0, empty: 0 }, from: null, to: null, toolCalls: 0 };
    for await (const session of sessions) {
      cover.sessions += 1;
      if (!session.start) {
        cover.excluded.undated += 1;
        continue;
      }
      if (session.start >= untilMs) {
        cover.excluded.afterUntil += 1;
        continue;
      }
      const repo = repoFromCwd(session.cwd, HOME, repoNames);
      // Sessions in /tmp are the workflow's own canaries and test fixtures.
      if (repo === "scratch") {
        cover.excluded.scratch += 1;
        continue;
      }
      const metrics = source === "codex" ? null : sessionMetrics(session);
      const toolCalls = source === "codex" ? session.toolCalls : metrics.toolCalls;
      if (!toolCalls) {
        cover.excluded.empty += 1;
        continue;
      }
      for (const event of session.events) {
        if (event.kind !== "tool" || !event.command) continue;
        if (IBNI_USE.test(event.command) && (!firstUse.ibni || event.at < firstUse.ibni.at)) firstUse.ibni = { at: event.at, repo, source };
        if (WORKTREE_CLI_USE.test(event.command) && (!firstUse.worktreeCli || event.at < firstUse.worktreeCli.at)) firstUse.worktreeCli = { at: event.at, repo, source };
      }
      const times = source === "codex" ? session.times : [session.start, ...session.events.map((event) => event.at)];
      cover.analysed += 1;
      cover.toolCalls += toolCalls;
      const from = new Date(session.start).toISOString().slice(0, 10);
      const to = new Date(session.end ?? session.start).toISOString().slice(0, 10);
      cover.from = !cover.from || from < cover.from ? from : cover.from;
      cover.to = !cover.to || to > cover.to ? to : cover.to;
      const quotes = metrics?.quoteCandidates.length ?? 0;
      if (metrics) delete metrics.quoteCandidates;
      rows.push({ source, repo, start: session.start, model: session.model, metrics, toolCalls, quotes, spans: activeSpans(times) });
    }
    coverage[source] = cover;
    log(`${source}: ${cover.analysed} of ${cover.sessions} sessions`);
  }
  return { rows, coverage, firstUse };
}

// --- Backpack ---------------------------------------------------------------

async function backpack(repos, dates) {
  const series = [];
  for (const repo of repos) {
    for (const date of dates) {
      if (repo.firstCommit && date < repo.firstCommit) continue;
      const row = await backpackAt(repo.dir, date, { mexxi: repo.name === "mexxi" });
      if (row && (row.instructions || row.skills)) series.push({ date, source: repo.name, ...row });
    }
  }
  return series;
}

// --- Main -------------------------------------------------------------------

const repos = await collectRepos();
log(`repositories: ${repos.map((r) => r.name).join(", ")}`);
const labels = publicLabels(repos.map(({ name, firstCommit }) => ({ name, firstCommit })));
const label = (name) => labels.get(name) ?? "unknown";
const mexxi = repos.find((r) => r.name === "mexxi");
const mexxiTools = mexxi ? await mexxiToolDates(mexxi.dir) : {};

const { rows: allRows, coverage, firstUse } = await readSessions(repos.map((r) => r.name));
const rows = allRows.filter((row) => row.metrics);
const notes = [];

// Milestones ------------------------------------------------------------------
const nonSelf = (name) => (repo) => repo.name !== name;
const asMilestone = (id, found, note) => found ? { id, date: found.date, repo: label(found.repo), commit: found.commit ?? null, note } : { id, date: null, repo: null, commit: null, note };
const mexxiMilestone = (id, key, note) => asMilestone(id, mexxiTools[key] ? { ...mexxiTools[key], repo: "mexxi" } : null, note);
const ibniUse = firstUse.ibni ? new Date(firstUse.ibni.at).toISOString().slice(0, 10) : null;
const milestones = [
  asMilestone("first-agent-commit", earliest(repos, "agentCommit"), "Earliest commit carrying a Claude Code, OpenCode or Codex attribution trailer. Unattributed agent commits before it cannot be told apart."),
  asMilestone("first-instructions-file", earliest(repos, "instructions"), "First AGENTS.md or CLAUDE.md added to any repository."),
  asMilestone("first-skill", earliest(repos, "skill"), "First SKILL.md added to any repository."),
  asMilestone("first-verify-command", earliest(repos, "verifyScript"), "First package.json gaining a single \"verify\" script."),
  asMilestone("strict-lint", earliest(repos, "strictLint"), "First ESLint config commit whose message says it hardens or tightens lint. Only one repository's history says so in words."),
  asMilestone("verifika-adoption", earliest(repos, "verifika", nonSelf("verifika")), "First verifika.config.json outside verifika itself."),
  mexxiMilestone("worktree-cli", "worktreeCli", "ibni's predecessor, the implementation-workspace CLI, first committed."),
  { ...mexxiMilestone("ibni-first-use", "ibni", "The worktree CLI renamed ibni and split into commands."), firstSessionUse: ibniUse },
  mexxiMilestone("port-blocks", "portBlocks", "Each workspace gets a block of ports."),
  mexxiMilestone("run-slots", "runSlots", "Setup and verify wait for a machine-wide run slot."),
  { ...mexxiMilestone("mexxi-public", "docsSite", "Renamed to mexxi with a docs site and one-paste setup; GitHub Pages first deployed the same day. The MIT licence followed on " + (mexxiTools.licence?.date ?? "n/a") + ". GitHub does not record when the repository's visibility changed.") },
];
const date = (id) => milestones.find((m) => m.id === id)?.date;

// Eras -------------------------------------------------------------------------
const sessionFrom = rows.map((r) => r.start).sort((a, b) => a - b)[0];
const firstDay = new Date(sessionFrom).toISOString().slice(0, 10);
const shift = (day, days) => new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
const eraBounds = [
  { id: "prose-and-scripts", from: firstDay, note: "Instructions in prose; per-repository verify scripts appear." },
  { id: "worktree-cli", from: date("worktree-cli"), note: "Isolated worktrees through implementation-workspace." },
  { id: "verifika", from: date("verifika-adoption"), note: "Verify runs through verifika, which keeps check output out of the agent's context." },
  { id: "ibni-mexxi", from: date("ibni-first-use"), note: "ibni, one config file, mexxi public." },
  { id: "port-blocks-run-slots", from: date("port-blocks"), note: "Port blocks, run slots and systemd scopes." },
].filter((era) => era.from);
const eras = eraBounds.map((era, index) => ({ ...era, to: index + 1 < eraBounds.length ? shift(eraBounds[index + 1].from, -1) : today }));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const eraOf = (ms) => eras.find((era) => dayOf(ms) >= era.from && dayOf(ms) <= era.to)?.id ?? null;

const concurrency = dailyConcurrency(allRows.map((r) => r.spans));
const eraRows = eras.map((era) => {
  const group = rows.filter((row) => eraOf(row.start) === era.id);
  return { id: era.id, from: era.from, to: era.to, note: era.note, ...summarize(group, concurrency, daysBetween(era.from, era.to)) };
});

// The same eras split by host: OpenCode gave way to Claude Code mid-way, so
// many era differences are host differences.
const erasBySource = eras.flatMap((era) => ["opencode", "claude"].map((source) => {
  const group = rows.filter((row) => row.source === source && eraOf(row.start) === era.id);
  return group.length ? { era: era.id, source, ...summarize(group) } : null;
}).filter(Boolean));

const weeks = [...new Set(rows.map((row) => isoWeek(row.start)))].sort();
const weekly = weeks.map((week) => {
  const group = rows.filter((row) => isoWeek(row.start) === week);
  const days = [...new Set(group.map((row) => dayOf(row.start)))];
  const allDays = Object.keys(concurrency).filter((day) => isoWeek(Date.parse(day)) === week);
  return { week, ...summarize(group, concurrency, allDays.length ? allDays : days) };
});

// Before/after within the repositories that adopted a tool: a session is
// "after" once its own repository has it. Repositories that never adopted it
// are left out, so each side is the same set of repositories.
function splitByRepoDate(key, filter = () => true) {
  const byRepo = Object.fromEntries(repos.filter((repo) => repo.milestones[key]?.date).map((repo) => [repo.name, repo.milestones[key].date]));
  const known = rows.filter((row) => row.repo in byRepo && filter(row));
  const after = known.filter((row) => dayOf(row.start) >= byRepo[row.repo]);
  const before = known.filter((row) => dayOf(row.start) < byRepo[row.repo]);
  return { before: summarize(before), after: summarize(after), repositories: Object.keys(byRepo).length };
}
function splitByDate(day, filter = () => true) {
  const group = rows.filter(filter);
  const beforeRows = group.filter((row) => dayOf(row.start) < day);
  const afterRows = group.filter((row) => dayOf(row.start) >= day);
  const beforeDays = Object.keys(concurrency).filter((d) => d < day && d >= firstDay);
  const afterDays = Object.keys(concurrency).filter((d) => d >= day && d <= today);
  return { before: summarize(beforeRows, concurrency, beforeDays), after: summarize(afterRows, concurrency, afterDays) };
}

// Backpack ------------------------------------------------------------------------
const instructionRepos = repos.filter((repo) => repo.milestones.instructions || repo.milestones.skill);
const backpackDates = [...new Set([...monthEnds(earliest(repos, "instructions")?.date ?? firstDay, today), ...milestones.map((m) => m.date).filter(Boolean)])].sort();
const backpackRows = await backpack(instructionRepos, backpackDates);
const backpackTotals = backpackDates.map((d) => {
  const at = backpackRows.filter((row) => row.date === d);
  return {
    date: d,
    instructions: at.reduce((t, row) => t + row.instructions, 0),
    projectWorkflowRules: at.filter((row) => row.source !== "mexxi").reduce((t, row) => t + row.workflowRules, 0),
    instructionLines: at.reduce((t, row) => t + row.instructionLines, 0),
    workflowRules: at.reduce((t, row) => t + row.workflowRules, 0),
    workflowLines: at.reduce((t, row) => t + row.workflowLines, 0),
    skillDescriptionWords: at.reduce((t, row) => t + row.skillDescriptionWords, 0),
    skills: at.reduce((t, row) => t + row.skills, 0),
    movedToTools: at.reduce((t, row) => t + row.movedToTools.length, 0),
    repositories: at.length,
    source: "all repositories",
  };
}).filter((row) => row.repositories);
const concerns = CONCERNS.map(({ id, tool }) => {
  const prose = backpackRows.filter((row) => row.concernsInProse.includes(id)).map((row) => row.date).sort();
  const tooled = backpackRows.filter((row) => row.movedToTools.includes(id)).map((row) => row.date).sort();
  const latest = backpackRows.filter((row) => row.date === today);
  return {
    id, tool,
    firstInProse: prose[0] ?? null,
    firstInTool: tooled[0] ?? null,
    repositoriesWithProseNow: latest.filter((row) => row.concernsInProse.includes(id)).length,
    repositoriesWithToolNow: latest.filter((row) => row.movedToTools.includes(id)).length,
  };
});

// Hypotheses ------------------------------------------------------------------------
// H1 reads two series: the always-loaded rules across every repository, and
// the workflow prose (commands, agents) kept in project repositories, which
// is what moved into mexxi and its tools.
const peakOf = (key, series) => series.reduce((best, row) => (row[key] > (best?.[key] ?? -1) ? row : best), null);
const projectWorkflow = backpackDates.map((d) => ({ date: d, workflowRules: backpackRows.filter((row) => row.date === d && row.source !== "mexxi").reduce((t, row) => t + row.workflowRules, 0) }));
const mexxiSeries = backpackRows.filter((row) => row.source === "mexxi");
const latestTotals = backpackTotals.at(-1);
const shrinkReading = (peakRow, latestRow, key) => {
  if (!peakRow || !latestRow || !peakRow[key]) return { metric: key, peak: null, peakDate: null, latest: null, change: null, reading: "insufficient data" };
  const change = (latestRow[key] - peakRow[key]) / peakRow[key];
  return { metric: key, peak: peakRow[key], peakDate: peakRow.date, latest: latestRow[key], change: Math.round(change * 1000) / 1000, reading: change <= -0.25 ? "improved" : change <= -0.1 ? "slightly improved" : change < 0.1 ? "no change" : "worse" };
};
const h1 = [
  { ...shrinkReading(peakOf("instructions", backpackTotals), latestTotals, "instructions"), metric: "always-loaded directive rules, all repositories" },
  { ...shrinkReading(peakOf("workflowRules", projectWorkflow), projectWorkflow.at(-1), "workflowRules"), metric: "workflow prose rules kept in project repositories" },
  { ...shrinkReading(peakOf("workflowRules", mexxiSeries), mexxiSeries.at(-1), "workflowRules"), metric: "workflow prose rules in mexxi" },
];
const hypotheses = [];
hypotheses.push({
  id: "H1-backpack",
  verdict: verdict(h1),
  headline: `Always-loaded rules across repositories: peak ${h1[0].peak} (${h1[0].peakDate}), now ${h1[0].latest}. Workflow prose in project repositories: peak ${h1[1].peak} rules (${h1[1].peakDate}), now ${h1[1].latest}. mexxi's own workflow prose: peak ${h1[2].peak} (${h1[2].peakDate}), now ${h1[2].latest}. Tool-enforced concerns across repositories: ${backpackTotals[0]?.movedToTools ?? 0} at the first snapshot, ${latestTotals?.movedToTools ?? 0} now.`,
  evidence: { comparisons: h1, concerns },
  caveats: ["Counts directive lines (always, never, must, prefer...) in AGENTS.md, CLAUDE.md and rule files, and separately in commands and agent definitions; it does not weigh how long or how often a rule is read.", "Global instructions live in mexxi's own AGENTS.md since August 2026; earlier global files in the hosts' own config directories were not in Git and have no history.", "New repositories joining raise the total without any one backpack growing."],
});

const verifySplit = splitByRepoDate("verifyScript");
const h2 = [compare(verifySplit.before, verifySplit.after, "unverifiedDoneRate", { label: "unverified done-claim rate" })];
hypotheses.push({
  id: "H2-done-claims",
  verdict: verdict(h2, { forceInsufficient: true }),
  headline: `Claims that checks pass with no passing check after the last edit: ${pct(verifySplit.before.metrics.unverifiedDoneRate)} of ${verifySplit.before.metrics.doneClaims} claims (${verifySplit.before.sessions} sessions) before each repository added its verify script, ${pct(verifySplit.after.metrics.unverifiedDoneRate)} of ${verifySplit.after.metrics.doneClaims} claims (${verifySplit.after.sessions} sessions) after. The detector's precision was 28-48% on a hand-checked sample, so this cannot carry a verdict.`,
  evidence: { comparisons: h2 },
  caveats: [`Session logs start on ${firstDay}; the first verify script is dated ${date("first-verify-command")}. The 'before' side is the few sessions in repositories that added theirs later.`, "A hand-checked sample of 25 flagged claims found 7 clearly unverified, 5 ambiguous and 13 false positives (METHOD.md).", "Checks run by delegated subagents are invisible to the parent session and read as unverified."],
});

const lintSplit = splitByRepoDate("strictLint");
const h3 = [compare(lintSplit.before, lintSplit.after, "correctionsPerSession", { label: "correction prompts per session" })];
hypotheses.push({
  id: "H3-lint",
  verdict: verdict(h3),
  headline: `Only ${lintSplit.repositories} repository's history dates a lint tightening in words (${date("strict-lint")}). That repository has ${lintSplit.before.sessions} sessions before the date and ${lintSplit.after.sessions} after, so there is no before to compare.`,
  evidence: { comparisons: h3, lintErrorRulesNow: backpackRows.filter((row) => row.date === today).map((row) => ({ source: label(row.source), lintErrorRules: row.lintErrorRules })) },
  caveats: ["Corrections are counted with the retro's CORRECTION_RE; it does not know which pattern a correction is about, so 'the same pattern' cannot be tested from transcripts.", "Lint strictness over time is shown as the number of rules set to error in each ESLint config (backpack rows, lintErrorRules)."],
});

const verifikaSplit = splitByRepoDate("verifika");
const verifikaClaude = splitByRepoDate("verifika", (row) => row.source === "claude");
const h4 = [
  compare(verifikaSplit.before, verifikaSplit.after, "medianCheckRunBytes", { label: "median bytes per check run" }),
  compare(verifikaSplit.before, verifikaSplit.after, "p90CheckRunBytes", { label: "p90 bytes per check run" }),
  compare(verifikaSplit.before, verifikaSplit.after, "compactionsPerSession", { label: "compactions per session" }),
  compare(verifikaClaude.before, verifikaClaude.after, "medianCheckRunBytes", { label: "median bytes per check run, Claude Code only" }),
  compare(verifikaClaude.before, verifikaClaude.after, "p90CheckRunBytes", { label: "p90 bytes per check run, Claude Code only" }),
  compare(verifikaClaude.before, verifikaClaude.after, "compactionsPerSession", { label: "compactions per session, Claude Code only" }),
];
hypotheses.push({
  id: "H4-verifika",
  verdict: verdict(h4),
  headline: `Median check-run output went from ${verifikaSplit.before.metrics.medianCheckRunBytes} to ${verifikaSplit.after.metrics.medianCheckRunBytes} bytes (p90 ${verifikaSplit.before.metrics.p90CheckRunBytes} to ${verifikaSplit.after.metrics.p90CheckRunBytes}); compactions per session ${verifikaSplit.before.metrics.compactionsPerSession} to ${verifikaSplit.after.metrics.compactionsPerSession}. Claude Code only: p90 ${verifikaClaude.before.metrics.p90CheckRunBytes} to ${verifikaClaude.after.metrics.p90CheckRunBytes} bytes, compactions ${verifikaClaude.before.metrics.compactionsPerSession} to ${verifikaClaude.after.metrics.compactionsPerSession} per session (${verifikaClaude.before.sessions} and ${verifikaClaude.after.sessions} sessions).`,
  evidence: { comparisons: h4 },
  caveats: ["Before verifika most sessions ran in OpenCode, after it all ran in Claude Code: the host, its compaction policy and the models changed at the same time. The Claude Code-only rows hold the host constant.", "Agents often pipe check output through tail or grep, so bytes per check run measure what reached the context, not what the check printed."],
});

const totalFailures = rows.reduce((t, r) => t + r.metrics.bashFailures, 0);
const envFailures = rows.reduce((t, r) => t + r.metrics.environmentalFailures, 0);
const silentGlobs = rows.reduce((t, r) => t + r.metrics.globAborts, 0);
const envShare = totalFailures ? envFailures / totalFailures : null;
hypotheses.push({
  id: "H5-environment",
  verdict: envShare === null ? "insufficient data" : envShare >= 0.5 ? "supported" : "not supported",
  headline: `${pct(envShare)} of ${totalFailures} failed Bash calls had an environmental cause (shell glob, timeout, busy port, missing package or command). Most failures were the checks themselves failing, which is the work, not friction. Separately, ${silentGlobs} glob aborts and ${rows.reduce((t, r) => t + r.metrics.hiddenExitCodes, 0)} hidden exit codes hit calls that often reported success.`,
  evidence: { failedBashCalls: totalFailures, environmentalFailures: envFailures, globAborts: silentGlobs, hiddenExitCodes: rows.reduce((t, r) => t + r.metrics.hiddenExitCodes, 0), editBeforeRead: rows.reduce((t, r) => t + r.metrics.editBeforeRead, 0) },
  caveats: ["Failures matching no pattern are not proof of model error: most are failing tests and builds during normal work.", "Model intelligence is not measured; only environmental causes can be recognised from output text."],
});

const ibniSplit = splitByDate(date("ibni-first-use"));
const portClaude = splitByDate(date("port-blocks"), (row) => row.source === "claude");
const portSplit = splitByDate(date("port-blocks"));
const h6 = [
  compare(ibniSplit.before, ibniSplit.after, "meanDailyMaxConcurrent", { better: "higher", label: "mean daily peak of concurrent sessions" }),
  compare(portSplit.before, portSplit.after, "portClashes", { label: "port clashes per 100 tool calls" }),
  compare(portSplit.before, portSplit.after, "timeouts", { label: "timeouts per 100 tool calls" }),
  compare(portClaude.before, portClaude.after, "portClashes", { label: "port clashes per 100 tool calls, Claude Code only" }),
  compare(portClaude.before, portClaude.after, "timeouts", { label: "timeouts per 100 tool calls, Claude Code only" }),
];
hypotheses.push({
  id: "H6-parallel",
  verdict: verdict(h6),
  headline: `Mean daily peak of concurrent sessions: ${ibniSplit.before.metrics.meanDailyMaxConcurrent} before ibni, ${ibniSplit.after.metrics.meanDailyMaxConcurrent} after. Port clashes per 100 tool calls: ${portSplit.before.metrics.portClashes} before port blocks, ${portSplit.after.metrics.portClashes} after; timeouts ${portSplit.before.metrics.timeouts} to ${portSplit.after.metrics.timeouts}.`,
  evidence: { comparisons: h6 },
  caveats: [`The port-block 'after' side covers ${daysBetween(date("port-blocks"), today).length} days (${date("port-blocks")} to ${today}).`, "Concurrency counts sessions with activity within 30 minutes of each other; an idle open session does not count."],
});

function pct(value) {
  return value === null || value === undefined ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

// Pull requests -----------------------------------------------------------------------
let pullRequests = null;
if (!options.offline) {
  const summaries = [];
  for (const repo of repos.filter((r) => r.slug)) {
    const prs = await listPullRequests(repo.slug);
    if (!prs) continue;
    for (const pr of prs.filter((p) => AGENT_BRANCH.test(p.headRefName))) summaries.push({ repo: repo.name, ...summarizePullRequest(pr) });
  }
  const inWindow = summaries.filter((pr) => pr.createdAt.slice(0, 10) <= today);
  pullRequests = {
    total: summarizeGroup(inWindow),
    byEra: eras.map((era) => ({ id: era.id, ...summarizeGroup(inWindow.filter((pr) => pr.createdAt.slice(0, 10) >= era.from && pr.createdAt.slice(0, 10) <= era.to)) })),
    byRepository: [...new Set(inWindow.map((pr) => pr.repo))].map((name) => ({ repository: label(name), ...summarizeGroup(inWindow.filter((pr) => pr.repo === name)) })).sort((a, b) => a.repository.localeCompare(b.repository)),
    firstAgentPullRequest: inWindow.map((pr) => pr.createdAt).sort()[0]?.slice(0, 10) ?? null,
  };
} else {
  notes.push("Run with --offline: pull requests were not read.");
}

// Notes -----------------------------------------------------------------------------
notes.push(
  "constitutionofmalta.com: no repository by that name exists locally or on GitHub; alexportelli12/constitution-explained (public, July 2025, with CLAUDE.md and .claude/) is taken to be it.",
  "coding-agent-config is mexxi's earlier name: GitHub redirects it to alexportelli12/mexxi, so its history is mexxi's history.",
  "Codex: only start, end, place and tool-call counts are read (five sessions), so Codex sessions count toward coverage and concurrency only.",
  "Claude Code keeps transcripts for cleanupPeriodDays (90 here), but the oldest transcript on disk starts on " + (coverage.claude.from ?? "n/a") + "; nothing older survives to measure.",
  "Session metrics before " + firstDay + " do not exist: anything older comes from Git history only.",
  "Sessions whose working directory is under /tmp (segwi canaries, test fixtures) are excluded; their counts are in coverage.excluded.",
  "Repositories not listed for publication are labelled 'private repo A', 'B'... in order of their first commit.",
);

const data = {
  generatedAt: new Date().toISOString(),
  generatedBy: "research/journey/scripts/run.mjs",
  coverage: {
    sessions: Object.fromEntries(Object.entries(coverage).map(([source, c]) => [source, { from: c.from, to: c.to, sessions: c.sessions, analysed: c.analysed, toolCalls: c.toolCalls, excluded: c.excluded }])),
    // Sorted by label: the real names' order would hint at the private ones.
    git: repos.map((repo) => ({ repository: label(repo.name), from: repo.firstCommit, to: today, commits: null })).sort((a, b) => a.repository.localeCompare(b.repository)),
    sessionMetricsFrom: firstDay,
    until: today,
  },
  milestones,
  backpack: backpackTotals,
  backpackBySource: backpackRows.map((row) => ({ date: row.date, source: label(row.source), commit: PUBLIC_REPOS.has(row.source) ? row.commit : null, instructions: row.instructions, instructionLines: row.instructionLines, workflowRules: row.workflowRules, workflowLines: row.workflowLines, skills: row.skills, skillDescriptionWords: row.skillDescriptionWords, lintErrorRules: row.lintErrorRules, movedToTools: row.movedToTools.length, toolConcerns: row.movedToTools })),
  concerns,
  eras: eraRows,
  erasBySource,
  weekly,
  sessionsByRepository: [...new Set(rows.map((r) => r.repo))].map((repo) => ({ repository: label(repo), sessions: rows.filter((r) => r.repo === repo).length })).sort((a, b) => a.repository.localeCompare(b.repository)),
  sessionsBySource: Object.fromEntries(["claude", "opencode"].map((source) => [source, eras.map((era) => rows.filter((r) => r.source === source && eraOf(r.start) === era.id).length)])),
  concurrencyByDay: concurrency,
  hypotheses,
  pullRequests,
  quotes: JSON.parse(await readFile(path.join(OUT, "scripts", "quotes.json"), "utf8")),
  notes,
};
for (const repo of repos) {
  const entry = data.coverage.git.find((g) => g.repository === label(repo.name));
  entry.commits = Number((await git(repo.dir, ["rev-list", "--count", "HEAD"])).trim()) || null;
}

const json = `${JSON.stringify(data, null, 2)}\n`;
const reportFile = path.join(OUT, "REPORT.md");
const report = replaceGenerated(await readFile(reportFile, "utf8").catch(() => ""), renderTables(data));
const privateNames = repos.map((r) => r.name).filter((name) => !PUBLIC_REPOS.has(name));
for (const [file, text] of [["journey-data.json", json], ["REPORT.md", report]]) {
  const problems = scanForLeaks(text, privateNames);
  if (problems.length) {
    log(`refusing to write ${file}: ${[...new Set(problems)].join(", ")}`);
    process.exit(1);
  }
}
await writeFile(path.join(OUT, "journey-data.json"), json);
await writeFile(reportFile, report);
log(`wrote journey-data.json and REPORT.md (${rows.length} sessions with metrics)`);
