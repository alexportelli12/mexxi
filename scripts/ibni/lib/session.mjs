import { WorkspaceError } from "./errors.mjs";
import { pathExists } from "./fs.mjs";
import {
  canonicalRemoteUrl,
  cleanOutput,
  currentBranch,
  fetchBranch,
  git,
  isAncestor,
  redactEndpoint,
  remoteBranchSha,
  remoteDefault,
  repositoryAt,
} from "./git.mjs";
import { inspectImplementationWorktrees } from "./metadata.mjs";

export async function ownedSession(cwd, sessionId) {
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

export async function validateRemote(session) {
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

export async function validatePublication(session) {
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
