// Approvals: a call outside the allow list waits here for a person. The approver
// process holds an HTTP request open (the "long poll") until the call is decided
// or expires. Expired means denied. Nothing here widens a decision: it applies
// to the one call, there is no "allow all" and no "remember".
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { audit } from "./audit.mjs";
import { cleanText } from "./clean.mjs";
import { HttpError } from "./errors.mjs";
import { classifyRisk, RISK_LABELS } from "./risk.mjs";
import { hashSecret } from "./runs.mjs";

const EXACT_MAX = 2000;
const WHY_MAX = 300;
const ASKABLE = new Set(["running", "needs_input", "needs_approval"]);
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Read"]);

/** What the person is shown to decide on: the command, path or URL itself. */
export function exactFor(tool, input) {
  if (tool === "Bash" && typeof input.command === "string") return input.command;
  if (FILE_TOOLS.has(tool)) {
    const file = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof file === "string") return file;
  }
  if (tool === "WebFetch" && typeof input.url === "string") return input.url;
  return `${tool} ${JSON.stringify(input)}`;
}

function tildeHome(directory, home) {
  return home && (directory === home || directory.startsWith(`${home}/`)) ? `~${directory.slice(home.length)}` : directory;
}

/** The approval as the API shows it. */
export function publicApproval(approval, repo) {
  const { toolUseId, ...rest } = approval;
  return { ...rest, repo, riskLabel: RISK_LABELS[approval.risk] };
}

/**
 * @param {{ store: object, settings: object, runs: object, broker: object, notify?: Function,
 *   timeoutMs?: number, home?: string }} deps
 *   `timeoutMs` overrides the configured approval timeout; tests use it, config and requests never do.
 */
export function createApprovalService({ store, settings, runs, broker, notify = () => {}, timeoutMs, home = os.homedir() }) {
  const expiryMs = timeoutMs ?? settings.segwi.limits.approvalTimeoutMinutes * 60_000;
  /** @type {Map<string, { resolve: (answer: { decision: "allow"|"deny", message: string }) => void, timer: NodeJS.Timeout }>} */
  const waiting = new Map();

  function record(approval, status) {
    const row = store.addEvent(approval.runId, "approval", { approvalId: approval.id, status, tool: approval.tool, exact: approval.exact, risk: approval.risk, riskLabel: RISK_LABELS[approval.risk] });
    broker.publish(row, null);
  }

  function settle(approval, status, answer, { actor, origin }) {
    if (!store.decideApproval(approval.id, status, actor)) return false;
    const entry = waiting.get(approval.id);
    if (entry) {
      clearTimeout(entry.timer);
      waiting.delete(approval.id);
      entry.resolve(answer);
    }
    audit(store, { actor, origin, action: `approval.${status}`, target: approval.id, outcome: "ok", detail: `${approval.tool}: ${approval.exact}` });
    record(approval, status);
    if (!store.pendingApprovalsFor(approval.runId).length) runs.markResumed(approval.runId);
    return true;
  }

  const expire = (approval) => settle(approval, "expired", { decision: "deny", message: "No one answered in time, so segwi denied it." }, { actor: "system", origin: "system" });

  // A run that ends takes its open questions with it.
  runs.onFinish((runId) => store.pendingApprovalsFor(runId).forEach(expire));

  function checkSecret(runId, bearer) {
    const stored = store.getRunSecretHash(runId);
    if (!stored || !bearer) return false;
    const given = Buffer.from(hashSecret(bearer));
    const expected = Buffer.from(stored);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  return {
    /**
     * Called by the internal route. Resolves with the decision once a person answers or the
     * time runs out. `signal` aborts when the approver's request is dropped; that expires it.
     */
    request({ runId, toolName, input, toolUseId, bearer, signal }) {
      const run = store.getRun(runId);
      if (!run || !checkSecret(runId, bearer)) throw new HttpError(401, "That run secret is not valid.");
      if (!ASKABLE.has(run.status)) throw new HttpError(409, `The run is ${run.status}, so nothing can be approved for it.`);
      const lastText = store.lastEventOfKind(runId, "text")?.data.text ?? "";
      const repoPath = settings.segwi.repositories.find((repository) => repository.name === run.repo)?.path ?? "";
      const approval = store.createApproval({
        id: randomBytes(12).toString("hex"), runId, tool: toolName, exact: cleanText(exactFor(toolName, input), EXACT_MAX),
        cwd: tildeHome(run.worktreePath ?? repoPath, home),
        why: cleanText(typeof input.description === "string" && input.description ? input.description : lastText, WHY_MAX),
        risk: classifyRisk({ tool: toolName, input, worktreeRoot: settings.worktreeRoot }),
        expiresAt: new Date(Date.now() + expiryMs).toISOString(), toolUseId,
      });
      audit(store, { actor: "approver", origin: "system", action: "approval.requested", target: approval.id, outcome: "ok", detail: `${approval.tool}: ${approval.exact}` });
      record(approval, "pending");
      runs.markWaiting(runId);
      notify("approval", run);
      return new Promise((resolve) => {
        const timer = setTimeout(() => expire(approval), expiryMs);
        timer.unref();
        waiting.set(approval.id, { resolve, timer });
        signal?.addEventListener("abort", () => expire(approval), { once: true });
      });
    },

    list({ status = "pending" } = {}) {
      return store.listApprovals({ status }).map((approval) => publicApproval(approval, store.getRun(approval.runId)?.repo ?? ""));
    },

    /** A person's answer. Only a pending approval can be decided. */
    decide(id, decision, identity) {
      const approval = store.getApproval(id);
      if (!approval) throw new HttpError(404, "No such approval.");
      if (approval.status !== "pending") throw new HttpError(409, `That approval is already ${approval.status}.`);
      const allowed = decision === "allow";
      settle(approval, allowed ? "allowed" : "denied", { decision: allowed ? "allow" : "deny", message: "A person denied this in segwi." }, { actor: identity, origin: "web" });
      return publicApproval(store.getApproval(id), store.getRun(approval.runId)?.repo ?? "");
    },

    /** Pending approvals that are still held open; tests use this to wait for the approver. */
    openCount: () => waiting.size,
    shutdown() {
      for (const [id, entry] of waiting) {
        clearTimeout(entry.timer);
        entry.resolve({ decision: "deny", message: "segwi is shutting down, so it denied this." });
        waiting.delete(id);
      }
    },
  };
}
