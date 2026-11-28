// The node:http router: /api is JSON only and audited; /mcp is the MCP door;
// everything else is the built web app (or a one-line 503 until it is built).
// Bodies are never logged. The routes and their JSON are the web app's contract:
// scripts/hares/web/src/app/core/api.ts and pages/github/github-api.ts.
//
// Who may do what: every route here needs the web identity (cookie or Tailscale
// header) and every write the app's own origin. Permission decisions, always-
// allow, raw keys and every GitHub write (review, merge, reply, comment, rerun)
// exist only here, for a person; MCP has none of them.
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionForDecision } from "./approvals.mjs";
import { assertSameOriginWrite, isRunBrowserRequest } from "./auth.mjs";
import { audit } from "./audit.mjs";
import { checkoutState } from "./checkout.mjs";
import { cleanDeep } from "./clean.mjs";
import { HttpError } from "./errors.mjs";
import { parsePullUrl, slugForRepository } from "./github.mjs";
import { IMAGE_HOSTS } from "./html-sanitize.mjs";
import { createRunView } from "./run-view.mjs";
import { parse, schemas as schemasFor } from "./validate.mjs";
import { labelsFor, webAudit, webCi, webIssue, webPending, webPr, webPrDetail, webSession, webTranscript } from "./web-api.mjs";

const BODY_LIMIT = 64 * 1024;
const AUDIT_DAYS = 90;
// No inline script or style: the web build turns Angular's critical-CSS inlining off instead of loosening this.
// Images may also come from GitHub's image hosts, for pull request descriptions (html-sanitize.mjs keeps the same list).
const CSP = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: ${IMAGE_HOSTS.map((host) => `https://${host}`).join(" ")}; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
const NOT_BUILT = "Build the web app: npm --prefix scripts/hares/web run build\n";
// hares's colours and type, for extension pages (decision 0020).
const TOKENS = fileURLToPath(new URL("../../../site/tokens.css", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
  ".mjs": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};
// What each route parameter may look like; anything else is a 404 before a handler runs.
const PARAMS = { id: "[A-Za-z0-9_.:-]{1,128}", repo: "[a-z0-9][a-z0-9._-]{0,63}", n: "\\d{1,9}", runId: "\\d{1,15}" };

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

export async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request body is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The body is not valid JSON.");
  }
}

function cacheHeaders(file) {
  const name = path.basename(file);
  if (name === "sw.js") return { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" };
  return { "Cache-Control": name === "index.html" || name.endsWith(".webmanifest") ? "no-cache" : "public, max-age=3600" };
}

async function serveStatic(res, root, pathname) {
  if (!root) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(NOT_BUILT);
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request.\n");
    return;
  }
  const requested = path.normalize(path.join(root, decoded));
  let file = requested.startsWith(`${root}${path.sep}`) ? requested : path.join(root, "index.html");
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    file = path.join(root, "index.html"); // single-page app fallback
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", ...cacheHeaders(file) });
    res.end(body);
  } catch {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(NOT_BUILT);
  }
}

/** The answer body for a refusal: the words, and a machine code where the app needs one. */
function errorBody(error) {
  if (!(error instanceof HttpError)) return { error: "Something went wrong on the server." };
  const body = { error: error.message };
  if (error.name === "StaleStateError") body.code = "stale";
  if (error.name === "ConfirmRequired") Object.assign(body, { code: "confirm", confirm: error.confirm });
  return body;
}

const tilde = (dir) => {
  const home = os.homedir();
  return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
};
const keyName = (key) => key.replace(/^(shift|ctrl)-/, "$1+");

/**
 * @param {{ store: object, settings: object, authenticate: Function, sessions: object, approvals: object, readiness: object,
 *   board?: object|null, writer?: object|null, notifier?: object|null, push: object, stream: object, herdr: object, linkIndex: object,
 *   staticRoot: string|null, version: string, mcp?: Function|null, extensions?: object[], checkout?: Function }} deps
 */
export function createHandler({
  store, settings, authenticate, sessions, approvals, readiness, board = null, writer = null, notifier = null, push, stream, herdr, linkIndex,
  staticRoot, version, mcp = null, extensions = [], checkout = checkoutState,
}) {
  const parsers = schemasFor(settings);
  const by = (identity) => ({ actor: identity, origin: "web" });
  const runView = (identity) => createRunView({ sessions, store, settings, checkout, origin: "web", actor: identity });
  const needsBoard = () => {
    if (!board) throw new HttpError(503, "GitHub isn't set up for hares.");
    return board;
  };
  const needsWriter = () => {
    if (!writer) throw new HttpError(503, "GitHub writes aren't set up for hares.");
    return writer;
  };
  const repoNames = () => settings.hares.repositories.map((repository) => repository.name);

  /** A session in the web shape, with the links ħares last derived for it. */
  const sessionRow = (session) => webSession(session, linkIndex.linksOf(session.id));
  async function sessionById(id) {
    const { session } = await sessions.get(id, { limit: 0 });
    return session;
  }

  async function sessionDetail(id) {
    const page = await sessions.get(id, { limit: 5000 });
    const byRecord = new Map((page.approvals ?? []).map((approval) => [approval.recordId, approval]));
    return {
      ...webSession(page.session, page.links),
      transcript: webTranscript(page.transcript.rows),
      nextSince: page.transcript.nextSince,
      pending: page.pending.items.map((item) => webPending(item, page.session, byRecord.get(item.id) ?? null)),
    };
  }

  /** Every waiting question or permission across sessions, oldest first. */
  async function questions() {
    const all = [];
    for (const session of await sessions.list()) {
      if (!session.alive || (session.status !== "blocked" && !session.pendingCount)) continue;
      const { items } = await sessions.pending(session.id);
      const byRecord = new Map(approvals.forSession(session.id).map((approval) => [approval.recordId, approval]));
      all.push(...items.map((item) => webPending(item, session, byRecord.get(item.id) ?? null)));
    }
    return all.sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)));
  }

  /** The session and pending item a Pending id belongs to, from a fresh look. */
  async function findPending(pendingId) {
    for (const session of await sessions.list()) {
      if (!session.alive) continue;
      const { items } = await sessions.pending(session.id);
      const item = items.find((candidate) => candidate.id === pendingId);
      if (item) return { session, item };
    }
    throw new HttpError(409, "That question is no longer waiting; check the session again.", { outcome: "rejected" });
  }

  /** Answers a question form, one answer per question in order, then submits the review step when there is one. */
  async function answerQuestion(id, { questionId, expect, answers }, identity) {
    if (answers.some((answer) => answer.kind === "chat")) throw new HttpError(422, "Talking it through isn't sent from ħares yet; answer in the terminal.");
    let seen = expect;
    for (let step = 0; step < answers.length + 1; step += 1) {
      const { items } = await sessions.pending(id);
      const item = items.find((candidate) => candidate.id === questionId);
      if (!item) {
        if (step === 0) throw new HttpError(409, "That question is no longer waiting; check the session again.");
        break;
      }
      if (item.step === "review") {
        await sessions.answer(id, { recordId: item.id, kind: "review", optionLabel: "Submit answers", expect: seen }, by(identity));
        break;
      }
      const index = item.current ?? 0;
      const answer = answers[index];
      const question = item.questions[index];
      if (!answer || !question) break;
      const picked = labelsFor(question, answer);
      if (!picked) throw new HttpError(409, "That choice is not on the question any more; check it again.");
      await sessions.answer(id, { recordId: item.id, kind: "question", expect: seen, ...picked }, by(identity));
      if (item.questions.length < 2) break;
      await herdr.refresh?.().catch(() => {});
      seen = (await sessionById(id)).expect ?? seen;
    }
    return { session: sessionRow(await sessionById(id)) };
  }

  /** A person's decision on a permission, plan or folder-trust prompt (a Pending id, or an approval id from the old app). */
  async function decide(pendingId, body, identity) {
    const decision = body.decision === "allow" ? "once" : body.decision;
    const options = { identity, origin: "web", confirm: body.confirm === true, rule: body.rule, expect: body.expect };
    let sessionId;
    const legacy = store.getApproval(pendingId);
    if (legacy) {
      if (decision === "always" && body.rule === undefined && legacy.suggestedRule) throw new HttpError(400, "Always allow needs the rule you saw.");
      const decided = await approvals.decide(pendingId, decision, options);
      sessionId = decided.sessionId;
      if (!body.expect && !sessionId) return { approval: decided };
    } else {
      const { session, item } = await findPending(pendingId);
      sessionId = session.id;
      if (item.kind === "permission") {
        const approval = approvals.forSession(session.id).find((candidate) => candidate.recordId === item.id);
        if (!approval) throw new HttpError(422, item.reason || "This one is too long to show in full; answer it in the terminal.");
        if (decision === "always" && body.rule === undefined && approval.suggestedRule) throw new HttpError(400, "Always allow needs the rule you saw.");
        await approvals.decide(approval.id, decision, options);
      } else if (item.kind === "plan" || item.kind === "trust") {
        const option = optionForDecision({ options: item.screenOptions ?? [] }, decision);
        if (!option) throw new HttpError(422, "This prompt has no such choice here; answer it in the terminal.");
        if (decision === "always" && body.confirm !== true) throw new HttpError(409, "This grants more than this one call; confirm it first.");
        await sessions.answer(session.id, { recordId: item.id, kind: item.kind, optionLabel: option.label, confirmAlways: decision === "always", expect: body.expect }, by(identity));
      } else {
        throw new HttpError(409, "That is a question, not a permission; answer it as one.");
      }
    }
    // A reason given with a deny is typed back to Claude once the prompt has gone; best effort, never instead of the deny.
    if (decision === "deny" && body.reason && sessionId) {
      try {
        await herdr.refresh?.();
        const after = await sessionById(sessionId);
        if (after.alive && after.status !== "blocked" && after.expect) await sessions.steer(sessionId, { text: body.reason, expect: after.expect }, by(identity));
      } catch { /* the deny stands; the reason can be typed in the terminal */ }
    }
    return { session: sessionId ? sessionRow(await sessionById(sessionId)) : null };
  }

  /** All open pull requests of every configured repository, newest first, in the web shape. */
  async function pullRequests() {
    const all = [];
    for (const name of repoNames()) {
      let listed;
      try {
        listed = await needsBoard().listPrs(name);
      } catch (error) {
        if (error instanceof HttpError && error.status === 503) throw error;
        continue; // one repository GitHub can't answer for doesn't hide the others
      }
      for (const item of Object.values(listed.pulls).flat()) all.push({ item, summary: webPr(item, linkIndex.session(item.sessionId)) });
    }
    return all.sort((a, b) => String(b.summary.createdAt ?? "").localeCompare(String(a.summary.createdAt ?? "")));
  }

  async function prDetail(repo, number) {
    const sessionId = linkIndex.sessionForPr(repo, number);
    const detail = await needsBoard().prDetail(repo, number, { sessionId });
    let summary = null;
    try {
      const item = Object.values((await needsBoard().listPrs(repo)).pulls).flat().find((entry) => entry.number === number);
      if (item) summary = { ...webPr(item, linkIndex.session(sessionId)), changedFiles: item.changedFiles ?? 0 };
    } catch { /* a closed pull request is not in the open list */ }
    return webPrDetail(detail, summary, linkIndex.session(sessionId));
  }

  const isPositive = (value) => Number.isSafeInteger(value) && value > 0;
  const prNumber = (params) => {
    const number = Number(params.n);
    if (!isPositive(number)) throw new HttpError(400, "The pull request number must be a positive whole number.");
    return number;
  };
  const known = (repo) => {
    if (!repoNames().includes(repo)) throw new HttpError(404, "No such repository in hares.repositories.");
    return repo;
  };
  const githubAudit = (identity, action, target, detail = "") => ({ detail: `${action} ${target}${detail ? `: ${detail}` : ""}` });

  /** The legacy readiness of a run: its pull request's, keyed as readiness now is. */
  async function runReadiness(id, identity, accept = null) {
    const run = await runView(identity).get(id);
    const pull = run.prUrl ? parsePullUrl(run.prUrl) : null;
    if (!pull || !run.repo) throw new HttpError(404, "This run has no pull request.");
    // Readiness keys a session by its Claude session id, not the launch id a run may carry.
    const target = { repo: run.repo, number: pull.number, sessionId: (await runView(identity).sessionIdOf(id)) ?? null };
    return accept ? readiness.accept(target, accept, identity) : readiness.forPr(target);
  }

  const routes = [
    ["GET", "/api/health", "none", async () => {
      const status = herdr.status();
      const panes = herdr.panes();
      const mainRed = notifier?.mainRed?.() ?? null;
      return {
        ok: true, version, host: os.hostname(),
        herdr: { connected: Boolean(status.connected), protocol: status.protocol ?? null, version: status.version ?? null, error: status.error ?? null, panes: panes.length, claudeSessions: panes.filter((pane) => pane.sessionId).length, lastSeenAt: status.lastSyncAt ?? null },
        ...(mainRed === null ? {} : { board: { mainRed } }),
      };
    }],
    ["GET", "/api/repos", "none", async () => ({
      repos: await Promise.all(settings.hares.repositories.map(async (repository) => {
        const state = await checkout(repository.path).catch(() => ({ defaultBranch: null }));
        let github = null;
        try { github = await slugForRepository(repository); } catch { github = null; }
        return { name: repository.name, path: tilde(repository.path), github, defaultBranch: state.defaultBranch ?? "main", actions: repository.actions };
      })),
    })],
    ["GET", "/api/extensions", "none", async () => ({ extensions: extensions.map(({ name, title }) => ({ name, title, url: `/ext/${name}/` })) })],

    // --- Sessions
    ["GET", "/api/sessions", "none", async () => {
      const rows = (await sessions.list()).map(sessionRow);
      return { sessions: rows.sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? ""))) };
    }],
    ["POST", "/api/sessions", "startSession", async ({ body, identity }) => {
      const kind = body.kind === "prompt" ? "session" : body.kind;
      const input = { kind, repo: body.repo, clientId: body.clientId, task: body.prompt, command: body.command, args: body.args, issue: body.issue, pr: body.pr, ask: body.ask };
      const { session, created } = await sessions.start(input, by(identity));
      return { status: created ? 201 : 200, body: { session: { id: session.launchId ?? session.id } }, detail: `${kind} in ${body.repo}` };
    }],
    ["GET", "/api/sessions/:id", "none", async ({ params }) => ({ session: await sessionDetail(params.id) })],
    ["GET", "/api/sessions/:id/screen", "none", async ({ params }) => {
      const screen = await sessions.screen(params.id);
      const session = await sessionById(params.id);
      return { screen: { text: screen.text, expect: screen.expect, at: new Date().toISOString(), overlay: session.status !== "blocked" && screen.form.kind !== "unknown" } };
    }],
    ["POST", "/api/sessions/:id/answer", "answer", async ({ params, body, identity }) => answerQuestion(params.id, body, identity)],
    ["POST", "/api/sessions/:id/steer", "steer", async ({ params, body, identity }) => {
      await sessions.steer(params.id, { text: body.text, expect: body.expect }, by(identity));
      return { session: sessionRow(await sessionById(params.id)) };
    }],
    ["POST", "/api/sessions/:id/keys", "keys", async ({ params, body, identity }) => {
      // The contract types the text first, then the keys (to send it, say), each checked against the state it finds.
      if (body.text) await sessions.keys(params.id, { keys: [], text: body.text, expect: body.expect }, by(identity));
      if (body.keys?.length) {
        if (body.text) await herdr.refresh?.().catch(() => {});
        const expect = body.text ? (await sessionById(params.id)).expect : body.expect;
        await sessions.keys(params.id, { keys: body.keys.map(keyName), expect }, by(identity));
      }
      if (!body.text && !body.keys?.length) throw new HttpError(400, "Send at least one key or some text.");
      return { session: sessionRow(await sessionById(params.id)) };
    }],
    ["POST", "/api/sessions/:id/esc", "esc", async ({ params, body, identity }) => {
      await sessions.esc(params.id, { expect: body.expect }, by(identity));
      return { session: sessionRow(await sessionById(params.id)) };
    }],
    ["POST", "/api/sessions/:id/end", "end", async ({ params, body, identity }) => {
      const ended = await sessions.end(params.id, { confirm: body.confirm, expect: body.expect }, by(identity));
      return { session: sessionRow(ended) };
    }],
    ["POST", "/api/sessions/:id/resume", "resume", async ({ params, identity }) => {
      const session = await sessions.resume(params.id, by(identity));
      return { body: { session: { id: session.launchId ?? session.id } } };
    }],
    ["POST", "/api/sessions/:id/rename", "rename", async ({ params, body, identity }) => ({ session: sessionRow(await sessions.rename(params.id, body.title, by(identity))) })],
    ["GET", "/api/questions", "none", async () => ({ questions: await questions() })],
    // Only a person decides a permission, here; MCP lists approvals and never reaches this (decision 0016, guardrails).
    ["GET", "/api/approvals", "listApprovals", async ({ query }) => ({ approvals: approvals.list({ status: query.status }) })],
    ["POST", "/api/approvals/:id", "decideApproval", async ({ params, body, identity }) => ({
      body: await decide(params.id, body, identity), detail: body.decision,
    })],

    // --- Notifications
    ["GET", "/api/notifications/prefs", "none", async ({ identity }) => ({ prefs: notifier.prefs(identity), held: notifier.held(identity) })],
    ["PUT", "/api/notifications/prefs", "notificationPrefs", async ({ body, identity }) => ({ prefs: notifier.savePrefs(identity, body), held: notifier.held(identity) })],
    ["POST", "/api/notifications/held/seen", "heldSeen", async ({ body, identity }) => {
      notifier.markSeen(identity, body.ids);
      return { held: notifier.held(identity) };
    }],
    ["GET", "/api/push/key", "none", async () => {
      const publicKey = push.publicKey();
      if (!publicKey) throw new HttpError(404, push.setupProblem() ?? "Push isn't set up.");
      return { publicKey };
    }],
    ["POST", "/api/push/subscriptions", "pushSubscription", async ({ body, identity }) => {
      const id = push.subscribe(body, identity);
      // Only the push service's host is recorded; the endpoint itself identifies the device.
      return { status: 201, body: { id }, detail: new URL(body.endpoint).host };
    }],
    ["DELETE", "/api/push/subscriptions/:id", "none", async ({ params }) => {
      push.unsubscribe(params.id);
      return { status: 204 };
    }],
    // Activity: every action, newest first, kept 90 days (a daily purge removes older rows).
    ["GET", "/api/audit", "audit", async ({ query }) => ({
      audit: store.listAuditSince(new Date(Date.now() - AUDIT_DAYS * 86_400_000).toISOString(), query.limit ?? 50).map(webAudit),
    })],

    // --- GitHub: reads with the read-only token; writes only here, with a person's identity.
    ["GET", "/api/prs", "none", async () => ({ prs: (await pullRequests()).map(({ summary }) => summary) })],
    ["GET", "/api/prs/:repo/:n", "none", async ({ params }) => ({ pr: await prDetail(known(params.repo), prNumber(params)) })],
    ["POST", "/api/prs/:repo/:n/review", "review", async ({ params, body, identity }) => {
      const repo = known(params.repo);
      const number = prNumber(params);
      await needsWriter().submitReview(repo, number, { event: body.event, body: body.body }, { actor: identity });
      let session;
      if (body.startSession) {
        const started = await sessions.start({ kind: "pr", repo, pr: number, ask: "review-comments" }, by(identity));
        session = { id: started.session.launchId ?? started.session.id };
      }
      return { body: { ok: true, ...(session ? { session } : {}) }, ...githubAudit(identity, body.event, `${repo}#${number}`) };
    }],
    // Merging asks the person to confirm the head commit first; GitHub refuses (409) if it moved since.
    ["POST", "/api/prs/:repo/:n/merge", "merge", async ({ params, body, identity }) => {
      const repo = known(params.repo);
      const number = prNumber(params);
      await needsWriter().merge(repo, number, { headSha: body.headSha, method: body.method }, { actor: identity });
      return { body: { ok: true }, ...githubAudit(identity, `merge (${body.method})`, `${repo}#${number}`, body.headSha.slice(0, 12)) };
    }],
    ["POST", "/api/prs/:repo/:n/reply", "reply", async ({ params, body, identity }) => {
      const repo = known(params.repo);
      const number = prNumber(params);
      await needsWriter().replyToThread(repo, number, body.threadId, body.body, { actor: identity });
      return { body: { ok: true }, ...githubAudit(identity, "reply", `${repo}#${number}`) };
    }],
    ["POST", "/api/prs/:repo/:n/comment", "comment", async ({ params, body, identity }) => {
      const repo = known(params.repo);
      const number = prNumber(params);
      await needsWriter().comment(repo, number, body.body, { actor: identity });
      return { body: { ok: true }, ...githubAudit(identity, "comment", `${repo}#${number}`) };
    }],
    // Only a person accepts a gate-weakening change, here in the web app: no MCP tool reaches this (decision 0027).
    ["POST", "/api/prs/:repo/:n/accept-gate", "acceptGateChange", async ({ params, body, identity }) => {
      const repo = known(params.repo);
      const number = prNumber(params);
      const result = await readiness.accept({ repo, number, sessionId: linkIndex.sessionForPr(repo, number) }, body.headSha, identity);
      return { body: { readiness: result }, detail: `accepted ${body.headSha.slice(0, 12)}` };
    }],
    ["GET", "/api/issues", "none", async () => {
      const issues = [];
      for (const name of repoNames()) {
        try {
          const listed = await needsBoard().listIssues(name);
          issues.push(...listed.issues.map((issue) => webIssue(issue, linkIndex.session(linkIndex.sessionForIssue(name, issue.number)))));
        } catch (error) {
          if (error instanceof HttpError && error.status === 503) throw error;
        }
      }
      return { issues: issues.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))) };
    }],
    ["GET", "/api/ci", "none", async () => {
      const repos = [];
      for (const name of repoNames()) {
        try {
          repos.push(webCi(await needsBoard().ci(name)));
        } catch (error) {
          if (error instanceof HttpError && error.status === 503) throw error;
          repos.push({ repo: name, latest: null, history: [] });
        }
      }
      return { repos };
    }],
    ["POST", "/api/ci/:repo/:runId/rerun", "rerun", async ({ params, identity }) => {
      const repo = known(params.repo);
      await needsWriter().rerunFailedJobs(repo, Number(params.runId), { actor: identity });
      return { body: { ok: true }, ...githubAudit(identity, "rerun failed jobs", `${repo} run ${params.runId}`) };
    }],

    // --- The old app's routes, kept for one release, served from sessions through run-view.mjs.
    ["GET", "/api/runs", "listRuns", async ({ query, identity }) => ({ runs: await runView(identity).list({ status: query.status, repo: query.repo, limit: query.limit }) })],
    ["POST", "/api/runs", "createRun", async ({ body, identity }) => {
      const { run, created } = await runView(identity).create(body);
      return { status: created ? 201 : 200, body: { run } };
    }],
    ["GET", "/api/runs/:id", "none", async ({ params, identity }) => ({ run: await runView(identity).get(params.id) })],
    ["GET", "/api/runs/:id/readiness", "none", async ({ params, identity }) => ({ readiness: await runReadiness(params.id, identity) })],
    ["POST", "/api/runs/:id/readiness/accept", "acceptGateChange", async ({ params, body, identity }) => ({
      body: { readiness: await runReadiness(params.id, identity, body.headSha) }, detail: `accepted ${body.headSha.slice(0, 12)}`,
    })],
    ["GET", "/api/runs/:id/events", "events", async ({ params, query, identity }) => ({ events: await runView(identity).events(params.id, query.since) })],
    ["POST", "/api/runs/:id/input", "input", async ({ params, body, identity }) => ({ run: await runView(identity).send(params.id, body.text) })],
    ["POST", "/api/runs/:id/stop", "stop", async ({ params, identity }) => {
      if (store.getRun(params.id)) return { run: await runView(identity).stop(params.id) };
      // The old app's confirm step stands for the person's look: it ends the session as it is now.
      const session = await sessionById(params.id);
      if (!session.alive) throw new HttpError(409, "The run has already ended.");
      await sessions.end(params.id, { confirm: true, expect: session.expect }, by(identity));
      return { run: await runView(identity).get(params.id) };
    }],
  ].map(([method, template, schema, handler]) => ({
    method, template, schema, handler,
    regex: new RegExp(`^${template.replace(/:(\w+)/g, (_, name) => `(?<${name}>${PARAMS[name]})`)}$`),
  }));

  async function handleApi(req, res, url) {
    let identity = "anonymous";
    let template = `${req.method} ${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`.slice(0, 200);
    let target = "";
    try {
      identity = authenticate(req);
      if (url.pathname === "/api/stream" && req.method === "GET") {
        template = "GET /api/stream";
        audit(store, { actor: identity, origin: "web", action: template, outcome: "ok" });
        stream.handle(req, res);
        return;
      }
      const matches = routes.map((candidate) => ({ candidate, match: candidate.regex.exec(url.pathname) })).filter((entry) => entry.match);
      if (!matches.length) throw new HttpError(404, "No such route.");
      const route = matches.find((entry) => entry.candidate.method === req.method);
      if (!route) throw new HttpError(405, "That method is not allowed here.");
      template = `${req.method} ${route.candidate.template}`;
      const groups = route.match.groups ?? {};
      target = groups.id ?? (groups.repo ? `${groups.repo}${groups.n ? `#${groups.n}` : ""}${groups.runId ? ` run ${groups.runId}` : ""}` : "");
      let body = {};
      const writes = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
      if (writes) assertSameOriginWrite(req, { json: req.method !== "DELETE" });
      if (req.method === "POST" || req.method === "PUT") body = parse(parsers[route.candidate.schema], await readBody(req));
      const query = req.method === "GET" ? parse(parsers[route.candidate.schema], Object.fromEntries(url.searchParams)) : {};
      let result = await route.candidate.handler({ params: groups, query, body, req, identity });
      // The old app's run routes show what a session said, as segwi's stored events were: redacted.
      if (route.candidate.template.startsWith("/api/runs")) result = cleanDeep(result);
      const status = result.status ?? 200;
      audit(store, { actor: identity, origin: "web", action: template, target, outcome: "ok", detail: result.detail ?? "" });
      if (status === 204) res.writeHead(204, { "Cache-Control": "no-store" }).end();
      else sendJson(res, status, result.body ?? result);
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error(`hares: ${template}: ${error.stack ?? error}`);
      const status = known ? error.status : 500;
      // Only the reason is audited, never the request body.
      audit(store, { actor: identity, origin: "web", action: template, target, outcome: known ? error.outcome : "error", detail: known ? `${status} ${error.message}` : "500 internal error" });
      if (!res.headersSent) sendJson(res, status, errorBody(error));
      else res.end();
    }
  }

  // An extension's API answers like hares's own: the same identity, the same
  // same-origin rule for writes, and an audit line naming the extension's route.
  // A GET is refused when another site's page sent it, too: the identity
  // comes with every request tailscale serve forwards, so an <img> on any
  // page you open could otherwise call a route that changes something.
  async function handleExtensionApi(req, res, extension, routePath, identity) {
    const template = `${req.method} /ext/${extension.name}/api${routePath}`.slice(0, 200);
    try {
      if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])) throw new HttpError(403, "Another site's page can't call an extension.");
      const handler = extension.routes.get(`${req.method} ${routePath}`);
      if (!handler) throw new HttpError(extension.routes.has(`${req.method === "GET" ? "POST" : "GET"} ${routePath}`) ? 405 : 404, "No such route.");
      let body = {};
      if (req.method === "POST") {
        assertSameOriginWrite(req, { json: true });
        body = await readBody(req);
      }
      const result = await handler({ query: Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams), body, identity });
      audit(store, { actor: identity, origin: "web", action: template, outcome: "ok" });
      sendJson(res, 200, result ?? {});
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error(`hares: ${template}: ${error.stack ?? error}`);
      audit(store, { actor: identity, origin: "web", action: template, outcome: known ? error.outcome : "error", detail: known ? `${error.status} ${error.message}` : "500 internal error" });
      if (!res.headersSent) sendJson(res, known ? error.status : 500, { error: known ? error.message : "Something went wrong in the extension." });
      else res.end();
    }
  }

  async function serveExtensionFile(res, root, relative) {
    let decoded;
    try {
      decoded = decodeURIComponent(relative || "index.html");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.normalize(path.join(root, decoded));
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const target = (await stat(file)).isDirectory() ? path.join(file, "index.html") : file;
      const body = await readFile(target);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found.\n");
    }
  }

  // Sign-in comes first, so nobody without it learns which extensions exist.
  async function handleExtension(req, res, url) {
    let identity;
    try {
      identity = authenticate(req);
    } catch (error) {
      return res.writeHead(error.status ?? 403, { "Content-Type": "text/plain; charset=utf-8" }).end(`${error.message}\n`);
    }
    const [, name, ...rest] = url.pathname.split("/").slice(1);
    if (url.pathname === "/ext/tokens.css" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": TYPES[".css"], "Cache-Control": "no-cache" });
      return res.end(await readFile(TOKENS));
    }
    const extension = extensions.find((candidate) => candidate.name === name);
    if (!extension) return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No such extension.\n");
    if (rest[0] === "api") return handleExtensionApi(req, res, extension, `/${rest.slice(1).join("/")}`, identity);
    if (rest.length === 0) return res.writeHead(308, { Location: `/ext/${name}/` }).end();
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    return serveExtensionFile(res, extension.root, rest.join("/"));
  }

  return async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    // A browser the agent drives must never use the app, the API, MCP or anything else here, or it could
    // answer its own prompts: refused before any route, in every spelling of the mark.
    if (isRunBrowserRequest(req)) {
      audit(store, { actor: "anonymous", origin: "web", action: `${req.method} ${url.pathname.slice(0, 100)}`, outcome: "rejected", detail: "403 a run's own browser" });
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("A run's own browser can't use hares.\n");
      return undefined;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname === "/mcp") return mcp ? mcp(req, res) : res.writeHead(404).end();
    // The approver's door is retired with the approver: permission prompts come from the hook now.
    if (url.pathname === "/internal" || url.pathname.startsWith("/internal/")) {
      audit(store, { actor: "anonymous", origin: "system", action: `${req.method} ${url.pathname.slice(0, 100)}`, outcome: "rejected", detail: "404 retired" });
      return res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "No such route." }));
    }
    if (url.pathname.startsWith("/ext/")) return handleExtension(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return undefined;
    }
    try {
      authenticate(req); // the app shell is behind the same identity check as the API
    } catch (error) {
      res.writeHead(error.status ?? 403, { "Content-Type": "text/plain; charset=utf-8" }).end(`${error.message}\n`);
      return undefined;
    }
    try {
      return await serveStatic(res, staticRoot, url.pathname);
    } catch {
      res.writeHead(400).end();
      return undefined;
    }
  };
}

