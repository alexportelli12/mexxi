import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { workspaceConfig } from "./config.mjs";
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
import { MACHINE_STATE_DIRECTORY } from "./lock.mjs";
import { EVIDENCE_SUFFIX, inspectImplementationWorktrees, readMetadata } from "./metadata.mjs";

async function repositoryOrNull(cwd) {
  try {
    return await repositoryAt(cwd);
  } catch (error) {
    if (error instanceof WorkspaceError) return null;
    throw error;
  }
}

// A worktree's .git file names its Git directory, so metadata can be read
// without starting Git for every retained workspace.
async function metadataAt(worktreePath) {
  try {
    const pointer = (await readFile(path.join(worktreePath, ".git"), "utf8")).match(/^gitdir: (.+)$/m);
    return pointer ? await readMetadata(path.resolve(worktreePath, pointer[1].trim())) : null;
  } catch {
    return null;
  }
}

// Workspaces outside any repository the caller stands in: the worktree beside
// an evidence directory containing cwd (any root, including retired ones), then
// every workspace under paths.worktreeRoot (<root>/<repository>/<leaf>).
export async function workspaceCandidates(cwd) {
  const candidates = [];
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    if (directory.endsWith(EVIDENCE_SUFFIX)) candidates.push(directory.slice(0, -EVIDENCE_SUFFIX.length));
    if (path.dirname(directory) === directory) break;
  }
  const { paths } = await workspaceConfig();
  const directories = async (parent) => (await readdir(parent, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(EVIDENCE_SUFFIX))
    .map((entry) => path.join(parent, entry.name));
  for (const repositoryFolder of await directories(paths.worktreeRoot)) {
    candidates.push(...await directories(repositoryFolder));
  }
  const found = [];
  for (const worktreePath of new Set(candidates)) {
    const metadata = await metadataAt(worktreePath);
    if (metadata) found.push({ worktreePath, metadata });
  }
  return found;
}

// Folders under paths.worktreeRoot that ibni did not make, such as a worktree
// added with plain `git worktree add`: ibni cleanup never finds them, so their
// disk stays used. Reported for a person to look at, never removed. ibni makes
// <root>/<repository>-<hash>/<leaf> with <leaf>.evidence beside it, and
// <root>/.ibni for its machine-wide state.
export async function unmanagedFolders(worktreeRoot) {
  const directories = async (parent) => (await readdir(parent, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const found = [];
  for (const name of await directories(worktreeRoot)) {
    const folder = path.join(worktreeRoot, name);
    if (name === MACHINE_STATE_DIRECTORY) continue;
    if (!/-[0-9a-f]{10}$/.test(name)) {
      found.push({ path: folder, reason: "not a repository folder ibni made" });
      continue;
    }
    const children = await directories(folder);
    for (const child of children) {
      const target = path.join(folder, child);
      if (child.endsWith(EVIDENCE_SUFFIX)) {
        if (!children.includes(child.slice(0, -EVIDENCE_SUFFIX.length))) found.push({ path: target, reason: "an evidence directory whose worktree is gone" });
      } else if (!await metadataAt(target)) {
        found.push({ path: target, reason: "a folder with no ibni workspace metadata" });
      }
    }
  }
  return found;
}

// Finds the repository holding the workspaces whose metadata matches: the one
// containing cwd when it has a match, otherwise the one a workspace found by
// workspaceCandidates belongs to. Session and PR lookups therefore work from
// any directory, including a session's evidenceDir.
export async function locateWorkspaces(cwd, matches) {
  const filterOwned = (repository, inspected) => inspected.filter(
    (entry) => entry.metadata && matches(entry.metadata)
      && entry.metadata.commonDirectory === repository.commonDirectory,
  );
  const here = await repositoryOrNull(cwd);
  if (here) {
    const inspected = await inspectImplementationWorktrees(here.commonDirectory);
    const matched = filterOwned(here, inspected);
    if (matched.length) return { repository: here, inspected, matched };
  }
  const elsewhere = (await workspaceCandidates(cwd)).filter((candidate) => matches(candidate.metadata));
  const commonDirectories = new Set(elsewhere.map((candidate) => candidate.metadata.commonDirectory));
  if (commonDirectories.size > 1) {
    throw new WorkspaceError(
      "matching workspaces belong to more than one repository; ownership is ambiguous",
      elsewhere.map((candidate) => candidate.worktreePath).join("\n"),
    );
  }
  for (const candidate of elsewhere) {
    const repository = await repositoryOrNull(candidate.worktreePath);
    if (!repository) continue;
    const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
    return { repository, inspected, matched: filterOwned(repository, inspected) };
  }
  return { repository: here, inspected: [], matched: [] };
}

// The single retained workspace a session id owns, without the lifecycle
// checks ownedSession adds; for read-only and bookkeeping commands.
export async function sessionWorkspace(cwd, sessionId) {
  if (!sessionId) throw new WorkspaceError("the operation requires --session <session-id>");
  const located = await locateWorkspaces(cwd, (metadata) => metadata.sessionId === sessionId);
  if (located.matched.length === 0) {
    throw new WorkspaceError(
      "no implementation worktree for this session exists",
      `Session: ${sessionId}. The session may have been adopted by another session or cleaned up; see ibni list.`,
    );
  }
  if (located.matched.length > 1) {
    throw new WorkspaceError(
      `session ${sessionId} owns more than one repository worktree; ownership is ambiguous`,
      "Manually inspect the implementation worktrees before further lifecycle operations.",
    );
  }
  return { repository: located.repository, inspected: located.inspected, entry: located.matched[0] };
}

// When cwd stands in a linked implementation worktree, only its own session
// may act from there. cwd's repository is checked separately because the
// session's workspace may be found in another repository altogether.
async function assertCwdWorktreeOwnedBy(cwd, sessionId) {
  const here = await repositoryOrNull(cwd);
  if (!here || here.gitDirectory === here.commonDirectory) return;
  const inspected = await inspectImplementationWorktrees(here.commonDirectory);
  const entry = inspected.find((candidate) =>
    candidate.worktreeExists && candidate.gitDirectory === here.gitDirectory
  );
  if (!entry) return;
  if (!entry.metadata) {
    throw new WorkspaceError("this worktree has no implementation ownership metadata");
  }
  if (entry.metadata.sessionId !== sessionId) {
    throw new WorkspaceError("the session token does not own this implementation worktree");
  }
}

export async function ownedSession(cwd, sessionId) {
  const { repository, entry: owned } = await sessionWorkspace(cwd, sessionId);
  await assertCwdWorktreeOwnedBy(cwd, sessionId);

  const { worktreePath, gitDirectory, metadata } = owned;
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
