import { pullRequestForge } from "../lib/checks.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { assertClean, assertNoGitOperation, cleanOutput, fetchBranch, git, isAncestor, remoteBranchSha } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { updateMetadata } from "../lib/metadata.mjs";
import { ownedSession, validatePublication, validateRemote } from "../lib/session.mjs";

// A stacked pull request targets another task's branch. Once that lower pull
// request merges (or its branch is gone), this one is retargeted at the
// default branch (decision 0026): never by rebase or force push, only after
// the default branch was merged into this branch and that merge is on the
// remote, so the retargeted pull request never shows the lower one's changes
// again. null when the pull request is not stacked; every forge failure is
// reported, never thrown, since a sync must not fail on it.
export async function retargetStack(session, latestDefaultSha) {
  const { repository: { root }, metadata } = session;
  if (!metadata.prUrl) return null;
  try {
    const forge = await pullRequestForge(root, metadata, metadata.prUrl, "retargeting a stacked pull request");
    const request = await forge.changeRequest(root, metadata.prUrl);
    if (request.state !== "OPEN" || !request.baseBranch || request.baseBranch === metadata.defaultBranch) return null;
    const base = request.baseBranch;
    const baseGone = !await remoteBranchSha(root, metadata.pushUrl, base);
    const lower = baseGone ? null : await forge.mergedRequestFor(root, base);
    if (!baseGone && !lower) return { base, retargeted: false, reason: `the pull request into ${base} has not merged yet` };
    const remoteSha = await remoteBranchSha(root, metadata.pushUrl, metadata.branch);
    if (!remoteSha || !await isAncestor(root, latestDefaultSha, remoteSha)) {
      return {
        base, retargeted: false,
        reason: `${base} ${baseGone ? "is gone" : `merged (${lower})`}, but the merge of ${metadata.defaultBranch} into this branch is not published yet`,
        nextAction: `Run ibni publish --session ${metadata.sessionId}; it retargets the pull request at ${metadata.defaultBranch} once the merge is pushed.`,
      };
    }
    await forge.retarget(root, metadata.prUrl, metadata.defaultBranch);
    return { base, retargeted: true, to: metadata.defaultBranch, reason: baseGone ? `${base} is gone` : `${lower} merged` };
  } catch (error) {
    return { retargeted: false, checked: false, reason: `could not check whether the pull request is stacked: ${error.message.split("\n")[0]}` };
  }
}

const withStack = (result, stack) => (stack ? { ...result, stack } : result);
const stackOf = (session, latestDefaultSha, checkStack) => (checkStack ? retargetStack(session, latestDefaultSha) : null);

// publish checks the stack itself once it has pushed, so it passes
// checkStack false.
export async function synchronizeUnlocked(cwd, sessionId, { checkStack = true } = {}) {
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
    return withStack({
      operation: "sync",
      synchronized: true,
      strategy: latestDefaultSha === metadata.baseSha ? "unchanged" : "already-contained",
      requiresRevalidation: false,
      baseSha: latestDefaultSha,
      headSha: head,
      branch: metadata.branch,
      defaultBranch: metadata.defaultBranch,
    }, await stackOf(session, latestDefaultSha, checkStack));
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
  return withStack({
    operation: "sync",
    synchronized: true,
    strategy,
    requiresRevalidation,
    baseSha: latestDefaultSha,
    headSha,
    branch: metadata.branch,
    defaultBranch: metadata.defaultBranch,
  }, await stackOf(session, latestDefaultSha, checkStack));
}

export async function synchronizeWorkspace({ cwd = process.cwd(), sessionId }) {
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, () => synchronizeUnlocked(cwd, sessionId));
}
