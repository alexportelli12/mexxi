#!/usr/bin/env node
// A fake hares server with realistic demo data for every screen of the web app, so each can be
// looked at, photographed and driven in a browser without herdr, GitHub or a hook. It serves the
// built app and answers the API contract listed at the top of web/src/app/core/api.ts (and
// web/src/app/pages/github/github-api.ts for the GitHub screens). Nothing here touches the network.
//
//   node scripts/hares/test/demo-server.mjs [--port 4290] [--scenario waiting]
//
// Build the web app first: npm --prefix scripts/hares/web run build
//
// Scenarios, each one artboard of the design: waiting (one question), queue (three questions),
// clear (nothing needs you), offline (herdr unreachable) and permission (a command waits for a
// decision, with an always-allow rule). While it runs:
//   POST /__demo/scenario {name}   switch scenario; open pages reload
//   POST /__demo/stale             the next change to a session is refused as stale (409)
//   GET  /__demo/calls             every change the app sent, in order, with its JSON body
import { createReadStream, existsSync, statSync } from "node:fs";
import { IMAGE_HOSTS } from "../lib/html-sanitize.mjs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = fileURLToPath(new URL("../web/dist/web/browser/", import.meta.url));
// The same policy the real server sends, so a stray inline style or script fails here as it would there.
const CSP = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: ${IMAGE_HOSTS.map((host) => `https://${host}`).join(" ")}; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
export const SCENARIOS = ["waiting", "queue", "clear", "offline", "permission"];

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SESSION_IDS = { thatsFair: ID(1), jev: ID(2), verifika: ID(3), docs: ID(4), gifts: ID(5), bump: ID(6) };
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const SCREEN = `⏺ Bash(npm run verify)
  ⎿ ✓ format     1.2s
    ✓ lint       4.8s  (oxlint)
    ✓ typecheck 21.4s
    ✓ test    2m 31s
    ✓ build     58.1s

⏺ oxlint covers the TypeScript rules, but nothing
  handles Angular templates yet.

──────────────────────────────────────────────
 ☐ Templates

How should I handle Angular template linting?

❯ 1. Keep ESLint for templates only
     oxlint handles everything else.
  2. Drop template linting for now
     Fastest. Opens a follow-up issue.
  3. Stop and write up both options
  4. Type something.
──────────────────────────────────────────────
  5. Chat about this

Enter to select, up and down to navigate, Esc to cancel`;

function transcriptFor(key) {
  const steps = (summary, titles) => ({ kind: "steps", summary, steps: titles.map((title) => ({ title, ok: true, detail: null })) });
  const entries = {
    thatsFair: [
      { kind: "you", text: "/wettaq #147: move lint and format to oxlint and oxfmt, then pnpm" },
      { kind: "agent", text: "I measured the baseline first. Lint takes 41 seconds on CI, so I’ve swapped in oxlint for the TypeScript rules." },
      steps("Ran verify, edited 6 files, checked 23 rules", ["npm run verify", "Edit package.json", "Edit oxlint.json", "Edit .github/workflows/verify.yml"]),
      { kind: "agent", text: "oxlint covers the TypeScript rules, but nothing handles Angular templates yet." },
    ],
    jev: [
      { kind: "agent", text: "The view-picker needs the OpenRouter SDK before I can run the eval." },
      steps("Edited 2 files", ["Edit src/picker.ts", "Edit src/eval.ts"]),
    ],
    verifika: [
      { kind: "agent", text: "Both lint errors came from the new reporter. I fixed them, verify is green, and PR #43 is open." },
      steps("Ran verify, edited 2 files, opened PR #43", ["npm run verify", "Edit src/reporters/human.ts", "gh pr create"]),
    ],
    docs: [{ kind: "agent", text: "The docs pass is finished. Ready for a new prompt." }],
    gifts: [{ kind: "agent", text: "The gift list has two layouts and I need to know which one opens first." }],
    bump: [{ kind: "agent", text: "TypeScript 7 removes a flag the build script uses." }],
  };
  return entries[key].map((entry, index) => ({ seq: index + 1, at: minutesAgo(40 - index * 3), ...entry }));
}

const link = (repo, kind, n) => `https://github.com/example/${repo}/${kind}/${n}`;

function buildState(scenario) {
  const base = (key, id, title, repo, status, line, minutes, extra = {}) => ({
    key, id, title, repo, status, alive: true, seq: 40 + Number(id.slice(-2)), terminalId: `term-${Number(id.slice(-2))}`,
    startedBy: "you", startedAt: minutesAgo(minutes + 30), lastActivityAt: minutesAgo(minutes), endedAt: null, line,
    waitingOn: null, pendingCount: 0, links: { issue: null, branch: null, pr: null }, ...extra,
  });
  const thatsFair = base("thatsFair", SESSION_IDS.thatsFair, "Move lint to oxlint and oxfmt", "thats-fair", "blocked", "Asks how to handle template linting", 41, {
    waitingOn: "question", pendingCount: 1,
    links: { issue: { number: 147, url: link("thats-fair", "issues", 147), evidence: "the first prompt names #147" }, branch: { name: "agent/oxlint", evidence: "git branch in the session folder" }, pr: null },
  });
  const jev = base("jev", SESSION_IDS.jev, "Jev view-picker in shadow mode", "eduline-ai-shop", "working", "Running the eval, 12 of 40 cases done", 18, {
    links: { issue: null, branch: { name: "agent/jev-picker", evidence: "git branch in the session folder" }, pr: { number: 231, repo: "eduline-ai-shop", url: link("eduline-ai-shop", "pull", 231), evidence: "pull request whose branch is agent/jev-picker" } },
  });
  const verifika = base("verifika", SESSION_IDS.verifika, "Fix verify:ci lint errors", "verifika", "working", "Editing src/reporters/human.ts", 6, {
    links: { issue: null, branch: { name: "agent/fix-lint", evidence: "git branch in the session folder" }, pr: null },
  });
  const docs = base("docs", SESSION_IDS.docs, "mexxi docs pass", "mexxi", "idle", "Finished, ready for a new prompt", 120);
  const gifts = base("gifts", SESSION_IDS.gifts, "Gift list default view", "eduline-ai-shop", "blocked", "Asks which view the gift list should use", 12, { waitingOn: "question", pendingCount: 1 });
  const bump = base("bump", SESSION_IDS.bump, "Bump typescript to 7.0", "verifika", "blocked", "Asks how to handle a removed build flag", 4, { waitingOn: "question", pendingCount: 1 });
  const expectOf = (s) => ({ terminalId: s.terminalId, sessionId: s.id, status: s.status, seq: s.seq });
  const question = (id, session, asker, topic, text, options, minutes) => ({
    id, sessionId: session.id, kind: "question", asker, topic, askedAt: minutesAgo(minutes),
    items: [{ question: text, multiSelect: false, options: options.map(([label, description], index) => ({ n: index + 1, label, description })) }],
    freeText: true, chat: true, expect: expectOf(session), answerable: true, reason: null,
  });
  const q1 = question("q-templates", thatsFair, "That’s Fair", "templates", "How should I handle Angular template linting?", [
    ["Keep ESLint for templates only", "oxlint handles everything else. No rules are lost."], ["Drop template linting for now", "Fastest. Opens a follow-up issue."], ["Stop and write up both options", "The session pauses here."]], 2);
  const q2 = question("q-gifts", gifts, "Ask Eduline", "the gift list", "Which view should the gift list use by default?", [["Gift picks", "The curated view"], ["Grid", "Every product"], ["Let Jev decide per request", "Chosen by the picker"]], 1);
  const q3 = question("q-bump", bump, "verifika", "the build", "TypeScript 7 drops a flag the build uses. How should I proceed?", [["Pin TypeScript 5.9 for now", "Safe and quick"], ["Update the build script", "Uses the new flag"], ["Stop and report", "The session pauses here"]], 0);
  const permission = {
    id: "p-pnpm-add", sessionId: jev.id, kind: "permission", asker: "eduline-ai-shop", askedAt: minutesAgo(19), items: [], freeText: false, chat: false,
    permission: { tool: "Bash", verb: "run a command", exact: "pnpm add @openrouter/sdk", risk: "low", riskLabel: "Installs a package", why: "Runs in eduline-ai-shop’s workspace and can change package.json and the lockfile.", tooLong: false, always: { text: "Bash(pnpm add:*)", scope: "rule" } },
    expect: { terminalId: jev.terminalId, sessionId: jev.id, status: "blocked", seq: jev.seq }, answerable: true, reason: null,
  };
  const herdr = { connected: true, protocol: 22, panes: 13, claudeSessions: 4, lastSeenAt: minutesAgo(0) };
  const state = { sessions: [], questions: [], herdr };
  switch (scenario) {
    case "queue":
      state.sessions = [thatsFair, gifts, bump, jev];
      state.questions = [q1, q2, q3];
      break;
    case "clear":
      state.sessions = [{ ...thatsFair, status: "working", line: "Running npm run verify", waitingOn: null, pendingCount: 0, lastActivityAt: minutesAgo(44) }, jev, docs,
        { ...verifika, status: "done", alive: false, line: "Finished and opened PR #43", lastActivityAt: minutesAgo(9), endedAt: minutesAgo(9), links: { ...verifika.links, pr: { number: 43, repo: "verifika", url: link("verifika", "pull", 43), evidence: "pull request whose branch is agent/fix-lint" } } }];
      break;
    case "offline":
      state.sessions = [thatsFair, jev, verifika, docs];
      state.herdr = { connected: false, protocol: null, panes: 0, claudeSessions: 0, lastSeenAt: minutesAgo(12) };
      break;
    case "permission":
      state.sessions = [thatsFair, { ...jev, status: "blocked", line: "Asks to run pnpm add @openrouter/sdk", waitingOn: "permission", pendingCount: 1, lastActivityAt: minutesAgo(19) }, verifika, docs];
      state.sessions[0] = { ...thatsFair, status: "working", line: "Editing oxlint.json", waitingOn: null, pendingCount: 0 };
      state.questions = [permission];
      break;
    default:
      state.sessions = [thatsFair, jev, verifika, docs];
      state.questions = [q1];
  }
  return state;
}

const AUDIT = () => [
  [1, 5, "session.answer", "Answered “Keep ESLint for templates only”", "thats-fair, Move lint to oxlint and oxfmt", "answer"],
  [2, 17, "pr.merge", "Squashed and merged #231", "eduline-ai-shop", "merge"],
  [3, 29, "session.start", "Started /wettaq #152", "thats-fair, new herdr pane", "session"],
  [4, 47, "ci.rerun", "Reran failed jobs on main", "verifika, verify", "ci"],
  [5, 85, "session.end", "Ended session mexxi docs pass", "mexxi", "session"],
  [6, 24 * 60 + 40, "approval.always", "Added the rule Bash(pnpm add:*)", "eduline-ai-shop, permanent", "rule"],
  [7, 24 * 60 + 100, "pr.review", "Requested changes on #148", "thats-fair, started a session to address it", "merge"],
].map(([id, ago, action, text, where, kind]) => ({ id, at: minutesAgo(ago), actor: "alex", origin: "web", action, target: "", outcome: "ok", detail: "", text, where, kind }));

const pr = (repo, number, title, groups, extra = {}) => ({
  repo, number, title, url: link(repo, "pull", number), author: "alex", bot: false, draft: false, createdAt: minutesAgo(60 * number % 900 + 30), additions: 120, deletions: 40, groups,
  checks: ["pass", "pass", "pass", "pass"], failureNote: null, ciRunId: null, unresolvedThreads: 0, bump: null, docsOnly: false, headSha: `abc${number}def`, headRef: `agent/pr-${number}`, baseRef: "main", commits: 3, deployWorkflow: null, session: null, ...extra,
});
const PRS = () => [
  pr("eduline-ai-shop", 231, "Jev view-picker spike", ["review", "ready"], { session: { id: SESSION_IDS.jev, title: "Jev view-picker in shadow mode", state: "working" } }),
  pr("thats-fair", 148, "Listing duplicate detection", ["review"], { unresolvedThreads: 2 }),
  pr("verifika", 41, "Polish the human TUI", ["review", "failing"], { checks: ["pass", "fail", "pass", "pass"], failureNote: "verify:ci failed at lint", ciRunId: 9001 }),
  pr("thats-fair", 150, "Map pins that overlap on phones", ["review"]),
  pr("mexxi", 77, "Review the finding format", ["review"]),
  pr("verifika", 44, "Bump typescript to 7.0", ["bumps", "failing"], { bot: true, author: "dependabot", bump: "major", checks: ["pass", "fail"], failureNote: "build failed", ciRunId: 9002 }),
  pr("eduline-shopify-tools", 12, "Sync the price list nightly", ["review"]),
  pr("atlas-ops", 9, "Disk alert thresholds", ["review"]),
  pr("verifika", 43, "Fix verify:ci lint errors", ["ready"], { session: { id: SESSION_IDS.verifika, title: "Fix verify:ci lint errors", state: "done" } }),
];
const ISSUES = () => [
  ["thats-fair", 152, "Show price per m² on listing cards", ["feature"]], ["thats-fair", 149, "OG images for listings", ["launch blocker"]],
  ["thats-fair", 146, "Map pins overlap on phones", ["ux"]], ["thats-fair", 139, "Admin role audit", ["launch blocker"]],
  ["eduline-ai-shop", 88, "Gift list loads slowly", ["performance"]],
].map(([repo, number, title, labels]) => ({ repo, number, title, url: link(repo, "issues", number), labels, createdAt: minutesAgo(60 * 24 * (number % 9 + 1)), session: null }));
const CI = () => ["thats-fair", "eduline-ai-shop", "mexxi", "verifika"].map((repo, index) => ({
  repo,
  latest: { id: 5000 + index, workflow: "verify", branch: "main", status: "completed", conclusion: repo === "verifika" ? "failure" : "success", startedAt: minutesAgo(20 + index * 30), durationSeconds: 240, jobsDone: 4, jobsTotal: 4, failedJob: repo === "verifika" ? "verify" : null, failedStep: repo === "verifika" ? "lint" : null, url: link(repo, "actions/runs", 5000 + index) },
  history: Array.from({ length: 20 }, (_, i) => (repo === "verifika" && i > 16 ? "fail" : "pass")),
}));

/**
 * @param {{ port?: number, scenario?: string }} [options]
 * @returns the running server: `url`, `port`, `calls` (every change the app sent), `setScenario(name)` and `close()`
 */
export async function startDemoServer({ port = 0, scenario = "waiting" } = {}) {
  let state = buildState(scenario);
  let staleNext = false;
  let current = scenario;
  const calls = [];
  const transcripts = new Map();
  const names = new Map();
  const streams = new Set();
  let prefs = { events: { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false }, quietHours: { enabled: true, start: "23:00", end: "07:00" } };
  let held = [{ id: "h1", kind: "ask", title: "Ask Eduline is asking", text: "Which view should the gift list use by default?", url: "/s/" + SESSION_IDS.gifts, createdAt: minutesAgo(380) }];
  const showHeld = () => current !== "queue" && current !== "clear";

  const keyOf = (session) => Object.entries(SESSION_IDS).find(([, id]) => id === session.id)?.[0];
  const transcriptOf = (session) => {
    if (!transcripts.has(session.id)) transcripts.set(session.id, keyOf(session) ? transcriptFor(keyOf(session)) : [{ seq: 1, at: new Date().toISOString(), kind: "agent", text: "Starting up." }]);
    return transcripts.get(session.id);
  };
  const row = ({ key, ...session }) => ({ ...session, title: names.get(session.id) ?? session.title });
  const emit = (event, data) => {
    for (const response of streams) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const touch = (session, patch) => {
    Object.assign(session, patch, { seq: session.seq + 1, lastActivityAt: new Date().toISOString() });
    emit("session", { sessionId: session.id, at: session.lastActivityAt });
  };
  const questionsOf = (id) => state.questions.filter((entry) => entry.sessionId === id);

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": CSP });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
    });
  });

  /** A change is refused when the app's expect no longer matches, or when the next one was told to be stale. */
  function refusesStale(session, expect) {
    const moved = staleNext || !expect || expect.seq !== session.seq || expect.status !== session.status;
    staleNext = false;
    return moved;
  }

  async function api(req, res, url) {
    const method = req.method;
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const body = method === "GET" ? {} : await readBody(req);
    if (method !== "GET" && method !== "HEAD") calls.push({ method, path: url.pathname, body });
    const [head, id, action] = parts;
    const session = head === "sessions" && id ? state.sessions.find((entry) => entry.id === id) : null;

    if (head === "health") return send(res, 200, { ok: true, version: "0.1.0", host: "atlas", herdr: state.herdr, board: { mainRed: current !== "clear" } });
    if (head === "repos") return send(res, 200, { repos: ["thats-fair", "eduline-ai-shop", "mexxi", "verifika", "eduline-shopify-tools", "atlas-ops"].map((name) => ({ name, path: `~/work/${name}`, github: `example/${name}`, defaultBranch: "main" })) });
    if (head === "extensions") return send(res, 200, { extensions: [{ name: "atlas-ops", title: "Machine health", url: "/ext/atlas-ops/" }] });
    // A well-formed key, so the notifications screen can show its normal state; no push is ever sent.
    if (head === "push") return send(res, 200, { publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSfcBrTgg5NQ1ehtd8NYbgcp0DM1sNqYGo" });
    if (head === "audit") return send(res, 200, { audit: AUDIT() });
    if (head === "questions") return send(res, 200, { questions: state.questions });
    if (head === "notifications") {
      if (id === "held") { held = held.filter((entry) => !body.ids?.includes(entry.id)); return send(res, 200, { held }); }
      if (method === "PUT") prefs = body;
      return send(res, 200, { prefs, held: showHeld() ? held : [] });
    }
    if (head === "prs") {
      if (!id) return send(res, 200, { prs: PRS() });
      const found = PRS().find((entry) => entry.repo === id && entry.number === Number(action));
      if (!found) return send(res, 404, { error: "No such pull request." });
      if (method !== "GET") return send(res, 200, { ok: true });
      return send(res, 200, { pr: { ...found, state: "open", changedFiles: 4, issue: 147, bodyHtml: "<p>Moves lint to oxlint. Closes #147.</p>", checkRuns: found.checks.map((check, index) => ({ name: `check ${index + 1}`, state: check, duration: "1m 2s", url: null })), files: [{ path: "package.json", additions: 4, deletions: 2 }], threads: [], readiness: { ready: found.groups.includes("ready"), checks: [] }, previewUrl: null } });
    }
    if (head === "issues") return send(res, 200, { issues: ISSUES() });
    if (head === "ci") return send(res, method === "GET" ? 200 : 200, method === "GET" ? { repos: CI() } : { ok: true });

    if (head === "sessions" && !id && method === "POST") {
      // A new pane: the session appears at once, working, so the screen the app opens has something to show.
      const launched = ID(100 + calls.length);
      state.sessions.unshift({ key: "started", id: launched, title: "New session", repo: body.repo ?? "", status: "working", alive: true, seq: 1, terminalId: "term-new", startedBy: "app", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), endedAt: null, line: "Starting up", waitingOn: null, pendingCount: 0, links: { issue: null, branch: null, pr: null } });
      emit("session", { sessionId: launched, at: new Date().toISOString() });
      return send(res, 200, { session: { id: launched } });
    }
    if (head === "sessions" && id && !session && !action) {
      // A launch id has no session yet: show one just starting.
      return send(res, 404, { error: "No such session." });
    }
    if (head === "sessions" && !id) return send(res, 200, { sessions: state.sessions.map(row) });
    if (session && !action) {
      return send(res, 200, { session: { ...row(session), transcript: transcriptOf(session), nextSince: transcriptOf(session).length, pending: questionsOf(session.id) } });
    }
    if (session && action === "screen") return send(res, 200, { screen: { text: SCREEN, expect: { terminalId: session.terminalId, sessionId: session.id, status: session.status, seq: session.seq }, at: new Date().toISOString(), overlay: false } });
    if (session && method === "POST") {
      if (action === "rename") { names.set(session.id, String(body.title)); touch(session, {}); return send(res, 200, { session: row(session) }); }
      if (action === "resume") { touch(session, { alive: true, status: "idle", endedAt: null }); return send(res, 200, { session: { id: session.id } }); }
      if (refusesStale(session, body.expect)) return send(res, 409, { error: "The session changed since you looked; check it again", code: "stale" });
      if (action === "answer") {
        const asked = state.questions.find((entry) => entry.id === body.questionId && entry.sessionId === session.id);
        if (!asked) return send(res, 409, { error: "That question is no longer waiting.", code: "stale" });
        state.questions = state.questions.filter((entry) => entry !== asked);
        const first = body.answers?.[0];
        const label = first?.kind === "option" ? asked.items[0].options.find((option) => option.n === first.n)?.label : first?.text;
        transcriptOf(session).push({ seq: transcriptOf(session).length + 1, at: new Date().toISOString(), kind: "answer", text: label ?? "" });
        touch(session, { status: "working", waitingOn: null, pendingCount: questionsOf(session.id).length, line: "Working on your answer" });
        emit("question", { sessionId: session.id, id: asked.id, at: new Date().toISOString() });
        return send(res, 200, { session: row(session) });
      }
      if (action === "end") { touch(session, { alive: false, status: "done", endedAt: new Date().toISOString() }); return send(res, 200, { session: row(session) }); }
      touch(session, {});
      return send(res, 200, { session: row(session) });
    }
    if (head === "approvals" && id && method === "POST") {
      const asked = state.questions.find((entry) => entry.id === id);
      const target = asked && state.sessions.find((entry) => entry.id === asked.sessionId);
      if (!asked || !target) return send(res, 404, { error: "No such prompt." });
      if (refusesStale(target, body.expect)) return send(res, 409, { error: "The session changed since you looked; check it again", code: "stale" });
      if (body.decision === "always" && (body.confirm !== true || body.rule !== asked.permission?.always?.text)) return send(res, 400, { error: "Always allow needs the confirm step and the rule you saw." });
      state.questions = state.questions.filter((entry) => entry !== asked);
      touch(target, { status: "working", waitingOn: null, pendingCount: 0, line: "Carrying on" });
      emit("question", { sessionId: target.id, id, at: new Date().toISOString() });
      return send(res, 200, { session: row(target) });
    }
    return send(res, 404, { error: "No such endpoint." });
  }

  function serveFile(res, url) {
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // A path with a file extension that isn't there is a 404; anything else is a screen of the app.
      if (path.extname(url.pathname)) { res.writeHead(404); return res.end(); }
      file = path.join(dist, "index.html");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Content-Security-Policy": CSP, "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://demo");
    try {
      if (url.pathname === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write("retry: 1000\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (url.pathname === "/__demo/calls") return send(res, 200, { calls });
      if (url.pathname === "/__demo/stale") { staleNext = true; return send(res, 200, { ok: true }); }
      if (url.pathname === "/__demo/scenario") {
        const wanted = (await readBody(req)).name;
        if (!SCENARIOS.includes(wanted)) return send(res, 400, { error: "Unknown scenario." });
        server.setScenario(wanted);
        return send(res, 200, { ok: true });
      }
      if (url.pathname.startsWith("/ext/")) {
        res.writeHead(200, { "Content-Type": TYPES[".html"] });
        return res.end("<!doctype html><title>Machine health</title><h1>Machine health</h1>");
      }
      serveFile(res, url);
    } catch (error) {
      send(res, 500, { error: String(error?.message ?? error) });
    }
  });
  server.setScenario = (name) => {
    current = name;
    state = buildState(name);
    transcripts.clear();
    names.clear();
    emit("reset", {});
  };
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}`, port: actual, calls, setScenario: server.setScenario,
    async close() {
      for (const response of streams) response.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const port = Number(flag("--port", 4290));
  const scenario = flag("--scenario", "waiting");
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !SCENARIOS.includes(scenario)) {
    process.stderr.write(`usage: demo-server.mjs [--port <number>] [--scenario ${SCENARIOS.join("|")}]\n`);
    process.exit(2);
  }
  const demo = await startDemoServer({ port, scenario });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void demo.close().finally(() => process.exit(0)));
  process.stdout.write(`hares demo on ${demo.url} (scenario: ${scenario})\nPress Ctrl+C to stop.\n`);
}
