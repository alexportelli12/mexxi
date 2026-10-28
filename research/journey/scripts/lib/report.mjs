// The generated part of REPORT.md: tables rebuilt from journey-data.json on
// every run, between two markers, so the hand-written summary around them
// survives a refresh.
export const START = "<!-- generated:start (scripts/run.mjs rewrites this block) -->";
export const END = "<!-- generated:end -->";

const cell = (value) => (value === null || value === undefined ? "n/a" : String(value));
const pct = (value) => (value === null || value === undefined ? "n/a" : `${Math.round(value * 1000) / 10}%`);
const kb = (bytes) => (bytes === null || bytes === undefined ? "n/a" : `${Math.round(bytes / 102.4) / 10} KB`);

export function bar(value, max, width = 24) {
  if (!max || value === null) return "";
  return "█".repeat(Math.round((value / max) * width));
}

export function renderTables(data) {
  const lines = [START, "", "### Milestones", "", "| Milestone | Date | Repository | Commit |", "| --- | --- | --- | --- |"];
  for (const m of data.milestones) lines.push(`| ${m.id} | ${cell(m.date)} | ${cell(m.repo)} | ${cell(m.commit)} |`);

  lines.push("", "### Verdicts", "", "| Hypothesis | Verdict |", "| --- | --- |");
  for (const h of data.hypotheses) lines.push(`| ${h.id} | ${h.verdict} |`);

  lines.push("", "### Eras", "", "| Era | Dates | Sessions | Tool calls | Bash failure rate | Glob aborts /100 | Hidden exits /100 | Timeouts /100 | Port clashes /100 | Edit before read /100 | Compactions /session | Median check run | Rework /session | Peak concurrent |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const e of data.eras) {
    const m = e.metrics;
    lines.push(`| ${e.id} | ${e.from} to ${e.to} | ${e.sessions} | ${e.toolCalls} | ${pct(m.bashFailureRate)} | ${cell(m.globAborts)} | ${cell(m.hiddenExitCodes)} | ${cell(m.timeouts)} | ${cell(m.portClashes)} | ${cell(m.editBeforeRead)} | ${cell(m.compactionsPerSession)} | ${kb(m.medianCheckRunBytes)} | ${cell(m.reworkPromptsPerSession)} | ${cell(m.maxConcurrentSessions)} |`);
  }

  lines.push("", "### Eras by host", "", "| Era | Host | Sessions | Bash failure rate | Glob aborts /100 | Hidden exits /100 | Compactions /session | Median check run | p90 check run |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const e of data.erasBySource) {
    const m = e.metrics;
    lines.push(`| ${e.era} | ${e.source} | ${e.sessions} | ${pct(m.bashFailureRate)} | ${cell(m.globAborts)} | ${cell(m.hiddenExitCodes)} | ${cell(m.compactionsPerSession)} | ${kb(m.medianCheckRunBytes)} | ${kb(m.p90CheckRunBytes)} |`);
  }

  const max = Math.max(...data.backpack.map((row) => Math.max(row.instructions, row.workflowRules)));
  lines.push("", "### Backpack: directive rules across all repositories", "", "Always-loaded rules (AGENTS.md, CLAUDE.md, rule files), then workflow rules (commands and agents, loaded per run) and how many of them still sit in project repositories.", "", "```text", "date        always-loaded                    workflow (in projects)          tools skills");
  for (const row of data.backpack) {
    lines.push(`${row.date}  ${String(row.instructions).padStart(4)} ${bar(row.instructions, max, 16).padEnd(16)}  ${String(row.workflowRules).padStart(4)} ${bar(row.workflowRules, max, 16).padEnd(16)} (${String(row.projectWorkflowRules).padStart(3)})  ${String(row.movedToTools).padStart(5)} ${String(row.skills).padStart(6)}`);
  }
  lines.push("```", "", "### Concerns: prose first, tool later", "", "| Concern | First in prose | First in a tool | Repositories with prose now | With the tool now |", "| --- | --- | --- | --- | --- |");
  for (const c of data.concerns) lines.push(`| ${c.id} (${c.tool}) | ${cell(c.firstInProse)} | ${cell(c.firstInTool)} | ${c.repositoriesWithProseNow} | ${c.repositoriesWithToolNow} |`);

  const peak = Math.max(...Object.values(data.concurrencyByDay));
  lines.push("", "### Peak concurrent sessions by week", "", "```text");
  for (const w of data.weekly) lines.push(`${w.week}  ${String(cell(w.metrics.maxConcurrentSessions)).padStart(2)} ${bar(w.metrics.maxConcurrentSessions, peak, 20).padEnd(20)}  ${String(w.sessions).padStart(3)} sessions`);
  lines.push("```", "", END);
  return lines.join("\n");
}

export function replaceGenerated(text, block) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block}\n`;
  return `${text.slice(0, start)}${block}${text.slice(end + END.length)}`;
}
