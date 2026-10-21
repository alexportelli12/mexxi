import { sessionWorkspace } from "../lib/session.mjs";
import { summarizeTimings } from "../lib/timings.mjs";
import { summarizeTriage } from "./triage.mjs";

export async function workspaceStats({ cwd = process.cwd(), sessionId }) {
  const { entry: { metadata } } = await sessionWorkspace(cwd, sessionId);
  return {
    operation: "stats",
    sessionId: metadata.sessionId,
    branch: metadata.branch,
    state: metadata.state,
    prUrl: metadata.prUrl,
    createdAt: metadata.createdAt,
    adoptions: metadata.adoptions ?? [],
    ...summarizeTimings(metadata),
    triage: summarizeTriage(metadata),
  };
}
