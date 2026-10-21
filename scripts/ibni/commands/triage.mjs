import { readFile } from "node:fs/promises";
import { redact } from "../../lib/redact.mjs";
import { workspaceConfig } from "../lib/config.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { configuredGithubRepository, git } from "../lib/git.mjs";
import { askJev, buildRequest, GATE_QUESTIONS } from "../lib/jev.mjs";
import { appendHistory } from "../lib/timings.mjs";
import { sessionWorkspace } from "../lib/session.mjs";

// Why triage may not send anything from this session's repository, or null.
// The repository is the owner/name of the push remote's configured GitHub URL;
// it must be listed in jev.repositories and owned by one of jev.owners.
export async function triagePolicy({ jev, root, remote, apiKey }) {
  if (!jev.enabled) return "jev.enabled is false";
  const github = await configuredGithubRepository(root, remote);
  if (!github) return `remote ${remote} is not a GitHub repository, so it cannot be matched against jev.repositories`;
  const name = `${github.owner}/${github.repo}`;
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!jev.repositories.some((listed) => same(listed, name))) return `${name} is not listed in jev.repositories`;
  if (!jev.owners.some((owner) => same(owner, github.owner))) {
    return `${name} is owned by ${github.owner}, which is not one of jev.owners; another organisation's content is not only yours to share`;
  }
  if (!apiKey) return "OPENROUTER_API_KEY is not set";
  return null;
}

// Paths and line counts of the work so far against baseSha: tracked changes
// (committed or not) from numstat, untracked files by name only. Never contents.
async function changeSummary(worktreePath, baseSha) {
  const numstat = (await git(worktreePath, ["diff", "--numstat", "--no-renames", "-z", baseSha])).stdout;
  const changed = new Map();
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\0").filter(Boolean)) {
    const [added, deleted, ...rest] = line.split("\t");
    changed.set(rest.join("\t"), true);
    insertions += Number(added) || 0;
    deletions += Number(deleted) || 0;
  }
  const untracked = (await git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  for (const file of untracked) changed.set(file, true);
  const changedPaths = [...changed.keys()].sort();
  return { changedPaths, diffStats: { files: changedPaths.length, insertions, deletions, untracked: untracked.length } };
}

const RECORD_DEFAULTS = {
  reason: null,
  model: null,
  payloadBytes: null,
  redacted: false,
  redactions: 0,
  truncated: [],
  attempts: 0,
  httpStatus: null,
  latencyMs: null,
  cost: null,
  inputTokens: null,
  responseModel: null,
  responseId: null,
  answers: null,
  sent: null,
};

// Shadow stage: one Jev call whose answers are only recorded. The agent's
// output carries the outcome but not the answers, so they cannot sway the
// gates it is about to decide; the answers are read later by stats and retro.
export async function triageSession({
  cwd = process.cwd(),
  sessionId,
  requestFile,
  contractFile,
  env = process.env,
  fetchImpl = fetch,
  sleep,
}) {
  if (!requestFile || !contractFile) throw new WorkspaceError("triage requires --request-file <file> and --contract-file <file>");
  const [request, contract] = await Promise.all([requestFile, contractFile].map(async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      throw new WorkspaceError(`cannot read ${file}`, error.message);
    }
  }));
  const { entry: { metadata, worktreePath } } = await sessionWorkspace(cwd, sessionId);
  const { jev } = await workspaceConfig(env);
  const apiKey = env.OPENROUTER_API_KEY;
  const record = { at: new Date().toISOString(), sessionId, stage: jev.stage, outcome: null, ...RECORD_DEFAULTS };
  const save = async (fields) => {
    const item = { ...record, ...fields };
    if (item.reason) item.reason = redact(item.reason).text;
    await appendHistory(cwd, sessionId, "triage", item);
    return { operation: "triage", sessionId, stage: item.stage, outcome: item.outcome, reason: item.reason };
  };

  let built;
  try {
    const refused = await triagePolicy({ jev, root: worktreePath, remote: metadata.remote, apiKey });
    if (refused) return save({ outcome: "skipped", reason: refused });
    built = buildRequest({
      model: jev.model,
      request,
      contract,
      ...await changeSummary(worktreePath, metadata.baseSha),
      maxBytes: jev.maxPayloadBytes,
      zeroDataRetention: jev.zeroDataRetention,
    });
  } catch (error) {
    // A Git hiccup while gathering metadata must not stop the run either.
    return save({ outcome: "failed", reason: `could not gather the change summary: ${error.message.split("\n")[0]}`.slice(0, 300) });
  }
  if (!built) return save({ outcome: "skipped", reason: `the questions alone do not fit below jev.maxPayloadBytes (${jev.maxPayloadBytes})` });
  const sent = {
    model: jev.model,
    payloadBytes: built.bytes,
    redacted: built.redactions > 0,
    redactions: built.redactions,
    truncated: built.truncated,
    sent: built.body.state,
  };
  const result = await askJev({ endpoint: jev.endpoint, apiKey, body: built.body, timeoutMs: jev.timeoutMs, fetchImpl, sleep });
  return save({ ...sent, ...result });
}

const condensed = (answers) => answers && Object.fromEntries(
  Object.entries(answers).map(([question, { answer, confidence }]) => [question, { answer, confidence }]),
);

// What the agent did at each gate triage has an opinion on: before-shots as
// recorded, rendered QA and review from their recorded passes. A gate with no
// pass counts as skipped once the pull request exists, and as undecided before.
function agentGates(metadata) {
  const records = metadata.records ?? [];
  const ran = (kind) => (records.some((item) => item.kind === kind) ? true : metadata.prUrl ? false : null);
  const beforeShots = records.filter((item) => item.kind === "before-shots").at(-1);
  return {
    beforeShots: beforeShots ? beforeShots.outcome === "taken" : null,
    renderedQa: ran("qa"),
    review: ran("review"),
  };
}

// Triage as stats reports it: the latest outcome, the latest answers (the run
// pane's rows), every call without the text it sent (that stays in the
// metadata for retro), and agreement between the answers and the agent.
export function summarizeTriage(metadata) {
  const calls = metadata.triage ?? [];
  const latest = calls.at(-1);
  const answered = calls.filter((call) => call.outcome === "answered").at(-1);
  const agent = agentGates(metadata);
  const gates = Object.fromEntries(Object.entries(GATE_QUESTIONS).map(([gate, recommends]) => {
    const triage = answered ? recommends(answered.answers) : null;
    const did = agent[gate];
    return [gate, { triage, agent: did, agree: triage === null || did === null ? null : triage === did }];
  }));
  const compared = Object.values(gates).filter((gate) => gate.agree !== null);
  return {
    status: latest?.outcome ?? "not-run",
    reason: latest?.reason ?? null,
    answers: condensed(answered?.answers ?? null),
    calls: calls.map(({ sent: _sent, ...call }) => call),
    agreement: { compared: compared.length, agreed: compared.filter((gate) => gate.agree).length, gates },
  };
}
