import { WorkspaceError } from "../lib/errors.mjs";
import { assertClean, cleanOutput, git, push, remoteBranchSha } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { updateMetadata } from "../lib/metadata.mjs";
import { ownedSession } from "../lib/session.mjs";
import { synchronizeUnlocked } from "./sync.mjs";

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
      await push(repository.root, [
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
