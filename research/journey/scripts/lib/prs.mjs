// Pull requests that agent sessions opened, from the forge: counts, review
// rounds, commits pushed after the first review and time to merge. Titles and
// bodies are never kept.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { percentile } from "./aggregate.mjs";

const run = promisify(execFile);

// Branch prefixes the workflow's sessions push: ibni and its predecessor use
// agent/, early OpenCode runs used opencode/, and claude/ and codex/ are the
// hosts' own defaults.
export const AGENT_BRANCH = /^(?:agent|opencode|claude|codex)\//;

const QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        headRefName createdAt mergedAt
        reviews(first: 50) { nodes { submittedAt } }
        commits(first: 100) { nodes { commit { committedDate } } }
      }
    }
  }
}`;

// Every pull request in a repository, paged through GraphQL: gh pr list
// cannot ask for commits on hundreds of pull requests at once.
export async function listPullRequests(slug) {
  const [owner, name] = slug.split("/");
  try {
    const { stdout } = await run("gh", ["api", "graphql", "--paginate", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`,
      "--jq", ".data.repository.pullRequests.nodes[]"], { maxBuffer: 256 * 1024 * 1024 });
    return stdout.split("\n").filter(Boolean).map((line) => {
      const pr = JSON.parse(line);
      return {
        headRefName: pr.headRefName, createdAt: pr.createdAt, mergedAt: pr.mergedAt,
        reviews: pr.reviews.nodes,
        commits: pr.commits.nodes.map((node) => ({ committedDate: node.commit.committedDate })),
      };
    });
  } catch {
    return null;
  }
}

// What one pull request contributes. Reviews count every submitted review,
// automated or human, since the forge does not say which is which.
export function summarizePullRequest(pr) {
  const reviews = (pr.reviews ?? []).filter((review) => review.submittedAt).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const firstReview = reviews[0]?.submittedAt ?? null;
  const commits = pr.commits ?? [];
  const afterReview = firstReview ? commits.filter((commit) => (commit.committedDate ?? "") > firstReview).length : 0;
  const hours = pr.mergedAt ? (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3_600_000 : null;
  return { createdAt: pr.createdAt, merged: Boolean(pr.mergedAt), hoursToMerge: hours, reviews: reviews.length, commits: commits.length, commitsAfterFirstReview: afterReview };
}

export function summarizeGroup(prs) {
  const merged = prs.filter((pr) => pr.merged);
  const median = (key, list = prs) => percentile(list.map((pr) => pr[key]), 50);
  return {
    pullRequests: prs.length,
    merged: merged.length,
    medianHoursToMerge: median("hoursToMerge", merged) === null ? null : Math.round(median("hoursToMerge", merged) * 10) / 10,
    medianCommits: median("commits"),
    medianReviews: median("reviews"),
    withCommitsAfterFirstReview: prs.filter((pr) => pr.commitsAfterFirstReview > 0).length,
  };
}
