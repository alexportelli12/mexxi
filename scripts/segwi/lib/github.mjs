// segwi's only door to GitHub (decision 0027): read-only, for the repositories
// segwi lists, with a fine-grained token the person stores in the state
// directory. Every request is a GET; nothing here can merge, approve, comment
// or change a pull request.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
// Enough for any pull request a person reviews by hand; more than this is "can't tell", never a guess.
const MAX_PAGES = 10;
// GitHub's fine-grained personal access tokens. A classic token (ghp_) can't be limited to some repositories.
const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]{20,255}$/;

export const githubTokenFile = (stateDir) => path.join(stateDir, "segwi-github-token");

export class GithubUnavailable extends Error {}

/** Why `token` can't be used, or null. */
export function tokenProblem(token) {
  if (!token) return "the token is empty";
  if (token.startsWith("ghp_") || token.startsWith("gho_") || token.startsWith("ghs_") || token.startsWith("ghu_")) {
    return "it is not a fine-grained token, so it can't be limited to the listed repositories and read-only access";
  }
  if (!FINE_GRAINED.test(token)) return "it does not look like a fine-grained GitHub token (github_pat_...)";
  return null;
}

/** Stores the token, mode 0600, after checking its shape. */
export function saveGithubToken(stateDir, token) {
  const trimmed = token.trim();
  const problem = tokenProblem(trimmed);
  if (problem) throw new Error(`segwi won't store that token: ${problem}.`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = githubTokenFile(stateDir);
  writeFileSync(file, `${trimmed}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function removeGithubToken(stateDir) {
  rmSync(githubTokenFile(stateDir), { force: true });
}

/**
 * The token, read fresh on each call so a rotation needs no restart, or a GithubUnavailable saying why there is
 * none. A file other users could read is refused: the token is a credential.
 */
export function readGithubToken(stateDir) {
  const file = githubTokenFile(stateDir);
  let mode;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new GithubUnavailable("The GitHub data source isn't set up. Run segwi github-token set with a read-only, fine-grained token for the listed repositories.");
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new GithubUnavailable(`segwi won't use the GitHub token: ${file} can be read by other users. Run chmod 600 on it.`);
  }
  const token = readFileSync(file, "utf8").trim();
  const problem = tokenProblem(token);
  if (problem) throw new GithubUnavailable(`segwi won't use the stored GitHub token: ${problem}. Run segwi github-token set again.`);
  return token;
}

const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** "owner/repo" from a github.com remote URL, or null. */
export function githubSlug(remoteUrl) {
  const match = GITHUB_REMOTE.exec(String(remoteUrl ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The checkout's origin remote as owner/repo on github.com, or a GithubUnavailable. */
export async function checkoutSlug(repoPath) {
  let url = "";
  try {
    url = (await execFileAsync("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], { timeout: 5_000 })).stdout.trim();
  } catch {
    throw new GithubUnavailable("The repository's checkout has no origin remote, so segwi can't tell which GitHub repository it is.");
  }
  const slug = githubSlug(url);
  if (!slug) throw new GithubUnavailable("The repository's origin remote is not on github.com, which is the only forge readiness reads.");
  return slug;
}

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/;

/** The pull request's repository and number from its URL, or null. */
export function parsePullUrl(url) {
  const match = PULL_URL.exec(String(url ?? ""));
  return match ? { slug: `${match[1]}/${match[2]}`, number: Number(match[3]) } : null;
}

const nextLink = (header) => /<([^>]+)>;\s*rel="next"/.exec(header ?? "")?.[1] ?? null;

/**
 * A GET-only GitHub client for one repository. `fetch` is injected by tests; segwi uses the global one.
 * @param {{ token: string, slug: string, fetch?: typeof globalThis.fetch }} options
 */
export function githubClient({ token, slug, fetch = globalThis.fetch }) {
  async function request(url) {
    // The URL is always segwi's own, under the repository segwi was told to read.
    if (!url.startsWith(`${API}/repos/${slug}/`)) throw new Error(`segwi refused to read ${url} outside ${slug}`);
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "segwi" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      throw new Error(`GitHub didn't answer (${error.name === "TimeoutError" ? "timed out" : "network error"})`);
    }
    if (!response.ok) {
      const error = new Error(`GitHub answered ${response.status} for ${url.slice(API.length).split("?")[0]}`);
      error.status = response.status;
      throw error;
    }
    return { body: await response.json(), next: nextLink(response.headers.get("link")) };
  }
  const urlFor = (pathAndQuery) => `${API}/repos/${slug}/${pathAndQuery}`;
  return {
    slug,
    async get(pathAndQuery) {
      return (await request(urlFor(pathAndQuery))).body;
    },
    /** Every page of a list, following GitHub's next links; `key` picks the list out of an object body. */
    async getAll(pathAndQuery, key = null) {
      const items = [];
      let url = urlFor(pathAndQuery);
      for (let page = 0; url; page += 1) {
        if (page === MAX_PAGES) throw new Error(`GitHub's list for ${pathAndQuery.split("?")[0]} is longer than segwi reads`);
        const { body, next } = await request(url);
        const list = key ? body?.[key] : body;
        if (!Array.isArray(list)) throw new Error(`GitHub's answer for ${pathAndQuery.split("?")[0]} had no list`);
        items.push(...list);
        url = next;
      }
      return items;
    },
  };
}
