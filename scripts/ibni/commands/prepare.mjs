import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { workspaceConfig, workspaceRoot, sanitizePrefix, sanitizeSegment } from "../lib/config.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { provenBaseline, repositorySettings, verifyCommandFrom } from "../lib/baseline.mjs";
import { detectForge } from "../lib/forge.mjs";
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
import { evidenceDirectoryFor, inspectImplementationWorktrees, readMetadata, summarizeSetup, writeMetadata } from "../lib/metadata.mjs";
import { allocatePort } from "../lib/ports.mjs";
import { workspaceCandidates } from "../lib/session.mjs";
import { deferredSetup, lockfilesAt, runSetup, setupPlan } from "../lib/setup.mjs";
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

// force is only for a failed setup: the worktree is still at baseSha and holds
// nothing but what the setup command wrote, which a plain remove may refuse.
async function rollbackAllocatedWorkspace(root, allocation, baseSha, { force = false } = {}) {
  // Allocation proved the evidence directory did not exist, so it is ours.
  await rm(evidenceDirectoryFor(allocation.worktreePath), { recursive: true, force: true }).catch(() => {});
  try {
    await git(root, ["worktree", "unlock", allocation.worktreePath], { allowedExitCodes: [0, 128] });
    await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), allocation.worktreePath], { allowedExitCodes: [0, 128] });
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

const normalPrefix = (value) => sanitizePrefix(value.replace(/\/+$/, ""));

/**
 * segwi names, one per line, the only branch prefixes its sandbox lets a run write. A branch under any other
 * would be made here, outside the sandbox, and then fail at the run's first commit, so it is refused up front.
 */
function assertWritablePrefix(prefix, environment) {
  if (!environment.IBNI_BRANCH_PREFIXES) return;
  const writable = environment.IBNI_BRANCH_PREFIXES.split("\n").filter(Boolean).map(normalPrefix);
  if (writable.includes(normalPrefix(prefix))) return;
  throw new WorkspaceError(
    `--prefix ${prefix} isn't one this run can write`,
    `This segwi run may only write branches under ${writable.map((name) => `${name}/`).join(", ")}. Run ibni prepare without --prefix, `
      + `or, if the repository's instructions require ${normalPrefix(prefix)}/, add it to segwi.branchPrefixes in config.json and start a new run.`,
  );
}

// segwi's sandbox keeps the checkout's git directory read-only. It runs ibni prepare outside only as a call of its own,
// so a chained one (`echo …; ibni prepare …`) fails here, at the lock, and the agent learns the form that works.
// Only in a segwi run, which names the checkout in IBNI_LAUNCH_CHECKOUT; elsewhere the error stays as it was.
function cannotWriteGitDirectory(error, repository, environment) {
  return Boolean(environment.IBNI_LAUNCH_CHECKOUT) && ["EROFS", "EACCES", "EPERM"].includes(error?.code) && typeof error.path === "string"
    && (error.path === repository.commonDirectory || error.path.startsWith(`${repository.commonDirectory}${path.sep}`));
}

export async function prepareWorkspace({ cwd = process.cwd(), slug, prefix, environment = process.env }) {
  if (!slug) throw new WorkspaceError("prepare requires --slug <short-name>");
  const config = await workspaceConfig();
  // The same prefix the branch gets: an empty --prefix means the configured one, as it does when allocating.
  const branchPrefix = prefix || config.workflow.branchPrefix.replace(/\/$/, "");
  assertWritablePrefix(branchPrefix, environment);
  const repository = await repositoryAt(cwd);
  if (repository.gitDirectory !== repository.commonDirectory) {
    throw new WorkspaceError("/wettaq must be launched from the repository's primary control worktree");
  }

  let prepared;
  try {
    prepared = await prepareLocked({ repository, config, slug, branchPrefix });
  } catch (error) {
    if (!cannotWriteGitDirectory(error, repository, environment)) throw error;
    throw new WorkspaceError(
      `can't write the repository's git directory (${error.code}: ${error.path})`,
      "In a segwi run, ibni prepare leaves the sandbox only as a Bash call of its own: run `ibni prepare --slug <name>` "
        + "with nothing before or after it (no echo, cd, ;, && or |).",
    );
  }
  return setUpPrepared(repository, prepared, environment);
}

// Setup runs after the repository lock is released: an install can take
// minutes, and other sessions' ibni commands give up on the lock after 30
// seconds. A failed setup takes the lock again to roll the allocation back.
// segwi sets IBNI_DEFER_SETUP because its prepare runs outside its sandbox,
// and install scripts must not; its run calls ibni setup inside instead.
async function setUpPrepared(repository, { result, allocation, plan, lockfiles, gitDirectory }, environment) {
  // A rollback that fails (the lock timing out, say) never hides why setup
  // failed; its own error is added to the details. The workspace it leaves
  // behind says "setup did not finish", so nothing later mistakes it for ready.
  const rollback = async (error) => {
    try {
      await withRepositoryLock(repository.commonDirectory, async () => {
        const metadata = await readMetadata(gitDirectory).catch(() => null);
        if (metadata?.sessionId === result.sessionId) {
          await rollbackAllocatedWorkspace(repository.root, allocation, result.baseSha, { force: true });
        }
      }, { env: {} });
    } catch (rollbackError) {
      return new WorkspaceError(
        error.message.replace("; the workspace was rolled back", "; rolling the workspace back failed too"),
        `Rollback: ${rollbackError.message}\nInspect ${result.worktreePath} before removing it.`,
      );
    }
    return error;
  };
  let setup;
  try {
    setup = environment.IBNI_DEFER_SETUP === "1"
      ? deferredSetup(plan, result.sessionId, lockfiles)
      : await runSetup({ plan, worktreePath: result.worktreePath, evidenceDir: result.evidenceDir, lockfiles });
  } catch (error) {
    throw await rollback(error);
  }
  if (setup.ran && !setup.passed) {
    throw await rollback(new WorkspaceError(
      `setup failed in the new worktree (${setup.command}, exit ${setup.exitCode ?? setup.signal ?? "unknown"}); the workspace was rolled back`,
      `${setup.logTail}\n\nFix the setup on the default branch (or "setup" in .mexxi.json), then prepare again.`,
    ));
  }
  await withRepositoryLock(repository.commonDirectory, async () => {
    const metadata = await readMetadata(gitDirectory);
    if (metadata?.sessionId !== result.sessionId) throw new WorkspaceError("the new workspace changed owner while its setup ran");
    await writeMetadata(gitDirectory, { ...metadata, setup, updatedAt: new Date().toISOString() });
  }, { env: {} });
  return { ...result, setup: summarizeSetup(setup) };
}

function prepareLocked({ repository, config, slug, branchPrefix }) {
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

    // segwi sets IBNI_SKIP_SWEEP: its run may have rewritten retained worktrees, and the sweep runs git in each,
    // outside the run's sandbox. Your own sessions still sweep.
    const cleanup = process.env.IBNI_SKIP_SWEEP === "1"
      ? { removed: [], kept: [], skipped: "IBNI_SKIP_SWEEP is set" }
      : await sweepConsumedWorkspaces(repository, config);
    const baseSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
    const settings = await repositorySettings(repository.root, baseSha);
    const verifyCommand = verifyCommandFrom(settings);
    const lockfiles = await lockfilesAt(repository.root, baseSha);
    const plan = setupPlan(settings, lockfiles);
    const forge = await detectForge({ root: repository.root, remote, baseSha, config });
    const baseline = await provenBaseline(repository.root, baseSha, settings, forge);
    const allocation = await allocateWorkspace(
      repository,
      repository.root,
      pushUrl,
      slug,
      branchPrefix,
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
        verifyCommand,
        baseline,
        // Replaced once setup ends; left as is, it says setup never finished.
        setup: plan.command
          ? { ran: false, command: plan.command, source: plan.source, reason: "setup did not finish", lockfiles }
          : { ran: false, command: null, reason: plan.reason, lockfiles },
        verification: null,
        evidenceTreeSha: null,
        evidenceRecordedAt: null,
        pendingOperation: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeMetadata(implementationRepository.gitDirectory, metadata);
      const result = {
        operation: "prepare",
        sessionId: metadata.sessionId,
        worktreePath: metadata.worktreePath,
        branch: metadata.branch,
        remote: metadata.remote,
        defaultBranch: metadata.defaultBranch,
        baseSha: metadata.baseSha,
        forge: forge.name,
        forgeReason: forge.name ? null : forge.reason,
        evidenceDir,
        port,
        verifyCommand,
        baseline,
        provisionedEnv,
        cleanup,
      };
      return { result, allocation, plan, lockfiles, gitDirectory: implementationRepository.gitDirectory };
    } catch (error) {
      await rollbackAllocatedWorkspace(repository.root, allocation, baseSha);
      throw error;
    }
  }, { env: {} });
}
