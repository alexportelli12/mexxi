import { randomBytes } from "node:crypto";
import { WorkspaceError } from "../lib/errors.mjs";
import { assertClean, assertNoGitOperation, cleanOutput, git, remoteBranchSha, run } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { updateMetadata, workspaceSummary } from "../lib/metadata.mjs";
import { locateWorkspaces, ownedSession, validateRemote } from "../lib/session.mjs";

async function pullRequest(root, prUrl) {
  let result;
  try {
    result = await run("gh", ["pr", "view", prUrl, "--json", "state,headRefName,headRefOid"], { cwd: root, timeout: 30_000 });
  } catch (error) {
    throw new WorkspaceError("could not read the pull request from GitHub", error.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (typeof parsed?.state !== "string" || typeof parsed.headRefName !== "string" || typeof parsed.headRefOid !== "string") {
    throw new WorkspaceError("gh returned an unexpected pull request description", cleanOutput(result));
  }
  return parsed;
}

async function workspaceForPullRequest(cwd, prUrl) {
  const { matched } = await locateWorkspaces(cwd, (metadata) => metadata.prUrl === prUrl);
  if (matched.length === 0) {
    throw new WorkspaceError(
      "no retained workspace records this pull request",
      "adopt only takes over a workspace whose session ran mark-pr with this exact URL; see ibni list.",
    );
  }
  if (matched.length > 1) {
    throw new WorkspaceError("more than one retained workspace records this pull request; ownership is ambiguous");
  }
  return matched[0];
}

// Ownership moves; it is never shared. adopt proves that the workspace is
// exactly what the pull request shows: the PR is open, its head branch is the
// recorded branch, and its head commit is the recorded publication, the remote
// branch and the clean local HEAD. Only then does it issue a new session id,
// which retires the previous one, so two sessions can never both drive one
// workspace. Every check runs before any change; a failure changes nothing.
export async function adoptWorkspace({ cwd = process.cwd(), prUrl }) {
  if (!prUrl || !/^https?:\/\//.test(prUrl)) throw new WorkspaceError("adopt requires --pr <pull-request-url>");
  const initial = await workspaceForPullRequest(cwd, prUrl);
  const previousSessionId = initial.metadata.sessionId;
  const commonDirectory = initial.metadata.commonDirectory;
  return withRepositoryLock(commonDirectory, async () => {
    const located = await workspaceForPullRequest(cwd, prUrl);
    if (located.metadata.sessionId !== previousSessionId) {
      throw new WorkspaceError("the workspace changed owner while it was being adopted");
    }
    // The previous owner's lifecycle checks (metadata path, branch, no pending
    // operation) apply unchanged before ownership can move.
    const session = await ownedSession(located.worktreePath, previousSessionId);
    const { repository, metadata } = session;
    await assertClean(repository.root, "the implementation worktree", "Uncommitted work belongs to the session that made it; adopt refuses rather than take it over.");
    await assertNoGitOperation(repository);
    await validateRemote(session);
    if (!metadata.publishedSha) throw new WorkspaceError("the workspace has never been published");

    const remote = await pullRequest(repository.root, prUrl);
    if (remote.state !== "OPEN") {
      throw new WorkspaceError(`the pull request is ${remote.state.toLowerCase()}, not open`, "Only an open pull request can take follow-up changes; start a new /wettaq instead.");
    }
    if (remote.headRefName !== metadata.branch) {
      throw new WorkspaceError("the pull request's head branch does not match the workspace", `Pull request: ${remote.headRefName}; workspace: ${metadata.branch}`);
    }
    const remoteSha = await remoteBranchSha(repository.root, metadata.pushUrl, metadata.branch);
    const head = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
    const heads = { pullRequest: remote.headRefOid, recorded: metadata.publishedSha, remote: remoteSha, local: head };
    if (new Set(Object.values(heads)).size !== 1) {
      throw new WorkspaceError(
        "the pull request, remote branch, recorded publication and local HEAD do not all match",
        `${Object.entries(heads).map(([name, sha]) => `${name}: ${sha ?? "none"}`).join("; ")}. Unpublished or outside commits mean another session may still be working; resolve that before adopting.`,
      );
    }

    const sessionId = randomBytes(12).toString("hex");
    const adoptedAt = new Date().toISOString();
    await updateMetadata(session, {
      sessionId,
      adoptions: [...(metadata.adoptions ?? []), { previousSessionId, sessionId, headSha: head, adoptedAt }],
    });
    return {
      operation: "adopt",
      ...workspaceSummary({ metadata: session.metadata }),
      headSha: head,
    };
  });
}
