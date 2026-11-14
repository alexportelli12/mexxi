// The code forge a repository lives on: where its pull requests (GitLab: merge
// requests), CI state and media URLs come from. GitHub goes through
// `gh`, GitLab through `glab api`. Detection never guesses: a remote on a host
// that is neither known nor mapped in forge.hosts has no forge, and every
// caller that needs one fails or skips with the reason.
import { OPT_IN_FILE } from "./baseline.mjs";
import { WorkspaceError } from "./errors.mjs";
import { cleanOutput, git, run } from "./git.mjs";

export const FORGES = ["github", "gitlab"];
const KNOWN_HOSTS = { "github.com": "github", "gitlab.com": "gitlab" };
// The forges' own SSH endpoints for networks that block port 22, by web host.
const SSH_ENDPOINTS = { "ssh.github.com": "github.com", "altssh.gitlab.com": "gitlab.com" };
const LABELS = { github: "GitHub", gitlab: "GitLab" };
const CHANGE_STATES = new Set(["OPEN", "MERGED", "CLOSED"]);
// gh's check buckets; GitLab job statuses are mapped onto them.
const BUCKETS = new Set(["pass", "fail", "pending", "skipping", "cancel"]);
const NO_CHECKS = /no checks reported/i;

// A remote URL as host and repository path, or null for a local path or a form
// that names no host. GitLab paths may hold nested groups (group/sub/repo). An
// http(s) host keeps its port, which the web and API URLs need; an SSH port is
// transport only, and ssh marks a host that may be an alias in ssh config.
export function parseRemoteUrl(url) {
  const web = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\/(.+)$/i);
  const match = web
    ?? url.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i)
    ?? url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
  // A host that starts with "-" would reach ssh as an option; git refuses
  // such hosts too.
  if (!match || match[1].startsWith("-")) return null;
  const segments = match[2].replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (segments.length < 2 || segments.some((segment) => !segment)) return null;
  return { host: match[1].toLowerCase(), namespace: segments.slice(0, -1).join("/"), repo: segments.at(-1), ssh: !web };
}

// The configured URL names the repository; `git remote get-url` would expand
// insteadOf rewrites, which are transport plumbing.
export async function configuredRemoteRepository(root, remote) {
  for (const key of [`remote.${remote}.pushurl`, `remote.${remote}.url`]) {
    const value = cleanOutput(await git(root, ["config", "--get", key], { allowedExitCodes: [0, 1] }));
    if (value) return parseRemoteUrl(value);
  }
  return null;
}

// "forge" in the repository's committed .mexxi.json, read from the base commit
// like ciCheck, so only what the default branch already holds counts.
async function committedForge(root, baseSha) {
  if (!baseSha) return null;
  const result = await git(root, ["show", `${baseSha}:${OPT_IN_FILE}`], { allowedExitCodes: [0, 128] });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout)?.forge ?? null;
  } catch {
    return null;
  }
}

// The host an SSH alias (git@github-work:owner/repo, a multi-account setup)
// stands for, as ssh config resolves it; `ssh -G` reads config and connects
// to nothing. gh resolves aliases the same way.
async function sshHostname(alias) {
  try {
    const result = await run("ssh", ["-G", alias], { timeout: 5_000 });
    return result.stdout.match(/^hostname (\S+)$/m)?.[1].toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// The web host behind the remote: an http(s) host as written, a forge's own
// SSH endpoint as its web host, and an SSH host that is neither known nor
// mapped as ssh config resolves it.
async function webHost(parsed, hosts) {
  if (!parsed.ssh) return parsed.host;
  if (SSH_ENDPOINTS[parsed.host]) return SSH_ENDPOINTS[parsed.host];
  if (KNOWN_HOSTS[parsed.host] || hosts[parsed.host]) return parsed.host;
  return (await sshHostname(parsed.host)) ?? parsed.host;
}

// Which forge the push remote is on: .mexxi.json's "forge" first, then
// forge.hosts in config.json, then github.com and gitlab.com. Returns a forge
// client, or { name: null, reason } when there is none.
export async function detectForge({ root, remote, baseSha, config }) {
  const parsed = await configuredRemoteRepository(root, remote);
  if (!parsed) return { name: null, reason: `remote ${remote} does not name a forge repository (it is a local path or an unrecognised URL)` };
  const committed = await committedForge(root, baseSha);
  if (committed !== null && !FORGES.includes(committed)) {
    return { name: null, reason: `${OPT_IN_FILE} names forge ${JSON.stringify(committed)}; use one of ${FORGES.join(", ")}` };
  }
  const hosts = config?.forge?.hosts ?? {};
  const host = await webHost(parsed, hosts);
  const name = committed ?? hosts[host] ?? KNOWN_HOSTS[host] ?? null;
  if (!name) {
    return { name: null, reason: `remote ${remote} is on ${host}, which is not a known forge; map it in forge.hosts in config.json or set "forge" in the repository's ${OPT_IN_FILE}` };
  }
  if (name === "github" && parsed.namespace.includes("/")) {
    return { name: null, reason: `remote ${remote} has a nested path, which a GitHub repository cannot have` };
  }
  return (name === "github" ? githubForge : gitlabForge)({ ...parsed, host });
}

const GITHUB_PULL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?(?:[?#].*)?$/i;
const GITLAB_MERGE_REQUEST = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)\/?(?:[?#].*)?$/;

// The forge to read a recorded pull request from. When the remote names none
// (an SSH alias ssh config does not resolve, say), the URL the forge's CLI
// returned does: a github.com pull request or a GitLab merge request on its
// own host, since changeRequest reads the request from its URL.
export function changeRequestForge(forge, url) {
  if (forge.name) return forge;
  const pull = url.match(GITHUB_PULL);
  if (pull) return githubForge({ host: "github.com", namespace: pull[1], repo: pull[2] });
  const merge = url.match(GITLAB_MERGE_REQUEST);
  if (merge) {
    const segments = merge[2].split("/");
    return gitlabForge({ host: merge[1].toLowerCase(), namespace: segments.slice(0, -1).join("/"), repo: segments.at(-1) });
  }
  return forge;
}

// A WorkspaceError naming what needed the forge and why there is none.
export function requireForge(forge, needed) {
  if (forge.name) return forge;
  throw new WorkspaceError(`${needed} needs a GitHub or GitLab remote`, forge.reason);
}

function parseJson(text, cli) {
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkspaceError(`unexpected ${cli} output: ${text.trim()}`);
  }
}

function parseArray(text, cli) {
  const parsed = parseJson(text, cli);
  if (!Array.isArray(parsed)) throw new WorkspaceError(`unexpected ${cli} output: ${text.trim()}`);
  return parsed;
}

const encodePath = (value) => value.split("/").map(encodeURIComponent).join("/");

function githubForge({ host, namespace: owner, repo }) {
  // gh takes [HOST/]OWNER/REPO; github.com is its default host.
  const repository = host === "github.com" ? `${owner}/${repo}` : `${host}/${owner}/${repo}`;
  const gh = (root, args, timeout = 30_000) => run("gh", args, { cwd: root, timeout });
  const ghRepo = async (root, args) => cleanOutput(await gh(root, [...args, "--repo", repository], 60_000));
  return {
    name: "github",
    label: LABELS.github,
    cli: "gh",
    host,
    // The pull request's state (OPEN, MERGED or CLOSED), merge commit, head
    // branch and head commit; fields gh does not report are null.
    async changeRequest(root, url) {
      const result = await gh(root, ["pr", "view", url, "--json", "state,mergeCommit,headRefName,headRefOid,baseRefName"]);
      const parsed = parseJson(result.stdout, "gh");
      if (!CHANGE_STATES.has(parsed?.state)) throw new WorkspaceError(`unexpected gh output: ${result.stdout.trim()}`);
      const oid = parsed.mergeCommit?.oid;
      return {
        state: parsed.state,
        mergeCommit: typeof oid === "string" && /^[0-9a-f]+$/i.test(oid) ? oid : null,
        headBranch: typeof parsed.headRefName === "string" ? parsed.headRefName : null,
        headSha: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null,
        baseBranch: typeof parsed.baseRefName === "string" ? parsed.baseRefName : null,
      };
    },
    // The pull request's checks as { name, bucket, link, workflow }, bucket
    // being gh's pass, fail, pending, skipping or cancel. gh exits 8 while
    // checks are pending and 1 when one failed, and still prints them.
    async checks(root, url) {
      const result = await run("gh", ["pr", "checks", url, "--json", "name,state,bucket,link,workflow"], { cwd: root, timeout: 60_000, allowedExitCodes: [0, 1, 8] }).catch((error) => {
        if (NO_CHECKS.test(error.stderr ?? "")) return { stdout: "[]" };
        throw error;
      });
      if (NO_CHECKS.test(result.stderr ?? "")) return [];
      return parseArray(result.stdout.trim() || "[]", "gh").map((item) => ({
        name: String(item?.name ?? "?"), bucket: BUCKETS.has(item?.bucket) ? item.bucket : "pending",
        link: typeof item?.link === "string" ? item.link : null, workflow: typeof item?.workflow === "string" ? item.workflow : null,
      }));
    },
    // Blocks until the checks finish or timeoutMs passes; the result is read
    // with checks() afterwards, since --watch cannot print JSON. A failing
    // check does not stop the watch (no --fail-fast), so every failure of the
    // round is known before a fix starts.
    async watchChecks(root, url, timeoutMs) {
      await run("gh", ["pr", "checks", url, "--watch", "--interval", "30"], { cwd: root, timeout: timeoutMs, allowedExitCodes: [0, 1, 8] }).catch(() => {});
    },
    // The end of a failed GitHub Actions job's log, or null for a check that
    // is not an Actions job (an external status has no log to fetch).
    async failedLog(root, check) {
      const job = check.link?.match(/\/actions\/runs\/\d+\/job\/(\d+)/);
      if (!job) return null;
      const result = await gh(root, ["run", "view", "--job", job[1], "--log-failed", "--repo", repository], 120_000);
      return result.stdout;
    },
    // How much discussion the pull request holds, and the commands that read
    // it; the counts are null when gh cannot report them.
    async discussion(root, url) {
      const number = url.match(/\/pull\/(\d+)/)?.[1];
      const commands = [`gh pr view ${url} --comments`, `gh api repos/${owner}/${repo}/pulls/${number}/comments --paginate${host === "github.com" ? "" : ` --hostname ${host}`}`];
      try {
        const parsed = parseJson((await gh(root, ["pr", "view", url, "--json", "comments,reviews"])).stdout, "gh");
        return { comments: Array.isArray(parsed?.comments) ? parsed.comments.length : null, reviews: Array.isArray(parsed?.reviews) ? parsed.reviews.length : null, commands };
      } catch {
        return { comments: null, reviews: null, commands };
      }
    },
    async retarget(root, url, branch) {
      await gh(root, ["pr", "edit", url, "--base", branch], 60_000);
    },
    // The merged pull request whose head is branch, if any.
    async mergedRequestFor(root, branch) {
      const list = parseArray(await ghRepo(root, ["pr", "list", "--head", branch, "--state", "merged", "--json", "url", "--limit", "1"]), "gh");
      return list[0]?.url ?? null;
    },
    // Runs of the named check on sha, normalised to GitHub's check-run fields.
    // On github.com (including an SSH alias for it) gh fills {owner}/{repo}
    // from the checkout's remotes, as it always has; a forge.hosts-mapped
    // GitHub Enterprise host is named outright.
    async checkRuns(root, sha, check) {
      const query = `commits/${sha}/check-runs?check_name=${encodeURIComponent(check)}&filter=latest&per_page=100`;
      const result = await gh(root, host === "github.com"
        ? ["api", `repos/{owner}/{repo}/${query}`]
        : ["api", "--hostname", host, `repos/${owner}/${repo}/${query}`]);
      const parsed = parseJson(cleanOutput(result), "gh");
      return (Array.isArray(parsed?.check_runs) ? parsed.check_runs : []).map((item) => ({
        id: item?.id, name: item?.name, sha: item?.head_sha, status: item?.status, conclusion: item?.conclusion,
        url: item?.html_url ?? null, completedAt: item?.completed_at ?? null,
      }));
    },
    rawFileUrl(commit, file) {
      return `https://${host}/${owner}/${repo}/blob/${commit}/${encodePath(file)}?raw=true`;
    },
  };
}

// GitLab merge request states, as GitHub's pull request states. A locked
// request is mid-merge, so it counts as open.
const GITLAB_STATES = { opened: "OPEN", locked: "OPEN", merged: "MERGED", closed: "CLOSED" };
// Finished GitLab commit statuses, as GitHub check-run conclusions; any other
// status (pending, running, created, manual) is a run still in progress.
const GITLAB_CONCLUSIONS = { success: "success", failed: "failure", canceled: "cancelled", skipped: "skipped" };
const GITLAB_BUCKETS = { success: "pass", failed: "fail", canceled: "cancel", skipped: "skipping", manual: "skipping" };
const PAGE_SIZE = 100;

function mergeRequestParts(url) {
  const match = url.match(GITLAB_MERGE_REQUEST);
  if (!match) throw new WorkspaceError(`not a GitLab merge request URL: ${url}`);
  return { urlHost: match[1], projectPath: match[2], iid: match[3] };
}

function gitlabForge({ host, namespace, repo }) {
  const project = `projects/${encodeURIComponent(`${namespace}/${repo}`)}`;
  // Every call names the host and project, so glab never guesses them from
  // another remote. -f sends a field as a string, never reading @file.
  const call = async (root, apiHost, endpoint, fields = {}, method = Object.keys(fields).length ? "POST" : null) => {
    const args = ["api", "--hostname", apiHost];
    if (method) args.push("--method", method);
    args.push(endpoint);
    for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
    return cleanOutput(await run("glab", args, { cwd: root, timeout: 60_000 }));
  };
  const api = async (...args) => parseJson(await call(...args), "glab");
  const list = async (...args) => parseArray(await call(...args), "glab");
  return {
    name: "gitlab",
    label: LABELS.gitlab,
    cli: "glab",
    host,
    async changeRequest(root, url) {
      const { urlHost, projectPath, iid } = mergeRequestParts(url);
      const parsed = await api(root, urlHost, `projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`);
      const state = GITLAB_STATES[parsed?.state];
      if (!state) throw new WorkspaceError(`unexpected glab output: ${JSON.stringify(parsed)}`);
      // A squash without a merge commit (fast-forward) leaves only the squash commit.
      const merge = [parsed.merge_commit_sha, parsed.squash_commit_sha].find((sha) => typeof sha === "string" && /^[0-9a-f]+$/i.test(sha));
      return {
        state,
        mergeCommit: merge ?? null,
        headBranch: typeof parsed.source_branch === "string" ? parsed.source_branch : null,
        headSha: typeof parsed.sha === "string" ? parsed.sha : null,
        baseBranch: typeof parsed.target_branch === "string" ? parsed.target_branch : null,
      };
    },
    // The jobs of the merge request's head pipeline, as gh's check buckets.
    // A job allowed to fail never fails the request, as GitLab shows it.
    async checks(root, url) {
      const { urlHost, projectPath, iid } = mergeRequestParts(url);
      const request = await api(root, urlHost, `projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`);
      const pipeline = request?.head_pipeline?.id;
      if (!pipeline) return [];
      const jobs = await list(root, urlHost, `projects/${encodeURIComponent(projectPath)}/pipelines/${pipeline}/jobs?per_page=${PAGE_SIZE}`);
      return jobs.map((job) => ({
        name: String(job?.name ?? "?"),
        bucket: job?.status === "failed" && job?.allow_failure ? "pass" : GITLAB_BUCKETS[job?.status] ?? "pending",
        link: typeof job?.web_url === "string" ? job.web_url : null,
        workflow: typeof job?.stage === "string" ? job.stage : null,
        id: job?.id ?? null,
      }));
    },
    async failedLog(root, check) {
      if (!check.id || !check.link) return null;
      const { host: urlHost, projectPath } = check.link.match(/^https?:\/\/(?<host>[^/]+)\/(?<projectPath>.+?)\/-\/jobs\/\d+/)?.groups ?? {};
      if (!urlHost) return null;
      return call(root, urlHost, `projects/${encodeURIComponent(projectPath)}/jobs/${check.id}/trace`);
    },
    async discussion(root, url) {
      const { urlHost, projectPath, iid } = mergeRequestParts(url);
      const endpoint = `projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`;
      const commands = [`glab mr view ${iid} --comments --repo ${projectPath}`, `glab api --hostname ${urlHost} ${endpoint}/discussions?per_page=100`];
      try {
        const notes = await list(root, urlHost, `${endpoint}/notes?per_page=${PAGE_SIZE}`);
        return { comments: notes.filter((note) => !note?.system).length, reviews: null, commands };
      } catch {
        return { comments: null, reviews: null, commands };
      }
    },
    async retarget(root, url, branch) {
      const { urlHost, projectPath, iid } = mergeRequestParts(url);
      await call(root, urlHost, `projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`, { target_branch: branch }, "PUT");
    },
    async mergedRequestFor(root, branch) {
      const merged = await list(root, host, `${project}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=merged&per_page=1`);
      return merged[0]?.web_url ?? null;
    },
    // The latest commit statuses (pipeline jobs and external statuses) named
    // check, normalised to GitHub's check-run fields.
    async checkRuns(root, sha, check) {
      const statuses = await list(root, host, `${project}/repository/commits/${sha}/statuses?name=${encodeURIComponent(check)}&per_page=${PAGE_SIZE}`);
      return statuses.map((item) => {
        const conclusion = Object.hasOwn(GITLAB_CONCLUSIONS, item?.status) ? GITLAB_CONCLUSIONS[item.status] : null;
        return {
          id: item?.id, name: item?.name, sha: item?.sha,
          status: conclusion ? "completed" : item?.status, conclusion,
          url: item?.target_url ?? null, completedAt: item?.finished_at ?? null,
        };
      });
    },
    rawFileUrl(commit, file) {
      return `https://${host}/${namespace}/${repo}/-/raw/${commit}/${encodePath(file)}`;
    },
  };
}
