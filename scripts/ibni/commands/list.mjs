import { repositoryAt } from "../lib/git.mjs";
import { inspectImplementationWorktrees, workspaceSummary } from "../lib/metadata.mjs";

export async function listWorkspaces({ cwd = process.cwd() }) {
  const repository = await repositoryAt(cwd);
  const inspected = await inspectImplementationWorktrees(repository.commonDirectory);
  return {
    operation: "list",
    workspaces: inspected
      .filter((entry) => entry.metadata)
      .map((entry) => workspaceSummary(entry)),
  };
}
