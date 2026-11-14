import { WorkspaceError } from "../lib/errors.mjs";
import { appendHistory } from "../lib/timings.mjs";

const VERIFY_OUTCOMES = new Set(["pass", "fail"]);
const BEFORE_SHOT_OUTCOMES = new Set(["taken", "skipped"]);

function findingCount(kind, value) {
  if (!/^\d+$/.test(value)) throw new WorkspaceError(`--${kind} expects a whole number of findings`);
  return Number(value);
}

// Records one gate result: a full verify run, the finding count of one review
// or rendered QA pass, or whether before-shots were taken. A review may also
// say how many of its findings were accepted. `stats` reports them.
export async function recordGate({ cwd = process.cwd(), sessionId, verify, review, qa, beforeShots, accepted }) {
  const given = Object.entries({ verify, review, qa, "before-shots": beforeShots }).filter(([, value]) => value !== undefined);
  if (given.length !== 1) {
    throw new WorkspaceError("record takes exactly one of --verify <pass|fail>, --review <count>, --qa <count>, or --before-shots <taken|skipped>");
  }
  const [[kind, value]] = given;
  if (kind === "verify" && !VERIFY_OUTCOMES.has(value)) {
    throw new WorkspaceError("--verify expects pass or fail");
  }
  if (kind === "before-shots" && !BEFORE_SHOT_OUTCOMES.has(value)) {
    throw new WorkspaceError("--before-shots expects taken or skipped");
  }
  if (accepted !== undefined && kind !== "review") throw new WorkspaceError("--accepted applies only to --review");
  const acceptedCount = accepted === undefined ? undefined : findingCount("accepted", accepted);
  if (acceptedCount > Number(value)) throw new WorkspaceError("--accepted cannot exceed the review's finding count");
  const record = {
    kind,
    at: new Date().toISOString(),
    sessionId,
    ...(kind === "verify" || kind === "before-shots" ? { outcome: value } : { findings: findingCount(kind, value) }),
    ...(acceptedCount === undefined ? {} : { accepted: acceptedCount }),
  };
  await appendHistory(cwd, sessionId, "records", record);
  return { operation: "record", ...record };
}
