import { mkdir } from "node:fs/promises";
import { workspaceConfig } from "../lib/config.mjs";
import { detectForge } from "../lib/forge.mjs";
import { workspaceSummary } from "../lib/metadata.mjs";
import { sessionPortEnvironment } from "../lib/ports.mjs";
import { sessionWorkspace } from "../lib/session.mjs";

export async function workspaceInfo({ cwd = process.cwd(), sessionId }) {
  const { entry } = await sessionWorkspace(cwd, sessionId);
  const config = await workspaceConfig();
  const summary = workspaceSummary(entry);
  // Sessions prepared before evidence directories existed get one on demand.
  if (entry.worktreeExists) await mkdir(summary.evidenceDir, { recursive: true });
  // The forge names the CLI that creates and updates the pull request (gh or
  // glab), so agents need not guess it from the remote.
  const forge = entry.worktreeExists
    ? await detectForge({ root: entry.worktreePath, remote: entry.metadata.remote, baseSha: entry.metadata.baseSha, config })
    : { name: null, reason: "the worktree is missing" };
  return {
    operation: "info",
    ...summary,
    // What to export when starting a server by hand, as setup and verify get.
    portEnv: sessionPortEnvironment(entry.metadata, config),
    forge: forge.name,
    forgeReason: forge.name ? null : forge.reason,
    // The code-reviewer's agent text is shared by every host, so the
    // orchestrator passes it this setting rather than the text being rendered.
    reviewTool: config.review.tool,
  };
}
