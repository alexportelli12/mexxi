// The web app's writes to GitHub (decision 0027, amended): rerun failed jobs,
// submit a review, reply to a review thread, comment, merge. Each is one
// "gh api" call with a fixed argument list, validated parameters and the JSON
// body on stdin, so nothing a person or a pull request typed ever reaches a
// shell. It uses the person's own gh login, never the read-only token, and the
// environment's GH_TOKEN/GITHUB_TOKEN are dropped so gh can't pick up another one.
//
// Only the web app imports this file. mcp.mjs must never import it: an MCP
// client can't merge, review, comment or rerun anything (a test reads mcp.mjs
// to hold that line).
import { execFile } from "node:child_process";
import { HttpError } from "./errors.mjs";
import { GithubUnavailable, slugForRepository } from "./github.mjs";

const TIMEOUT_MS = 30_000;
const BODY_MAX = 65_536;
const REVIEW_EVENTS = new Set(["COMMENT", "REQUEST_CHANGES", "APPROVE"]);
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const SHA = /^[0-9a-f]{40}$/;

function positiveInteger(value, what) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, `${what} must be a positive whole number.`);
  return value;
}

function text(value, what, { required }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `${what} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `${what} must be text.`);
  if (value.length > BODY_MAX) throw new HttpError(400, `${what} is longer than ${BODY_MAX} characters.`);
  if (required && !value.trim()) throw new HttpError(400, `${what} is required.`);
  return value;
}

/** Runs gh with a fixed argv; the body goes in on stdin. Resolves {stdout}; rejects with {stderr, code}. */
export function runGh(argv, { input, timeoutMs = TIMEOUT_MS } = {}) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return new Promise((resolve, reject) => {
    const child = execFile("gh", argv, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(error.message), { stderr: String(stderr ?? ""), code: error.code }));
      else resolve({ stdout: String(stdout) });
    });
    child.stdin.end(input ?? "");
  });
}

/** What a failed gh call means to the person: GitHub's status when gh printed it, else a plain "couldn't reach it". */
function failure(error, what) {
  const status = Number(/\(HTTP (\d{3})\)/.exec(String(error.stderr ?? ""))?.[1] ?? 0);
  const detail = String(error.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (error.code === "ENOENT") return new HttpError(503, "The gh command isn't installed on this machine, so hares can't write to GitHub.");
  if (status === 409 || status === 422 || status === 405 || status === 404 || status === 403 || status === 401) {
    const reason = status === 409 && what === "merge" ? "The pull request's head moved since you looked, so nothing was done. Check it again." : `GitHub refused to ${what} (${status}): ${detail}`;
    return new HttpError(status === 401 ? 502 : status, reason);
  }
  return new HttpError(502, `GitHub didn't ${what}: ${detail || "gh failed"}`);
}

/**
 * @param {{ settings: { hares: { repositories: object[] } }, exec?: typeof runGh, audit?: (entry: object) => void, resolveSlug?: (repository: object) => Promise<string> }} options
 *   exec, audit and resolveSlug are injected by tests; hares uses gh and the config.
 */
export function createGithubWriter({ settings, exec = runGh, audit = () => {}, resolveSlug = slugForRepository }) {
  async function slugOf(repoName) {
    const repository = settings.hares.repositories.find((candidate) => candidate.name === repoName);
    if (!repository) throw new HttpError(404, "No such repository in hares.repositories.");
    try {
      return await resolveSlug(repository);
    } catch (error) {
      if (error instanceof GithubUnavailable) throw new HttpError(409, error.message);
      throw error;
    }
  }

  /** One validated write: gh api -X <method> <path> --input - . */
  async function call({ action, repo, method, pathAfterSlug, body, what, actor }) {
    const slug = await slugOf(repo);
    const argv = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", `repos/${slug}/${pathAfterSlug}`, "--input", "-"];
    try {
      const { stdout } = await exec(argv, { input: JSON.stringify(body) });
      audit({ action, target: `${repo}:${pathAfterSlug}`, actor, outcome: "ok" });
      try {
        return stdout.trim() ? JSON.parse(stdout) : {};
      } catch {
        return {};
      }
    } catch (error) {
      const refused = failure(error, what);
      audit({ action, target: `${repo}:${pathAfterSlug}`, actor, outcome: refused.status >= 500 ? "error" : "rejected" });
      throw refused;
    }
  }

  return {
    /** Reruns only the jobs that failed in a workflow run. */
    async rerunFailedJobs(repo, runId, { actor } = {}) {
      positiveInteger(runId, "The workflow run id");
      await call({ action: "github.rerun-failed-jobs", repo, method: "POST", pathAfterSlug: `actions/runs/${runId}/rerun-failed-jobs`, body: {}, what: "rerun the failed jobs", actor });
      return { ok: true };
    },

    /** Submits a review. GitHub needs words for a comment or a change request; an approval may go without. */
    async submitReview(repo, number, { event, body } = {}, { actor } = {}) {
      positiveInteger(number, "The pull request number");
      if (!REVIEW_EVENTS.has(event)) throw new HttpError(400, "The review event must be COMMENT, REQUEST_CHANGES or APPROVE.");
      const words = text(body, "The review text", { required: event !== "APPROVE" });
      const payload = { event, ...(words ? { body: words } : {}) };
      const review = await call({ action: "github.submit-review", repo, method: "POST", pathAfterSlug: `pulls/${number}/reviews`, body: payload, what: "submit the review", actor });
      return { id: review.id ?? null, state: review.state ?? null };
    },

    /** A reply inside an existing review thread (the thread's first comment id). */
    async replyToThread(repo, number, commentId, body, { actor } = {}) {
      positiveInteger(number, "The pull request number");
      positiveInteger(commentId, "The comment id");
      const words = text(body, "The reply", { required: true });
      const reply = await call({ action: "github.reply-to-thread", repo, method: "POST", pathAfterSlug: `pulls/${number}/comments/${commentId}/replies`, body: { body: words }, what: "post the reply", actor });
      return { id: reply.id ?? null };
    },

    /** A plain comment on the pull request's conversation. */
    async comment(repo, number, body, { actor } = {}) {
      positiveInteger(number, "The pull request number");
      const words = text(body, "The comment", { required: true });
      const created = await call({ action: "github.comment", repo, method: "POST", pathAfterSlug: `issues/${number}/comments`, body: { body: words }, what: "post the comment", actor });
      return { id: created.id ?? null };
    },

    /**
     * Merges, but only the commit the person confirmed: GitHub is handed the head sha and answers 409 if the head has
     * moved, which comes back as a 409 here and merges nothing.
     */
    async merge(repo, number, { headSha, method } = {}, { actor } = {}) {
      positiveInteger(number, "The pull request number");
      if (!SHA.test(String(headSha ?? ""))) throw new HttpError(400, "Merging needs the head commit you confirmed (40 hex characters).");
      if (!MERGE_METHODS.has(method)) throw new HttpError(400, "The merge method must be merge, squash or rebase.");
      const merged = await call({ action: "github.merge", repo, method: "PUT", pathAfterSlug: `pulls/${number}/merge`, body: { sha: headSha, merge_method: method }, what: "merge", actor });
      return { merged: merged.merged === true, sha: merged.sha ?? null };
    },
  };
}
