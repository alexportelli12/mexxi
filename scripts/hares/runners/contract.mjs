// What every runner adapter promises. The shapes are zod schemas so the shared
// contract tests can check each event an adapter emits.
import { z } from "zod";

/**
 * @typedef {{
 *   runId: string, repoPath: string, action: "build"|"ready"|"ask", task: string, model?: string,
 *   limits: { maxTurns: number, approvalTimeoutMinutes: number }, worktreeRoot: string,
 *   browser: object, serverUrl?: string, bindPort?: number, tailnetName?: string, runSecret?: string,
 * }} RunSpec
 * @typedef {{ id: string, capabilities: { input: boolean, approvals: boolean, cost: boolean },
 *   detect(): Promise<{ available: boolean, version: string|null, testedVersions: string[], problems: string[] }>,
 *   start(spec: RunSpec, emit: (event: RunEvent) => void): Promise<{ hostSessionId: string }>,
 *   send(runId: string, text: string): void,
 *   answer(runId: string, approvalId: string, decision: "allow"|"deny"): void,
 *   close(runId: string): void,
 *   stop(runId: string): void }} RunnerAdapter
 */

export const RUN_ACTIONS = ["build", "ready", "ask"];

// A call's input: its text fields, and run_in_background for a command the host runs while the agent goes on.
const inputSummary = z.record(z.string(), z.union([z.string(), z.boolean()]));
const backgroundTask = z.strictObject({ taskId: z.string().min(1), description: z.string(), toolUseId: z.string().min(1).nullable() });

// `session`, `background` and `exit` are internal: the runs service uses them and never stores them as steps.
export const runEventSchema = z.union([
  z.strictObject({ kind: z.literal("session"), hostSessionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({
    kind: z.literal("step"), phase: z.literal("call"), toolUseId: z.string().min(1), tool: z.string().min(1), input: inputSummary,
  }),
  z.strictObject({
    kind: z.literal("step"), phase: z.literal("result"), toolUseId: z.string().min(1), ok: z.boolean(), detail: z.string(),
  }),
  // Something other than a person refused a call (a classifier, a deny rule or a hook); it follows the call's result.
  z.strictObject({ kind: z.literal("refusal"), toolUseId: z.string().min(1), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal("needs-input"), prompt: z.string().optional() }),
  z.strictObject({ kind: z.literal("approval"), approvalId: z.string().min(1) }),
  // Everything the host still runs in the background (commands, monitors), sent whole each time it changes.
  z.strictObject({ kind: z.literal("background"), tasks: z.array(backgroundTask) }),
  // `wakePending`: background work finished during the turn, so the host starts another turn by itself.
  z.strictObject({
    kind: z.literal("result"),
    ok: z.boolean(), subtype: z.string(), costUsd: z.number().nullable(), hostSessionId: z.string().nullable(), durationMs: z.number().nullable(),
    wakePending: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("error"), message: z.string() }),
  z.strictObject({ kind: z.literal("exit"), code: z.number().nullable(), signal: z.string().nullable() }),
]);

export function assertRunEvent(event) {
  return runEventSchema.parse(event);
}

/**
 * Run status after a `result`: the one place the plan's "when a run ends" rule lives. `waiting` is true while the
 * host still has background work it will come back to, so the turn's end is not the agent asking anything.
 */
export function statusAfterResult({ result, action, hasPullRequest, waiting = false }) {
  if (!result.ok) return "failed";
  if (waiting) return "running";
  if (action === "ask" || hasPullRequest) return "completed";
  return "needs_input";
}
