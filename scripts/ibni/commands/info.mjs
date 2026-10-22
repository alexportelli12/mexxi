import { mkdir } from "node:fs/promises";
import { workspaceConfig } from "../lib/config.mjs";
import { workspaceSummary } from "../lib/metadata.mjs";
import { sessionWorkspace } from "../lib/session.mjs";

export async function workspaceInfo({ cwd = process.cwd(), sessionId }) {
  const { entry } = await sessionWorkspace(cwd, sessionId);
  const summary = workspaceSummary(entry);
  // Sessions prepared before evidence directories existed get one on demand.
  if (entry.worktreeExists) await mkdir(summary.evidenceDir, { recursive: true });
  return {
    operation: "info",
    ...summary,
    // The code-reviewer's agent text is shared by every host, so the
    // orchestrator passes it this setting rather than the text being rendered.
    reviewTool: (await workspaceConfig()).review.tool,
  };
}
