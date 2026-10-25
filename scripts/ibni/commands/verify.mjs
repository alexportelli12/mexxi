import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_VERIFY_COMMAND, repositorySettings, verifyCommandFrom } from "../lib/baseline.mjs";
import { workspaceConfig } from "../lib/config.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { assertClean, assertNoGitOperation, cleanOutput, git } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { logTail, runLoggedInSlot, scopeFields } from "../lib/logged-run.mjs";
import { evidenceDirectoryFor, sessionVerifyCommand, updateMetadata } from "../lib/metadata.mjs";
import { busyPorts, recordedBlock, sessionRunEnvironment } from "../lib/ports.mjs";
import { ownedSession } from "../lib/session.mjs";

const DIRTY_HINT = "ibni verify binds its result to a committed tree. Commit the change first (or, before any commit, leave the tree at baseSha for the baseline run), then run it again.";

const committedState = async (root) => ({
  headSha: cleanOutput(await git(root, ["rev-parse", "HEAD"])),
  treeSha: cleanOutput(await git(root, ["rev-parse", "HEAD^{tree}"])),
  dirty: (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.length > 0,
});

const treeOf = async (root, sha) => cleanOutput(await git(root, ["rev-parse", `${sha}^{tree}`]));

async function packageVerifyScriptAt(root, sha) {
  const result = await git(root, ["show", `${sha}:package.json`], { allowedExitCodes: [0, 128] });
  try {
    return result.code === 0 && typeof JSON.parse(result.stdout)?.scripts?.verify === "string";
  } catch {
    return false;
  }
}

// The command that gates the session: its recorded verifyCommand, read from
// the default branch. A branch never replaces a gate the default branch has.
// Only when the default branch has none at all (no verify in .mexxi.json and
// no verify script for the default) is the one the branch adds the gate, as
// when /lesti makes a repository mexxi-ready; commandSource then says so.
async function gatingCommand(root, metadata, headSha) {
  const command = sessionVerifyCommand(metadata);
  if (command !== DEFAULT_VERIFY_COMMAND || await packageVerifyScriptAt(root, metadata.baseSha)) return { command, commandSource: "default-branch" };
  const branchCommand = verifyCommandFrom(await repositorySettings(root, headSha));
  return { command: branchCommand, commandSource: branchCommand === command ? "default-branch" : "branch" };
}

// Records the result in one metadata write, under the lock and only while the
// session still owns the worktree, with the tree exactly as it was when the run
// started: a commit or an edit during the run leaves the result unrecorded.
// Only the start and the end are compared, so an edit undone before the run
// ends goes unnoticed (decision 0014 accepts that).
async function recordVerification(cwd, sessionId, started, verification) {
  return withRepositoryLock(started.repository.commonDirectory, async () => {
    const session = await ownedSession(cwd, sessionId);
    const now = await committedState(session.repository.root);
    if (now.headSha !== started.headSha) {
      return { recorded: false, reason: "HEAD moved while verify ran, so the result belongs to no committed tree; run ibni verify again" };
    }
    if (now.dirty) {
      // Often the verify command's own output, such as a report it leaves behind.
      const changed = cleanOutput(await git(session.repository.root, ["status", "--short", "--untracked-files=all"])).split("\n").slice(0, 5).join("; ");
      return { recorded: false, reason: `the worktree was not clean when verify ended (${changed}); commit or remove those changes, or gitignore what the verify command writes, then run ibni verify again` };
    }
    const record = {
      kind: "verify", at: verification.ranAt, sessionId, outcome: verification.passed ? "pass" : "fail", treeSha: verification.treeSha, source: "ibni",
      durationMs: verification.durationMs, queuedMs: verification.queuedMs, ...(verification.resources ?? {}),
    };
    await updateMetadata(session, { verification, records: [...(session.metadata.records ?? []), record] });
    return { recorded: true };
  });
}

// Runs the session's verify command on its committed tree. Before any commit
// the tree is baseSha's, so this is also the baseline run; when prepare proved
// a green CI run of that exact tree (baseline.reused), it is cited instead of
// rerun. The lock is held only to check and to record, never during the run,
// so the run can take as long as it needs in the background.
export async function verifyWorkspace({ cwd = process.cwd(), sessionId }) {
  const initial = await ownedSession(cwd, sessionId);
  const started = await withRepositoryLock(initial.repository.commonDirectory, async () => {
    const session = await ownedSession(cwd, sessionId);
    await assertClean(session.repository.root, "the implementation worktree", DIRTY_HINT);
    await assertNoGitOperation(session.repository);
    return { ...session, ...await committedState(session.repository.root) };
  });
  const { repository, metadata, headSha, treeSha } = started;
  const { command, commandSource } = await gatingCommand(repository.root, metadata, headSha);
  const ranAt = new Date().toISOString();
  const baselineTree = await treeOf(repository.root, metadata.baseSha);
  const result = (verification, extra = {}) => ({ operation: "verify", sessionId, baseline: treeSha === baselineTree, ...verification, ...extra });

  const { baseline } = metadata;
  if (baseline?.reused && baseline.sha && await treeOf(repository.root, baseline.sha) === treeSha) {
    const verification = {
      treeSha, headSha, passed: true, exitCode: null, durationMs: 0, queuedMs: 0, logPath: null, ranAt, command, commandSource,
      reused: { check: baseline.check, sha: baseline.sha, url: baseline.url ?? null },
    };
    return result(verification, await recordVerification(cwd, sessionId, started, verification));
  }

  // Sessions prepared before evidence directories existed get one on demand.
  const evidenceDir = evidenceDirectoryFor(repository.root);
  await mkdir(evidenceDir, { recursive: true });
  const logPath = path.join(evidenceDir, `verify-${treeSha.slice(0, 12)}.log`);
  const config = await workspaceConfig();
  const env = sessionRunEnvironment(metadata, config);
  // prepare found the block free, but anything can bind a port since; a test
  // server that hits one fails half-way with a less clear EADDRINUSE. Checked
  // once the slot is held, since the wait for it can take minutes.
  const portsFree = async () => {
    const busy = await busyPorts(recordedBlock(metadata));
    if (busy.length) {
      throw new WorkspaceError(
        `port ${busy.join(", ")} of this workspace's block is already in use`,
        "Stop whatever listens there (often a dev server started in this workspace), then run ibni verify again.",
      );
    }
  };
  const outcome = await runLoggedInSlot(config, { sessionId, kind: "verify", worktreePath: repository.root }, { command, cwd: repository.root, logPath, env }, { beforeRun: portsFree });
  const verification = {
    treeSha, headSha, passed: outcome.passed, exitCode: outcome.exitCode, durationMs: outcome.durationMs, queuedMs: outcome.queuedMs, logPath, ranAt, command, commandSource,
    ...scopeFields(outcome),
    ...(outcome.signal ? { signal: outcome.signal } : {}),
  };
  const recorded = await recordVerification(cwd, sessionId, started, verification);
  return result(verification, { ...recorded, ...(outcome.passed ? {} : { logTail: await logTail(logPath) }) });
}
