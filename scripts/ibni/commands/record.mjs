import { WorkspaceError } from "../lib/errors.mjs";
import { cleanOutput, git } from "../lib/git.mjs";
import { sessionWorkspace } from "../lib/session.mjs";
import { appendHistory } from "../lib/timings.mjs";

const VERIFY_OUTCOMES = new Set(["pass", "fail"]);
const BEFORE_SHOT_OUTCOMES = new Set(["taken", "skipped"]);
// The finding grades of decision 0024, in the order they are reported.
const SEVERITIES = ["blocker", "major", "minor", "nit"];

function findingCount(kind, value) {
  if (!/^\d+$/.test(value)) throw new WorkspaceError(`--${kind} expects a whole number of findings`);
  return Number(value);
}

// A pass's counts per grade, or undefined when it gave none. Grades left out
// count as zero, and the grades must add up to the pass's finding count, so a
// stored breakdown always accounts for every finding.
function severityCounts(kind, findings, grades) {
  const given = SEVERITIES.filter((severity) => grades[severity] !== undefined);
  if (given.length === 0) return undefined;
  const severity = Object.fromEntries(SEVERITIES.map((name) => [name, grades[name] === undefined ? 0 : findingCount(name, grades[name])]));
  const total = SEVERITIES.reduce((sum, name) => sum + severity[name], 0);
  if (total !== findings) {
    throw new WorkspaceError(`--blocker, --major, --minor and --nit add up to ${total}, but --${kind} says ${findings} findings; give a count for every grade the pass found`);
  }
  return severity;
}

// The commit a review pass looked at: the worktree's HEAD, but only when
// nothing is uncommitted, since a review of a dirty tree saw no single commit.
// segwi's readiness compares it with the pull request's head (issue #67).
async function reviewedCommit(cwd, sessionId) {
  try {
    const { entry: { worktreePath } } = await sessionWorkspace(cwd, sessionId);
    if (cleanOutput(await git(worktreePath, ["status", "--porcelain"]))) return undefined;
    const sha = cleanOutput(await git(worktreePath, ["rev-parse", "HEAD"]));
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

// Records one gate result: a full verify run, the findings of one review or
// rendered QA pass, or whether before-shots were taken. A review or QA pass
// may break its findings down by grade and say how many it left open; a review
// may also say how many it accepted. Only counts are kept, never finding text.
// `stats` reports them.
export async function recordGate({ cwd = process.cwd(), sessionId, verify, review, qa, beforeShots, accepted, open, ...grades }) {
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
  const isPass = kind === "review" || kind === "qa";
  if (!isPass && (open !== undefined || SEVERITIES.some((name) => grades[name] !== undefined))) {
    throw new WorkspaceError("--blocker, --major, --minor, --nit and --open apply only to --review or --qa");
  }
  const findings = isPass ? findingCount(kind, value) : undefined;
  const acceptedCount = accepted === undefined ? undefined : findingCount("accepted", accepted);
  if (acceptedCount > findings) throw new WorkspaceError("--accepted cannot exceed the review's finding count");
  const openCount = open === undefined ? undefined : findingCount("open", open);
  if ((acceptedCount ?? 0) + (openCount ?? 0) > findings) {
    throw new WorkspaceError(`--open${acceptedCount === undefined ? "" : " and --accepted together"} cannot exceed the pass's finding count`);
  }
  const severity = isPass ? severityCounts(kind, findings, grades) : undefined;
  const headSha = kind === "review" ? await reviewedCommit(cwd, sessionId) : undefined;
  const record = {
    kind,
    at: new Date().toISOString(),
    sessionId,
    ...(isPass ? { findings } : { outcome: value }),
    ...(acceptedCount === undefined ? {} : { accepted: acceptedCount }),
    ...(severity === undefined ? {} : { severity }),
    ...(openCount === undefined ? {} : { open: openCount }),
    ...(headSha === undefined ? {} : { headSha }),
  };
  await appendHistory(cwd, sessionId, "records", record);
  return { operation: "record", ...record };
}
