import { randomBytes } from "node:crypto";
import { WorkspaceError } from "../lib/errors.mjs";
import { checksSummary, pullRequestForge } from "../lib/checks.mjs";
import { changeRequestForge } from "../lib/forge.mjs";
import { assertClean, assertNoGitOperation, cleanOutput, fetchBranch, git, isAncestor, remoteBranchSha, repositoryAt } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { updateMetadata, workspaceSummary } from "../lib/metadata.mjs";
import { locateWorkspaces, ownedSession, validateRemote } from "../lib/session.mjs";
import { dependencyState, lockfilesAt } from "../lib/setup.mjs";
import { verifyRefusal } from "../lib/verification.mjs";

async function readPullRequest(forge, root, prUrl) {
  let request;
  try {
    request = await forge.changeRequest(root, prUrl);
  } catch (error) {
    throw new WorkspaceError(`could not read the pull request from ${forge.label}`, error.message);
  }
  if (!request.headBranch || !request.headSha) {
    throw new WorkspaceError(`${forge.cli} returned an unexpected pull request description`, JSON.stringify(request));
  }
  return request;
}

async function pullRequest(root, metadata, prUrl) {
  const forge = await pullRequestForge(root, metadata, prUrl, "adopt");
  return { forge, request: await readPullRequest(forge, root, prUrl) };
}

const prFields = (request, url) => ({ state: request.state, baseBranch: request.baseBranch ?? null, headSha: request.headSha, url });

// A merged pull request takes no more code, so nothing is adopted: its
// post-merge steps run from the control checkout on the updated default
// branch, where they act on what actually merged (decision 0026).
function mergedReport(request, prUrl, { worktreePath = null, controlWorktreePath = null, defaultBranch = null } = {}) {
  const control = controlWorktreePath ?? "the repository's control checkout";
  return {
    operation: "adopt",
    merged: true,
    adopted: false,
    pr: prFields(request, prUrl),
    worktreePath,
    nextAction: `The pull request has merged, so no worktree takes changes for it. Run the post-merge steps its description lists from ${control}, after updating it to the latest ${defaultBranch ?? "default branch"} (git pull --ff-only there), but only when it is on that branch with no changes; otherwise say so and ask, and never switch its branch or stash. No ibni workspace is needed. A further code change is a new /wettaq.`,
  };
}

// What a fresh follow-up session reads before it changes anything: the
// checks as they stand (never waited on) and how to read the review
// comments. Each part reports its own failure rather than failing adopt.
async function followUpContext(forge, root, prUrl) {
  let checks;
  try {
    checks = checksSummary(await forge.checks(root, prUrl));
  } catch (error) {
    checks = { state: null, reason: `could not read the checks: ${error.message.split("\n")[0]}` };
  }
  const discussion = await forge.discussion(root, prUrl);
  return {
    checks,
    reviewComments: {
      ...discussion,
      nextAction: `Read the pull request's comments and review comments before changing anything: ${discussion.commands.join(" ; ")}`,
    },
  };
}

// No retained workspace records the URL: when it names a merged pull request
// on a forge (read from the URL alone), say so instead of refusing, since a
// merged pull request's workspace is often cleaned up already.
async function mergedWithoutWorkspace(cwd, prUrl) {
  const forge = changeRequestForge({ name: null }, prUrl);
  if (!forge.name) return null;
  try {
    const { root } = await repositoryAt(cwd);
    const request = await forge.changeRequest(root, prUrl);
    return request.state === "MERGED" ? mergedReport(request, prUrl, { controlWorktreePath: root }) : null;
  } catch {
    return null;
  }
}

// The workspace that recorded the pull request. When more than one did (a
// retry that ran mark-pr again from a new workspace, say), the owner is picked
// below; the others are reported, never touched. Anything less clear-cut stays
// ambiguous and is refused.
async function workspaceForPullRequest(cwd, prUrl, request = null) {
  const { matched } = await locateWorkspaces(cwd, (metadata) => metadata.prUrl === prUrl);
  if (matched.length === 0) {
    throw new WorkspaceError(
      "no retained workspace records this pull request",
      "adopt only takes over a workspace whose session ran mark-pr with this exact URL; see ibni list.",
    );
  }
  if (matched.length === 1) return { ...matched[0], passedOver: [] };
  const ambiguous = new WorkspaceError("more than one retained workspace records this pull request; ownership is ambiguous", matched.map((entry) => entry.worktreePath).join("\n"));
  if (!request?.headSha) throw ambiguous;
  // Only a workspace on the pull request's head branch can own it; when more
  // than one is, the one whose HEAD is the head commit or behind it. The
  // ownership proofs that follow still apply to whichever is picked.
  let owners = matched.filter((entry) => entry.metadata.branch === request.headBranch);
  if (owners.length > 1) {
    const onLine = [];
    for (const entry of owners) {
      const head = cleanOutput(await git(entry.worktreePath, ["rev-parse", "HEAD"], { allowedExitCodes: [0, 128] }));
      // A head behind the pull request's is compared once its commits are here.
      const behind = head === request.headSha || (head && await fetchBranch(entry.worktreePath, entry.metadata.pushUrl, entry.metadata.branch)
        .then(() => isAncestor(entry.worktreePath, head, request.headSha), () => false));
      if (behind) onLine.push(entry);
    }
    owners = onLine;
  }
  if (owners.length !== 1) throw ambiguous;
  const passedOver = matched.filter((entry) => entry !== owners[0])
    .map((entry) => ({ worktreePath: entry.worktreePath, branch: entry.metadata.branch, reason: "its branch is not the pull request's head branch, or its HEAD is off that branch's line" }));
  return { ...owners[0], passedOver };
}

// A publish or sync interrupted in a session that is gone leaves
// pendingOperation set, and every lifecycle command refuses the workspace.
// Under the repository lock no live session can be mid-operation (both hold
// it throughout), so adopt settles it where the outcome is provable: the push
// landed or it did not; the sync left HEAD where it started. Any other state
// is left for a person. Returns what it settled, or null.
async function settleInterruptedOperation(located) {
  const { metadata, worktreePath, gitDirectory } = located;
  const operation = metadata.pendingOperation;
  if (!operation) return null;
  const unclear = new WorkspaceError(`the implementation has an incomplete ${operation.type} operation whose outcome adopt cannot prove`, "Inspect the retained worktree and remote state; automatic recovery would require guessing.");
  const session = { repository: { gitDirectory }, metadata };
  if (operation.type === "publication") {
    const remoteSha = await remoteBranchSha(worktreePath, metadata.pushUrl, metadata.branch);
    if (remoteSha === operation.headSha) {
      await updateMetadata(session, { publishedSha: operation.headSha, pendingOperation: null });
      return { type: "publication", outcome: "pushed", headSha: operation.headSha };
    }
    if (remoteSha === (operation.priorPublishedSha ?? null)) {
      await updateMetadata(session, { pendingOperation: null });
      return { type: "publication", outcome: "not pushed" };
    }
    throw unclear;
  }
  if (operation.type === "synchronization") {
    const head = cleanOutput(await git(worktreePath, ["rev-parse", "HEAD"]));
    const repository = await repositoryAt(worktreePath);
    const untouched = head === operation.originalHead
      && await assertNoGitOperation(repository).then(() => true, () => false)
      && await assertClean(worktreePath, "the implementation worktree").then(() => true, () => false);
    if (!untouched) throw unclear;
    await updateMetadata(session, { pendingOperation: null });
    return { type: "synchronization", outcome: "not applied" };
  }
  throw unclear;
}

// Ownership moves; it is never shared. adopt proves that the workspace is
// exactly what the pull request shows: the PR is open, its head branch is the
// recorded branch, and its head commit is the recorded publication, the remote
// branch and the clean local HEAD. Only then does it issue a new session id,
// which retires the previous one, so two sessions can never both drive one
// workspace. Every ownership check runs before ownership moves, and a refused
// adoption keeps the old session. Two provable corrections may already have
// been written by then: a dead session's settled pendingOperation, and a
// clean worktree fast-forwarded to the pull request's head.
export async function adoptWorkspace({ cwd = process.cwd(), prUrl }) {
  if (!prUrl || !/^https?:\/\//.test(prUrl)) throw new WorkspaceError("adopt requires --pr <pull-request-url>");
  const recorders = await locateWorkspaces(cwd, (metadata) => metadata.prUrl === prUrl);
  if (recorders.matched.length === 0) {
    const merged = await mergedWithoutWorkspace(cwd, prUrl);
    if (merged) return merged;
  }
  // Read once from any recording workspace: a merged pull request is reported
  // before any ownership check (nothing is taken over, so a dirty or busy
  // worktree does not matter to it), and the head picks the owner among
  // several recorders.
  const probe = recorders.matched[0];
  const first = probe ? await pullRequest(probe.worktreePath, probe.metadata, prUrl).catch(() => null) : null;
  if (first?.request.state === "MERGED") return mergedReport(first.request, prUrl, probe.metadata);
  const initial = await workspaceForPullRequest(cwd, prUrl, first?.request);
  const previousSessionId = initial.metadata.sessionId;
  const commonDirectory = initial.metadata.commonDirectory;
  const adopted = await withRepositoryLock(commonDirectory, async () => {
    const located = await workspaceForPullRequest(cwd, prUrl, first?.request);
    if (located.metadata.sessionId !== previousSessionId) {
      throw new WorkspaceError("the workspace changed owner while it was being adopted");
    }
    const settled = await settleInterruptedOperation(located);
    // The previous owner's lifecycle checks (metadata path, branch, no pending
    // operation) apply unchanged before ownership can move.
    const session = await ownedSession(located.worktreePath, previousSessionId);
    const { repository, metadata } = session;
    await assertClean(repository.root, "the implementation worktree", "Uncommitted work belongs to the session that made it; adopt refuses rather than take it over.");
    await assertNoGitOperation(repository);
    await validateRemote(session);
    if (!metadata.publishedSha) throw new WorkspaceError("the workspace has never been published");

    const { forge, request: remote } = await pullRequest(repository.root, metadata, prUrl);
    if (remote.state === "MERGED") return { result: mergedReport(remote, prUrl, metadata) };
    if (remote.state !== "OPEN") {
      throw new WorkspaceError(`the pull request is ${remote.state.toLowerCase()}, not open`, "Only an open pull request can take follow-up changes; start a new /wettaq instead.");
    }
    if (remote.headBranch !== metadata.branch) {
      throw new WorkspaceError("the pull request's head branch does not match the workspace", `Pull request: ${remote.headBranch}; workspace: ${metadata.branch}`);
    }
    const remoteSha = await remoteBranchSha(repository.root, metadata.pushUrl, metadata.branch);
    let head = cleanOutput(await git(repository.root, ["rev-parse", "HEAD"]));
    const heads = { pullRequest: remote.headSha, recorded: metadata.publishedSha, remote: remoteSha, local: head };
    const mismatch = () => new WorkspaceError(
      "the pull request, remote branch, recorded publication and local HEAD do not all match",
      `${Object.entries(heads).map(([name, sha]) => `${name}: ${sha ?? "none"}`).join("; ")}. Unpublished or outside commits mean another session may still be working; resolve that before adopting.`,
    );
    // Someone pushed to the pull request (a reviewer's suggestion, say):
    // the clean worktree is fast-forwarded to it, which loses nothing. A
    // local commit the remote lacks, or diverged history, is still refused.
    let fastForwarded = null;
    if (!remoteSha || remote.headSha !== remoteSha) throw mismatch();
    if (head !== remoteSha || metadata.publishedSha !== remoteSha) {
      await fetchBranch(repository.root, metadata.pushUrl, metadata.branch);
      const behind = await isAncestor(repository.root, head, remoteSha) && await isAncestor(repository.root, metadata.publishedSha, remoteSha);
      if (!behind) throw mismatch();
      await git(repository.root, ["merge", "--ff-only", "--quiet", remoteSha]);
      fastForwarded = { from: head, to: remoteSha };
      head = remoteSha;
      await updateMetadata(session, { publishedSha: remoteSha });
    }

    const sessionId = randomBytes(12).toString("hex");
    const adoptedAt = new Date().toISOString();
    await updateMetadata(session, {
      sessionId,
      adoptions: [...(metadata.adoptions ?? []), { previousSessionId, sessionId, headSha: head, adoptedAt }],
    });
    // Reported, never acted on: a reinstall or a verify run is the new
    // session's choice, and a workspace from before ibni recorded either
    // still adopts.
    const treeSha = cleanOutput(await git(repository.root, ["rev-parse", "HEAD^{tree}"]));
    const verifyGap = verifyRefusal(session.metadata, treeSha, "carry on");
    return {
      forge,
      root: repository.root,
      result: {
        operation: "adopt",
        ...workspaceSummary({ metadata: session.metadata }),
        headSha: head,
        pr: prFields(remote, prUrl),
        ...(fastForwarded ? { fastForwarded } : {}),
        ...(settled ? { settled } : {}),
        ...(located.passedOver.length ? { passedOver: located.passedOver } : {}),
        dependencies: dependencyState(session.metadata.setup, await lockfilesAt(repository.root, "HEAD"), sessionId),
        verified: verifyGap ? { current: false, ...verifyGap } : { current: true },
      },
    };
  });
  // Read once ownership has moved, outside the lock, since the forge can be slow.
  if (!adopted.forge) return adopted.result;
  return { ...adopted.result, ...await followUpContext(adopted.forge, adopted.root, prUrl) };
}
