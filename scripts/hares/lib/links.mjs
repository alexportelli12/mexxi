// Links between a session and its branch, issue and pull request, derived from
// evidence only (plan §5): the branch git reports in the session's folder, the
// issue named in the session's first prompt (or closed by its pull request),
// and the pull request whose head ref is exactly that branch. Every link
// carries its evidence; anything without evidence is no link. There is no
// fuzzy matching by title.
//
// GitHub lookups are not made here: the caller passes findPullsForBranch
// (github-board supplies it), so this module stays testable and GET-free.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const LINK_CACHE_MS = 60_000;

/**
 * The issue a first prompt names: "/wettaq #12", any slash command whose first
 * argument is "#12", or a link to an issue of the session's own repository.
 * A bare "#12" in prose is not evidence (it may be anything).
 */
export function issueFromPrompt(text, slug = null) {
  const prompt = String(text ?? "");
  const command = /^\s*(\/[A-Za-z0-9._:-]+)\s+#(\d+)\b/.exec(prompt);
  if (command) return { number: Number(command[2]), evidence: { kind: "first-prompt", text: `${command[1]} #${command[2]}` } };
  if (slug) {
    const link = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\b/.exec(prompt);
    if (link && link[1].toLowerCase() === slug.toLowerCase()) return { number: Number(link[2]), evidence: { kind: "first-prompt", text: link[0] } };
  }
  return null;
}

/** Issues a pull request says it closes: GitHub's closingIssuesReferences, else "Closes #N" (fixes, resolves) in its body. */
export function issuesClosedByPull(pull) {
  const references = Array.isArray(pull?.closingIssuesReferences) ? pull.closingIssuesReferences.map((entry) => Number(entry?.number)).filter(Number.isInteger) : [];
  if (references.length) return references;
  const found = [];
  for (const match of String(pull?.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    const number = Number(match[1]);
    if (!found.includes(number)) found.push(number);
  }
  return found;
}

/** The pull requests whose head ref is exactly this branch; never one whose head merely looks similar. */
export function pullsForBranch(pulls, branch) {
  if (typeof branch !== "string" || !branch) return [];
  return (pulls ?? []).filter((pull) => pull?.headRefName === branch);
}

/** The sessions that made a pull request: same repository, and on its head branch. */
export function sessionsForPull(pull, sessions) {
  return (sessions ?? []).filter((session) => session.repo === pull.repo && session.links?.branch?.name === pull.headRefName && Boolean(pull.headRefName));
}

/** The branch git has checked out in a folder, or null (detached, not a repository, gone). */
export async function currentBranch(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Derives a session's links. findPullsForBranch({repo, branch}) resolves the
 * repository's pull requests with that head ref (any order; it may return
 * near matches, which are dropped); slugFor(repo) gives "owner/name" when known.
 * Results are cached for a minute per session folder.
 */
export function createLinkResolver({ findPullsForBranch = async () => [], slugFor = async () => null, branchOf = currentBranch, now = () => Date.now(), cacheMs = LINK_CACHE_MS } = {}) {
  const cache = new Map();

  async function derive({ repo, cwd, firstPrompt }) {
    const branchName = cwd ? await branchOf(cwd) : null;
    const branch = branchName ? { name: branchName, evidence: { kind: "git", text: "git branch --show-current" } } : null;
    let slug = null;
    try { slug = repo ? await slugFor(repo) : null; } catch { slug = null; }
    let issue = issueFromPrompt(firstPrompt, slug);
    let pull = null;
    if (repo && branchName) {
      let pulls = [];
      try { pulls = await findPullsForBranch({ repo, branch: branchName }); } catch { pulls = []; }
      const [match] = pullsForBranch(pulls, branchName);
      if (match) {
        pull = { number: match.number, url: match.url ?? null, title: match.title ?? null, state: match.state ?? null, evidence: { kind: "head-ref", text: branchName } };
        if (!issue) {
          const [closed] = issuesClosedByPull(match);
          if (closed) issue = { number: closed, evidence: { kind: "pull-request", text: `#${match.number} closes #${closed}` } };
        }
      }
    }
    if (issue && slug) issue.url = `https://github.com/${slug}/issues/${issue.number}`;
    return { branch, issue, pull };
  }

  return {
    async resolve({ repo = "", cwd = null, firstPrompt = null }) {
      const key = JSON.stringify([repo, cwd, firstPrompt]);
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheMs) return hit.links;
      const links = await derive({ repo, cwd, firstPrompt });
      cache.set(key, { at: now(), links });
      return links;
    },
    forget: () => cache.clear(),
  };
}
