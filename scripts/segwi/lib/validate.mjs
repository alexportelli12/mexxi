// Every body and query is parsed by a strict zod schema: unknown fields are
// rejected, lengths are capped, and repo and action must be configured.
import { z } from "zod";
import { HttpError } from "./errors.mjs";

const STATUSES = ["queued", "running", "needs_input", "needs_approval", "completed", "failed", "stopped", "timed_out"];

export function schemas(settings) {
  const { limits, repositories } = settings.segwi;
  const createRun = z.strictObject({
    repo: z.string(),
    action: z.enum(["build", "ready", "ask"]),
    task: z.string().min(1).max(limits.taskMaxChars),
    clientId: z.uuid().optional(),
  }).superRefine((value, ctx) => {
    const repository = repositories.find((candidate) => candidate.name === value.repo);
    if (!repository) ctx.addIssue({ code: "custom", path: ["repo"], message: "repo is not configured" });
    else if (!repository.actions.includes(value.action)) ctx.addIssue({ code: "custom", path: ["action"], message: "action is not allowed for this repo" });
  });
  return {
    createRun,
    input: z.strictObject({ text: z.string().min(1).max(limits.inputMaxChars) }),
    stop: z.strictObject({ confirm: z.literal(true) }),
    listRuns: z.strictObject({
      status: z.enum(STATUSES).optional(),
      repo: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
    events: z.strictObject({ since: z.coerce.number().int().min(0).optional() }),
    audit: z.strictObject({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    listApprovals: z.strictObject({ status: z.enum(["pending", "allowed", "denied", "expired"]).optional() }),
    decideApproval: z.strictObject({ decision: z.enum(["allow", "deny"]) }),
    internalApproval: z.strictObject({
      runId: z.string().min(1).max(64), toolName: z.string().min(1).max(200),
      input: z.record(z.string(), z.unknown()), toolUseId: z.string().min(1).max(200),
    }),
    pushSubscription: z.strictObject({
      endpoint: z.string().max(1000),
      keys: z.strictObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
    }),
    none: z.strictObject({}),
  };
}

/** Parses `value` or throws a 400 that names the fields, never their values. */
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.flatMap((issue) => {
    const path = issue.path.join(".");
    return issue.code === "unrecognized_keys" ? issue.keys.map((key) => `${path ? `${path}.` : ""}${key}`) : [path || "body"];
  }))];
  throw new HttpError(400, `Invalid ${fields.join(", ")}.`);
}
