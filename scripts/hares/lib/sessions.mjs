// The session service: every Claude Code session herdr knows, plus the ones ħares
// started, as one list. It merges the herdr adapter (panes, status, the guard),
// the transcript (what was said), the hook's pending records (what is asked),
// links (branch, issue, pull request) and the store (launches, renames).
//
// A session's id is its Claude session id. A session ħares starts gets a ħares
// launch id at once, which aliases to the Claude id once herdr reports it.
// Every key, answer, steer, close and start goes through the guard (adapter.guard),
// which proves the pane is still what the person saw; this module never talks
// to herdr's write methods itself.
//
// Who may do what: a permission, plan or folder-trust answer, an always option and
// raw terminal keys are a person's, from the web app only (origin "web"). Over MCP
// (origin "mcp") a client may answer questions, steer and end only sessions ħares
// started (decision D3), as segwi only reached its own runs.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, statSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { permissionDisplay, PERSON_ONLY_MESSAGE } from "./approvals.mjs";
import { audit } from "./audit.mjs";
import { checkoutProblem, checkoutState } from "./checkout.mjs";
import { HttpError } from "./errors.mjs";
import { parseScreen } from "./herdr/screen.mjs";
import { assertWithinCaps } from "./limits.mjs";
import { actionNeeded } from "./validate.mjs";
import { createLinkResolver } from "./links.mjs";
import { foldPending, gcResolved, listRecords, pendingRoot, removeRecords, staleWhenUnblocked } from "./pending.mjs";
import { displayTitle, locateTranscript, openTail, TranscriptFolder } from "./transcript.mjs";

const execFileAsync = promisify(execFile);

export const START_KINDS = ["session", "command", "issue", "pr", "build", "ready", "ask"];
const NEEDS_CLEAN_CHECKOUT = new Set(["build", "ready", "issue", "pr"]);
/** Forms only a person answers, in the web app: they grant something (a tool call, a plan, a folder). */
export const PERSON_ONLY_KINDS = new Set(["permission", "plan", "trust"]);
export const PR_ASKS = { "review-comments": "Address the review comments on it.", "failing-check": "Fix its failing checks." };
// An ask promises to change nothing, so the tools that write files are taken away (decision 0011).
const ASK_DISALLOWED_TOOLS = "Edit,Write,NotebookEdit";
const ASK_PROMPT = "This session only answers a question: read what you need and change nothing.";
/** How long a launch may wait for herdr to show its pane before it counts as gone. */
const LAUNCH_GRACE_MS = 120_000;
const SYNC_DEBOUNCE_MS = 100;
const TITLE_MAX = 200;

/**
 * The keys the raw terminal may send (P_Terminal's keycap row), as herdr names them.
 * Ctrl is sticky in the app, so a Ctrl combination arrives as "ctrl+<letter>".
 */
export const TERMINAL_KEYS = new Set(["escape", "tab", "shift+tab", "up", "down", "left", "right", "enter", "backspace", "1", "2", "3", "4", "/"]);
const CTRL_KEY = /^ctrl\+[a-z]$/;

/** The mexxi commands a session may start with, from names.json. */
export function loadCommandNames(file = new URL("../../../names.json", import.meta.url)) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).filter((entry) => entry?.kind === "command").map((entry) => entry.name);
  } catch {
    return [];
  }
}

function plainPrompt(text, what) {
  const value = String(text ?? "").trim();
  if (!value) throw new HttpError(400, `${what} must not be empty`);
  // A prompt is claude's positional argument: one that starts with "-" would be read as a flag.
  if (value.startsWith("-")) throw new HttpError(400, `${what} must not start with "-"`);
  return value;
}

/**
 * The arguments after "claude" for each way to start (plan §7.2): plain claude in the
 * repository; a mexxi command as a slash-command prompt; /wettaq from an issue; a fix
 * from a pull request; and the three old actions build, ready and ask.
 */
export function composeArgs({ kind, command, args, issue, pr, ask, task, slug = null, commands = [] }) {
  const extra = typeof task === "string" && task.trim() ? task.trim() : "";
  switch (kind) {
    case "session":
      return extra ? [plainPrompt(extra, "The first message")] : [];
    case "command": {
      if (!commands.includes(command)) throw new HttpError(400, "That is not a mexxi command.");
      const tail = typeof args === "string" && args.trim() ? ` ${args.trim()}` : "";
      if (/[\r\n]/.test(tail)) throw new HttpError(400, "Command arguments are one line.");
      return [`/${command}${tail}`];
    }
    case "issue":
      if (!Number.isInteger(issue) || issue < 1) throw new HttpError(400, "An issue number is required.");
      if (!slug) throw new HttpError(409, "ħares can't tell which GitHub repository this is, so it can't name the issue.");
      return [`/wettaq #${issue} https://github.com/${slug}/issues/${issue}${extra ? `\n\n${extra}` : ""}`];
    case "pr": {
      if (!Number.isInteger(pr) || pr < 1) throw new HttpError(400, "A pull request number is required.");
      if (!slug) throw new HttpError(409, "ħares can't tell which GitHub repository this is, so it can't name the pull request.");
      if (ask !== undefined && !Object.hasOwn(PR_ASKS, ask)) throw new HttpError(400, "Say what to address: review-comments or failing-check.");
      const what = [ask ? PR_ASKS[ask] : "", extra].filter(Boolean).join("\n\n");
      return [`/wettaq https://github.com/${slug}/pull/${pr}${what ? `\n\n${what}` : ""}`];
    }
    case "build":
      return [`/wettaq ${plainPrompt(extra, "The task")}`];
    case "ready":
      return [extra ? `/lesti\n\n${extra}` : "/lesti"];
    case "ask":
      return ["--disallowedTools", ASK_DISALLOWED_TOOLS, "--append-system-prompt", ASK_PROMPT, plainPrompt(extra, "The question")];
    default:
      throw new HttpError(400, `A session starts as one of: ${START_KINDS.join(", ")}.`);
  }
}

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * @param {{ adapter: object, store: object, settings: object, approvals?: object, links?: object, home?: string,
 *   pendingOptions?: {env?: object, home?: string}, checkout?: Function, slugFor?: Function, commands?: string[],
 *   now?: () => Date, launchGraceMs?: number, log?: Function }} deps
 *   slugFor(repository) gives "owner/name" (github.mjs slugForRepository); links is createLinkResolver's result,
 *   whose findPullsForBranch the GitHub layer supplies.
 */
export function createSessionService({
  adapter, store, settings, approvals = null, links = createLinkResolver(), home = os.homedir(), pendingOptions = {},
  checkout = checkoutState, slugFor = async () => null, commands = loadCommandNames(), now = () => new Date(),
  launchGraceMs = LAUNCH_GRACE_MS, log = () => {},
}) {
  const events = new EventEmitter();
  const repositories = settings.hares.repositories;
  const limits = settings.hares.limits;
  /** sessionKey -> what the last sync saw: {status, seq, alive, records: Set<recordId>} */
  const known = new Map();
  /** sessionId -> {file, tail, folder, resolved, cwd, lastAt} */
  const transcripts = new Map();
  const commonDirs = new Map();
  let synced = false;
  let syncTimer = null;
  let syncing = null;
  let resync = false;
  let watcher = null;
  let unsubscribe = null;

  // --- Where a session belongs ---------------------------------------------

  async function gitCommonDir(cwd) {
    if (commonDirs.has(cwd)) return commonDirs.get(cwd);
    let dir = null;
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5_000 });
      dir = stdout.trim() || null;
    } catch {
      dir = null;
    }
    commonDirs.set(cwd, dir);
    return dir;
  }

  /** The configured repository whose checkout holds this folder, or whose worktree it is (an ibni workspace); else "". */
  async function repoFor(cwd) {
    if (!cwd) return "";
    const inside = repositories.find((repository) => cwd === repository.path || cwd.startsWith(repository.path + path.sep));
    if (inside) return inside.name;
    const common = await gitCommonDir(cwd);
    if (!common) return "";
    return repositories.find((repository) => path.resolve(common) === path.join(repository.path, ".git"))?.name ?? "";
  }

  // --- Transcripts, read incrementally ---------------------------------------

  function transcriptFor(sessionId, { cwd = null, transcriptPath = null } = {}) {
    let entry = transcripts.get(sessionId);
    if (!entry) {
      const file = locateTranscript({ sessionId, transcriptPath, cwd, home });
      if (!file) return null;
      entry = { file, tail: openTail(file), folder: new TranscriptFolder(), resolved: new Set(), cwd: null, lastAt: null };
      transcripts.set(sessionId, entry);
    }
    for (const line of entry.tail.read()) {
      entry.folder.push(line);
      if (!entry.cwd && typeof line?.cwd === "string") entry.cwd = line.cwd;
      if (typeof line?.timestamp === "string") entry.lastAt = line.timestamp;
      if (line?.type === "user" && Array.isArray(line.message?.content)) {
        for (const block of line.message.content) if (block?.type === "tool_result" && block.tool_use_id) entry.resolved.add(block.tool_use_id);
      }
    }
    return entry;
  }

  const lastAgentText = (entry) => entry?.folder.rows.findLast((row) => row.kind === "assistant")?.data.text ?? "";
  const isClaudeId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const recordsOf = (sessionId) => (isClaudeId(sessionId) ? listRecords(sessionId, pendingOptions) : []);

  // --- The list ---------------------------------------------------------------

  /**
   * Whether a launch may still be found by its pane alone: only while the launch has no Claude id yet, or the
   * pane shows none or that same one. After /clear, or a new claude in the same pane, the pane runs another
   * session, which must not inherit the launch (and with it MCP's reach, decision D3).
   */
  const samePaneSession = (launch, pane) => !launch.sessionId || !pane.sessionId || pane.sessionId === launch.sessionId;

  /** Follows herdr for ħares's launches: the Claude id once known, the pane after a move, and the end of a pane that went. */
  function upkeepLaunches(panes) {
    const connected = adapter.status().connected;
    for (const launch of store.openLaunches()) {
      const pane = (launch.sessionId && panes.find((candidate) => candidate.sessionId === launch.sessionId))
        || (launch.paneId && panes.find((candidate) => candidate.paneId === launch.paneId && samePaneSession(launch, candidate)))
        || null;
      if (pane) {
        const fields = {};
        if (!launch.sessionId && pane.sessionId) fields.sessionId = pane.sessionId;
        if (pane.paneId !== launch.paneId) fields.paneId = pane.paneId;
        if (pane.terminalId !== launch.terminalId) fields.terminalId = pane.terminalId;
        if (pane.workspaceId !== launch.workspaceId) fields.workspaceId = pane.workspaceId;
        if (Object.keys(fields).length) store.updateLaunch(launch.id, fields);
        continue;
      }
      // Only a connected, fresh picture can say a pane is gone; a launch still starting gets its grace.
      const young = now().getTime() - Date.parse(launch.createdAt) < launchGraceMs;
      if (connected && launch.paneId && (launch.sessionId || !young)) store.endLaunch(launch.id, { endedBy: "gone" });
    }
  }

  async function view(pane, launch, sessionId = null) {
    const id = pane?.sessionId ?? launch?.sessionId ?? sessionId ?? launch?.id ?? `pane-${pane?.paneId}`;
    const records = recordsOf(id);
    const transcript = isClaudeId(id) ? transcriptFor(id, { cwd: pane?.cwd ?? null, transcriptPath: records.find((record) => record.transcriptPath)?.transcriptPath ?? null }) : null;
    const repository = launch ? repositories.find((candidate) => candidate.name === launch.repo) : null;
    const cwd = pane?.cwd ?? transcript?.cwd ?? repository?.path ?? null;
    const alive = Boolean(pane);
    let status = pane?.status ?? "closed";
    if (!pane && launch && !launch.endedAt) status = "starting";
    if (launch?.endedBy === "failed") status = "failed";
    const actionable = records.filter((record) => record.kind !== "hint");
    return {
      id,
      launchId: launch?.id ?? null,
      paneId: pane?.paneId ?? null,
      terminalId: pane?.terminalId ?? null,
      workspaceId: pane?.workspaceId ?? null,
      alive,
      status,
      seq: pane?.seq ?? null,
      title: (isClaudeId(id) ? store.sessionName(id) : null) ?? (transcript ? displayTitle(transcript.folder) : null) ?? pane?.title ?? launch?.task ?? null,
      repo: launch?.repo || (await repoFor(cwd)),
      cwd,
      startedBy: launch ? "hares" : "you",
      action: launch?.action ?? null,
      task: launch?.task ?? null,
      clientId: launch?.clientId ?? null,
      createdAt: launch?.createdAt ?? null,
      lastActivityAt: transcript?.lastAt ?? launch?.createdAt ?? null,
      endedAt: launch?.endedAt ?? null,
      endedBy: launch?.endedBy ?? null,
      reason: launch?.reason ?? null,
      waiting: actionable[0]?.kind ?? (status === "blocked" ? "unknown" : null),
      pendingCount: actionable.length,
      // What the person is looking at; the guard refuses any act once it changed.
      expect: pane ? { terminalId: pane.terminalId, sessionId: pane.sessionId, status: pane.status, seq: pane.seq } : null,
    };
  }

  async function list() {
    const panes = adapter.panes();
    upkeepLaunches(panes);
    const launches = store.listLaunches({ limit: 200 });
    const sessions = [];
    const seen = new Set();
    for (const pane of panes) {
      const launch = (pane.sessionId && launches.find((candidate) => candidate.sessionId === pane.sessionId))
        || launches.find((candidate) => candidate.paneId === pane.paneId && !candidate.endedAt && samePaneSession(candidate, pane)) || null;
      const session = await view(pane, launch);
      seen.add(session.id);
      if (launch) seen.add(launch.id);
      sessions.push(session);
    }
    for (const launch of launches) {
      if (seen.has(launch.id) || (launch.sessionId && seen.has(launch.sessionId))) continue;
      const session = await view(null, launch);
      seen.add(session.id);
      seen.add(launch.id);
      sessions.push(session);
    }
    return sessions;
  }

  async function find(id) {
    if (typeof id !== "string" || !id) throw new HttpError(404, "No such session.");
    const session = (await list()).find((candidate) => candidate.id === id || candidate.launchId === id);
    if (!session) {
      // A session ħares never saw live (closed before it started) can still be read from its transcript.
      if (isClaudeId(id) && transcriptFor(id)) return view(null, store.launchBySession(id), id);
      throw new HttpError(404, "No such session.");
    }
    return session;
  }

  function live(session) {
    if (!session.alive || !session.paneId) throw new HttpError(409, "The session is not running.");
    return session;
  }

  function mcpReach(session, origin) {
    if (origin === "mcp" && !session.launchId) throw new HttpError(409, "Over MCP only sessions ħares started can be reached; use the web app for this one.");
  }

  // --- Pending questions ------------------------------------------------------

  async function readForm(session) {
    if (!session.alive || session.status !== "blocked") return null;
    const read = await adapter.read(session.paneId, "visible");
    return parseScreen(read?.text ?? "");
  }

  async function pendingFor(session) {
    const records = recordsOf(session.id);
    const screen = await readForm(session);
    const items = foldPending({ sessionId: session.id, records, screen }).map((item) => {
      const record = records.find((candidate) => candidate.recordId === item.id);
      const marked = { ...item, personOnly: PERSON_ONLY_KINDS.has(item.kind) };
      if (item.kind === "permission" && record) {
        const display = permissionDisplay(record);
        marked.permission = { ...item.permission, exact: display.exact, content: display.content };
        // Decision D2: a call too long to read in full is never offered as Allow; the terminal answers it.
        if (display.tooLong) Object.assign(marked, { answerable: false, reason: "too long to show in full; answer in the terminal" });
      }
      return marked;
    });
    return { items: items.map((item, index) => ({ ...item, position: { n: index + 1, of: items.length } })), count: items.length, screen, records };
  }

  // --- Sync: herdr changes and hook records become events ---------------------

  /** A pane that closed takes its waiting questions with it: nobody can answer them now. */
  function closed(id, recordIds, reason = "closed") {
    const left = recordsOf(id);
    if (left.length) removeRecords(id, left, pendingOptions);
    for (const recordId of recordIds) events.emit("question.cleared", { sessionId: id, recordId });
    approvals?.expireSession(id);
    events.emit("session.finished", { id, reason });
  }

  async function syncOnce() {
    const sessions = await list();
    const initial = !synced;
    const present = new Set();
    for (const session of sessions) {
      present.add(session.id);
      const before = known.get(session.id);
      let records = recordsOf(session.id);
      const leftBlocked = before?.status === "blocked" && session.status !== "blocked";
      const stale = staleWhenUnblocked(records, { status: session.alive ? session.status : "closed", leftBlocked, now: now().getTime() });
      if (stale.length) {
        removeRecords(session.id, stale, pendingOptions);
        records = records.filter((record) => !stale.includes(record));
      }
      const transcript = transcripts.get(session.id) ?? null;
      if (transcript && gcResolved(session.id, transcript.resolved, pendingOptions)) records = recordsOf(session.id);
      if (approvals && isClaudeId(session.id)) {
        approvals.observe({ sessionId: session.id, paneId: session.paneId, cwd: session.cwd, records, lastText: lastAgentText(transcript) });
      }
      const ids = new Set(records.filter((record) => record.kind !== "hint").map((record) => record.recordId));
      for (const recordId of ids) if (!before?.records.has(recordId)) events.emit("question.added", { sessionId: session.id, recordId, initial });
      for (const recordId of before?.records ?? []) if (!ids.has(recordId)) events.emit("question.cleared", { sessionId: session.id, recordId });
      if (!before || before.status !== session.status || before.seq !== session.seq || before.alive !== session.alive) {
        events.emit("session.changed", { id: session.id, status: session.status, initial });
      }
      if (before?.status === "working" && (session.status === "idle" || session.status === "done")) {
        events.emit("session.finished", { id: session.id, reason: "idle" });
      }
      if (before?.alive && !session.alive) {
        closed(session.id, ids);
        known.set(session.id, { status: session.status, seq: session.seq, alive: false, records: new Set() });
        continue;
      }
      known.set(session.id, { status: session.status, seq: session.seq, alive: session.alive, records: ids });
    }
    for (const [id, before] of known) {
      if (present.has(id)) continue;
      known.delete(id);
      if (before.alive) closed(id, before.records);
    }
    synced = true;
    return sessions;
  }

  /** Runs one sync now (or right after the one in flight). Tests call this; the server relies on watch(). */
  function sync() {
    if (syncing) {
      resync = true;
      return syncing;
    }
    syncing = (async () => {
      try {
        do {
          resync = false;
          await syncOnce();
        } while (resync);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { sync().catch((error) => log(`session sync failed: ${error.message}`)); }, SYNC_DEBOUNCE_MS);
  }

  function changed(id) {
    events.emit("session.changed", { id, initial: false });
    scheduleSync();
  }

  // --- Starting ---------------------------------------------------------------

  const caps = {
    countActive: () => store.openLaunches().length,
    countSince: (sinceIso) => store.countLaunchesSince(sinceIso),
  };

  async function launch({ repo, action, task, clientId = null, sessionId = null, cwd, args, actor, origin, label }) {
    // Checked and inserted in one synchronous step, so two requests can't both pass a cap.
    assertWithinCaps(caps, limits, now());
    const id = randomUUID();
    store.createLaunch({ id, clientId, sessionId, repo, action, task });
    audit(store, { actor, origin, action: "session.started", target: id, outcome: "ok", detail: `${action} in ${repo || cwd}` });
    try {
      const started = await adapter.guard.startSession({ cwd, args, label });
      store.updateLaunch(id, { paneId: started.paneId, workspaceId: started.workspaceId });
    } catch (error) {
      store.endLaunch(id, { endedBy: "failed", reason: `The session could not start: ${error.message}` });
      audit(store, { actor: "system", origin: "system", action: "session.start_failed", target: id, outcome: "error", detail: error.message });
    }
    adapter.refresh().catch(() => {});
    changed(id);
    return view(null, store.getLaunch(id));
  }

  // --- Answering --------------------------------------------------------------

  function requireExpect(expect) {
    if (!expect || typeof expect !== "object") throw new HttpError(400, "Say which state of the session you are answering (expect).");
    return expect;
  }

  function decisionFor(form, label) {
    const option = form.options.find((candidate) => squash(candidate.label) === squash(label));
    if (!option) return null;
    if (option.always) return "always";
    return /^no\b/i.test(option.label) ? "deny" : "once";
  }

  return {
    events,
    on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn); },
    list,
    sync,

    /** One session: a page of its transcript, its links and its queue of waiting questions ("1 of 3"). */
    async get(id, { since = 0, limit = 200 } = {}) {
      const session = await find(id);
      const transcript = isClaudeId(session.id) ? transcriptFor(session.id, { cwd: session.cwd }) : null;
      const rows = transcript ? transcript.folder.rows.filter((row) => row.seq > since).slice(0, limit) : [];
      const total = transcript ? transcript.folder.rows.length : 0;
      const linked = await links.resolve({ repo: session.repo, cwd: session.alive ? session.cwd : null, firstPrompt: transcript?.folder.firstPrompt ?? null });
      const { items, count } = await pendingFor(session);
      return {
        session,
        transcript: { rows, nextSince: rows.length ? rows.at(-1).seq : since, total },
        links: linked,
        pending: { items, count },
        approvals: approvals && isClaudeId(session.id) ? approvals.forSession(session.id) : [],
      };
    },

    /** What the pane shows now, read-only, with the form ħares reads on it. */
    async screen(id) {
      const session = live(await find(id));
      const read = await adapter.read(session.paneId, "visible");
      const { raw, ...form } = parseScreen(read?.text ?? "");
      return { text: read?.text ?? "", form, expect: session.expect };
    },

    /** The transcript rows after `since`, for get_output. */
    async transcriptRows(id, since = 0) {
      const session = await find(id);
      const transcript = isClaudeId(session.id) ? transcriptFor(session.id, { cwd: session.cwd }) : null;
      return transcript ? transcript.folder.rows.filter((row) => row.seq > since) : [];
    },

    /** The pending queue alone (send_input and the Now screen use it). */
    async pending(id) {
      const { items, count } = await pendingFor(await find(id));
      return { items, count };
    },

    /**
     * Answers one waiting question: {recordId, kind, optionLabel} for one choice, labels for a
     * multi-select, text for "Type something.". Permission, plan and trust forms and any
     * option that grants more than this call are a person's, from the web app only.
     */
    async answer(id, { recordId, kind, optionLabel, labels, text, confirmAlways = false, expect } = {}, { actor = "unknown", origin = "web" } = {}) {
      const session = live(await find(id));
      mcpReach(session, origin);
      requireExpect(expect);
      if (PERSON_ONLY_KINDS.has(kind) && origin !== "web") throw new HttpError(403, PERSON_ONLY_MESSAGE);
      if (confirmAlways === true && origin !== "web") throw new HttpError(403, PERSON_ONLY_MESSAGE);
      const { items, screen, records } = await pendingFor(session);
      const item = items.find((candidate) => candidate.id === recordId);
      if (!item) throw new HttpError(409, "That question is no longer waiting; check the session again.");
      const formKind = item.step === "review" ? "review" : item.kind;
      if (formKind !== kind) throw new HttpError(409, "The question changed since you looked; check it again.");
      if (!item.answerable) throw new HttpError(422, item.reason || "Answer this one in the terminal.");
      if (!screen || screen.kind === "unknown") throw new HttpError(409, "The session shows no question now; check it again.");
      // A record can't steer keys to a different prompt: the question it asks must be the one on screen.
      const record = records.find((candidate) => candidate.recordId === recordId);
      if (kind === "question" && record?.input?.questions) {
        const asked = record.input.questions.map((entry) => squash(entry?.question));
        if (!asked.includes(squash(screen.question))) throw new HttpError(409, "The question on screen is not the one on record; check it again.");
      }
      const target = { paneId: session.paneId, expect };
      let result;
      if (kind === "permission" && approvals) {
        const approval = approvals.forSession(session.id).find((candidate) => candidate.recordId === recordId);
        const decision = approval ? decisionFor(screen, optionLabel) : null;
        if (approval && decision) {
          result = await approvals.decide(approval.id, decision, { identity: actor, origin, confirm: confirmAlways === true, rule: approval.suggestedRule ?? undefined, expect });
        }
      }
      if (!result) {
        if (Array.isArray(labels)) result = await adapter.guard.answerMany({ ...target, answer: { question: screen.question, labels } });
        else if (typeof text === "string") result = await adapter.guard.answerText({ ...target, answer: { question: screen.question, text } });
        else result = await adapter.guard.answer({ ...target, answer: { kind, question: screen.question, optionLabel, confirmAlways: origin === "web" && confirmAlways === true } });
      }
      const said = Array.isArray(labels) ? labels.join(", ") : typeof text === "string" ? `typed ${text.length} characters` : optionLabel;
      audit(store, { actor, origin, action: "session.answered", target: session.id, outcome: "ok", detail: `${kind}: ${said}` });
      changed(session.id);
      return result;
    },

    /** A message to a session that is working or idle (never one waiting on a form). */
    async steer(id, { text, expect } = {}, { actor = "unknown", origin = "web" } = {}) {
      const session = live(await find(id));
      mcpReach(session, origin);
      requireExpect(expect);
      // An overlay (a menu, a dialog) looks idle to herdr; typing into it would answer it.
      const read = await adapter.read(session.paneId, "visible");
      if (parseScreen(read?.text ?? "").kind !== "unknown") throw new HttpError(409, "The session shows a dialog; answer it or close it in the terminal first.");
      await adapter.guard.steer({ paneId: session.paneId, expect, text });
      audit(store, { actor, origin, action: "session.steered", target: session.id, outcome: "ok", detail: `${String(text ?? "").length} characters` });
      changed(session.id);
      return { ok: true };
    },

    /** Esc: interrupts what the session is doing. A person's, from the web app. */
    async esc(id, { expect } = {}, { actor = "unknown", origin = "web" } = {}) {
      if (origin !== "web") throw new HttpError(403, "Only the web app sends keys to a session.");
      const session = live(await find(id));
      await adapter.guard.sendKeys({ paneId: session.paneId, expect: requireExpect(expect), keys: ["escape"] });
      audit(store, { actor, origin, action: "session.esc", target: session.id, outcome: "ok" });
      changed(session.id);
      return { ok: true };
    },

    /**
     * The raw terminal: keycaps from TERMINAL_KEYS (or ctrl+letter), then optional text.
     * Raw keys can answer anything on screen, a permission too, so only a person sends them.
     */
    async keys(id, { keys = [], text, expect } = {}, { actor = "unknown", origin = "web" } = {}) {
      if (origin !== "web") throw new HttpError(403, "Only the web app sends keys to a session.");
      if (!Array.isArray(keys) || keys.some((key) => !TERMINAL_KEYS.has(key) && !CTRL_KEY.test(key))) throw new HttpError(400, "Those are not keys the terminal row offers.");
      if (keys.length === 0 && (typeof text !== "string" || text === "")) throw new HttpError(400, "Send at least one key or some text.");
      const session = live(await find(id));
      requireExpect(expect);
      if (keys.length) await adapter.guard.sendKeys({ paneId: session.paneId, expect, keys });
      // The keys may have moved the pane on: the text is checked against the state they left.
      if (typeof text === "string" && text !== "") {
        const nextExpect = keys.length ? (await adapter.refresh(), (await find(session.id)).expect ?? expect) : expect;
        await adapter.guard.sendText({ paneId: session.paneId, expect: nextExpect, text });
      }
      audit(store, { actor, origin, action: "session.keys", target: session.id, outcome: "ok", detail: `${keys.join(" ")}${typeof text === "string" && text ? ` + ${text.length} characters` : ""}` });
      changed(session.id);
      return { ok: true };
    },

    /** End: closes the session's pane, after a confirmation. */
    async end(id, { confirm = false, expect } = {}, { actor = "unknown", origin = "web" } = {}) {
      if (confirm !== true) throw new HttpError(400, "Ending a session needs a confirmation.");
      const session = await find(id);
      if (!session.alive) throw new HttpError(409, "The session has already ended.");
      mcpReach(session, origin);
      // MCP's two-step confirmation stands for the person's look; it acts on the state as it is now.
      const seen = origin === "mcp" ? session.expect : requireExpect(expect);
      await adapter.guard.close({ paneId: session.paneId, expect: seen });
      if (session.launchId) store.endLaunch(session.launchId, { endedBy: "hares", reason: "Ended from ħares" });
      audit(store, { actor, origin, action: "session.ended", target: session.id, outcome: "ok" });
      closed(session.id, known.get(session.id)?.records ?? new Set(), "ended");
      known.set(session.id, { status: "closed", seq: null, alive: false, records: new Set() });
      await adapter.refresh().catch(() => {});
      scheduleSync();
      return find(session.launchId ?? session.id).catch(() => ({ ...session, alive: false, status: "closed", endedBy: "hares" }));
    },

    /** Resume: a new pane running claude --resume <id> in the session's folder. */
    async resume(id, { actor = "unknown", origin = "web" } = {}) {
      const session = await find(id);
      if (!isClaudeId(session.id)) throw new HttpError(409, "This session has no Claude session to resume yet.");
      if (session.alive) throw new HttpError(409, "The session is still running.");
      const cwd = session.cwd ?? transcriptFor(session.id)?.cwd;
      if (!cwd || !path.isAbsolute(cwd)) throw new HttpError(409, "ħares doesn't know which folder this session ran in.");
      return launch({ repo: session.repo, action: "resume", task: session.title ?? "", sessionId: session.id, cwd, args: ["--resume", session.id], actor, origin, label: session.title?.slice(0, 40) });
    },

    /** A person's name for a session, kept by ħares. */
    async rename(id, title, { actor = "unknown", origin = "web" } = {}) {
      const name = String(title ?? "").trim();
      if (!name || name.length > TITLE_MAX || /[\r\n]/.test(name)) throw new HttpError(400, `A name is one line of 1 to ${TITLE_MAX} characters.`);
      const session = await find(id);
      if (!isClaudeId(session.id)) throw new HttpError(409, "This session has no Claude session to name yet.");
      store.setSessionName(session.id, name, actor);
      audit(store, { actor, origin, action: "session.renamed", target: session.id, outcome: "ok", detail: name });
      changed(session.id);
      return find(session.id);
    },

    /**
     * Starts work, always in a new pane: a plain session, a mexxi command, /wettaq from an
     * issue, a fix from a pull request, or build/ready/ask. A repeated clientId returns the
     * first start. Caps (limits.mjs) bound launches: live ħares panes and launches per day.
     */
    async start(input = {}, { actor = "unknown", origin = "web" } = {}) {
      const { kind, repo, command, args, issue, pr, ask, task, clientId } = input;
      if (!START_KINDS.includes(kind)) throw new HttpError(400, `A session starts as one of: ${START_KINDS.join(", ")}.`);
      const existing = () => (clientId ? store.launchByClientId(clientId) : null);
      if (existing()) return { session: await view(null, existing()), created: false };
      const repository = repositories.find((candidate) => candidate.name === repo);
      if (!repository) throw new HttpError(400, "That repository is not configured.");
      // The repository's actions bound every way to start, the review sheet's "start a session" too.
      if (!repository.actions.includes(actionNeeded({ kind, command }))) throw new HttpError(400, "That action is not allowed for this repository.");
      if (NEEDS_CLEAN_CHECKOUT.has(kind)) {
        const problem = checkoutProblem(await checkout(repository.path));
        if (problem) throw new HttpError(409, problem);
      }
      let slug = null;
      if (kind === "issue" || kind === "pr") {
        try { slug = await slugFor(repository); } catch { slug = null; }
      }
      const argv = composeArgs({ kind, command, args, issue, pr, ask, task, slug, commands });
      // A retry with the same clientId may have started while this one awaited.
      if (existing()) return { session: await view(null, existing()), created: false };
      const what = kind === "command" ? `/${command}${args ? ` ${args}` : ""}` : kind === "issue" ? `#${issue}` : kind === "pr" ? `PR #${pr}${ask ? ` (${ask})` : ""}` : (task ?? "");
      const session = await launch({ repo, action: kind, task: what, clientId: clientId ?? null, cwd: repository.path, args: argv, actor, origin, label: `${repo} ${kind}` });
      return { session, created: true };
    },

    /** Follows herdr and the hook's records; returns a stop function. */
    watch() {
      unsubscribe = adapter.onChange(() => scheduleSync());
      const root = pendingRoot(pendingOptions);
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        watcher = watch(root, { recursive: true }, () => scheduleSync());
        watcher.on("error", () => {});
      } catch (error) {
        log(`cannot watch ${root}: ${error.message}; herdr changes still resync`);
      }
      scheduleSync();
      return () => this.close();
    },
    close() {
      clearTimeout(syncTimer);
      unsubscribe?.();
      watcher?.close();
      events.removeAllListeners();
    },
  };
}
