import { spawn } from "node:child_process";
import path from "node:path";
import { WorkspaceError } from "./errors.mjs";
import { canonicalPath, pathExists } from "./fs.mjs";

export function redactEndpoint(value) {
  return value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)([^\s?#]*)(\?[^\s#]*)?/gi,
    (_match, scheme, authority, pathname, query) => {
      const safeAuthority = authority.includes("@")
        ? `[redacted]@${authority.slice(authority.lastIndexOf("@") + 1)}`
        : authority;
      return `${scheme}${safeAuthority}${pathname}${query ? "?[redacted]" : ""}`;
    },
  );
}

export function canonicalRemoteUrl(value, controlRoot) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\\]+:.+/.test(value)) {
    return value;
  }
  if (value.startsWith("~")) {
    throw new WorkspaceError(
      "the remote uses a home-relative URL",
      "Configure an absolute path so linked worktrees resolve the same endpoint.",
    );
  }
  return path.resolve(controlRoot, value);
}

export function run(command, args, options = {}) {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: options.timeout,
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => reject(new WorkspaceError(
      `could not run ${command}`,
      error.message,
    )));
    child.once("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (signal || !allowedExitCodes.includes(result.code)) {
        const diagnostics = redactEndpoint(result.stderr.trim() || result.stdout.trim()) ||
          `exit code ${result.code}${signal ? ` (signal ${signal})` : ""}`;
        reject(new WorkspaceError(
          `command failed: ${command} ${args.map(redactEndpoint).join(" ")}`,
          diagnostics,
        ));
        return;
      }
      resolve(result);
    });
  });
}

export async function git(cwd, args, options = {}) {
  return run("git", args, { ...options, cwd });
}

export function cleanOutput(result) {
  return result.stdout.trim();
}

export async function repositoryAt(cwd) {
  const rootResult = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = await canonicalPath(cleanOutput(rootResult));
  const gitDirectory = await canonicalPath(cleanOutput(
    await git(root, ["rev-parse", "--absolute-git-dir"]),
  ));
  const commonValue = cleanOutput(await git(root, ["rev-parse", "--git-common-dir"]));
  const commonDirectory = await canonicalPath(path.resolve(root, commonValue));
  return { root, gitDirectory, commonDirectory };
}

export async function currentBranch(root) {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowedExitCodes: [0, 1],
  });
  if (result.code !== 0 || !cleanOutput(result)) {
    throw new WorkspaceError("the worktree has a detached HEAD");
  }
  return cleanOutput(result);
}

export async function assertClean(root, label, recoveryHint) {
  const result = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.stdout.length > 0) {
    const readable = cleanOutput(await git(root, ["status", "--short", "--untracked-files=all"]));
    const details = recoveryHint ? `${readable}\n\n${recoveryHint}` : readable || "Git reported a non-clean worktree.";
    throw new WorkspaceError(
      `${label} contains uncommitted or untracked work`,
      details,
    );
  }
}

export async function assertNoGitOperation(repository) {
  const operationPaths = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-apply",
    "rebase-merge",
  ];
  for (const operationPath of operationPaths) {
    const resolved = cleanOutput(await git(repository.root, ["rev-parse", "--git-path", operationPath]));
    if (await pathExists(path.resolve(repository.root, resolved))) {
      throw new WorkspaceError(`an unfinished Git operation is present (${operationPath})`);
    }
  }
}

export async function configuredRemote(root, branch) {
  const configured = await git(root, ["config", "--get", `branch.${branch}.remote`], {
    allowedExitCodes: [0, 1],
  });
  if (configured.code === 0 && cleanOutput(configured) && cleanOutput(configured) !== ".") {
    return cleanOutput(configured);
  }

  const remotes = cleanOutput(await git(root, ["remote"])).split("\n").filter(Boolean);
  if (remotes.length === 1) return remotes[0];
  if (remotes.length === 0) {
    throw new WorkspaceError("the repository has no configured remote");
  }
  throw new WorkspaceError(
    "the repository remote is ambiguous",
    `Configure an upstream for ${branch}; available remotes: ${remotes.join(", ")}`,
  );
}

export async function remoteDefault(root, remote) {
  const result = await git(root, ["ls-remote", "--symref", remote, "HEAD"]);
  const match = result.stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m);
  if (!match) {
    throw new WorkspaceError(
      `remote ${redactEndpoint(remote)} did not advertise a default branch`,
      "Set the remote's HEAD/default branch before using /wettaq.",
    );
  }
  return match[1];
}

export async function fetchBranch(root, remote, branch) {
  await git(root, ["fetch", "--quiet", "--no-tags", remote, `refs/heads/${branch}`]);
  return cleanOutput(await git(root, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]));
}

export async function remoteBranchSha(root, remote, branch) {
  const result = await git(root, ["ls-remote", "--branches", remote, `refs/heads/${branch}`]);
  const line = result.stdout.trim();
  if (!line) return null;
  const [sha, ref, ...extra] = line.split(/\s+/);
  if (extra.length > 0 || ref !== `refs/heads/${branch}` || !/^[0-9a-f]+$/i.test(sha)) {
    throw new WorkspaceError(
      `remote ${redactEndpoint(remote)} returned an unexpected ref for ${branch}`,
    );
  }
  return sha;
}

export async function isAncestor(root, ancestor, descendant) {
  const result = await git(root, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowedExitCodes: [0, 1],
  });
  return result.code === 0;
}

export async function refExists(root, ref) {
  const result = await git(root, ["show-ref", "--verify", "--quiet", ref], {
    allowedExitCodes: [0, 1],
  });
  return result.code === 0;
}

// A transient server error from the Git host (HTTP 5xx) is retried once; every
// other failure, including rejections and authentication errors, is final.
const TRANSIENT_HTTP_FAILURE = /\b(?:HTTP|returned error:)\s*5\d\d\b/i;

export async function push(root, args, options = {}) {
  const attempt = () => git(root, ["push", ...args], options);
  let result;
  try {
    result = await attempt();
  } catch (error) {
    if (error instanceof WorkspaceError && TRANSIENT_HTTP_FAILURE.test(error.message)) return attempt();
    throw error;
  }
  if (result.code !== 0 && TRANSIENT_HTTP_FAILURE.test(result.stderr)) return attempt();
  return result;
}
