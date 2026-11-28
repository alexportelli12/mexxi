// The cross-repository board (read-only): per configured repository, open pull
// requests grouped for the person, open issues, recent Actions runs with "main
// red", and one pull request's detail. Every call is a GET with the read-only
// token (github.mjs); writes are in github-write.mjs and never here. Answers are
// cached for about 30 s so a phone polling the board doesn't spend the rate limit.
import { HttpError } from "./errors.mjs";
import { GithubUnavailable, githubClient, readGithubToken, slugForRepository } from "./github.mjs";
import { sanitizeHtml } from "./html-sanitize.mjs";

const CACHE_MS = 30_000;
const LIST_PAGE = 50;
const RUNS_PER_REPO = 10;
const HTML = "application/vnd.github.html+json";
const BOT_AUTHORS = /^(?:dependabot(?:\[bot\])?|renovate(?:\[bot\])?|app\/(?:dependabot|renovate))$/i;
// Verdicts a rerun on the same commit can turn green (cancelled is not one: a newer push cancels). "error" is a commit status's.
const RED = new Set(["failure", "error", "timed_out", "startup_failure", "action_required"]);
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d{1,7})\b/gi;

const person = (user) => (user ? { login: user.login, url: user.html_url ?? null } : null);
const pagedHint = (items) => items.length >= LIST_PAGE;

/** Issue numbers a pull request body closes ("Closes #12", "fixes owner/repo#3"), only in the pull request's own repository. */
export function closingIssues(body, slug) {
  const numbers = new Set();
  for (const match of String(body ?? "").matchAll(CLOSES)) {
    if (!match[1] || match[1].toLowerCase() === slug.toLowerCase()) numbers.add(Number(match[2]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Latest check run per name (and app) with its verdict: "failing" if any ended red, "pending" if any is still running, else "passing". */
export function summarizeChecks(runs, statuses = []) {
  const newest = new Map();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) newest.set(`${run.app?.id ?? ""}:${run.name}`, run);
  const checks = [...newest.values()].map((run) => ({
    name: String(run.name), status: run.status, conclusion: run.conclusion ?? null, url: run.html_url ?? null, runId: run.id,
  }));
  const latestStatus = new Map();
  for (const status of [...statuses].sort((a, b) => a.id - b.id)) latestStatus.set(status.context, status);
  const contexts = [...latestStatus.values()].map((status) => ({ name: String(status.context), status: status.state === "pending" ? "in_progress" : "completed", conclusion: status.state === "pending" ? null : status.state, url: status.target_url ?? null, runId: null }));
  const allChecks = [...checks, ...contexts];
  const bad = allChecks.filter((check) => check.status === "completed" && RED.has(check.conclusion));
  const pending = allChecks.filter((check) => check.status !== "completed");
  const state = bad.length ? "failing" : pending.length ? "pending" : allChecks.length ? "passing" : "none";
  return { state, checks: allChecks, failing: bad.map((check) => check.name), pending: pending.map((check) => check.name) };
}

/**
 * @param {{ settings: object, stateDir: string, fetch?: typeof fetch, now?: () => number,
 *   readiness?: { forPr(target: { repo: string, number: number, sessionId?: string|null }): Promise<{ ready: boolean }> },
 *   linkedSession?: (target: { repo: string, number: number, branch: string }) => string|null|Promise<string|null>,
 *   readToken?: (stateDir: string) => string }} options
 *   fetch, now, readiness, linkedSession and readToken are injected by tests. Without readiness no pull request a
 *   session made is "ready". With linkedSession, a pull request no session made is ready on GitHub's facts alone:
 *   not a draft, mergeable and every check green; one a session made keeps the readiness gate.
 */
export function createGithubBoard({ settings, stateDir, fetch = globalThis.fetch, now = () => Date.now(), readiness = null, linkedSession = null, readToken = readGithubToken }) {
  const cache = new Map();
  const repositories = () => settings.hares.repositories;
  const repositoryNamed = (name) => {
    const repository = repositories().find((candidate) => candidate.name === name);
    if (!repository) throw new HttpError(404, "No such repository in hares.repositories.");
    return repository;
  };

  async function cached(key, { fresh = false } = {}, load) {
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    return value;
  }

  async function clientFor(repository) {
    const token = readToken(stateDir);
    const slug = await slugForRepository(repository);
    return githubClient({ token, slug, fetch });
  }

  /** A GitHub failure becomes a reason on that repository's card, not a failed board. */
  async function guarded(repository, read) {
    try {
      return { ...(await read()), error: null };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return { error: error instanceof GithubUnavailable ? error.message : `${error.message}.` };
    }
  }

  async function checksFor(client, sha) {
    const [runs, statuses] = await Promise.all([
      client.getAll(`commits/${sha}/check-runs?filter=latest&per_page=100`, "check_runs"),
      client.getAll(`commits/${sha}/statuses?per_page=100`),
    ]);
    return summarizeChecks(runs, statuses);
  }

  async function groupPulls(repository, client) {
    const raw = await client.get(`pulls?state=open&sort=updated&direction=desc&per_page=${LIST_PAGE}`);
    const items = await Promise.all(raw.map(async (pull) => {
      const [checks, reviews, detail] = await Promise.all([
        checksFor(client, pull.head.sha).catch(() => ({ state: "unknown", checks: [], failing: [], pending: [] })),
        client.get(`pulls/${pull.number}/reviews?per_page=100`).catch(() => null),
        // The list leaves out mergeable and the size of the change; one GET per pull request has them.
        client.get(`pulls/${pull.number}`).catch(() => null),
      ]);
      const bump = BOT_AUTHORS.test(pull.user?.login ?? "");
      const needsReview = !pull.draft && ((pull.requested_reviewers ?? []).length > 0 || (pull.requested_teams ?? []).length > 0 || (reviews !== null && reviews.length === 0));
      return {
        repo: repository.name, number: pull.number, title: pull.title, url: pull.html_url, draft: pull.draft === true, bump,
        author: person(pull.user), headSha: pull.head.sha, branch: pull.head.ref, baseRef: pull.base.ref, updatedAt: pull.updated_at,
        labels: (pull.labels ?? []).map((label) => label.name), checks: { state: checks.state, failing: checks.failing, pending: checks.pending },
        checkList: checks.checks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, url: check.url })),
        ciRunId: failedWorkflowRun(checks.checks),
        createdAt: pull.created_at ?? null, mergeable: typeof detail?.mergeable === "boolean" ? detail.mergeable : null,
        additions: detail?.additions ?? 0, deletions: detail?.deletions ?? 0, commits: detail?.commits ?? 0, changedFiles: detail?.changed_files ?? 0,
        needsReview, ready: false, sessionId: null, groups: [],
      };
    }));
    if (linkedSession) {
      await Promise.all(items.map(async (item) => {
        try { item.sessionId = (await linkedSession({ repo: repository.name, number: item.number, branch: item.branch })) ?? null; } catch { item.sessionId = null; }
      }));
    }
    // A pull request no session made has no run, review or approval to wait for: GitHub's own facts decide.
    const ownFacts = (item) => linkedSession !== null && item.sessionId === null;
    for (const item of items.filter(ownFacts)) item.ready = !item.draft && item.mergeable === true && item.checks.state === "passing";
    // Readiness is the expensive read (seven calls), so only for a pull request that could be ready.
    if (readiness) {
      await Promise.all(items.filter((item) => !ownFacts(item) && !item.draft && item.checks.state === "passing").map(async (item) => {
        try {
          item.ready = (await readiness.forPr({ repo: repository.name, number: item.number, sessionId: item.sessionId })).ready === true;
        } catch {
          item.ready = false; // can't tell is never "ready"
        }
      }));
    }
    // Every group a pull request belongs to (a failing bump is in both), for the web app's chips.
    for (const item of items) {
      if (item.needsReview && !item.bump) item.groups.push("review");
      if (item.ready) item.groups.push("ready");
      if (item.checks.state === "failing") item.groups.push("failing");
      if (item.bump) item.groups.push("bumps");
    }
    const groups = { toReview: [], ready: [], failing: [], bumps: [], other: [] };
    for (const item of items) {
      // One group each, most urgent first. A bump that fails is "failing": bumps are otherwise judged like any pull request.
      if (item.checks.state === "failing") groups.failing.push(item);
      else if (item.ready) groups.ready.push(item);
      else if (item.bump) groups.bumps.push(item);
      else if (item.needsReview) groups.toReview.push(item);
      else groups.other.push(item);
    }
    return { pulls: groups, pullsTruncated: pagedHint(raw) };
  }

  async function readIssues(repository, client) {
    const raw = await client.get(`issues?state=open&sort=updated&direction=desc&per_page=${LIST_PAGE}`);
    const issues = raw.filter((issue) => !issue.pull_request).map((issue) => ({
      repo: repository.name, number: issue.number, title: issue.title, url: issue.html_url, author: person(issue.user),
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)), comments: issue.comments ?? 0, updatedAt: issue.updated_at,
    }));
    return { issues, issuesTruncated: pagedHint(raw) };
  }

  async function readActions(repository, client) {
    const info = await client.get("");
    const defaultBranch = info.default_branch;
    const body = await client.get(`actions/runs?per_page=${RUNS_PER_REPO}`);
    const runs = (body.workflow_runs ?? []).map((run) => ({
      id: run.id, workflowId: run.workflow_id, name: run.name, branch: run.head_branch, sha: run.head_sha, event: run.event,
      status: run.status, conclusion: run.conclusion ?? null, url: run.html_url, createdAt: run.created_at,
      startedAt: run.run_started_at ?? run.created_at ?? null, updatedAt: run.updated_at ?? null,
    }));
    // The newest finished run of each workflow on the default branch: red if any workflow's latest verdict is red.
    const latest = new Map();
    for (const run of runs.filter((entry) => entry.branch === defaultBranch && entry.status === "completed").sort((a, b) => a.id - b.id)) latest.set(run.workflowId, run);
    const redRuns = [...latest.values()].filter((run) => RED.has(run.conclusion));
    return { defaultBranch, runs, main: { red: redRuns.length > 0, failing: redRuns.map((run) => ({ name: run.name, runId: run.id, url: run.url, sha: run.sha })) } };
  }

  async function repoBoard(repository, options) {
    return cached(`board:${repository.name}`, options, () => guarded(repository, async () => {
      const client = await clientFor(repository);
      const settle = async (read) => {
        try {
          return await read();
        } catch (error) {
          return { error: `${error.message}.` };
        }
      };
      const [pulls, issues, actions] = await Promise.all([settle(() => groupPulls(repository, client)), settle(() => readIssues(repository, client)), settle(() => readActions(repository, client))]);
      return { name: repository.name, slug: client.slug, pulls, issues, actions };
    }));
  }

  return {
    /** Every configured repository's board; one repository's failure shows on its own card. */
    async board(options = {}) {
      const repos = await Promise.all(repositories().map(async (repository) => ({ name: repository.name, ...(await repoBoard(repository, options)) })));
      return { repos, mainRed: repos.filter((repo) => repo.actions?.main?.red).map((repo) => repo.name), generatedAt: new Date(now()).toISOString() };
    },

    /** One repository's open pull requests, grouped. */
    async listPrs(repo, options = {}) {
      const board = await repoBoard(repositoryNamed(repo), options);
      if (board.error) throw new HttpError(502, board.error);
      if (board.pulls.error) throw new HttpError(502, board.pulls.error);
      return { repo, ...board.pulls };
    },

    async listIssues(repo, options = {}) {
      const board = await repoBoard(repositoryNamed(repo), options);
      if (board.error) throw new HttpError(502, board.error);
      if (board.issues.error) throw new HttpError(502, board.issues.error);
      return { repo, ...board.issues };
    },

    /** Recent runs and whether the default branch is red. */
    async ci(repo, options = {}) {
      const board = await repoBoard(repositoryNamed(repo), options);
      if (board.error) throw new HttpError(502, board.error);
      if (board.actions.error) throw new HttpError(502, board.actions.error);
      return { repo, slug: board.slug, ...board.actions };
    },

    /**
     * A pull request in full: sanitized description and comments, review threads, reviews, checks, readiness, the issues
     * it closes and a link to its files on github.com (hares has no diff viewer).
     */
    async prDetail(repo, number, { sessionId = null, fresh = false } = {}) {
      if (!Number.isSafeInteger(number) || number <= 0) throw new HttpError(400, "The pull request number must be a positive whole number.");
      const repository = repositoryNamed(repo);
      return cached(`pr:${repo}#${number}:${sessionId ?? ""}`, { fresh }, async () => {
        let client;
        try {
          client = await clientFor(repository);
        } catch (error) {
          if (error instanceof GithubUnavailable) throw new HttpError(503, error.message);
          throw error;
        }
        const read = async (promise) => {
          try {
            return await promise;
          } catch (error) {
            if (error.status === 404) throw new HttpError(404, "No such pull request.");
            throw new HttpError(502, `${error.message}.`);
          }
        };
        const pull = await read(client.get(`pulls/${number}`, { accept: HTML }));
        const [issueComments, reviewComments, reviews, checks] = await Promise.all([
          read(client.getAll(`issues/${number}/comments?per_page=100`, null, { accept: HTML })),
          read(client.getAll(`pulls/${number}/comments?per_page=100`, null, { accept: HTML })),
          read(client.getAll(`pulls/${number}/reviews?per_page=100`, null, { accept: HTML })),
          checksFor(client, pull.head.sha).catch((error) => ({ state: "unknown", checks: [], failing: [], pending: [], error: `${error.message}.` })),
        ]);
        let ready = null;
        if (readiness) {
          try {
            ready = await readiness.forPr({ repo, number, sessionId });
          } catch (error) {
            ready = { ready: false, checks: [], error: error.message };
          }
        }
        const threads = groupThreads(reviewComments);
        const closes = closingIssues(pull.body, client.slug);
        return {
          repo, number, slug: client.slug, title: pull.title, url: pull.html_url, state: pull.state, merged: pull.merged === true, draft: pull.draft === true,
          author: person(pull.user), branch: pull.head.ref, baseRef: pull.base.ref, headSha: pull.head.sha, mergeable: pull.mergeable ?? null,
          bodyHtml: sanitizeHtml(pull.body_html), bodyIsEmpty: !String(pull.body ?? pull.body_html ?? "").trim(),
          comments: issueComments.map((comment) => ({ id: comment.id, author: person(comment.user), createdAt: comment.created_at, url: comment.html_url, bodyHtml: sanitizeHtml(comment.body_html) })),
          threads,
          reviews: reviews.map((review) => ({ id: review.id, author: person(review.user), state: review.state, submittedAt: review.submitted_at ?? null, url: review.html_url, bodyHtml: sanitizeHtml(review.body_html) })),
          checks, readiness: ready,
          closes: closes.map((issue) => ({ number: issue, url: `https://github.com/${client.slug}/issues/${issue}` })),
          filesUrl: `https://github.com/${client.slug}/pull/${number}/files`,
        };
      });
    },

    /**
     * The pull request whose head branch is exactly this branch (an open one first), or null. Used to link a session to
     * the pull request it made; a branch that merely looks similar never matches.
     */
    async prForBranch(repo, branch, options = {}) {
      if (typeof branch !== "string" || !branch || branch.length > 250 || /[\s\x00-\x1f]/.test(branch)) return null;
      const repository = repositoryNamed(repo);
      return cached(`branch:${repo}:${branch}`, options, async () => {
        const client = await clientFor(repository);
        const owner = client.slug.split("/")[0];
        const found = await client.get(`pulls?state=all&head=${encodeURIComponent(owner + ":" + branch)}&sort=updated&direction=desc&per_page=10`);
        const matches = found.filter((pull) => pull.head?.ref === branch && pull.head?.repo?.full_name?.toLowerCase() === client.slug.toLowerCase());
        const pull = matches.find((entry) => entry.state === "open") ?? matches[0];
        if (!pull) return null;
        return { repo, number: pull.number, url: pull.html_url, title: pull.title, state: pull.state, merged: Boolean(pull.merged_at), draft: pull.draft === true, headSha: pull.head.sha };
      });
    },
  };
}

/** The Actions run behind a failed check (its URL is …/actions/runs/<id>/job/<job>), for "rerun failed jobs"; null when none. */
export function failedWorkflowRun(checks) {
  for (const check of checks) {
    if (check.status !== "completed" || !RED.has(check.conclusion)) continue;
    const id = /\/actions\/runs\/(\d+)/.exec(String(check.url ?? ""))?.[1];
    if (id) return Number(id);
  }
  return null;
}

/** Review comments as threads: a root (no in_reply_to_id) and its replies in time order. */
export function groupThreads(comments) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootOf = (comment) => {
    let current = comment;
    for (let hops = 0; current.in_reply_to_id && byId.has(current.in_reply_to_id) && hops < 100; hops += 1) current = byId.get(current.in_reply_to_id);
    return current;
  };
  const threads = new Map();
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const root = rootOf(comment);
    if (!threads.has(root.id)) threads.set(root.id, { id: root.id, path: root.path ?? null, line: root.line ?? root.original_line ?? null, outdated: root.position === null, comments: [] });
    threads.get(root.id).comments.push({ id: comment.id, author: person(comment.user), createdAt: comment.created_at, url: comment.html_url, bodyHtml: sanitizeHtml(comment.body_html) });
  }
  return [...threads.values()];
}
