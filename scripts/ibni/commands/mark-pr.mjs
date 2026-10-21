import { WorkspaceError } from "../lib/errors.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { updateMetadata } from "../lib/metadata.mjs";
import { ownedSession } from "../lib/session.mjs";

export async function markPullRequest({ cwd = process.cwd(), sessionId, url }) {
  if (!url || !/^https?:\/\//.test(url)) {
    throw new WorkspaceError("mark-pr requires --url <pull-request-url>");
  }
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, async () => {
    const session = await ownedSession(cwd, sessionId);
    if (!session.metadata.publishedSha) {
      throw new WorkspaceError("the implementation branch must be published before recording a pull request");
    }
    await updateMetadata(session, { state: "pr-open", prUrl: url });
    return {
      operation: "mark-pr",
      state: "pr-open",
      branch: session.metadata.branch,
      worktreePath: session.metadata.worktreePath,
      prUrl: url,
    };
  });
}
