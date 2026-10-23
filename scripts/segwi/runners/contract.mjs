// What every runner adapter promises. The shapes are zod schemas so the shared
// contract tests can check each event an adapter emits.
import { z } from "zod";

/**
 * @typedef {{
 *   runId: string, repoPath: string, action: "build"|"ready"|"ask", task: string, model?: string,
 *   limits: { maxTurns: number }, worktreeRoot: string, verifyCommand: string,
 *   denyPatterns: string[], browser: object, serverUrl?: string, bindPort?: number, runSecret?: string,
 * }} RunSpec
 * @typedef {{ id: string, capabilities: { input: boolean, approvals: boolean, cost: boolean },
 *   detect(): Promise<{ available: boolean, version: string|null, testedVersions: string[], problems: string[], sandbox: { available: boolean, problems: string[] } }>,
 *   start(spec: RunSpec, emit: (event: RunEvent) => void): Promise<{ hostSessionId: string }>,
 *   send(runId: string, text: string): void,
 *   answer(runId: string, approvalId: string, decision: "allow"|"deny"): void,
 *   close(runId: string): void,
 *   stop(runId: string): void }} RunnerAdapter
 */

export const RUN_ACTIONS = ["build", "ready", "ask"];

const inputSummary = z.record(z.string(), z.string());

// `session` and `exit` are internal: the runs service uses them and never stores them as steps.
export const runEventSchema = z.union([
  z.strictObject({ kind: z.literal("session"), hostSessionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({
    kind: z.literal("step"), phase: z.literal("call"), toolUseId: z.string().min(1), tool: z.string().min(1), input: inputSummary,
  }),
  z.strictObject({
    kind: z.literal("step"), phase: z.literal("result"), toolUseId: z.string().min(1), ok: z.boolean(), detail: z.string(),
  }),
  z.strictObject({ kind: z.literal("needs-input"), prompt: z.string().optional() }),
  z.strictObject({ kind: z.literal("approval"), approvalId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("result"),
    ok: z.boolean(), subtype: z.string(), costUsd: z.number().nullable(), hostSessionId: z.string().nullable(), durationMs: z.number().nullable(),
  }),
  z.strictObject({ kind: z.literal("error"), message: z.string() }),
  z.strictObject({ kind: z.literal("exit"), code: z.number().nullable(), signal: z.string().nullable() }),
]);

export function assertRunEvent(event) {
  return runEventSchema.parse(event);
}

/** Run status after a `result`: the one place the plan's "when a run ends" rule lives. */
export function statusAfterResult({ result, action, hasPullRequest }) {
  if (!result.ok) return "failed";
  if (action === "ask" || hasPullRequest) return "completed";
  return "needs_input";
}
