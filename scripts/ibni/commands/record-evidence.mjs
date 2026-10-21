import { assertClean, assertNoGitOperation, cleanOutput, git } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { updateMetadata } from "../lib/metadata.mjs";
import { ownedSession } from "../lib/session.mjs";

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
