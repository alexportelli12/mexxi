import { mkdir } from "node:fs/promises";
import { WorkspaceError } from "../lib/errors.mjs";
import { repositoryAt } from "../lib/git.mjs";
import { inspectImplementationWorktrees, workspaceSummary } from "../lib/metadata.mjs";

export async function workspaceInfo({ cwd = process.cwd(), sessionId }) {
  if (!sessionId) throw new WorkspaceError("info requires --session <session-id>");
  const repository = await repositoryAt(cwd);
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
  const owned = inspected.filter(
    (entry) => entry.metadata?.sessionId === sessionId
      && entry.metadata?.commonDirectory === repository.commonDirectory,
  );
  if (owned.length === 0) {
    throw new WorkspaceError(
      "no implementation worktree for this session exists in this repository",
      `Session: ${sessionId}`,
    );
  }
  if (owned.length > 1) {
    throw new WorkspaceError(
      `session ${sessionId} owns more than one repository worktree; ownership is ambiguous`,
    );
  }
  const summary = workspaceSummary(owned[0]);
  // Sessions prepared before evidence directories existed get one on demand.
  if (owned[0].worktreeExists) await mkdir(summary.evidenceDir, { recursive: true });
  return {
    operation: "info",
    ...summary,
  };
}
