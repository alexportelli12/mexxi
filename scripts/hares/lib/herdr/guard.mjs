// The one choke point for everything ħares does TO a herdr pane: keys, text,
// prompts, answers, closing a pane and starting new ones. No other module may
// name those methods or import herdrWrite (test/herdr-static.test.mjs).
//
// Before anything reaches a pane the guard proves that the pane is still the
// one the person looked at: herdr still speaks protocol 22, the pane exists and
// runs Claude, its terminal and Claude session are the same, its status is the
// same, and its state_change_seq has not moved. An answer also re-reads the
// screen and finds the option by its label and question text on THAT screen;
// it never trusts an index computed earlier. Any difference throws
// StaleStateError (HTTP 409) and sends nothing.
//
// A short race remains between the last check and the send (about 100 ms, one
// socket round trip); herdr has no compare-and-send, so it is accepted.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "../errors.mjs";
import { HERDR_PROTOCOL, herdrRequest, herdrWrite } from "./client.mjs";
import { parseScreen } from "./screen.mjs";

export const STALE_MESSAGE = "The session changed since you looked; check it again";
export const OWNED_WORKSPACE_LABEL = "ħares";
const START_TIMEOUT_MS = 60_000;
const START_BUSY_RETRIES = 6;
const START_BUSY_DELAY_MS = 250;
const ANSWERABLE_KINDS = new Set(["question", "review", "permission", "plan", "trust"]);

export class StaleStateError extends HttpError {
  constructor(reason, message = STALE_MESSAGE) {
    super(409, message);
    this.name = "StaleStateError";
    this.reason = reason;
  }
}

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

function checkExpectation(expect) {
  const complete = expect
    && typeof expect.terminalId === "string" && expect.terminalId
    // null: the pane has no Claude session yet (the folder-trust dialog comes first); it must still match exactly.
    && (expect.sessionId === null || (typeof expect.sessionId === "string" && expect.sessionId))
    && typeof expect.status === "string"
    && Number.isInteger(expect.seq);
  if (!complete) throw new StaleStateError("incomplete_expectation");
}

/**
 * request/write default to the real socket client; tests pass the same functions
 * pointed at a fake server through `socket`. workspaceStore remembers the
 * ħares-owned workspace id ({get(), set(id)}); the default keeps it in memory.
 */
export function createGuard({ socket, request = herdrRequest, write = herdrWrite, workspaceStore } = {}) {
  const read = (method, params) => request(method, params, { socket });
  const send = (method, params) => write(method, params, { socket });
  let rememberedWorkspace = null;
  const store = workspaceStore ?? { get: () => rememberedWorkspace, set: (id) => { rememberedWorkspace = id; } };
  let workspaceLock = Promise.resolve();

  async function checkProtocol() {
    const pong = await read("ping", {});
    if (pong?.protocol !== HERDR_PROTOCOL) {
      throw new StaleStateError("protocol", `herdr speaks protocol ${pong?.protocol ?? "unknown"} and ħares speaks ${HERDR_PROTOCOL}, so ħares sends nothing`);
    }
  }

  /** Fresh agent.list; throws unless the pane is exactly what the person saw. */
  async function confirmPane(paneId, expect) {
    const { agents = [] } = await read("agent.list", {});
    const agent = agents.find((candidate) => candidate.pane_id === paneId);
    if (!agent) throw new StaleStateError("pane_gone");
    if (agent.agent !== "claude") throw new StaleStateError("not_claude");
    if (agent.terminal_id !== expect.terminalId) throw new StaleStateError("terminal_changed");
    if ((agent.agent_session?.value ?? null) !== expect.sessionId) throw new StaleStateError("session_changed");
    if (agent.agent_status !== expect.status) throw new StaleStateError("status_changed");
    if ((agent.state_change_seq ?? 0) !== expect.seq) throw new StaleStateError("seq_moved");
    return agent;
  }

  async function freshForm(paneId) {
    const screen = await read("pane.read", { pane_id: paneId, source: "visible" });
    return parseScreen(screen?.read?.text ?? "");
  }

  async function preflight(paneId, expect) {
    if (typeof paneId !== "string" || !paneId) throw new StaleStateError("no_pane");
    checkExpectation(expect);
    await checkProtocol();
    return confirmPane(paneId, expect);
  }

  return {
    /** Raw keys (the terminal keycaps, Esc). */
    async sendKeys({ paneId, expect, keys }) {
      if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string" || key === "")) {
        throw new HttpError(400, "Keys must be a non-empty list of key names");
      }
      await preflight(paneId, expect);
      await send("pane.send_keys", { pane_id: paneId, keys });
      return { ok: true };
    },

    /** Literal text typed into the pane, without Enter. */
    async sendText({ paneId, expect, text }) {
      if (typeof text !== "string" || text === "") throw new HttpError(400, "Text must not be empty");
      await preflight(paneId, expect);
      await send("pane.send_text", { pane_id: paneId, text });
      return { ok: true };
    },

    /** Steer a session that is not waiting on a form: herdr types the message and submits it. */
    async steer({ paneId, expect, text }) {
      if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "The message must not be empty");
      if (expect?.status === "blocked") throw new StaleStateError("blocked", "The session is waiting on a question; answer it instead");
      await preflight(paneId, expect);
      await send("agent.prompt", { target: paneId, text });
      return { ok: true };
    },

    /**
     * Answer the form on screen. answer = {kind, question, optionLabel, confirmAlways?}:
     * the form kind, the question text and the option label the person chose. The
     * option's number comes from a fresh read of the screen, never from the caller.
     * An option that grants more than this call (always allow, all edits, auto mode,
     * folder trust) needs confirmAlways: true, which only a person's confirmation sets.
     */
    async answer({ paneId, expect, answer }) {
      if (!answer || typeof answer.optionLabel !== "string" || typeof answer.question !== "string" || typeof answer.kind !== "string") {
        throw new HttpError(400, "An answer needs the form kind, the question and the option label");
      }
      if (expect?.status !== "blocked") throw new StaleStateError("not_blocked");
      await preflight(paneId, expect);
      const screen = await read("pane.read", { pane_id: paneId, source: "visible" });
      const form = parseScreen(screen?.read?.text ?? "");
      if (!ANSWERABLE_KINDS.has(form.kind)) throw new StaleStateError("screen_unreadable");
      if (form.kind !== answer.kind) throw new StaleStateError("form_changed");
      if (squash(form.question) !== squash(answer.question)) throw new StaleStateError("question_changed");
      const option = form.options.find((candidate) => squash(candidate.label) === squash(answer.optionLabel));
      if (!option) throw new StaleStateError("option_missing");
      if (form.multiSelect) throw new HttpError(422, "This question takes several choices; send them together");
      if (!option.keys && option.n > 9) throw new HttpError(422, "This option has no single key; answer it in the terminal");
      if (option.always && answer.confirmAlways !== true) {
        throw new HttpError(409, "This option grants more than this one call; confirm it first");
      }
      // The screen read took a round trip: prove nothing moved while it did.
      await confirmPane(paneId, expect);
      await send("pane.send_keys", { pane_id: paneId, keys: option.keys ?? [String(option.n)] });
      return { ok: true, n: option.n, label: option.label };
    },

    /**
     * A multi-select question: answer = {question, labels}. Toggles each option whose
     * box differs from the wanted set (a digit toggles; proven live at gate 1), then
     * moves to the review step ("right"), where the person confirms with
     * answer({kind: "review", optionLabel: "Submit answers"}). Returns the review.
     */
    async answerMany({ paneId, expect, answer }) {
      const labels = answer?.labels;
      if (typeof answer?.question !== "string" || !Array.isArray(labels) || labels.length === 0 || labels.some((label) => typeof label !== "string")) {
        throw new HttpError(400, "A multi-select answer needs the question and at least one option label");
      }
      if (expect?.status !== "blocked") throw new StaleStateError("not_blocked");
      await preflight(paneId, expect);
      const form = await freshForm(paneId);
      if (form.kind !== "question" || !form.multiSelect) throw new StaleStateError("form_changed");
      if (squash(form.question) !== squash(answer.question)) throw new StaleStateError("question_changed");
      const wanted = new Set(labels.map(squash));
      for (const label of wanted) if (!form.options.some((option) => squash(option.label) === label)) throw new StaleStateError("option_missing");
      const toggles = form.options.filter((option) => wanted.has(squash(option.label)) !== Boolean(option.selected));
      if (toggles.some((option) => option.n > 9)) throw new HttpError(422, "This option has no single key; answer it in the terminal");
      await confirmPane(paneId, expect);
      await send("pane.send_keys", { pane_id: paneId, keys: [...toggles.map((option) => String(option.n)), "right"] });
      const review = await freshForm(paneId);
      return { ok: true, review: review.kind === "review" ? { answers: review.answers, options: review.options } : null };
    },

    /**
     * "Type something.": answer = {question, text}. Moves to the free-text row by its
     * number, types the text, checks the row now shows it, then presses Enter
     * (proven live at gate 1). One line only.
     */
    async answerText({ paneId, expect, answer }) {
      const text = answer?.text;
      if (typeof answer?.question !== "string" || typeof text !== "string" || text.trim() === "" || /[\r\n]/.test(text) || text.length > 4000) {
        throw new HttpError(400, "A typed answer needs the question and one line of text");
      }
      if (expect?.status !== "blocked") throw new StaleStateError("not_blocked");
      await preflight(paneId, expect);
      const form = await freshForm(paneId);
      if (form.kind !== "question" || form.multiSelect) throw new StaleStateError("form_changed");
      if (squash(form.question) !== squash(answer.question)) throw new StaleStateError("question_changed");
      if (!Number.isInteger(form.freeText) || form.freeText > 9) throw new HttpError(422, "This question takes no typed answer here; answer it in the terminal");
      await confirmPane(paneId, expect);
      await send("pane.send_keys", { pane_id: paneId, keys: [String(form.freeText)] });
      await send("pane.send_text", { pane_id: paneId, text });
      // The row now reads the typed text; anything else means the form moved under us.
      const typed = await read("pane.read", { pane_id: paneId, source: "visible" });
      const row = new RegExp(`^\\s*❯\\s*${form.freeText}\\.\\s+(.*)$`, "m").exec(typed?.read?.text ?? "");
      if (!row || !squash(text).startsWith(squash(row[1]).slice(0, 40))) throw new StaleStateError("typed_text_missing");
      await send("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
      return { ok: true };
    },

    /** End a session by closing its pane. */
    async close({ paneId, expect }) {
      await preflight(paneId, expect);
      await send("pane.close", { pane_id: paneId });
      return { ok: true };
    },

    /**
     * Start Claude in a new tab of the ħares-owned workspace (created once, labelled
     * "ħares"). Never splits a pane the person has open. Returns
     * {paneId, workspaceId, name, state: "started"|"needs_trust", argv?}.
     */
    async startSession({ cwd, args = [], label }) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new HttpError(400, "A session starts in an absolute folder");
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new HttpError(400, "Arguments must be strings");
      await checkProtocol();
      const { workspaceId, unusedPaneId } = await ensureOwnedWorkspace(cwd);
      let paneId = unusedPaneId;
      if (!paneId) {
        const tab = await send("tab.create", { workspace_id: workspaceId, cwd, focus: false, ...(label ? { label } : {}) });
        paneId = tab?.root_pane?.pane_id;
        if (!paneId) throw new HttpError(502, "herdr made a tab without a pane");
      }
      const name = `hares-${randomUUID().slice(0, 8)}`;
      // A fresh tab's shell may not be ready yet: herdr answers agent_pane_busy (seen
      // live at gate 1). Retry a few times, then give up with herdr's own error.
      for (let attempt = 1; ; attempt += 1) {
        try {
          const started = await send("agent.start", { name, kind: "claude", pane_id: paneId, args, timeout_ms: START_TIMEOUT_MS });
          return { paneId, workspaceId, name, state: "started", argv: started?.argv ?? null };
        } catch (error) {
          // A new folder opens Claude's trust dialog first; it shows up as a blocked pane to answer.
          if (error?.code === "agent_not_ready") return { paneId, workspaceId, name, state: "needs_trust" };
          if (error?.code === "agent_pane_busy" && attempt < START_BUSY_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, START_BUSY_DELAY_MS * attempt));
            continue;
          }
          throw error;
        }
      }
    },
  };

  function ensureOwnedWorkspace(cwd) {
    const run = workspaceLock.catch(() => {}).then(async () => {
      const known = store.get();
      if (known) {
        const { snapshot } = await read("session.snapshot", {});
        const workspace = (snapshot?.workspaces ?? []).find((candidate) => candidate.workspace_id === known);
        if (workspace && workspace.label === OWNED_WORKSPACE_LABEL) return { workspaceId: known, unusedPaneId: null };
      }
      const created = await send("workspace.create", { label: OWNED_WORKSPACE_LABEL, cwd, focus: false });
      const workspaceId = created?.workspace?.workspace_id;
      if (!workspaceId) throw new HttpError(502, "herdr made a workspace without an id");
      store.set(workspaceId);
      return { workspaceId, unusedPaneId: created?.root_pane?.pane_id ?? null };
    });
    workspaceLock = run;
    return run;
  }
}
