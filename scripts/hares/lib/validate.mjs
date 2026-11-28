// Every body and query is parsed by a strict zod schema: unknown fields are
// rejected, lengths are capped, and repo and action must be configured.
import { z } from "zod";
import { HttpError } from "./errors.mjs";

const STATUSES = ["queued", "running", "needs_input", "needs_approval", "completed", "failed", "stopped", "timed_out"];
/** The configured actions a repository may allow; the herdr-era ways to start are open to every repository. */
const CONFIGURED_ACTIONS = new Set(["build", "ready", "ask"]);
/** Ways to start that need no task: a plain session, an issue or a pull request (their number says what to do). */
const TASK_OPTIONAL = new Set(["session", "issue", "pr"]);
const SESSION_STATUSES = ["blocked", "working", "idle", "done", "unknown"];

export function schemas(settings) {
  const { limits, repositories } = settings.hares;
  const repoAllows = (value, ctx) => {
    const repository = repositories.find((candidate) => candidate.name === value.repo);
    if (!repository) ctx.addIssue({ code: "custom", path: ["repo"], message: "repo is not configured" });
    else if (CONFIGURED_ACTIONS.has(value.action ?? value.kind) && !repository.actions.includes(value.action ?? value.kind)) {
      ctx.addIssue({ code: "custom", path: ["action"], message: "action is not allowed for this repo" });
    }
  };
  // start_run's input (and the legacy POST /api/runs): build, ready and ask as before, plus the four ways
  // to start a session. The new fields are optional, so every old call validates unchanged.
  const createRun = z.strictObject({
    repo: z.string(),
    action: z.enum(["build", "ready", "ask", "session", "command", "issue", "pr"]),
    task: z.string().min(1).max(limits.taskMaxChars).optional(),
    clientId: z.uuid().optional(),
    command: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/).optional(),
    issue: z.number().int().min(1).max(10_000_000).optional(),
    pr: z.number().int().min(1).max(10_000_000).optional(),
    ask: z.enum(["review-comments", "failing-check"]).optional(),
  }).superRefine((value, ctx) => {
    repoAllows(value, ctx);
    if (value.task === undefined && !TASK_OPTIONAL.has(value.action)) ctx.addIssue({ code: "custom", path: ["task"], message: "task is required" });
    if (value.action === "command" && !value.command) ctx.addIssue({ code: "custom", path: ["command"], message: "command is required" });
    if (value.action === "issue" && !value.issue) ctx.addIssue({ code: "custom", path: ["issue"], message: "issue is required" });
    if (value.action === "pr" && !value.pr) ctx.addIssue({ code: "custom", path: ["pr"], message: "pr is required" });
  });
  const expect = z.strictObject({
    terminalId: z.string().min(1).max(200).nullable(),
    sessionId: z.string().min(1).max(200).nullable(),
    status: z.enum(SESSION_STATUSES),
    seq: z.number().int().min(0),
  });
  const body = z.string().min(1).max(65_536);
  const answer = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("option"), n: z.number().int().min(1).max(99) }),
    z.strictObject({ kind: z.literal("options"), ns: z.array(z.number().int().min(1).max(99)).min(1).max(20) }),
    z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(limits.inputMaxChars) }),
    z.strictObject({ kind: z.literal("chat"), text: z.string().min(1).max(limits.inputMaxChars) }),
  ]);
  const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
  return {
    createRun,
    // The web app's start (core/api.ts StartRequest): always a new herdr pane.
    startSession: z.strictObject({
      clientId: z.uuid().optional(),
      repo: z.string(),
      kind: z.enum(["prompt", "command", "issue", "pr"]),
      prompt: z.string().min(1).max(limits.taskMaxChars).optional(),
      command: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/).optional(),
      args: z.string().max(limits.taskMaxChars).optional(),
      issue: z.number().int().min(1).max(10_000_000).optional(),
      pr: z.number().int().min(1).max(10_000_000).optional(),
      ask: z.enum(["review-comments", "failing-check"]).optional(),
    }).superRefine((value, ctx) => {
      if (!repositories.some((candidate) => candidate.name === value.repo)) ctx.addIssue({ code: "custom", path: ["repo"], message: "repo is not configured" });
    }),
    answer: z.strictObject({ questionId: z.string().min(1).max(200), expect, answers: z.array(answer).min(1).max(20) }),
    steer: z.strictObject({ expect, text: z.string().min(1).max(limits.inputMaxChars) }),
    keys: z.strictObject({ expect, keys: z.array(z.string().min(1).max(20)).max(20).optional(), text: z.string().min(1).max(limits.inputMaxChars).optional() }),
    esc: z.strictObject({ expect }),
    end: z.strictObject({ confirm: z.literal(true), expect }),
    resume: z.strictObject({ prompt: z.string().min(1).max(limits.inputMaxChars).optional() }),
    rename: z.strictObject({ title: z.string().min(1).max(200) }),
    sessionList: z.strictObject({}),
    notificationPrefs: z.strictObject({
      events: z.strictObject({ asks: z.boolean(), finishes: z.boolean(), mainRed: z.boolean(), prReady: z.boolean(), newBump: z.boolean() }),
      quietHours: z.strictObject({ enabled: z.boolean(), start: hhmm, end: hhmm }),
    }),
    heldSeen: z.strictObject({ ids: z.array(z.string().min(1).max(40)).max(200) }),
    review: z.strictObject({ event: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]), body: z.string().max(65_536), startSession: z.boolean().optional() }),
    merge: z.strictObject({ headSha: z.string().regex(/^[0-9a-f]{40}$/), method: z.enum(["squash", "merge", "rebase"]) }),
    reply: z.strictObject({ threadId: z.number().int().min(1), body }),
    comment: z.strictObject({ body }),
    rerun: z.strictObject({}),
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
    // "allow" is the old spelling of "once". "always" needs confirm: true and the rule the person saw.
    decideApproval: z.strictObject({
      decision: z.enum(["allow", "deny", "once", "always"]),
      expect: expect.optional(),
      reason: z.string().min(1).max(limits.inputMaxChars).optional(),
      rule: z.string().min(1).max(2000).optional(),
      confirm: z.literal(true).optional(),
    }),
    acceptGateChange: z.strictObject({ headSha: z.string().regex(/^[0-9a-f]{40}$/) }),
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
