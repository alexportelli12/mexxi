import { repositoryAt } from "../lib/git.mjs";
import { workspaceConfig } from "../lib/config.mjs";
import { inspectImplementationWorktrees, workspaceSummary } from "../lib/metadata.mjs";
import { unmanagedFolders } from "../lib/session.mjs";

export async function listWorkspaces({ cwd = process.cwd() }) {
  const repository = await repositoryAt(cwd);
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
  return {
    operation: "list",
    workspaces: inspected
      .filter((entry) => entry.metadata)
      .map((entry) => workspaceSummary(entry)),
    unmanaged: await unmanagedFolders((await workspaceConfig()).paths.worktreeRoot),
  };
}
