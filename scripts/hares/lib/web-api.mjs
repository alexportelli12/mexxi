// The web app's view of ħares: sessions, questions, pull requests, issues, CI and
// activity in the shapes scripts/hares/web/src/app/core/api.ts and
// pages/github/github-api.ts name (the frontend is the contract). Pure mapping:
// nothing here talks to herdr or GitHub, and nothing decides anything.
import { alwaysGrantText, optionForDecision } from "./approvals.mjs";
import { cleanText } from "./clean.mjs";

const UNKNOWN_EXPECT = { terminalId: null, sessionId: null, status: "unknown", seq: 0 };
const WEB_STATUS = { blocked: "blocked", working: "working", idle: "idle", done: "done", unknown: "unknown", starting: "unknown", closed: "done", failed: "done" };
const PENDING_KINDS = new Set(["question", "plan", "permission", "trust"]);
const GREEN = new Set(["success", "neutral", "skipped"]);
const VERBS = {
  Bash: "run a command", Edit: "edit a file", MultiEdit: "edit a file", Write: "write a file", NotebookEdit: "edit a notebook",
  Read: "read a file", WebFetch: "fetch a page", WebSearch: "search the web",
};

/** A session's links in the web app's shape: each with the evidence it came from, as words. */
export function webLinks(links, repo = "") {
  const evidence = (value) => (typeof value === "string" ? value : value?.text ?? value?.kind ?? "");
  return {
    issue: links?.issue ? { number: links.issue.number, url: links.issue.url ?? "", evidence: evidence(links.issue.evidence) } : null,
    branch: links?.branch ? { name: links.branch.name, evidence: evidence(links.branch.evidence) } : null,
    pr: links?.pull ? { number: links.pull.number, repo, url: links.pull.url ?? "", evidence: `the pull request whose branch is ${evidence(links.pull.evidence)}` } : null,
  };
}

/** One plain line for lists: what the session is doing or asking. */
export function sessionLine(session) {
  if (session.status === "blocked") return session.waiting === "question" ? "Asks a question" : "Asks for your OK";
  if (session.status === "working") return "Working";
  if (session.status === "starting") return "Starting";
  if (session.status === "failed") return session.reason ?? "Could not start";
  if (!session.alive) return session.endedBy === "hares" ? "Ended" : "Finished";
  return "Ready for your next message";
}

/** A session as core/models.ts Session. */
export function webSession(session, links = null) {
  return {
    id: session.id,
    title: cleanText(session.title ?? "", 200),
    repo: session.repo ?? "",
    status: WEB_STATUS[session.status] ?? "unknown",
    alive: Boolean(session.alive),
    seq: session.seq ?? 0,
    terminalId: session.terminalId ?? null,
    startedBy: session.startedBy === "hares" ? "app" : "you",
    startedAt: session.createdAt ?? session.lastActivityAt ?? null,
    lastActivityAt: session.lastActivityAt ?? session.createdAt ?? null,
    endedAt: session.endedAt ?? null,
    line: sessionLine(session),
    waitingOn: session.status === "blocked" ? (session.waiting === "question" ? "question" : "permission") : null,
    pendingCount: session.pendingCount ?? 0,
    links: webLinks(links, session.repo ?? ""),
  };
}

/**
 * Transcript rows as the readable transcript: messages as they are, runs of tool steps folded into one row.
 * Every text is redacted on the way out (clean.mjs), as the old run events were before they were stored.
 */
export function webTranscript(rows) {
  const entries = [];
  let steps = null;
  const flush = () => {
    if (!steps) return;
    entries.push({ seq: steps.seq, at: steps.at, kind: "steps", summary: `${steps.steps.length} step${steps.steps.length === 1 ? "" : "s"}`, steps: steps.steps });
    steps = null;
  };
  for (const { seq, kind, data } of rows) {
    const at = data?.at ?? "";
    if (kind === "tool") {
      steps ??= { seq, at, steps: [] };
      steps.seq = seq;
      const ok = data.status === "done" ? true : data.status === "running" ? null : false;
      steps.steps.push({ title: cleanText(data.title ?? data.name ?? ""), ok, detail: null });
      continue;
    }
    flush();
    if (kind === "user") entries.push({ seq, at, kind: "you", text: cleanText(data.text ?? "") });
    else if (kind === "assistant") entries.push({ seq, at, kind: "agent", text: cleanText(data.text ?? "") });
    else if (kind === "question") {
      entries.push({ seq, at, kind: "agent", text: cleanText((data.questions ?? []).map((entry) => entry?.question ?? "").filter(Boolean).join("\n")) });
      if (data.answers) entries.push({ seq, at, kind: "answer", text: cleanText(Object.values(data.answers).join(", ")) });
    } else if (kind === "interrupted") entries.push({ seq, at, kind: "you", text: cleanText(data.text ?? "Interrupted") });
  }
  flush();
  return entries;
}

/** What "always" grants on this prompt, from the screen's own option and the hook's rule; null when nothing to offer. */
function alwaysRule(item, approval) {
  const option = optionForDecision({ options: item.screenOptions ?? [] }, "always");
  // The same text decide() checks the confirmed rule against (approvals.mjs alwaysGrantText).
  const text = alwaysGrantText(approval?.suggestedRule ?? null, option);
  if (!text) return null;
  return { text, scope: /^Allow access to /.test(text) || /session/i.test(option?.label ?? "") ? "session" : "rule" };
}

/** A pending item (pending.mjs plus the session) as core/models.ts Pending. `approval` is its hook-fed row, if any. */
export function webPending(item, session, approval = null) {
  const questions = item.questions ?? [];
  const pending = {
    id: item.id,
    sessionId: session.id,
    kind: item.step === "review" || !PENDING_KINDS.has(item.kind) ? "question" : item.kind,
    asker: session.repo || session.title || "A session",
    topic: questions[item.current ?? 0]?.header || undefined,
    askedAt: item.at ?? session.lastActivityAt ?? new Date().toISOString(),
    items: questions,
    freeText: Boolean(item.freeText),
    chat: Boolean(item.chat),
    expect: session.expect ?? UNKNOWN_EXPECT,
    answerable: Boolean(item.answerable) && session.alive,
    reason: item.answerable ? null : item.reason || "Answer this one in the terminal.",
  };
  if (item.kind === "permission") {
    const tool = approval?.tool ?? item.permission?.tool ?? "";
    const tooLong = !approval || item.answerable === false;
    pending.permission = {
      tool, verb: VERBS[tool] ?? `use ${tool || "a tool"}`,
      exact: approval?.exact ?? item.permission?.exact ?? "",
      content: approval?.content ?? (typeof item.permission?.content === "object" ? item.permission.content : null),
      risk: approval?.risk ?? "unknown", riskLabel: approval?.riskLabel ?? "Unknown risk", why: approval?.why ?? "",
      tooLong,
      // D2: a call too long to show whole offers neither Allow nor Always.
      always: tooLong ? null : alwaysRule(item, approval),
    };
  }
  return pending;
}

const checkState = (check) => (check.status !== "completed" ? "pending" : GREEN.has(check.conclusion) ? "pass" : "fail");

/** "Bump x from 1.2.3 to 2.0.0" says how big a bump is; a security label beats the numbers. */
export function bumpKind(title, labels = []) {
  if (labels.some((label) => /security/i.test(label))) return "security";
  const match = /from v?(\d+)\.(\d+)(?:\.(\d+))? to v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(title ?? ""));
  if (!match) return null;
  if (match[1] !== match[4]) return "major";
  if (match[2] !== match[5]) return "minor";
  return "patch";
}

/** A session linked to a pull request or issue, as github/models.ts LinkedSession. */
export function linkedSession(session) {
  if (!session) return null;
  const state = !session.alive ? "done" : session.status === "blocked" ? "waiting" : session.status === "working" ? "working" : session.status === "done" ? "done" : "idle";
  return { id: session.id, title: session.title ?? "", state };
}

/** A board item (github-board.mjs) as github/models.ts PrSummary. */
export function webPr(item, session = null) {
  return {
    repo: item.repo, number: item.number, title: item.title, url: item.url, author: item.author?.login ?? "", bot: Boolean(item.bump), draft: Boolean(item.draft),
    createdAt: item.createdAt ?? item.updatedAt ?? null, additions: item.additions ?? 0, deletions: item.deletions ?? 0,
    groups: item.groups ?? [], checks: (item.checkList ?? []).map(checkState),
    failureNote: item.checks?.failing?.length ? `${item.checks.failing.join(", ")} failed` : null,
    ciRunId: item.ciRunId ?? null, unresolvedThreads: 0, bump: item.bump ? bumpKind(item.title, item.labels) : null, docsOnly: false,
    headSha: item.headSha, headRef: item.branch, baseRef: item.baseRef, commits: item.commits ?? 0, deployWorkflow: null,
    session: linkedSession(session),
  };
}

/** A pull request's detail (github-board prDetail) on top of its summary, as github/models.ts PrDetail. */
export function webPrDetail(detail, summary, session = null) {
  const person = (author) => author?.login ?? "";
  const comment = (entry) => ({ id: entry.id, author: person(entry.author), mine: false, createdAt: entry.createdAt, bodyHtml: entry.bodyHtml ?? "" });
  const threads = [
    ...(detail.threads ?? []).map((thread) => ({ id: thread.id, path: thread.path, line: thread.line, resolved: false, comments: thread.comments.map(comment) })),
    ...(detail.comments ?? []).map((entry) => ({ id: entry.id, path: null, line: null, resolved: false, comments: [comment(entry)] })),
  ];
  const base = summary ?? {
    repo: detail.repo, number: detail.number, title: detail.title, url: detail.url, author: person(detail.author), bot: false, draft: detail.draft,
    createdAt: null, additions: 0, deletions: 0, groups: [], checks: [], failureNote: null, ciRunId: null, unresolvedThreads: 0, bump: null,
    docsOnly: false, headSha: detail.headSha, headRef: detail.branch, baseRef: detail.baseRef, commits: 0, deployWorkflow: null, session: linkedSession(session),
  };
  return {
    ...base,
    title: detail.title, draft: detail.draft, headSha: detail.headSha,
    state: detail.merged ? "merged" : detail.state === "open" ? "open" : "closed",
    changedFiles: summary?.changedFiles ?? 0,
    issue: detail.closes?.[0]?.number ?? null,
    bodyHtml: detail.bodyHtml ?? "",
    checkRuns: (detail.checks?.checks ?? []).map((check) => ({ name: check.name, state: checkState(check), duration: null, url: check.url ?? null })),
    files: [],
    filesUrl: detail.filesUrl,
    threads,
    unresolvedThreads: threads.filter((thread) => thread.path !== null).length,
    readiness: { ready: detail.readiness?.ready === true, checks: detail.readiness?.checks ?? [], canAccept: detail.readiness?.canAccept === true },
    previewUrl: null,
    session: linkedSession(session),
  };
}

/** An open issue as github/models.ts Issue. */
export function webIssue(issue, session = null) {
  return { repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, labels: issue.labels ?? [], createdAt: issue.createdAt ?? issue.updatedAt ?? null, session: linkedSession(session) };
}

const runState = (run) => (run.status !== "completed" ? "running" : run.conclusion === "success" ? "pass" : "fail");

/** A repository's Actions (github-board ci) as github/models.ts CiRepo: the newest default-branch run and its history. */
export function webCi(ci) {
  const onDefault = (ci.runs ?? []).filter((run) => run.branch === ci.defaultBranch).sort((a, b) => b.id - a.id);
  const latest = onDefault[0] ?? null;
  const seconds = (run) => (run.status === "completed" && run.startedAt && run.updatedAt ? Math.max(0, Math.round((Date.parse(run.updatedAt) - Date.parse(run.startedAt)) / 1000)) : null);
  return {
    repo: ci.repo,
    latest: latest ? {
      id: latest.id, workflow: latest.name, branch: latest.branch, status: latest.status, conclusion: latest.conclusion ?? null, startedAt: latest.startedAt ?? latest.createdAt,
      durationSeconds: seconds(latest), jobsDone: null, jobsTotal: null, failedJob: null, failedStep: null, url: latest.url,
    } : null,
    history: onDefault.slice(0, 20).reverse().map(runState),
  };
}

/** What kind of thing an audit row records, for the Activity page's grouping. */
export function activityKind(action) {
  if (action === "approval.allowed" || action === "approval.denied" || action === "session.answered") return "answer";
  if (action === "github.merge" || action === "github.submit-review") return "merge";
  if (action === "github.rerun-failed-jobs") return "ci";
  if (/^session\./.test(action)) return "session";
  if (/always/.test(action)) return "rule";
  return "other";
}

/** An audit row for the Activity page: the row as stored, with its kind. An always-allow is a rule. */
export function webAudit(row) {
  const kind = row.action === "approval.allowed" && /\(always: /.test(row.detail) ? "rule" : activityKind(row.action);
  return { ...row, kind };
}

/** The labels a web answer picks, from the question on screen now; null when an answer names no such option. */
export function labelsFor(question, answer) {
  const byN = (n) => question.options.find((option) => option.n === n)?.label ?? null;
  if (answer.kind === "option") {
    const label = byN(answer.n);
    return label ? { optionLabel: label } : null;
  }
  if (answer.kind === "options") {
    const labels = answer.ns.map(byN);
    return labels.every(Boolean) ? { labels } : null;
  }
  if (answer.kind === "text") return { text: answer.text };
  return null;
}

