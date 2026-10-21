import { WorkspaceError } from "../lib/errors.mjs";
import { appendHistory } from "../lib/timings.mjs";

const VERIFY_OUTCOMES = new Set(["pass", "fail"]);

function findingCount(kind, value) {
  if (!/^\d+$/.test(value)) throw new WorkspaceError(`--${kind} expects a whole number of findings`);
  return Number(value);
}

// Records one gate result: a full verify run, or the finding count of one
// review or rendered QA pass. `stats` reports them.
export async function recordGate({ cwd = process.cwd(), sessionId, verify, review, qa }) {
  const given = Object.entries({ verify, review, qa }).filter(([, value]) => value !== undefined);
  if (given.length !== 1) {
    throw new WorkspaceError("record takes exactly one of --verify <pass|fail>, --review <count>, or --qa <count>");
  }
  const [[kind, value]] = given;
  if (kind === "verify" && !VERIFY_OUTCOMES.has(value)) {
    throw new WorkspaceError("--verify expects pass or fail");
  }
  const record = {
    kind,
    at: new Date().toISOString(),
    sessionId,
    ...(kind === "verify" ? { outcome: value } : { findings: findingCount(kind, value) }),
  };
  await appendHistory(cwd, sessionId, "records", record);
  return { operation: "record", ...record };
}
