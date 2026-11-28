// Approvals: the hook records a permission prompt, the row here mirrors it for
// list_approvals and the web card, and a person's decision goes to the prompt in
// the terminal through the guard. Nothing decides by itself, and only the web app
// decides (origin "web"); MCP can list approvals and never decide one. (The
// approver MCP server that held a call open until a person answered was retired
// once the hook covered every case it handled; plan §1.)
//
// What the person sees is exactly what runs: the raw command or file content,
// never redacted or shortened. A call too long to show in full offers no Allow:
// the card says to answer in the terminal (decision D2).
import { randomBytes } from "node:crypto";
import os from "node:os";
import { audit } from "./audit.mjs";
import { cleanText } from "./clean.mjs";
import { HttpError } from "./errors.mjs";
import { parseScreen } from "./herdr/screen.mjs";
import { ruleTexts } from "./pending.mjs";
import { classifyRisk, RISK_LABELS } from "./risk.mjs";

/** The most a phone can show of one call, counting the command or path and any file content. */
export const DISPLAY_MAX = 20_000;
const WHY_MAX = 300;

// The input fields each tool is known to take, with their types. A call with any other field, or a field of
// another type, is shown whole, as JSON, so nothing that changes what runs can hide beside the part the card
// names. dangerouslyDisableSandbox is left out on purpose, so a call that sets it shows it.
const KNOWN_FIELDS = {
  Bash: { command: "string", description: "string", timeout: "number", run_in_background: "boolean" },
  Read: { file_path: "string", offset: "number", limit: "number", pages: "string" },
  Write: { file_path: "string", content: "string" },
  Edit: { file_path: "string", old_string: "string", new_string: "string", replace_all: "boolean" },
  NotebookEdit: { notebook_path: "string", cell_id: "string", new_source: "string", cell_type: "string", edit_mode: "string" },
  WebFetch: { url: "string", prompt: "string" },
};
const PRIMARY = { Bash: "command", Read: "file_path", Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path", WebFetch: "url" };

const knownShape = (tool, input) => Object.hasOwn(KNOWN_FIELDS, tool) && typeof input[PRIMARY[tool]] === "string"
  && Object.entries(input).every(([key, value]) => Object.hasOwn(KNOWN_FIELDS[tool], key) && typeof value === KNOWN_FIELDS[tool][key]);

/** The line the person decides on: the command, path or URL itself, or the whole call as JSON. */
export function exactFor(tool, input) {
  return knownShape(tool, input) ? input[PRIMARY[tool]] : `${tool} ${JSON.stringify(input)}`;
}

const text = (value) => (typeof value === "string" ? value : "");
const orNull = (value) => (typeof value === "string" ? value : null);

/** What a file tool would write, raw, or null for every other call. */
export function contentFor(tool, input) {
  if (!knownShape(tool, input)) return null;
  if (tool === "Write") return { kind: "write", text: text(input.content) };
  if (tool === "Edit") return { kind: "edit", oldText: text(input.old_string), newText: text(input.new_string), replaceAll: input.replace_all === true };
  if (tool === "NotebookEdit") {
    return { kind: "notebook", cellId: orNull(input.cell_id), editMode: orNull(input.edit_mode), cellType: orNull(input.cell_type), text: text(input.new_source) };
  }
  return null;
}

const CONTENT_TEXTS = { write: ["text"], edit: ["oldText", "newText"], notebook: ["cellId", "editMode", "cellType", "text"] };

/** Characters the person would have to read: the exact line and every text in the content. */
export function displayLength(exact, content) {
  const texts = content ? CONTENT_TEXTS[content.kind].map((field) => content[field] ?? "") : [];
  return [exact, ...texts].reduce((sum, value) => sum + value.length, 0);
}

function tildeHome(directory, home) {
  return home && (directory === home || directory.startsWith(`${home}/`)) ? `~${directory.slice(home.length)}` : directory;
}

/** The approval as list_approvals and the old REST route show it: exactly the legacy fields, null where a value is missing. */
export function publicApproval(approval, repo) {
  const { id, runId = null, tool, exact, content = null, cwd, why, risk, createdAt, expiresAt = null, status, decidedBy = null, decidedAt = null } = approval;
  return { id, runId, tool, exact, content, cwd, why, risk, riskLabel: RISK_LABELS[risk], repo, createdAt, expiresAt, status, decidedBy, decidedAt };
}

// --- Herdr era: approvals fed by hook records ---------------------------------

export const DECISIONS = ["once", "always", "deny"];
const NEVER_A_BUTTON = /auto mode/i;
export const PERSON_ONLY_MESSAGE = "Only a person in the web app can decide a permission.";

/**
 * The option on a permission prompt's screen that carries out a decision. The
 * screen label is the authority: "once" is the plain Yes, "always" the option
 * that grants more than this call (an always-allow rule, access to a folder,
 * accept edits for the session), "deny" the No. Auto mode is never a button.
 * Null when the screen has no such option.
 */
export function optionForDecision(form, decision) {
  const options = form?.options ?? [];
  if (decision === "once") return options.find((option) => !option.always && /^yes\b/i.test(option.label)) ?? null;
  if (decision === "always") return options.find((option) => option.always && !NEVER_A_BUTTON.test(option.label)) ?? null;
  if (decision === "deny") return options.find((option) => /^no\b/i.test(option.label)) ?? null;
  return null;
}

/** What "always" would add, in words: the exact rule (Bash(pnpm add:*)) or the folders it opens (gate 1, F6). */
export function alwaysText(suggestions) {
  const [rule] = ruleTexts(suggestions);
  if (rule) return rule;
  const folders = (Array.isArray(suggestions) ? suggestions : []).filter((entry) => entry?.type === "addDirectories").flatMap((entry) => entry.directories ?? []);
  return folders.length ? `Allow access to ${folders.join(", ")} from this project` : null;
}

/** What a person would read for a permission record, and whether it is too long to show in full (then no Allow is offered). */
export function permissionDisplay(record) {
  if (record.truncated || !record.input || typeof record.input !== "object") return { exact: "", content: null, length: 0, tooLong: Boolean(record.truncated) };
  const tool = record.toolName ?? "";
  const exact = exactFor(tool, record.input);
  const content = contentFor(tool, record.input);
  const length = displayLength(exact, content);
  return { exact, content, length, tooLong: length > DISPLAY_MAX };
}

/** A person must confirm "always" first; the error carries what they confirm: the screen's label and the rule. */
export class ConfirmRequired extends HttpError {
  constructor(confirm) {
    super(409, "This grants more than this one call; confirm it first.");
    this.name = "ConfirmRequired";
    this.confirm = confirm;
  }
}

/**
 * @param {{ store: object, adapter: object, settings: object, notify?: Function, home?: string,
 *   repoForSession?: (sessionId: string) => string }} deps
 *   adapter is the herdr adapter: panes() to find the session's pane, read() for the screen, guard to answer.
 */
export function createHookApprovals({ store, adapter, settings, notify = () => {}, home = os.homedir(), repoForSession = () => "" }) {
  const reportedTooLong = new Set();

  const repoOf = (approval) => (approval.sessionId ? repoForSession(approval.sessionId) : store.getRun(approval.runId)?.repo ?? "");
  const view = (approval) => ({
    ...publicApproval(approval, repoOf(approval)),
    source: approval.source, sessionId: approval.sessionId, recordId: approval.recordId, suggestedRule: approval.suggestedRule, decidedVia: approval.decidedVia,
  });

  function expire(approval) {
    if (!store.decideApproval(approval.id, "expired", "system", "gone")) return false;
    audit(store, { actor: "system", origin: "system", action: "approval.expired", target: approval.id, outcome: "ok", detail: `answered elsewhere or gone: ${approval.tool}: ${approval.exact}` });
    return true;
  }

  return {
    /**
     * Mirrors one session's permission records: a new record makes a pending row (and a
     * push), a record that went away expires its row ("answered elsewhere or gone").
     * A call too long to show in full makes no row: the card says to answer in the terminal.
     */
    observe({ sessionId, paneId = null, cwd = null, records, lastText = "" }) {
      const permissions = records.filter((record) => record.kind === "permission");
      const pending = store.pendingApprovalsForSession(sessionId);
      const added = [];
      const tooLong = [];
      for (const record of permissions) {
        if (pending.some((approval) => approval.recordId === record.recordId)) continue;
        const display = permissionDisplay(record);
        if (display.tooLong) {
          tooLong.push(record.recordId);
          if (!reportedTooLong.has(sessionId + "/" + record.recordId)) {
            reportedTooLong.add(sessionId + "/" + record.recordId);
            audit(store, { actor: "hook", origin: "system", action: "approval.too_long", target: sessionId, outcome: "rejected", detail: `${record.toolName}: ${display.length} characters` });
          }
          continue;
        }
        const input = record.input ?? {};
        const approval = store.createApproval({
          id: randomBytes(12).toString("hex"), tool: record.toolName ?? "", exact: display.exact, content: display.content,
          cwd: cwd ? tildeHome(cwd, home) : "",
          why: cleanText(typeof input.description === "string" && input.description ? input.description : lastText, WHY_MAX),
          risk: classifyRisk({ tool: record.toolName, input, worktreeRoot: settings.worktreeRoot }),
          source: "hook", sessionId, paneId: record.paneId ?? paneId, recordId: record.recordId, suggestedRule: alwaysText(record.suggestions),
        });
        audit(store, { actor: "hook", origin: "system", action: "approval.requested", target: approval.id, outcome: "ok", detail: `${approval.tool}: ${approval.exact}` });
        notify("needs_approval", { sessionId, approvalId: approval.id, recordId: record.recordId });
        added.push(view(approval));
      }
      const live = new Set(permissions.map((record) => record.recordId));
      const expired = pending.filter((approval) => !live.has(approval.recordId) && expire(approval)).map((approval) => approval.id);
      return { added, expired, tooLong };
    },

    /** Every pending approval of a session that ended expires with it. */
    expireSession(sessionId) {
      return store.pendingApprovalsForSession(sessionId).filter(expire).map((approval) => approval.id);
    },

    list({ status = "pending" } = {}) {
      return store.listApprovals({ status }).map((approval) => publicApproval(approval, repoOf(approval)));
    },
    forSession: (sessionId) => store.pendingApprovalsForSession(sessionId).map(view),
    get(id) {
      const approval = store.getApproval(id);
      if (!approval) throw new HttpError(404, "No such approval.");
      return view(approval);
    },

    /**
     * A person's decision from the web app: once, always or deny. It reaches the prompt
     * in the terminal through the guard, which proves the session is still the one the
     * person saw (expect). "always" needs confirm: true, which only the web app's
     * confirm sheet sends, and a rule, if given, must be the one that sheet showed.
     */
    async decide(id, decision, { identity, origin, confirm = false, rule, expect } = {}) {
      if (origin !== "web") throw new HttpError(403, PERSON_ONLY_MESSAGE);
      if (!DECISIONS.includes(decision)) throw new HttpError(400, "A decision is once, always or deny.");
      const approval = store.getApproval(id);
      if (!approval) throw new HttpError(404, "No such approval.");
      if (approval.status !== "pending") throw new HttpError(409, `That approval is already ${approval.status}.`);
      if (approval.source !== "hook") throw new HttpError(409, "This approval belongs to a run, not a session.");
      const pane = adapter.panes().find((candidate) => candidate.sessionId === approval.sessionId);
      if (!pane) throw new HttpError(409, "The session is gone, so nothing can be approved for it.");
      const form = parseScreen((await adapter.read(pane.paneId, "visible"))?.text ?? "");
      if (form.kind !== "permission") throw new HttpError(409, "The session no longer shows this prompt; check it again.");
      if (form.tool && approval.tool && form.tool !== approval.tool) throw new HttpError(409, "The prompt on screen is for a different tool; check it again.");
      // A Bash prompt shows its command: it must be the one on record (whitespace aside, since the pane wraps it).
      const bare = (text) => String(text ?? "").replace(/\s+/g, "");
      if (approval.tool === "Bash" && form.detail && bare(form.detail) !== bare(approval.exact)) {
        throw new HttpError(409, "The command on screen is not the one on record; check it again.");
      }
      const option = optionForDecision(form, decision);
      if (!option) throw new HttpError(422, "This prompt has no such choice here; answer it in the terminal.");
      if (decision === "always") {
        if (confirm !== true) throw new ConfirmRequired({ label: option.label, rule: approval.suggestedRule });
        if (rule !== undefined && rule !== approval.suggestedRule) throw new HttpError(409, "The rule changed since you confirmed it; check it again.");
      }
      await adapter.guard.answer({
        paneId: pane.paneId, expect,
        answer: { kind: "permission", question: form.question, optionLabel: option.label, confirmAlways: decision === "always" && confirm === true },
      });
      store.decideApproval(id, decision === "deny" ? "denied" : "allowed", identity, decision);
      const what = decision === "always" ? ` (always: ${approval.suggestedRule ?? option.label})` : "";
      audit(store, { actor: identity, origin: "web", action: decision === "deny" ? "approval.denied" : "approval.allowed", target: id, outcome: "ok", detail: `${approval.tool}: ${approval.exact}${what}` });
      return view(store.getApproval(id));
    },
  };
}
