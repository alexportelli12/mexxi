import { mkdir } from "node:fs/promises";
import { repositorySettings } from "../lib/baseline.mjs";
import { workspaceConfig } from "../lib/config.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { evidenceDirectoryFor, summarizeSetup, updateMetadata } from "../lib/metadata.mjs";
import { sessionRunEnvironment } from "../lib/ports.mjs";
import { ownedSession } from "../lib/session.mjs";
import { lockfilesAt, runSetup, setupPlan } from "../lib/setup.mjs";

// Installs, or reinstalls, the session's dependencies in its worktree: when
// adopt finds them out of date, or after a commit changed a lockfile. The command comes from the default branch's .mexxi.json
// (at baseSha) or the lockfile at HEAD, as prepare resolves it. The lock is
// held only to record the result, never while the install runs.
export async function setupWorkspace({ cwd = process.cwd(), sessionId }) {
  const { repository, metadata } = await ownedSession(cwd, sessionId);
  const settings = await repositorySettings(repository.root, metadata.baseSha);
  const lockfiles = await lockfilesAt(repository.root, "HEAD");
  const evidenceDir = evidenceDirectoryFor(repository.root);
  await mkdir(evidenceDir, { recursive: true });
  const env = sessionRunEnvironment(metadata, await workspaceConfig());
  const setup = await runSetup({ plan: setupPlan(settings, lockfiles), worktreePath: repository.root, evidenceDir, lockfiles, env });
  await withRepositoryLock(repository.commonDirectory, async () => {
    const session = await ownedSession(cwd, sessionId);
    if (session.repository.gitDirectory !== repository.gitDirectory) throw new WorkspaceError("the session's workspace changed while setup ran");
    // The log tail is for the caller; the log itself stays in evidenceDir.
    const { logTail: _tail, ...recorded } = setup;
    await updateMetadata(session, { setup: recorded });
  });
  return { operation: "setup", sessionId, setup: summarizeSetup(setup) };
}
