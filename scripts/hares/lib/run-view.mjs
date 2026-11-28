// Sessions as the legacy "run" shape, so segwi's MCP tools (and the old REST
// routes, for one release) keep their names, inputs and reply shapes while they
// read herdr sessions (plan §7.2). Every legacy field is kept; a field with no
// value in the herdr era (verify, costUsd, waitingOn, snapshot) is null.
//
// Runs from before ħares (the runs table) stay readable, read-only.
import { checkoutState } from "./checkout.mjs";
import { cleanText } from "./clean.mjs";
import { HttpError } from "./errors.mjs";
import { PERSON_ONLY_KINDS } from "./sessions.mjs";
import { foldEvents } from "./steps.mjs";
import { FINAL } from "./store.mjs";

const TITLE_MAX = 120;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
export const NEEDS_APPROVAL_MESSAGE = "The session is needs_approval. Only a person in the web app can answer it.";

/** The MCP status of a session (plan §7.2). timed_out is never produced now. */
export function legacyStatus(session) {
  if (session.status === "starting") return "queued";
  if (session.status === "failed") return "failed";
  if (!session.alive) return session.endedBy === "hares" ? "stopped" : "completed";
  if (session.status === "working" || session.status === "unknown") return "running";
  if (session.status === "blocked") return session.waiting === "question" ? "needs_input" : "needs_approval";
  // idle or done with the pane open: it listens for the next message.
  return "needs_input";
}

/** A session as publicRun was: the same keys, in the same order. */
export function runFromSession(session, links = null) {
  return {
    // A session ħares launched keeps the id start_run returned, so an MCP client can match it across calls.
    id: session.launchId ?? session.id,
    repo: session.repo ?? "",
    action: session.action ?? "session",
    task: session.task ?? session.title ?? "",
    status: legacyStatus(session),
    clientId: session.clientId ?? null,
    branch: links?.branch?.name ?? null,
    prUrl: links?.pull?.url ?? null,
    verify: null,
    costUsd: null,
    reason: session.reason ?? null,
    waitingOn: null,
    createdAt: session.createdAt ?? session.lastActivityAt ?? null,
    updatedAt: session.lastActivityAt ?? session.createdAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
    endedAt: session.endedAt ?? null,
    snapshot: null,
  };
}

function questionText(data) {
  const asked = (data.questions ?? []).map((entry) => `${entry?.question ?? ""} (${(entry?.options ?? []).map((option) => option?.label).join(" / ")})`).join("\n");
  const answers = data.answers ? Object.values(data.answers).join(", ") : null;
  return answers ? `Asked: ${asked}\nAnswered: ${answers}` : `Asked: ${asked}`;
}

/** Transcript rows as stored run events, so get_output's entryFor and outputWindow read them unchanged. */
export function eventsFromRows(rows) {
  return rows.map(({ seq, kind, data }) => {
    if (kind === "user") return { seq, kind: "input", data: { text: data.text } };
    if (kind === "assistant") return { seq, kind: "text", data: { text: data.text } };
    if (kind === "tool") return { seq, kind: "step", data: { phase: "call", tool: data.name, toolUseId: data.id, input: { description: data.title } } };
    if (kind === "question") return { seq, kind: "text", data: { text: questionText(data) } };
    if (kind === "interrupted") return { seq, kind: "status", data: { status: "interrupted", reason: data.text } };
    return { seq, kind: "other", data: {} };
  });
}

const OUTCOME = { done: true, answered: true, error: false, interrupted: false, declined: false };

/** Transcript rows as get_run's steps: {seq, type, title, ok, from}. */
export function stepsFromRows(rows) {
  return rows.map(({ seq, kind, data }) => {
    if (kind === "user") return { seq, type: "message", title: cleanText(data.text, TITLE_MAX), ok: null, from: "you" };
    if (kind === "assistant") return { seq, type: "message", title: cleanText(data.text, TITLE_MAX), ok: null, from: "agent" };
    if (kind === "question") return { seq, type: "message", title: cleanText(questionText(data), TITLE_MAX), ok: OUTCOME[data.status] ?? null, from: "agent" };
    if (kind === "tool") {
      const type = EDIT_TOOLS.has(data.name) ? "edit" : READ_TOOLS.has(data.name) ? "read" : "command";
      return { seq, type, title: cleanText(data.title, TITLE_MAX), ok: OUTCOME[data.status] ?? null, from: "agent" };
    }
    return { seq, type: "message", title: cleanText(data.text ?? "", TITLE_MAX), ok: false, from: "you" };
  });
}

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * The runs facade mcp.mjs calls: repos, create, list, get, events, send, stop.
 * origin and actor say who acts; MCP's view uses the defaults.
 */
export function createRunView({ sessions, store, settings, checkout = checkoutState, origin = "mcp", actor = "mcp-token" }) {
  const by = { origin, actor };
  const legacyRun = (id) => store.getRun(id);
  const stripPrivate = ({ hostSessionId, worktreePath, ...rest }) => rest;

  async function session(id) {
    try {
      return await sessions.get(id, { limit: 0 });
    } catch (error) {
      if (error.status === 404) throw new HttpError(404, "No such run.");
      throw error;
    }
  }

  return {
    async repos() {
      const all = await sessions.list();
      return Promise.all(settings.hares.repositories.map(async (repository) => {
        const state = await checkout(repository.path);
        const launch = store.lastLaunchFor(repository.name);
        const old = store.lastRunFor(repository.name);
        let lastRun = null;
        if (launch && (!old || launch.createdAt >= old.createdAt)) {
          const found = all.find((candidate) => candidate.launchId === launch.id);
          lastRun = { id: found?.id ?? launch.sessionId ?? launch.id, status: found ? legacyStatus(found) : "completed", createdAt: launch.createdAt };
        } else if (old) {
          lastRun = { id: old.id, status: old.status, createdAt: old.createdAt };
        }
        return { name: repository.name, actions: repository.actions, defaultBranch: state.defaultBranch, clean: state.clean, onDefault: state.onDefault, lastRun };
      }));
    },

    /** start_run: build, ready and ask as before, plus session, command, issue and pr. */
    async create(input) {
      const { action, ...rest } = input;
      const { session: started, created } = await sessions.start({ kind: action, ...rest }, by);
      return { run: { ...runFromSession(started), id: started.launchId ?? started.id }, created };
    },

    /** Every session, then the runs from before ħares; newest first. */
    async list({ status, repo, limit = 50 } = {}) {
      const runs = (await sessions.list()).map((entry) => runFromSession(entry));
      const old = store.listRuns({ limit: 50 }).map((run) => stripPrivate(run));
      return [...runs, ...old]
        .filter((run) => (!status || run.status === status) && (!repo || run.repo === repo))
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
        .slice(0, limit)
        .map(({ snapshot: _snapshot, ...run }) => run);
    },

    async get(id) {
      const old = legacyRun(id);
      if (old) {
        const repoPath = settings.hares.repositories.find((repository) => repository.name === old.repo)?.path ?? null;
        return { ...stripPrivate(old), steps: foldEvents(store.listEvents(id, 0, 5000), { root: old.worktreePath ?? repoPath }) };
      }
      const page = await session(id);
      const rows = await sessions.transcriptRows(id, 0);
      return { ...runFromSession(page.session, page.links), steps: stepsFromRows(rows) };
    },

    async events(id, since = 0) {
      if (legacyRun(id)) return store.listEvents(id, since, 1000);
      await session(id);
      return eventsFromRows(await sessions.transcriptRows(id, since));
    },

    /**
     * send_input: answers a waiting question (the text is an option's number or exact
     * label, or free text where "Type something." is offered) or steers a session that is
     * working or idle. A permission, plan or trust prompt is refused: a person decides it.
     */
    async send(id, text) {
      const old = legacyRun(id);
      if (old) throw new HttpError(409, `The run is ${old.status} and can't take a reply.`);
      const { session: current } = await session(id);
      if (!current.alive) throw new HttpError(409, `The run is ${legacyStatus(current)} and can't take a reply.`);
      const { items } = await sessions.pending(id);
      const waiting = current.status === "blocked" ? items.find((item) => item.kind !== "hint") ?? null : null;
      if (current.status === "blocked" && (!waiting || PERSON_ONLY_KINDS.has(waiting.kind) || waiting.kind === "unknown")) {
        throw new HttpError(409, NEEDS_APPROVAL_MESSAGE);
      }
      if (waiting) {
        if (!waiting.answerable) throw new HttpError(409, `${waiting.reason || "Answer this one in the terminal."}`);
        if (waiting.step === "review") throw new HttpError(409, "The question waits for its answers to be submitted; do that in the web app.");
        const question = waiting.questions[waiting.current ?? 0];
        if (!question || question.multiSelect) throw new HttpError(409, "This question takes several choices; answer it in the web app.");
        const typed = squash(text);
        const option = question.options.find((candidate) => String(candidate.n) === typed || squash(candidate.label) === typed);
        const answer = { recordId: waiting.id, kind: "question", expect: current.expect };
        if (option) await sessions.answer(id, { ...answer, optionLabel: option.label }, by);
        else if (waiting.freeText) await sessions.answer(id, { ...answer, text }, by);
        else throw new HttpError(409, `Reply with one of the options: ${question.options.map((candidate) => `${candidate.n}. ${candidate.label}`).join(", ")}.`);
      } else {
        await sessions.steer(id, { text, expect: current.expect }, by);
      }
      const { session: after } = await session(id);
      return { id, status: legacyStatus(after) };
    },

    /** stop_run's second step: ends the session (its pane closes). Its branch and any pull request stay. */
    async stop(id) {
      const old = legacyRun(id);
      if (old) {
        if (FINAL.has(old.status)) throw new HttpError(409, `The run is already ${old.status}.`);
        throw new HttpError(409, "This run is from before ħares and can't be stopped from here.");
      }
      const { session: current } = await session(id);
      if (!current.alive) throw new HttpError(409, `The run is already ${legacyStatus(current)}.`);
      const ended = await sessions.end(id, { confirm: true }, by);
      return { id, status: legacyStatus({ ...ended, alive: false, endedBy: ended.endedBy ?? "hares" }) };
    },
  };
}
