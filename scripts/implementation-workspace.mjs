#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, configPath, loadConfig } from "./lib/config.mjs";

const METADATA_FILE = "implementation-workspace.json";
const LEGACY_METADATA_FILE = "opencode-implementation.json";
// Keep the legacy lock name so old and new CLI versions serialize on the same
// Git repository during an incremental installation.
const LOCK_DIRECTORY = "opencode-implementation.lock";

class WorkspaceError extends Error {
  constructor(message, details = "") {
    super(details ? `${message}\n${details}` : message);
    this.name = "WorkspaceError";
  }
}

function redactEndpoint(value) {
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

function canonicalRemoteUrl(value, controlRoot) {
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

function run(command, args, options = {}) {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout,
    });
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

async function git(cwd, args, options = {}) {
  return run("git", args, { ...options, cwd });
}

function cleanOutput(result) {
  return result.stdout.trim();
}

async function canonicalPath(value) {
  return realpath(value);
}

async function repositoryAt(cwd) {
  const rootResult = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = await canonicalPath(cleanOutput(rootResult));
  const gitDirectory = await canonicalPath(cleanOutput(
    await git(root, ["rev-parse", "--absolute-git-dir"]),
  ));
  const commonValue = cleanOutput(await git(root, ["rev-parse", "--git-common-dir"]));
  const commonDirectory = await canonicalPath(path.resolve(root, commonValue));
  return { root, gitDirectory, commonDirectory };
}

async function currentBranch(root) {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowedExitCodes: [0, 1],
  });
  if (result.code !== 0 || !cleanOutput(result)) {
    throw new WorkspaceError("the worktree has a detached HEAD");
  }
  return cleanOutput(result);
}

async function assertClean(root, label, recoveryHint) {
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

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoGitOperation(repository) {
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

async function configuredRemote(root, branch) {
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

async function remoteDefault(root, remote) {
  const result = await git(root, ["ls-remote", "--symref", remote, "HEAD"]);
  const match = result.stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m);
  if (!match) {
    throw new WorkspaceError(
      `remote ${redactEndpoint(remote)} did not advertise a default branch`,
      "Set the remote's HEAD/default branch before using /implement.",
    );
  }
  return match[1];
}

async function fetchBranch(root, remote, branch) {
  await git(root, ["fetch", "--quiet", "--no-tags", remote, `refs/heads/${branch}`]);
  return cleanOutput(await git(root, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]));
}

async function remoteBranchSha(root, remote, branch) {
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

async function isAncestor(root, ancestor, descendant) {
  const result = await git(root, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowedExitCodes: [0, 1],
  });
  return result.code === 0;
}

async function refExists(root, ref) {
  const result = await git(root, ["show-ref", "--verify", "--quiet", ref], {
    allowedExitCodes: [0, 1],
  });
  return result.code === 0;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function acquireRepositoryLock(commonDirectory) {
  const lockPath = path.join(commonDirectory, LOCK_DIRECTORY);
  const owner = {
    hostname: os.hostname(),
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  const deadline = Date.now() + 30_000;
  let unreadableSince = null;
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return { lockPath, owner };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
      } catch {
        unreadableSince ??= Date.now();
        if (Date.now() - unreadableSince < 500) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw new WorkspaceError(
          "repository lifecycle lock has no readable owner",
          `Inspect ${lockPath}; it was not removed automatically because ownership is ambiguous.`,
        );
      }
      unreadableSince = null;
      if (existing.hostname !== os.hostname() || processIsAlive(existing.pid)) {
        if (Date.now() >= deadline) {
          throw new WorkspaceError(
            "timed out waiting for another implementation workspace operation",
            `Lock owner: pid ${existing.pid} on ${existing.hostname}, started ${existing.startedAt}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const stalePath = `${lockPath}.stale-${owner.token}`;
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    }
  }
}

async function releaseRepositoryLock(lock) {
  try {
    const existing = JSON.parse(await readFile(path.join(lock.lockPath, "owner.json"), "utf8"));
    if (existing.token === lock.owner.token) {
      await rm(lock.lockPath, { recursive: true, force: true });
    }
  } catch {
    // A missing or replaced lock must not cause a successful Git operation to fail.
  }
}

async function withRepositoryLock(commonDirectory, operation) {
  const lock = await acquireRepositoryLock(commonDirectory);
  try {
    return await operation();
  } finally {
    await releaseRepositoryLock(lock);
  }
}

function sanitizeSegment(value, fallback) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return normalized || fallback;
}

function sanitizePrefix(value) {
  return value
    .split("/")
    .map((segment) => sanitizeSegment(segment, "work"))
    .join("/");
}

async function workspaceConfig(environment = process.env) {
  // Both variables are retired in favour of config.json; failing beats
  // silently creating worktrees somewhere other than where they were asked for.
  for (const name of ["IMPLEMENTATION_WORKTREE_ROOT", "OPENCODE_WORKTREE_ROOT"]) {
    if (environment[name]) {
      throw new WorkspaceError(`${name} is retired`, `Set paths.worktreeRoot in ${configPath({ env: environment })} instead and unset ${name}.`);
    }
  }
  try {
    return (await loadConfig({ file: configPath({ env: environment }) })).config;
  } catch (error) {
    if (error instanceof ConfigError) throw new WorkspaceError("mexxi configuration is invalid", error.message);
    throw error;
  }
}

// New workspaces always go under paths.worktreeRoot. Retained ones under the
// earlier coding-agent/ and opencode/ roots stay reachable, because sessions
// are found through Git's worktree list and their metadata, not this path.
async function workspaceRoot(repository, config) {
  const repositoryName = sanitizeSegment(path.basename(repository.root), "repository");
  const identity = createHash("sha256").update(repository.commonDirectory).digest("hex").slice(0, 10);
  return path.resolve(config.paths.worktreeRoot, `${repositoryName}-${identity}`);
}

async function writeMetadata(gitDirectory, metadata) {
  const legacy = path.join(gitDirectory, LEGACY_METADATA_FILE);
  const current = path.join(gitDirectory, METADATA_FILE);
  const destination = await pathExists(legacy) && !await pathExists(current) ? legacy : current;
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

async function readMetadata(gitDirectory) {
  try {
    const current = path.join(gitDirectory, METADATA_FILE);
    const legacy = path.join(gitDirectory, LEGACY_METADATA_FILE);
    if (await pathExists(current) && await pathExists(legacy)) {
      throw new WorkspaceError("implementation ownership metadata is ambiguous", `Both ${current} and ${legacy} exist.`);
    }
    return JSON.parse(await readFile(await pathExists(current) ? current : legacy, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("implementation ownership metadata is invalid", error.message);
  }
}

async function linkedWorktreeDirectories(root) {
  const result = await git(root, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let currentPath = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line === "" && currentPath) {
      entries.push(currentPath);
      currentPath = null;
    }
  }
  if (currentPath) entries.push(currentPath);
  return entries;
}

async function inspectImplementationWorktrees(root) {
  const inspected = [];
  for (const worktreePath of await linkedWorktreeDirectories(root)) {
    const entry = { worktreePath, root };
    let gitDirectory;
    try {
      gitDirectory = await canonicalPath(cleanOutput(
        await git(worktreePath, ["rev-parse", "--absolute-git-dir"]),
      ));
      const existing = await pathExists(worktreePath);
      entry.gitDirectory = gitDirectory;
      entry.worktreeExists = existing;
      const metadata = await readMetadata(gitDirectory);
      if (metadata) {
        entry.metadata = metadata;
        entry.branch = metadata.branch;
      }
    } catch (error) {
      entry.error = error.message;
    }
    inspected.push(entry);
  }
  return inspected;
}

const ENV_FILE_PREFIX = ".env";

async function controlEnvCandidates(controlRoot) {
  const entries = await readdir(controlRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.filter(
    (candidate) => candidate.isFile() && candidate.name.startsWith(ENV_FILE_PREFIX),
  ).map((candidate) => candidate.name).sort()) {
    const ignored = await git(controlRoot, ["check-ignore", "--quiet", entry], {
      allowedExitCodes: [0, 1],
    });
    if (ignored.code !== 0) continue;
    const tracked = await git(controlRoot, ["ls-files", "--error-unmatch", entry], {
      allowedExitCodes: [0, 1],
    });
    if (tracked.code === 0) continue;
    candidates.push(entry);
  }
  return candidates;
}

async function provisionEnvFiles(controlRoot, worktreePath) {
  const provisioned = [];
  for (const name of await controlEnvCandidates(controlRoot)) {
    const destination = path.join(worktreePath, name);
    if (await pathExists(destination)) continue;
    await copyFile(path.join(controlRoot, name), destination);
    provisioned.push(name);
  }
  return provisioned;
}

// Transient evidence (screenshots, recordings, reports) lives beside the
// worktree rather than inside it: untracked files in the worktree would block
// record-evidence, publish, and cleanup, which all require a clean tree.
function evidenceDirectoryFor(worktreePath) {
  return `${worktreePath}.evidence`;
}

function workspaceLeaf(slug, attempt) {
  const base = sanitizeSegment(slug, "change");
  if (attempt === 0) return base;

  const suffix = `-${attempt + 1}`;
  return `${base.slice(0, Math.max(1, 48 - suffix.length))}${suffix}`;
}

async function allocateWorkspace(repository, root, pushUrl, slug, prefix, config) {
  const parent = await workspaceRoot(repository, config);
  await mkdir(parent, { recursive: true });
  const sessionId = randomBytes(12).toString("hex");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    // The repository lock serializes allocation, so readable names can use a
    // deterministic numeric suffix when a slug is already in use.
    const leaf = workspaceLeaf(slug, attempt);
    const branch = `${sanitizePrefix(prefix || "agent")}/${leaf}`;
    const worktreePath = path.join(parent, leaf);
    await git(root, ["check-ref-format", "--branch", branch]);
    if (await refExists(root, `refs/heads/${branch}`)) continue;
    if (await remoteBranchSha(root, pushUrl, branch)) continue;
    if (await pathExists(worktreePath)) continue;
    if (await pathExists(evidenceDirectoryFor(worktreePath))) continue;
    return { sessionId, branch, worktreePath };
  }
  throw new WorkspaceError("could not allocate a collision-free branch and worktree path");
}

async function rollbackAllocatedWorkspace(root, allocation, baseSha) {
  // Allocation proved the evidence directory did not exist, so it is ours.
  await rm(evidenceDirectoryFor(allocation.worktreePath), { recursive: true, force: true }).catch(() => {});
  try {
    await git(root, ["worktree", "unlock", allocation.worktreePath], { allowedExitCodes: [0, 128] });
    await git(root, ["worktree", "remove", allocation.worktreePath], { allowedExitCodes: [0, 128] });
  } catch {
    // Continue to the branch check; all cleanup is limited to this allocation.
  }
  try {
    const ref = `refs/heads/${allocation.branch}`;
    if (await refExists(root, ref)) {
      const current = cleanOutput(await git(root, ["rev-parse", "--verify", `${ref}^{commit}`]));
      if (current === baseSha) await git(root, ["branch", "-d", allocation.branch]);
    }
  } catch {
    // Preserve anything that no longer exactly matches the just-created branch.
  }
}

export async function prepareWorkspace({ cwd = process.cwd(), slug, prefix }) {
  if (!slug) throw new WorkspaceError("prepare requires --slug <short-name>");
  const config = await workspaceConfig();
  const repository = await repositoryAt(cwd);
  if (repository.gitDirectory !== repository.commonDirectory) {
    throw new WorkspaceError("/implement must be launched from the repository's primary control worktree");
  }

  return withRepositoryLock(repository.commonDirectory, async () => {
    const controlCleanHint = [
      "If the listed files are transient workflow artifacts (rendered-inspection",
      "screenshots, analysis or report documents, temporary evidence), move them to",
      "the session's evidenceDir (see implementation-workspace info) or a system",
      "temporary directory before retrying. Review before removing anything;",
      "do not delete untracked work you did not create.",
    ].join("\n");
    await assertClean(repository.root, "the control worktree", controlCleanHint);
    await assertNoGitOperation(repository);
    const branch = await currentBranch(repository.root);
    const remote = await configuredRemote(repository.root, branch);
    const defaultBranch = await remoteDefault(repository.root, remote);
    if (branch !== defaultBranch) {
      throw new WorkspaceError(
        "/implement must be launched from the checked-out default branch",
        `Current branch: ${branch}; remote ${remote} default: ${defaultBranch}`,
      );
    }

    const fetchUrl = canonicalRemoteUrl(
      cleanOutput(await git(repository.root, ["remote", "get-url", remote])),
      repository.root,
    );
    const pushUrls = cleanOutput(await git(repository.root, [
      "remote",
      "get-url",
      "--push",
      "--all",
      remote,
    ])).split("\n").filter(Boolean).map((value) => canonicalRemoteUrl(value, repository.root));
    if (pushUrls.length !== 1) {
      throw new WorkspaceError(
        `remote ${remote} has ${pushUrls.length} push URLs`,
        "The implementation lifecycle requires exactly one unambiguous publication endpoint.",
      );
    }
    const [pushUrl] = pushUrls;
    const latestDefaultSha = await fetchBranch(repository.root, remote, defaultBranch);
    await assertClean(repository.root, "the control worktree", controlCleanHint);
    if (await isAncestor(repository.root, branch, latestDefaultSha)) {
      const localSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
      if (localSha !== latestDefaultSha) {
        await git(repository.root, ["merge", "--ff-only", latestDefaultSha]);
        await assertClean(repository.root, "the fast-forwarded control worktree");
      }
    } else {
      const localSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
      const state = await isAncestor(repository.root, latestDefaultSha, localSha)
        ? "ahead of"
        : "diverged from";
      throw new WorkspaceError(
        `the local default branch is ${state} ${remote}/${defaultBranch}`,
        "The workflow will not rewrite, merge, or publish local default-branch history.",
      );
    }

    const cleanup = await sweepConsumedWorkspaces(repository);
    const baseSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
    const allocation = await allocateWorkspace(
      repository,
      repository.root,
      pushUrl,
      slug,
      prefix ?? config.workflow.branchPrefix.replace(/\/$/, ""),
      config,
    );
    try {
      await git(repository.root, [
        "worktree",
        "add",
        "--quiet",
        "--lock",
        "--reason",
        `Coding agent implementation ${allocation.sessionId}`,
        "-b",
        allocation.branch,
        allocation.worktreePath,
        baseSha,
      ]);
      const implementationRepository = await repositoryAt(allocation.worktreePath);
      const evidenceDir = evidenceDirectoryFor(implementationRepository.root);
      await mkdir(evidenceDir);
      const provisionedEnv = await provisionEnvFiles(repository.root, allocation.worktreePath);
      const now = new Date().toISOString();
      const metadata = {
        version: 1,
        sessionId: allocation.sessionId,
        state: "active",
        branch: allocation.branch,
        worktreePath: implementationRepository.root,
        controlWorktreePath: repository.root,
        commonDirectory: repository.commonDirectory,
        remote,
        fetchUrl,
        pushUrl,
        defaultBranch,
        initialBaseSha: baseSha,
        baseSha,
        publishedSha: null,
        prUrl: null,
        evidenceTreeSha: null,
        evidenceRecordedAt: null,
        pendingOperation: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeMetadata(implementationRepository.gitDirectory, metadata);
      return {
        operation: "prepare",
        sessionId: metadata.sessionId,
        worktreePath: metadata.worktreePath,
        branch: metadata.branch,
        remote: metadata.remote,
        defaultBranch: metadata.defaultBranch,
        baseSha: metadata.baseSha,
        evidenceDir,
        provisionedEnv,
        cleanup,
      };
    } catch (error) {
      await rollbackAllocatedWorkspace(repository.root, allocation, baseSha);
      throw error;
    }
  });
}

async function ownedSession(cwd, sessionId) {
  if (!sessionId) throw new WorkspaceError("the operation requires --session <session-id>");
  const repository = await repositoryAt(cwd);
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);

  const cwdIsLinkedImplementationWorktree = repository.gitDirectory !== repository.commonDirectory
    && inspected.some((entry) => entry.worktreeExists && entry.gitDirectory === repository.gitDirectory);

  if (cwdIsLinkedImplementationWorktree) {
    const here = inspected.find((entry) =>
      entry.worktreeExists && entry.gitDirectory === repository.gitDirectory
    );
    if (!here?.metadata) {
      throw new WorkspaceError("this worktree has no implementation ownership metadata");
    }
    if (here.metadata.sessionId !== sessionId) {
      throw new WorkspaceError("the session token does not own this implementation worktree");
    }
  }

  const owned = inspected.filter(
    (entry) => entry.metadata?.sessionId === sessionId
      && entry.metadata?.commonDirectory === repository.commonDirectory,
  );
  if (owned.length === 0) {
    throw new WorkspaceError(
      "no implementation worktree for this session exists in this repository",
      `Session: ${sessionId}. Run lifecycle operations from the repository or its worktrees.`,
    );
  }
  if (owned.length > 1) {
    throw new WorkspaceError(
      `session ${sessionId} owns more than one repository worktree; ownership is ambiguous`,
      "Manually inspect the implementation worktrees before further lifecycle operations.",
    );
  }

  const { worktreePath, gitDirectory, metadata } = owned[0];
  if (!metadata.worktreePath || metadata.worktreePath !== worktreePath) {
    throw new WorkspaceError(
      "implementation ownership metadata does not path-match this worktree",
      `Metadata: ${metadata.worktreePath || "none"}; worktree: ${worktreePath}`,
    );
  }
  if (!await pathExists(worktreePath)) {
    throw new WorkspaceError(
      "the owned implementation worktree is missing on disk",
      `Recorded path: ${worktreePath}`,
    );
  }
  const repositoryAtOwner = await repositoryAt(worktreePath);
  if (repositoryAtOwner.gitDirectory !== gitDirectory
    || repositoryAtOwner.commonDirectory !== repository.commonDirectory) {
    throw new WorkspaceError("implementation ownership metadata does not match this worktree");
  }
  if (metadata.version !== 1) {
    throw new WorkspaceError("the session token does not own this implementation worktree");
  }
  if (metadata.pendingOperation) {
    throw new WorkspaceError(
      `the implementation has an incomplete ${metadata.pendingOperation.type} operation`,
      "Inspect the retained worktree and remote state; automatic recovery would require guessing.",
    );
  }
  if (metadata.worktreePath !== repositoryAtOwner.root || metadata.commonDirectory !== repository.commonDirectory) {
    throw new WorkspaceError("implementation ownership metadata does not match this worktree");
  }
  if (metadata.branch === metadata.defaultBranch) {
    throw new WorkspaceError("the owned implementation branch cannot be the default branch");
  }
  const branch = await currentBranch(repositoryAtOwner.root);
  if (branch !== metadata.branch) {
    throw new WorkspaceError(
      "the implementation worktree is on an unexpected branch",
      `Expected ${metadata.branch}; found ${branch}`,
    );
  }
  return { repository: repositoryAtOwner, metadata };
}

async function validateRemote(session) {
  const { repository, metadata } = session;
  const currentUrl = canonicalRemoteUrl(
    cleanOutput(await git(repository.root, ["remote", "get-url", metadata.remote])),
    metadata.controlWorktreePath,
  );
  if (currentUrl !== metadata.fetchUrl) {
    throw new WorkspaceError(
      `remote ${metadata.remote} changed during the implementation`,
      `Expected ${redactEndpoint(metadata.fetchUrl)}; found ${redactEndpoint(currentUrl)}`,
    );
  }
  const pushUrls = cleanOutput(await git(repository.root, [
    "remote",
    "get-url",
    "--push",
    "--all",
    metadata.remote,
  ])).split("\n").filter(Boolean).map((value) => canonicalRemoteUrl(
    value,
    metadata.controlWorktreePath,
  ));
  if (pushUrls.length !== 1 || pushUrls[0] !== metadata.pushUrl) {
    throw new WorkspaceError(
      `remote ${metadata.remote} publication endpoint changed during the implementation`,
      `Expected one push URL matching ${redactEndpoint(metadata.pushUrl)}; found ${pushUrls.map(redactEndpoint).join(", ") || "none"}`,
    );
  }
  const defaultBranch = await remoteDefault(repository.root, metadata.fetchUrl);
  if (defaultBranch !== metadata.defaultBranch) {
    throw new WorkspaceError(
      "the remote default branch changed during the implementation",
      `Expected ${metadata.defaultBranch}; found ${defaultBranch}`,
    );
  }
}

async function validatePublication(session) {
  const { repository, metadata } = session;
  const remoteSha = await remoteBranchSha(repository.root, metadata.pushUrl, metadata.branch);
  if (!metadata.publishedSha && remoteSha) {
    throw new WorkspaceError(
      "the implementation branch was published outside this session",
      `Publication endpoint already contains ${metadata.branch} at ${remoteSha}.`,
    );
  }
  if (metadata.publishedSha && !remoteSha) {
    throw new WorkspaceError("the published implementation branch was removed from the remote");
  }
  if (metadata.publishedSha && remoteSha !== metadata.publishedSha) {
    throw new WorkspaceError(
      "the published implementation branch changed outside this session",
      `Expected ${metadata.publishedSha}; found ${remoteSha}.`,
    );
  }
  if (remoteSha) {
    const fetchedSha = await fetchBranch(repository.root, metadata.pushUrl, metadata.branch);
    if (fetchedSha !== remoteSha) {
      throw new WorkspaceError("the published implementation branch changed while it was being inspected");
    }
    const head = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
    if (!await isAncestor(repository.root, remoteSha, head)) {
      throw new WorkspaceError("the local implementation branch does not contain its published history");
    }
  }
  return remoteSha;
}

async function updateMetadata(session, changes) {
  const metadata = {
    ...session.metadata,
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  await writeMetadata(session.repository.gitDirectory, metadata);
  session.metadata = metadata;
}

async function synchronizeUnlocked(cwd, sessionId) {
  const session = await ownedSession(cwd, sessionId);
  const { repository, metadata } = session;
  await assertClean(repository.root, "the implementation worktree");
  await assertNoGitOperation(repository);
  await validateRemote(session);
  const remoteFeatureSha = await validatePublication(session);
  const latestDefaultSha = await fetchBranch(repository.root, metadata.fetchUrl, metadata.defaultBranch);
  const head = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
  const treeBefore = cleanOutput(await git(repository.root, ["rev-parse", "HEAD^{tree}"]));

  if (!await isAncestor(repository.root, metadata.baseSha, head)) {
    throw new WorkspaceError("the implementation branch no longer contains its recorded base");
  }
  if (!await isAncestor(repository.root, metadata.baseSha, latestDefaultSha)) {
    throw new WorkspaceError(
      "the remote default branch history was rewritten",
      `Recorded base ${metadata.baseSha} is not an ancestor of ${latestDefaultSha}.`,
    );
  }

  if (latestDefaultSha === metadata.baseSha || await isAncestor(repository.root, latestDefaultSha, head)) {
    if (latestDefaultSha !== metadata.baseSha) {
      await updateMetadata(session, { baseSha: latestDefaultSha });
    }
    return {
      operation: "sync",
      synchronized: true,
      strategy: latestDefaultSha === metadata.baseSha ? "unchanged" : "already-contained",
      requiresRevalidation: false,
      baseSha: latestDefaultSha,
      headSha: head,
      branch: metadata.branch,
      defaultBranch: metadata.defaultBranch,
    };
  }

  let strategy;
  if (!remoteFeatureSha) {
    const merges = cleanOutput(await git(repository.root, [
      "rev-list",
      "--merges",
      `${metadata.baseSha}..${head}`,
    ]));
    if (merges) {
      throw new WorkspaceError(
        "unpublished implementation history contains merge commits",
        "The workflow cannot prove that rewriting this history is safe.",
      );
    }
    strategy = "rebase";
  } else {
    strategy = "merge";
  }
  await updateMetadata(session, {
    pendingOperation: {
      type: "synchronization",
      strategy,
      originalHead: head,
      targetBaseSha: latestDefaultSha,
      startedAt: new Date().toISOString(),
    },
  });
  try {
    if (!remoteFeatureSha) {
      await git(repository.root, [
        "-c",
        "rebase.autoStash=false",
        "-c",
        "rebase.updateRefs=false",
        "-c",
        "rerere.enabled=false",
        "rebase",
        "--no-autostash",
        "--no-rerere-autoupdate",
        "--reapply-cherry-picks",
        "--empty=keep",
        "--onto",
        latestDefaultSha,
        metadata.baseSha,
        metadata.branch,
      ], { env: { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } });
    } else {
      await git(repository.root, [
        "-c",
        "merge.autoStash=false",
        "-c",
        "rerere.enabled=false",
        "merge",
        "--no-edit",
        "--no-autostash",
        "--no-rerere-autoupdate",
        "--ff",
        latestDefaultSha,
      ], { env: { GIT_EDITOR: "true" } });
    }
  } catch (error) {
    let recoveryFailure = "";
    if (strategy === "rebase") {
      const abort = await git(repository.root, ["rebase", "--abort"], {
        allowedExitCodes: [0, 1, 128],
      });
      if (abort.code !== 0) recoveryFailure = abort.stderr.trim();
    } else if (strategy === "merge") {
      const abort = await git(repository.root, ["merge", "--abort"], {
        allowedExitCodes: [0, 1, 128],
      });
      if (abort.code !== 0) recoveryFailure = abort.stderr.trim();
    }
    try {
      await assertNoGitOperation(repository);
      await assertClean(repository.root, "the implementation worktree after synchronization abort");
      const restoredHead = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
      if (restoredHead !== head) {
        recoveryFailure = `HEAD was ${head} and is now ${restoredHead}`;
      } else {
        recoveryFailure = "";
      }
    } catch (recoveryError) {
      recoveryFailure = recoveryError.message;
    }
    if (!recoveryFailure) {
      await updateMetadata(session, { pendingOperation: null });
    }
    throw new WorkspaceError(
      recoveryFailure
        ? `could not synchronize by ${strategy}; automatic abort could not be verified`
        : `could not synchronize by ${strategy}; the operation was aborted`,
      recoveryFailure || error.message,
    );
  }

  const headSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
  const treeAfter = cleanOutput(await git(repository.root, ["rev-parse", "HEAD^{tree}"]));
  const requiresRevalidation = treeBefore !== treeAfter;
  await updateMetadata(session, {
    baseSha: latestDefaultSha,
    evidenceTreeSha: requiresRevalidation ? null : session.metadata.evidenceTreeSha,
    evidenceRecordedAt: requiresRevalidation ? null : session.metadata.evidenceRecordedAt,
    pendingOperation: null,
  });
  return {
    operation: "sync",
    synchronized: true,
    strategy,
    requiresRevalidation,
    baseSha: latestDefaultSha,
    headSha,
    branch: metadata.branch,
    defaultBranch: metadata.defaultBranch,
  };
}

export async function synchronizeWorkspace({ cwd = process.cwd(), sessionId }) {
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, () => synchronizeUnlocked(cwd, sessionId));
}

export async function recordEvidence({ cwd = process.cwd(), sessionId }) {
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, async () => {
    const session = await ownedSession(cwd, sessionId);
    await assertClean(session.repository.root, "the implementation worktree");
    await assertNoGitOperation(session.repository);
    const headSha = cleanOutput(await git(session.repository.root, ["rev-parse", "HEAD"]));
    const treeSha = cleanOutput(await git(session.repository.root, ["rev-parse", "HEAD^{tree}"]));
    const recordedAt = new Date().toISOString();
    await updateMetadata(session, {
      evidenceTreeSha: treeSha,
      evidenceRecordedAt: recordedAt,
    });
    return {
      operation: "record-evidence",
      headSha,
      treeSha,
      recordedAt,
    };
  });
}

export async function publishWorkspace({ cwd = process.cwd(), sessionId }) {
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, async () => {
    const synchronization = await synchronizeUnlocked(cwd, sessionId);
    if (synchronization.requiresRevalidation) {
      return {
        ...synchronization,
        operation: "publish",
        published: false,
        requiresEvidence: true,
        reason: "the remote default branch was integrated and changed the tree; prior evidence is stale",
        nextAction: "Rerun npm run verify and any gate the integration could affect, commit remediation if needed, run record-evidence, then publish again.",
      };
    }

    const session = await ownedSession(cwd, sessionId);
    const { repository, metadata } = session;
    await assertClean(repository.root, "the implementation worktree");
    const diff = await git(repository.root, ["diff", "--quiet", metadata.baseSha, "HEAD"], {
      allowedExitCodes: [0, 1],
    });
    if (diff.code === 0) throw new WorkspaceError("the implementation has no effective change to publish");

    const headSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
    const treeSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD^{tree}"]));
    if (metadata.evidenceTreeSha !== treeSha) {
      return {
        ...synchronization,
        operation: "publish",
        published: false,
        requiresEvidence: true,
        headSha,
        reason: "the current committed tree has no recorded evidence",
        nextAction: "Run record-evidence once the gates pass for this commit, then publish again.",
      };
    }
    await updateMetadata(session, {
      pendingOperation: {
        type: "publication",
        headSha,
        priorPublishedSha: metadata.publishedSha,
        startedAt: new Date().toISOString(),
      },
    });
    let publicationConfirmed = false;
    try {
      await git(repository.root, [
        "push",
        "--porcelain",
        metadata.pushUrl,
        `${headSha}:refs/heads/${metadata.branch}`,
      ]);
      const publishedSha = await remoteBranchSha(
        repository.root,
        metadata.pushUrl,
        metadata.branch,
      );
      if (publishedSha !== headSha) {
        throw new WorkspaceError(
          "the publication endpoint did not retain the evidenced commit",
          `Expected ${headSha}; found ${publishedSha || "no branch"}.`,
        );
      }
      publicationConfirmed = true;
    } catch (error) {
      let observedSha;
      try {
        observedSha = await remoteBranchSha(
          repository.root,
          metadata.pushUrl,
          metadata.branch,
        );
      } catch (reconciliationError) {
        throw new WorkspaceError(
          "publication outcome is ambiguous; ownership state was retained",
          `${error.message}\nReconciliation failed: ${reconciliationError.message}`,
        );
      }
      if (observedSha === headSha) {
        publicationConfirmed = true;
      } else if (observedSha === metadata.publishedSha) {
        await updateMetadata(session, { pendingOperation: null });
        throw error;
      } else {
        throw new WorkspaceError(
          "publication outcome is ambiguous; ownership state was retained",
          `Expected ${headSha}, previous remote state ${metadata.publishedSha || "no branch"}, found ${observedSha || "no branch"}.`,
        );
      }
    }
    if (!publicationConfirmed) {
      throw new WorkspaceError("publication could not be confirmed");
    }
    await updateMetadata(session, {
      state: "published",
      publishedSha: headSha,
      pendingOperation: null,
    });
    return {
      ...synchronization,
      operation: "publish",
      published: true,
      requiresEvidence: false,
      remote: metadata.remote,
      branch: metadata.branch,
      defaultBranch: metadata.defaultBranch,
      headSha,
    };
  });
}

export async function markPullRequest({ cwd = process.cwd(), sessionId, url }) {
  if (!url || !/^https?:\/\//.test(url)) {
    throw new WorkspaceError("mark-pr requires --url <pull-request-url>");
  }
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, async () => {
    const session = await ownedSession(cwd, sessionId);
    if (!session.metadata.publishedSha) {
      throw new WorkspaceError("the implementation branch must be published before recording a pull request");
    }
    await updateMetadata(session, { state: "pr-open", prUrl: url });
    return {
      operation: "mark-pr",
      state: "pr-open",
      branch: session.metadata.branch,
      worktreePath: session.metadata.worktreePath,
      prUrl: url,
    };
  });
}

function workspaceSummary(entry) {
  const { metadata } = entry;
  if (!metadata) return null;
  return {
    sessionId: metadata.sessionId,
    worktreePath: metadata.worktreePath,
    evidenceDir: evidenceDirectoryFor(metadata.worktreePath),
    branch: metadata.branch,
    state: metadata.state,
    prUrl: metadata.prUrl,
    defaultBranch: metadata.defaultBranch,
    baseSha: metadata.baseSha,
    publishedSha: metadata.publishedSha,
    evidenceTreeSha: metadata.evidenceTreeSha,
    evidenceRecordedAt: metadata.evidenceRecordedAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

export async function listWorkspaces({ cwd = process.cwd() }) {
  const repository = await repositoryAt(cwd);
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
  return {
    operation: "list",
    workspaces: inspected
      .filter((entry) => entry.metadata)
      .map((entry) => workspaceSummary(entry)),
  };
}

export async function workspaceInfo({ cwd = process.cwd(), sessionId }) {
  if (!sessionId) throw new WorkspaceError("info requires --session <session-id>");
  const repository = await repositoryAt(cwd);
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
  const owned = inspected.filter(
    (entry) => entry.metadata?.sessionId === sessionId
      && entry.metadata?.commonDirectory === repository.commonDirectory,
  );
  if (owned.length === 0) {
    throw new WorkspaceError(
      "no implementation worktree for this session exists in this repository",
      `Session: ${sessionId}`,
    );
  }
  if (owned.length > 1) {
    throw new WorkspaceError(
      `session ${sessionId} owns more than one repository worktree; ownership is ambiguous`,
    );
  }
  const summary = workspaceSummary(owned[0]);
  // Sessions prepared before evidence directories existed get one on demand.
  if (owned[0].worktreeExists) await mkdir(summary.evidenceDir, { recursive: true });
  return {
    operation: "info",
    ...summary,
  };
}
const PR_OPEN_STATES = new Set(["OPEN", "MERGED", "CLOSED"]);

async function pullRequestState(root, prUrl) {
  try {
    const result = await run(
      "gh",
      ["pr", "view", prUrl, "--json", "state,mergeCommit"],
      { cwd: root, timeout: 30_000 },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { state: null, mergeCommit: null, diagnostic: `unexpected gh output: ${cleanOutput(result)}` };
    }
    const state = typeof parsed?.state === "string" && PR_OPEN_STATES.has(parsed.state)
      ? parsed.state
      : null;
    const mergeCommit = parsed?.mergeCommit
      && typeof parsed.mergeCommit.oid === "string"
      && /^[0-9a-f]+$/i.test(parsed.mergeCommit.oid)
      ? parsed.mergeCommit.oid
      : null;
    if (!state) {
      return { state: null, mergeCommit, diagnostic: `unexpected gh output: ${result.stdout.trim()}` };
    }
    return { state, mergeCommit, diagnostic: null };
  } catch (error) {
    return { state: null, mergeCommit: null, diagnostic: error.message };
  }
}

async function verifyBranchConsumed(root, metadata, candidateSha) {
  if (!await refExists(root, `refs/heads/${metadata.branch}`)) {
    return { established: false, diagnostic: "the recorded branch no longer exists locally; restore it or remove the workspace manually" };
  }
  let latestDefaultSha;
  try {
    latestDefaultSha = await fetchBranch(root, metadata.fetchUrl, metadata.defaultBranch);
  } catch (error) {
    return { established: false, diagnostic: `could not fetch the remote default branch: ${error.message}` };
  }
  try {
    if (await isAncestor(root, candidateSha, latestDefaultSha)) {
      return { established: true, diagnostic: null };
    }
  } catch (error) {
    return { established: false, diagnostic: `Git rejected the consumption evidence: ${error.message}` };
  }
  return {
    established: false,
    diagnostic: "the branch history is not contained in the remote default branch",
  };
}

async function currentInvocationWorktree() {
  const invocationRoot = await canonicalPath(process.cwd());
  const repository = await repositoryAt(invocationRoot);
  return { invocationRoot, gitDirectory: repository.gitDirectory };
}

async function cleanupStatus(entry, activeGitDirectory, repositoryRoot) {
  const base = { worktreePath: entry.worktreePath };
  if (!entry.worktreeExists) {
    return { ...base, decision: "protect", reason: `worktree path is inaccessible: ${entry.error || "missing directory"}` };
  }
  if (!entry.metadata) {
    return { ...base, decision: "protect", reason: "not an owned implementation worktree" };
  }
  const metadata = entry.metadata;
  const summary = workspaceSummary(entry);
  if (entry.gitDirectory === activeGitDirectory) {
    return { ...base, summary, decision: "protect", reason: "this cleanup invocation runs from this worktree" };
  }
  if (metadata.pendingOperation) {
    return { ...base, summary, decision: "protect", reason: `incomplete ${metadata.pendingOperation.type} lifecycle operation` };
  }
  const statusResult = await git(entry.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"], {
    allowedExitCodes: [0, 1, 128],
  });
  if (statusResult.code !== 0) {
    return { ...base, summary, decision: "protect", reason: `could not inspect worktree state: ${cleanOutput(statusResult) || statusResult.stderr.trim()}` };
  }
  if (statusResult.stdout.length > 0) {
    return { ...base, summary, decision: "protect", reason: "contains uncommitted or untracked work" };
  }
  if (!metadata.prUrl) {
    return { ...base, summary, decision: "protect", reason: "no recorded pull request" };
  }

  const { state, mergeCommit, diagnostic } = await pullRequestState(repositoryRoot, metadata.prUrl);
  if (!state) {
    return { ...base, summary, decision: "protect", reason: `could not determine pull request state: ${diagnostic}` };
  }
  if (state === "OPEN") {
    return { ...base, summary, decision: "protect", reason: "pull request is open" };
  }

  // Only remove the worktree once Git evidence establishes that removing it
  // cannot discard the only useful representation of the implementation
  // history: the branch (for closed PRs) or its verified merge commit
  // (for merged PRs, including squash merges) must be contained in a
  // freshly fetched remote default branch.
  let branchHead;
  try {
    branchHead = cleanOutput(await git(entry.worktreePath, ["rev-parse", "HEAD"]));
  } catch (error) {
    return { ...base, summary, decision: "protect", reason: `could not resolve the worktree head: ${error.message}` };
  }
  const candidateSha = state === "MERGED" && mergeCommit ? mergeCommit : branchHead;
  const consumption = await verifyBranchConsumed(repositoryRoot, metadata, candidateSha);
  if (!consumption.established) {
    return { ...base, summary, decision: "protect", reason: `pull request ${state.toLowerCase()} but its history could not be established as consumed: ${consumption.diagnostic}` };
  }
  return { ...base, summary, decision: "remove", reason: `pull request ${state.toLowerCase()} and its history is confirmed consumed by the remote default branch`, prState: state };
}

const MEDIA_BRANCH = "pr-media";
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"]);

function githubRepository(url) {
  const match = url.match(
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  return match ? { owner: match[1], repo: match[2] } : null;
}

// The configured URL names the GitHub repository; `git remote get-url` would
// expand insteadOf rewrites, which are transport plumbing.
async function configuredGithubRepository(root, remote) {
  for (const key of [`remote.${remote}.pushurl`, `remote.${remote}.url`]) {
    const value = cleanOutput(await git(root, ["config", "--get", key], { allowedExitCodes: [0, 1] }));
    if (value) return githubRepository(value);
  }
  return null;
}

// Commits to pr-media through a temporary index and pushes the commit without
// creating local refs, so no checkout, branch, or working tree is touched.
// Pushes are fast-forward only; a concurrent update triggers a rebuild.
async function updateMediaBranch(root, pushUrl, message, mutateIndex) {
  let lastDiagnostic = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parent = await remoteBranchSha(root, pushUrl, MEDIA_BRANCH)
      ? await fetchBranch(root, pushUrl, MEDIA_BRANCH)
      : null;
    const indexDirectory = await mkdtemp(path.join(os.tmpdir(), "pr-media-index-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(indexDirectory, "index") };
      await git(root, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
      await mutateIndex(env);
      const tree = cleanOutput(await git(root, ["write-tree"], { env }));
      if (parent && tree === cleanOutput(await git(root, ["rev-parse", `${parent}^{tree}`]))) {
        return { commit: parent, changed: false };
      }
      const commit = cleanOutput(await git(root, [
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        message,
      ]));
      const push = await git(root, ["push", "--porcelain", pushUrl, `${commit}:refs/heads/${MEDIA_BRANCH}`], {
        allowedExitCodes: [0, 1],
      });
      if (push.code === 0) return { commit, changed: true };
      lastDiagnostic = redactEndpoint(push.stderr.trim() || push.stdout.trim());
    } finally {
      await rm(indexDirectory, { recursive: true, force: true });
    }
  }
  throw new WorkspaceError(`could not update ${MEDIA_BRANCH} after repeated push rejections`, lastDiagnostic);
}

async function mediaFiles(evidenceDir, requested) {
  const base = await canonicalPath(evidenceDir);
  let candidates = requested;
  if (!candidates.length) {
    candidates = (await readdir(base, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  }
  const files = [];
  const inside = (candidate) => candidate.startsWith(`${base}${path.sep}`);
  for (const candidate of candidates) {
    const requestedPath = path.resolve(base, candidate);
    let resolved = null;
    if (inside(requestedPath)) {
      try {
        resolved = await canonicalPath(requestedPath);
      } catch (error) {
        throw new WorkspaceError(`media file not found: ${candidate}`, error.message);
      }
    }
    // Check both the requested path and its target so symlinks cannot escape.
    if (!resolved || !inside(resolved)) {
      throw new WorkspaceError(`refusing to publish a file outside evidenceDir: ${candidate}`);
    }
    if (!(await lstat(resolved)).isFile()) {
      throw new WorkspaceError(`media path is not a file: ${candidate}`);
    }
    if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new WorkspaceError(
        `refusing to publish a non-media file: ${candidate}`,
        `Allowed extensions: ${[...MEDIA_EXTENSIONS].join(", ")}`,
      );
    }
    files.push({ absolute: resolved, relative: path.relative(base, resolved).split(path.sep).join("/") });
  }
  if (!files.length) throw new WorkspaceError("evidenceDir contains no media files to publish");
  return files;
}

export async function publishMedia({ cwd = process.cwd(), sessionId, files: requested = [] }) {
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, async () => {
    const { repository, metadata } = await ownedSession(cwd, sessionId);
    const github = await configuredGithubRepository(repository.root, metadata.remote);
    if (!github) {
      throw new WorkspaceError(
        "publish-media needs a GitHub remote to build embeddable URLs",
        "Deliver the pull request without media and note why in its Evidence section.",
      );
    }
    const files = await mediaFiles(evidenceDirectoryFor(metadata.worktreePath), requested);
    const published = files.map((file) => ({ ...file, path: `${metadata.branch}/${file.relative}` }));
    const { commit } = await updateMediaBranch(
      repository.root,
      metadata.pushUrl,
      `Add PR media for ${metadata.branch}`,
      async (env) => {
        for (const file of published) {
          const blob = cleanOutput(await git(repository.root, ["hash-object", "-w", "--no-filters", "--", file.absolute]));
          await git(repository.root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`], { env });
        }
      },
    );
    const encode = (value) => value.split("/").map(encodeURIComponent).join("/");
    // URLs pin the media commit rather than the branch tip: cleanup later drops
    // the folder from the tip, and merged PR descriptions must keep rendering.
    return {
      operation: "publish-media",
      mediaBranch: MEDIA_BRANCH,
      commit,
      files: published.map((file) => ({
        file: file.relative,
        path: file.path,
        url: `https://github.com/${github.owner}/${github.repo}/blob/${commit}/${encode(file.path)}?raw=true`,
      })),
    };
  });
}

// Best-effort: removes the media folders of removed workspaces in one additive
// commit per publication endpoint. Failures are reported, never thrown.
async function removeWorkspaceMedia(root, removedEntries) {
  const byEndpoint = new Map();
  for (const metadata of removedEntries) {
    if (!metadata?.pushUrl || !metadata.branch) continue;
    byEndpoint.set(metadata.pushUrl, [...(byEndpoint.get(metadata.pushUrl) ?? []), metadata.branch]);
  }
  const results = [];
  for (const [pushUrl, branches] of byEndpoint) {
    try {
      if (!await remoteBranchSha(root, pushUrl, MEDIA_BRANCH)) continue;
      const { changed } = await updateMediaBranch(
        root,
        pushUrl,
        `Remove PR media for ${branches.join(", ")}`,
        (env) => git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...branches], { env }),
      );
      results.push({ branches, removed: changed });
    } catch (error) {
      results.push({ branches, removed: false, error: error.message });
    }
  }
  return results;
}

async function removeWorkspace(root, status) {
  await git(root, ["worktree", "unlock", status.worktreePath], {
    allowedExitCodes: [0, 128],
  });
  await git(root, ["worktree", "remove", status.worktreePath]);
  status.removed = true;
  await rm(evidenceDirectoryFor(status.worktreePath), { recursive: true, force: true });
  const branch = status.summary?.branch;
  if (branch) {
    // `-d` refuses branches with unmerged local commits, keeping them.
    const branchDelete = await git(root, ["branch", "-d", branch], {
      allowedExitCodes: [0, 1],
    });
    if (branchDelete.code === 0) {
      status.branchDeleted = true;
    } else {
      status.branchRetained = true;
      status.branchDiagnostic = branchDelete.stderr.trim();
    }
  }
}

// Callers hold the repository lock. Every per-workspace failure is reported as
// a kept workspace so one unreadable entry never blocks the others.
async function cleanupUnlocked(repository, { dryRun, activeGitDirectory }) {
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
  const statuses = [];
  for (const entry of inspected) {
    try {
      statuses.push(await cleanupStatus(entry, activeGitDirectory, repository.root));
    } catch (error) {
      statuses.push({
        worktreePath: entry.worktreePath,
        owned: Boolean(entry.metadata),
        decision: "protect",
        reason: `could not inspect workspace: ${error.message}`,
      });
    }
  }

  const deletable = statuses.filter((status) => status.decision === "remove");
  let media = [];
  if (!dryRun) {
    for (const status of deletable) {
      try {
        await removeWorkspace(repository.root, status);
      } catch (error) {
        status.removalError = error.message;
      }
    }
    const removedMetadata = inspected
      .filter((entry) => statuses.some((status) => status.removed && status.worktreePath === entry.worktreePath))
      .map((entry) => entry.metadata);
    media = await removeWorkspaceMedia(repository.root, removedMetadata);
  }
  return {
    operation: "cleanup",
    dryRun,
    removedCount: statuses.filter((status) => status.removed).length,
    results: statuses,
    media,
  };
}

export async function cleanupWorkspaces({ cwd = process.cwd(), dryRun = true }) {
  const repository = await repositoryAt(cwd);
  return withRepositoryLock(repository.commonDirectory, async () => {
    const { gitDirectory: activeGitDirectory } = await currentInvocationWorktree();
    return cleanupUnlocked(repository, { dryRun, activeGitDirectory });
  });
}

// prepare runs this under its lock after fetching. It must never fail or block
// preparation: any error simply means every workspace was kept.
async function sweepConsumedWorkspaces(repository) {
  try {
    const result = await cleanupUnlocked(repository, {
      dryRun: false,
      activeGitDirectory: repository.gitDirectory,
    });
    const owned = result.results.filter((status) => status.summary || status.owned);
    return {
      removed: owned.filter((status) => status.removed).map((status) => ({
        worktreePath: status.worktreePath,
        branch: status.summary.branch,
        branchDeleted: Boolean(status.branchDeleted),
        ...(status.branchRetained ? { branchRetainedReason: status.branchDiagnostic || "branch has unmerged local commits" } : {}),
      })),
      kept: owned.filter((status) => !status.removed).map((status) => ({
        worktreePath: status.worktreePath,
        reason: status.removalError ? `removal failed: ${status.removalError}` : status.reason,
      })),
      media: result.media,
    };
  } catch (error) {
    return { removed: [], kept: [], media: [], error: error.message };
  }
}


function parseOptions(args) {
  const [operation, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new WorkspaceError(`invalid argument ${key ?? ""}`.trim());
    }
    options[key.slice(2)] = value;
  }
  return { operation, options };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { operation, options } = parseOptions(args);
    let result;
    if (operation === "prepare") {
      result = await prepareWorkspace({ slug: options.slug, prefix: options.prefix });
    } else if (operation === "sync") {
      result = await synchronizeWorkspace({ sessionId: options.session });
    } else if (operation === "publish") {
      result = await publishWorkspace({ sessionId: options.session });
    } else if (operation === "record-evidence") {
      result = await recordEvidence({ sessionId: options.session });
    } else if (operation === "mark-pr") {
      result = await markPullRequest({ sessionId: options.session, url: options.url });
    } else if (operation === "info") {
      result = await workspaceInfo({ sessionId: options.session });
    } else if (operation === "list") {
      result = await listWorkspaces({});
    } else if (operation === "publish-media") {
      result = await publishMedia({
        sessionId: options.session,
        files: options.files ? options.files.split(",").map((file) => file.trim()).filter(Boolean) : [],
      });
    } else if (operation === "cleanup") {
      result = await cleanupWorkspaces({ dryRun: options["dry-run"] !== "false" });
    } else {
      throw new WorkspaceError(
        "expected prepare, sync, record-evidence, publish, publish-media, mark-pr, info, list, or cleanup",
        "Usage: implementation-workspace prepare --slug <name> [--prefix <prefix>]",
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Implementation workspace error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
