import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { workspaceConfig, workspaceRoot, sanitizePrefix, sanitizeSegment } from "../lib/config.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { provenBaseline } from "../lib/baseline.mjs";
import { pathExists } from "../lib/fs.mjs";
import {
  assertClean,
  assertNoGitOperation,
  canonicalRemoteUrl,
  cleanOutput,
  configuredRemote,
  currentBranch,
  fetchBranch,
  git,
  isAncestor,
  refExists,
  remoteBranchSha,
  remoteDefault,
  repositoryAt,
} from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { evidenceDirectoryFor, inspectImplementationWorktrees, writeMetadata } from "../lib/metadata.mjs";
import { allocatePort } from "../lib/ports.mjs";
import { workspaceCandidates } from "../lib/session.mjs";
import { sweepConsumedWorkspaces } from "./cleanup.mjs";

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
    throw new WorkspaceError("/wettaq must be launched from the repository's primary control worktree");
  }

  return withRepositoryLock(repository.commonDirectory, async () => {
    const controlCleanHint = [
      "If the listed files are transient workflow artifacts (rendered-inspection",
      "screenshots, analysis or report documents, temporary evidence), move them to",
      "the session's evidenceDir (see ibni info) or a system",
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
        "/wettaq must be launched from the checked-out default branch",
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
    const baseline = await provenBaseline(repository.root, baseSha);
    const allocation = await allocateWorkspace(
      repository,
      repository.root,
      pushUrl,
      slug,
      prefix ?? config.workflow.branchPrefix.replace(/\/$/, ""),
      config,
    );
    // Retained workspaces of every repository share this machine's ports.
    const recordedPorts = [
      ...(await inspectImplementationWorktrees(repository.commonDirectory)).map((entry) => entry.metadata?.port),
      ...(await workspaceCandidates(repository.root)).map((candidate) => candidate.metadata.port),
    ].filter(Number.isInteger);
    const port = await allocatePort(config.workflow.ports, recordedPorts);
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
        port,
        baseline,
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
        port,
        baseline,
        provisionedEnv,
        cleanup,
      };
    } catch (error) {
      await rollbackAllocatedWorkspace(repository.root, allocation, baseSha);
      throw error;
    }
  });
}
