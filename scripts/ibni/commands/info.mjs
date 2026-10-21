import { mkdir } from "node:fs/promises";
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
  };
}
