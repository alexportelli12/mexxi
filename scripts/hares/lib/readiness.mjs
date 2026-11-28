// Whether a pull request is ready for the person to look at (issue #67), keyed by
// repository and pull request number, with the session that made it when one is
// linked. Advisory and fail-closed: computed only from what hares recorded and
// what the GitHub reader fetched, never from what the agent says, and a check
// whose facts can't be had fails. Nothing here merges, approves or marks a pull
// request ready, and no MCP tool can set a check; a person accepts a
// gate-weakening change in the web app, for one head commit (decision 0027).
//
// The store this reads and writes is injected (WS3's store.mjs provides it):
//   sessionForPr(repo, number)            -> sessionId | null   the session linked to the pull request
//   sessionFacts(sessionId)               -> { state, snapshot, pendingPermissions } | null
//        state is working|blocked|idle|done|closed; snapshot is ibni's report on the session's workspace (or null);
//        pendingPermissions is how many permission prompts of that session still wait for the person
//   gateAcceptance(repo, number, headSha) -> { acceptedBy, acceptedAt, detail } | null
//   acceptGateChange({ repo, number, headSha, acceptedBy, detail })
import { HttpError } from "./errors.mjs";
import { GithubUnavailable, githubClient, readGithubToken, slugForRepository } from "./github.mjs";

const CACHE_MS = 30_000;
const GREEN = new Set(["success", "neutral", "skipped"]);
// A session that has stopped working on the pull request: waiting for its next prompt, finished, or closed.
const FINISHED = new Set(["idle", "done", "closed"]);
// A verdict that a rerun on the same commit can turn green; cancelled is not one (a newer push cancels).
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const short = (sha) => String(sha).slice(0, 7);

/** A fact hares could not get, and why. Every rule that needs it fails with that reason. */
export const unknown = (reason) => ({ unknown: reason });
const isUnknown = (value) => value !== null && typeof value === "object" && typeof value.unknown === "string";

const list = (names, max = 5) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));

/** The newest run of each check (by app and name: two apps may share a name), oldest first within each. */
function byCheck(runs) {
  const groups = new Map();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    const key = `${run.appId ?? ""}:${run.name}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()];
}

/** Each commit status context's history, oldest first. */
function byContext(statuses) {
  const groups = new Map();
  for (const status of [...statuses].sort((a, b) => a.id - b.id)) groups.set(status.context, [...(groups.get(status.context) ?? []), status]);
  return [...groups.values()];
}

// What a diff may do only with the person's say-so. Added lines are scanned for suppressions; files and changed
// lines for the gate's own configuration.
const ADDED_LINE_FLAGS = [
  ["a lint or type-check suppression", /eslint-disable|biome-ignore|oxlint-disable|tslint:disable|\bnoqa\b|pylint:\s*disable|type:\s*ignore|\bnolint\b|rubocop:disable/],
  ["a coverage exclusion", /\b(?:istanbul|c8|v8)\s+ignore\b/],
  ["a skipped or focused test", /\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|xfail)\b|[{,]\s*(?:skip|only)\s*:\s*(?![\s}]|false\b)/],
  ["@ts-ignore", /@ts-(?:ignore|nocheck|expect-error)/],
  ["an any cast", /\bas\s+any\b|<any>/],
];
const FILE_FLAGS = [
  ["an edit to CI configuration", /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\/|^azure-pipelines\.ya?ml$|(^|\/)Jenkinsfile$/],
  ["an edit to verify configuration", /^\.mexxi\.json$|(^|\/)verifika\.config\.json$/],
  ["a CRAP baseline edit", /crap/i],
  ["an edit to coverage configuration", /(^|\/)(?:\.c8rc(?:\.json)?|\.nycrc(?:\.json|\.ya?ml)?|\.?codecov\.ya?ml)$/],
];
const CONFIG_FILE = /\.(?:json|ya?ml|toml|cfg|ini|cjs|mjs|js|ts)$|rc$/;
const THRESHOLD_LINE = /\b(?:coverage|thresholds?|crap|fail_under)\b/i;
// A file GitHub shows no patch for because it is binary carries no suppression; any other missing patch is unknown.
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|pdf|zip|gz)$/i;

/** The gate-weakening flags in a pull request's files, or an unknown when a file's diff wasn't returned. */
export function scanDiff(files) {
  const flags = new Set();
  for (const file of files) {
    const name = String(file.filename);
    for (const [label, pattern] of FILE_FLAGS) if (pattern.test(name) || (file.previousFilename && pattern.test(file.previousFilename))) flags.add(`${label} (${name})`);
    if (typeof file.patch !== "string") {
      if (file.status === "removed" || file.changes === 0 || BINARY.test(name)) continue;
      return unknown(`GitHub didn't return the diff of ${name}, so it can't be checked for gate-weakening changes.`);
    }
    for (const line of file.patch.split("\n")) {
      const added = line.startsWith("+") && !line.startsWith("+++");
      const removed = line.startsWith("-") && !line.startsWith("---");
      if (added) for (const [label, pattern] of ADDED_LINE_FLAGS) if (pattern.test(line)) flags.add(`${label} (${name})`);
      if ((added || removed) && CONFIG_FILE.test(name) && THRESHOLD_LINE.test(line)) flags.add(`a coverage or CRAP threshold change (${name})`);
      if ((added || removed) && /(^|\/)package\.json$/.test(name) && /"verify"\s*:/.test(line)) flags.add(`an edit to verify configuration (${name})`);
    }
  }
  return [...flags];
}

/**
 * One named rule: the facts it needs, and its verdict when it has them. A needed fact that is unknown fails the
 * rule with the reason, so a check that can't be determined never passes.
 */
const rule = (name, needs, decide) => ({
  name,
  check(facts) {
    const missing = needs.map((key) => facts[key]).find(isUnknown);
    if (missing) return { name, pass: false, detail: `Can't tell: ${missing.unknown}` };
    return { name, ...decide(facts) };
  },
});

const pass = (detail) => ({ pass: true, detail });
const fail = (detail) => ({ pass: false, detail });

/** The ten checks of issue #67, in its order. */
export const RULES = [
  rule("run-completed", ["session"], ({ session }) => {
    if (!session) return fail("No session is linked to this pull request, so nothing shows it was made and reviewed by a mexxi run.");
    if (!FINISHED.has(session.state)) return fail(`The linked session is ${session.state}, not finished.`);
    return pass(`The linked session finished (${session.state}) with this pull request.`);
  }),

  rule("verify-in-ci", ["pr", "ciCheck", "checkRuns"], ({ pr, ciCheck, checkRuns }) => {
    if (!ciCheck) return fail("The repository's .mexxi.json on the pull request's base branch names no ciCheck, so no CI check is known to run the full verify command.");
    const runs = checkRuns.filter((run) => run.name === ciCheck && run.headSha === pr.headSha).sort((a, b) => a.id - b.id);
    const latest = runs.at(-1);
    if (!latest) return fail(`${ciCheck}, the CI check that runs verify, has not run on ${short(pr.headSha)}.`);
    if (latest.status !== "completed") return fail(`${ciCheck} is still running on ${short(pr.headSha)}.`);
    if (latest.conclusion !== "success") return fail(`${ciCheck} ended ${latest.conclusion} on ${short(pr.headSha)}.`);
    return pass(`${ciCheck} ran the full verify command in CI on ${short(pr.headSha)} and passed.`);
  }),

  rule("reviewed-head", ["pr", "ibni"], ({ pr, ibni }) => {
    const last = ibni.review?.history?.at(-1);
    if (!last) return fail("No review pass is recorded.");
    if (!last.headSha) return fail("Can't tell: the last review pass recorded no commit (it was recorded over uncommitted changes, or by an older ibni).");
    if (last.headSha !== pr.headSha) return fail(`The last review looked at ${short(last.headSha)}, but the pull request's head is ${short(pr.headSha)}.`);
    return pass(`The last review looked at the head, ${short(pr.headSha)}.`);
  }),

  rule("review-findings-closed", ["ibni"], ({ ibni }) => {
    const rounds = ibni.review?.rounds ?? 0;
    const last = ibni.review?.history?.at(-1);
    if (!rounds || !last) return fail("No review round ran.");
    if (last.findings === 0) return pass(`${rounds} review round${rounds === 1 ? "" : "s"} ran; the last found nothing.`);
    if (typeof last.open !== "number") return fail("Can't tell: the last review pass didn't record how many findings it left open.");
    if (last.open > 0) return fail(`The last review pass left ${last.open} finding${last.open === 1 ? "" : "s"} open.`);
    const dismissed = last.findings - (last.accepted ?? 0) - last.open;
    if (dismissed > 0) return fail(`${dismissed} finding${dismissed === 1 ? " was" : "s were"} neither fixed nor left open, and no written reason for dismissing ${dismissed === 1 ? "it" : "them"} is recorded.`);
    return pass(`${rounds} review round${rounds === 1 ? "" : "s"} ran; the last pass's ${last.findings} finding${last.findings === 1 ? " was" : "s were"} fixed.`);
  }),

  rule("ci-green", ["pr", "ciCheck", "checkRuns", "statuses", "required"], ({ pr, ciCheck, checkRuns, statuses, required }) => {
    if (!ciCheck) return fail("Can't tell: without a ciCheck in .mexxi.json there is no configured CI to compare the required checks with.");
    const latestRuns = byCheck(checkRuns.filter((run) => run.headSha === pr.headSha)).map((runs) => runs.at(-1));
    const latestStatuses = byContext(statuses).map((history) => history.at(-1));
    if (!latestRuns.length && !latestStatuses.length) return fail(`No CI has reported on ${short(pr.headSha)}.`);
    const problems = [];
    const running = [...latestRuns.filter((run) => run.status !== "completed").map((run) => run.name), ...latestStatuses.filter((status) => status.state === "pending").map((status) => status.context)];
    if (running.length) problems.push(`still running: ${list(running)}`);
    const red = [
      ...latestRuns.filter((run) => run.status === "completed" && !GREEN.has(run.conclusion)).map((run) => `${run.name} (${run.conclusion})`),
      ...latestStatuses.filter((status) => status.state === "failure" || status.state === "error").map((status) => `${status.context} (${status.state})`),
    ];
    if (red.length) problems.push(`not green: ${list(red)}`);
    if (!required.length) problems.push(`the base branch ${pr.baseRef} requires no checks, so CI parity can't be shown; make ${ciCheck} a required check`);
    else {
      if (!required.includes(ciCheck)) problems.push(`${ciCheck}, the check that runs verify, is not a required check on ${pr.baseRef}`);
      const reported = new Set([...latestRuns.map((run) => run.name), ...latestStatuses.map((status) => status.context)]);
      const silent = required.filter((name) => !reported.has(name));
      if (silent.length) problems.push(`required check${silent.length === 1 ? "" : "s"} ${list(silent)} never reported`);
    }
    if (problems.length) return fail(`CI on ${short(pr.headSha)}: ${problems.join("; ")}.`);
    return pass(`All ${latestRuns.length + latestStatuses.length} checks are green on ${short(pr.headSha)}, and the required checks (${list(required)}) include ${ciCheck}.`);
  }),

  rule("no-flaky-checks", ["pr", "checkRuns", "statuses"], ({ pr, checkRuns, statuses }) => {
    const flaky = [
      ...byCheck(checkRuns.filter((run) => run.headSha === pr.headSha))
        .filter((runs) => runs.at(-1).conclusion === "success" && runs.slice(0, -1).some((run) => RED.has(run.conclusion))).map((runs) => runs.at(-1).name),
      ...byContext(statuses).filter((history) => history.at(-1).state === "success" && history.slice(0, -1).some((status) => status.state === "failure" || status.state === "error"))
        .map((history) => history.at(-1).context),
    ];
    if (flaky.length) return fail(`Green only after a rerun on ${short(pr.headSha)}: ${list(flaky)}.`);
    return pass(`No check on ${short(pr.headSha)} needed a rerun to go green.`);
  }),

  rule("no-merge-conflicts", ["pr"], ({ pr }) => {
    if (pr.mergeable === null || pr.mergeable === undefined) return fail("Can't tell: GitHub hasn't worked out yet whether the pull request merges cleanly.");
    if (pr.mergeable === false || pr.mergeableState === "dirty") return fail(`The pull request conflicts with ${pr.baseRef}.`);
    return pass(`The pull request merges into ${pr.baseRef} without conflicts.`);
  }),

  rule("not-draft", ["pr"], ({ pr }) => {
    if (pr.merged) return fail("The pull request is already merged.");
    if (pr.state !== "open") return fail("The pull request is closed.");
    if (pr.draft) return fail("The pull request is a draft.");
    return pass("The pull request is open and not a draft.");
  }),

  rule("no-pending-approval", ["pendingApprovals"], ({ pendingApprovals }) => {
    if (pendingApprovals > 0) return fail(`${pendingApprovals} permission${pendingApprovals === 1 ? " is" : "s are"} still waiting for you.`);
    return pass("No permission is waiting for you.");
  }),

  rule("no-gate-weakening", ["pr", "files", "acceptance"], ({ pr, files, acceptance }) => {
    const flags = scanDiff(files);
    if (isUnknown(flags)) return fail(`Can't tell: ${flags.unknown}`);
    if (!flags.length) return pass("The diff weakens no gate.");
    // Every flag is listed, never cut, so a person accepts only what they were shown and the record says all of it.
    if (acceptance) return pass(`${acceptance.by} accepted these on ${short(pr.headSha)} at ${acceptance.at}: ${flags.join(", ")}.`);
    return fail(`The diff weakens a gate, so it needs your acceptance in the web app: ${flags.join(", ")}.`);
  }),
];

/**
 * The readiness object from gathered facts: `ready` only when every check passed. `headSha` and `canAccept` tell
 * the web app which commit a person would accept the diff's gate-weakening changes for, when that is all that's left
 * of the last check.
 */
export function evaluateReadiness(facts) {
  const checks = RULES.map((entry) => entry.check(facts));
  const headSha = !isUnknown(facts.pr) && facts.pr ? facts.pr.headSha : null;
  const flags = !isUnknown(facts.files) && facts.files ? scanDiff(facts.files) : [];
  const canAccept = Boolean(headSha) && !isUnknown(facts.acceptance) && !facts.acceptance && Array.isArray(flags) && flags.length > 0;
  return { ready: checks.every((check) => check.pass), checks, headSha, canAccept };
}

/** Facts about a pull request on GitHub, each one known or the reason it isn't. */
async function githubFacts({ repository, number, stateDir, fetch }) {
  const all = (reason) => ({ pr: unknown(reason), ciCheck: unknown(reason), checkRuns: unknown(reason), statuses: unknown(reason), required: unknown(reason), files: unknown(reason) });
  if (!repository) return all("the repository is no longer in hares.repositories.");
  let client;
  try {
    const token = readGithubToken(stateDir);
    // The reader goes only where the person pointed hares: a listed repository.
    client = githubClient({ token, slug: await slugForRepository(repository), fetch });
  } catch (error) {
    if (error instanceof GithubUnavailable) return all(error.message);
    throw error;
  }
  let raw;
  try {
    raw = await client.get(`pulls/${number}`);
  } catch (error) {
    return all(`${error.message}.`);
  }
  const pr = {
    state: raw.state, draft: raw.draft === true, merged: raw.merged === true, mergeable: typeof raw.mergeable === "boolean" ? raw.mergeable : null,
    mergeableState: raw.mergeable_state ?? null, headSha: raw.head?.sha, baseRef: raw.base?.ref, changedFiles: raw.changed_files,
  };
  if (!/^[0-9a-f]{40}$/.test(pr.headSha ?? "") || typeof pr.baseRef !== "string") return all("GitHub's answer for the pull request had no head commit or base branch.");
  const settle = async (read) => {
    try {
      return await read();
    } catch (error) {
      return unknown(`${error.message}.`);
    }
  };
  const base = encodeURIComponent(pr.baseRef);
  const [ciCheck, checkRuns, statuses, required, files] = await Promise.all([
    // Read from the base branch, as ibni does, so the pull request can't rename the check it is judged by.
    settle(async () => {
      try {
        const file = await client.get(`contents/.mexxi.json?ref=${base}`);
        const value = JSON.parse(Buffer.from(String(file.content ?? ""), "base64").toString("utf8"));
        return typeof value?.ciCheck === "string" && value.ciCheck.trim() ? value.ciCheck.trim() : null;
      } catch (error) {
        if (error.status === 404) return null;
        if (error instanceof SyntaxError) throw new Error(`the .mexxi.json on ${pr.baseRef} is not valid JSON`);
        throw error;
      }
    }),
    settle(async () => (await client.getAll(`commits/${pr.headSha}/check-runs?filter=all&per_page=100`, "check_runs")).map((item) => ({
      id: item.id, name: String(item.name), appId: item.app?.id ?? null, headSha: item.head_sha, status: item.status, conclusion: item.conclusion ?? null,
    }))),
    settle(async () => (await client.getAll(`commits/${pr.headSha}/statuses?per_page=100`)).map((item) => ({ id: item.id, context: String(item.context), state: item.state }))),
    // Branch protection and rulesets both can require checks; either one unread leaves the list unknown.
    settle(async () => {
      const branch = await client.get(`branches/${base}`);
      const rules = await client.getAll(`rules/branches/${base}?per_page=100`);
      const protection = branch.protection?.required_status_checks ?? {};
      return [...new Set([
        ...(protection.contexts ?? []), ...(protection.checks ?? []).map((check) => check.context),
        ...rules.filter((entry) => entry.type === "required_status_checks").flatMap((entry) => (entry.parameters?.required_status_checks ?? []).map((check) => check.context)),
      ].filter((name) => typeof name === "string"))];
    }),
    settle(async () => {
      const items = await client.getAll(`pulls/${number}/files?per_page=100`);
      if (typeof pr.changedFiles === "number" && items.length < pr.changedFiles) throw new Error(`GitHub listed ${items.length} of the pull request's ${pr.changedFiles} files`);
      return items.map((item) => ({ filename: item.filename, previousFilename: item.previous_filename ?? null, status: item.status, changes: item.changes, patch: typeof item.patch === "string" ? item.patch : null }));
    }),
  ]);
  return { pr, ciCheck, checkRuns, statuses, required, files };
}

/** The session behind a pull request as the rules read it: none, or its state, ibni's report and its waiting permissions. */
function sessionFactsFor({ store, repo, number, sessionId }) {
  const id = sessionId ?? store.sessionForPr(repo, number) ?? null;
  const facts = id ? store.sessionFacts(id) : null;
  return { id, facts };
}

/** Every fact the rules read, for one pull request. */
export async function gatherFacts({ repo, number, sessionId = null, repository, store, stateDir, fetch }) {
  const github = await githubFacts({ repository, number, stateDir, fetch });
  const headSha = isUnknown(github.pr) ? null : github.pr.headSha;
  let acceptance = unknown("the pull request's head commit is unknown.");
  if (headSha) {
    const row = store.gateAcceptance(repo, number, headSha);
    acceptance = row ? { by: row.acceptedBy, at: row.acceptedAt } : null;
  }
  const { facts: session } = sessionFactsFor({ store, repo, number, sessionId });
  return {
    session: session ? { state: session.state } : null,
    ibni: session?.snapshot ? session.snapshot : unknown(session ? "ibni hasn't reported on this session's workspace." : "no session is linked to this pull request."),
    pendingApprovals: session?.pendingPermissions ?? 0,
    ...github,
    acceptance,
  };
}

/**
 * Readiness per pull request ({repo, number, sessionId?}: repo is the configured repository name), with a short cache so
 * polling clients don't spend the token's rate limit. `fetch` and `now` are injected by tests.
 */
export function createReadinessService({ store, settings, stateDir, fetch = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();
  const targetOf = ({ repo, number }) => {
    if (typeof repo !== "string" || !Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, "Readiness needs a repository and a pull request number.");
    return `${repo}#${number}`;
  };
  async function compute({ repo, number, sessionId }) {
    const repository = settings.hares.repositories.find((candidate) => candidate.name === repo);
    const facts = await gatherFacts({ repo, number, sessionId, repository, store, stateDir, fetch });
    return { ...evaluateReadiness(facts), checkedAt: new Date(now()).toISOString() };
  }
  return {
    /** The pull request's readiness; `fresh` skips the cache. */
    async forPr({ repo, number, sessionId = null }, { fresh = false } = {}) {
      const target = targetOf({ repo, number });
      const session = sessionFactsFor({ store, repo, number, sessionId });
      // What the session does changes the answer, so it is part of the cache key.
      const key = `${session.id}|${session.facts?.state}|${session.facts?.pendingPermissions}|${session.facts?.snapshot ? JSON.stringify(session.facts.snapshot.review ?? null) : ""}`;
      const hit = cache.get(target);
      if (!fresh && hit && hit.key === key && now() - hit.at < CACHE_MS) return hit.value;
      const value = await compute({ repo, number, sessionId: session.id });
      cache.set(target, { key, at: now(), value });
      return value;
    },

    /**
     * A person accepts the diff's gate-weakening changes for the head commit they saw, keyed by repo#number and that
     * commit. Only the web app calls this, with the signed-in identity; a new push needs a new acceptance.
     */
    async accept({ repo, number, sessionId = null }, headSha, identity) {
      const readiness = await this.forPr({ repo, number, sessionId }, { fresh: true });
      if (readiness.headSha !== headSha) throw new HttpError(409, "The pull request's head has moved since you looked. Check its readiness again before you accept.");
      if (!readiness.canAccept) throw new HttpError(409, "There is no gate-weakening change to accept on this commit.");
      const detail = readiness.checks.find((check) => check.name === "no-gate-weakening").detail;
      store.acceptGateChange({ repo, number, headSha, acceptedBy: identity, detail });
      cache.delete(targetOf({ repo, number }));
      return this.forPr({ repo, number, sessionId }, { fresh: true });
    },
  };
}
