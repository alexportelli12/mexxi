// Turns per-session metrics into era, weekly and before/after figures, and
// derives each hypothesis's verdict by fixed rules (METHOD.md, "Verdicts").

export const DAY_MS = 86_400_000;

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  // Nearest rank, so the result is always a measured value.
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (value, places = 2) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places);
const ratio = (part, whole) => (whole ? part / whole : null);
const per100 = (count, calls) => round(ratio(count, calls) === null ? null : (count / calls) * 100);

export function isoWeek(ms) {
  const date = new Date(ms);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Highest number of sessions active at once on each UTC day, from each
// session's active spans. Spans are cut at midnight so a long one counts on
// every day it covers; the peak always follows a start, so only starts are
// read.
export function dailyConcurrency(spansBySession) {
  const points = [];
  for (const spans of spansBySession) {
    for (const [start, end] of spans) {
      let from = start;
      while (from <= end) {
        const midnight = (Math.floor(from / DAY_MS) + 1) * DAY_MS;
        const to = Math.min(end, midnight - 1);
        points.push([from, 1], [to, -1]);
        from = midnight;
      }
    }
  }
  // Starts before ends at the same instant, so touching spans overlap.
  points.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const byDay = new Map();
  let active = 0;
  for (const [at, delta] of points) {
    active += delta;
    if (delta < 0) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    byDay.set(day, Math.max(byDay.get(day) ?? 0, active));
  }
  return Object.fromEntries([...byDay].sort());
}

// The metrics block for a group of sessions (an era, a week, one side of a
// comparison). Rates use the group's totals, not an average of session rates,
// so a session with one tool call does not weigh as much as one with 500.
export function summarize(rows, concurrencyByDay = {}, days = []) {
  const sum = (key) => rows.reduce((total, row) => total + row.metrics[key], 0);
  const toolCalls = sum("toolCalls");
  const doneClaims = sum("doneClaims");
  const sessionBytes = rows.map((row) => row.metrics.toolOutputBytes);
  const checkBytes = rows.flatMap((row) => row.metrics.checkRunBytes);
  const dailyMax = days.map((d) => concurrencyByDay[d]).filter(Number.isFinite);
  return {
    sessions: rows.length,
    toolCalls,
    metrics: {
      unverifiedDoneRate: round(ratio(sum("unverifiedDoneClaims"), doneClaims), 3),
      doneClaims,
      bashFailureRate: round(ratio(sum("bashFailures"), sum("bashCalls")), 3),
      globAborts: per100(sum("globAborts"), toolCalls),
      hiddenExitCodes: per100(sum("hiddenExitCodes"), toolCalls),
      timeouts: per100(sum("timeouts") + sum("bashCapHits"), toolCalls),
      bashCapHits: sum("bashCapHits"),
      portClashes: per100(sum("portClashes"), toolCalls),
      missingPackages: per100(sum("missingPackages"), toolCalls),
      commandNotFound: per100(sum("commandNotFound"), toolCalls),
      failingRetries: per100(sum("failingRetries"), toolCalls),
      editBeforeRead: per100(sum("editBeforeRead"), toolCalls),
      compactionsPerSession: round(ratio(sum("compactions"), rows.length)),
      medianToolOutputBytes: percentile(sessionBytes, 50),
      p90ToolOutputBytes: percentile(sessionBytes, 90),
      medianCheckRunBytes: percentile(checkBytes, 50),
      p90CheckRunBytes: percentile(checkBytes, 90),
      checkRuns: checkBytes.length,
      reworkPromptsPerSession: round(ratio(sum("reworkPrompts"), rows.length)),
      correctionsPerSession: round(ratio(sum("corrections"), rows.length)),
      maxConcurrentSessions: dailyMax.length ? Math.max(...dailyMax) : null,
      meanDailyMaxConcurrent: dailyMax.length ? round(dailyMax.reduce((a, b) => a + b, 0) / dailyMax.length) : null,
    },
  };
}

export function daysBetween(from, to) {
  const days = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

// Minimum sessions on each side before a comparison may carry a verdict.
export const MIN_SESSIONS = 20;
// Relative change a comparison needs, in the hypothesis's direction, to count.
export const SUPPORT_CHANGE = 0.25;
export const NOISE_CHANGE = 0.1;

// One before/after comparison of a metric where lower is better (or higher,
// with better: "higher"). Returns the figures and its own reading.
export function compare(before, after, key, { better = "lower", label = key } = {}) {
  const a = before.metrics[key];
  const b = after.metrics[key];
  const enough = before.sessions >= MIN_SESSIONS && after.sessions >= MIN_SESSIONS && a !== null && b !== null;
  let reading = "insufficient data";
  let change = null;
  if (a !== null && b !== null && a !== 0) change = round((b - a) / Math.abs(a), 3);
  if (enough) {
    const improved = better === "lower" ? b < a : b > a;
    const size = a === 0 ? (b === 0 ? 0 : 1) : Math.abs((b - a) / a);
    if (size < NOISE_CHANGE) reading = "no change";
    else if (improved && size >= SUPPORT_CHANGE) reading = "improved";
    else if (improved) reading = "slightly improved";
    else reading = "worse";
  }
  return { metric: label, before: a, after: b, change, beforeSessions: before.sessions, afterSessions: after.sessions, reading };
}

// A hypothesis's verdict from its comparisons: all improved is supported,
// none improved (and at least one worse or unchanged) is not supported, a
// split is mixed, and no comparison with enough data is insufficient.
export function verdict(comparisons, { forceInsufficient = false } = {}) {
  const usable = comparisons.filter((c) => c.reading !== "insufficient data");
  if (forceInsufficient || !usable.length) return "insufficient data";
  const improved = usable.filter((c) => c.reading === "improved").length;
  if (improved === usable.length) return "supported";
  if (improved === 0 && !usable.some((c) => c.reading === "slightly improved")) return "not supported";
  return "mixed";
}
