import { rm } from "node:fs/promises";
import { canonicalPath } from "../lib/fs.mjs";
import { cleanOutput, fetchBranch, git, isAncestor, refExists, remoteBranchSha, repositoryAt, run } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { MEDIA_BRANCH, updateMediaBranch } from "../lib/media.mjs";
import { evidenceDirectoryFor, inspectImplementationWorktrees, workspaceSummary } from "../lib/metadata.mjs";

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
export async function sweepConsumedWorkspaces(repository) {
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
