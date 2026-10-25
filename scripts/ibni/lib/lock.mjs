import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "./errors.mjs";

// Keep the legacy lock name so old and new CLI versions serialize on the same
// Git repository during an incremental installation.
export const LOCK_DIRECTORY = "opencode-implementation.lock";

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

// A lock is a directory holding its owner's pid, so a lock left by a process
// that died is taken over rather than waited on. what names it in errors.
async function acquireLock(lockPath, what) {
  const owner = {
    hostname: os.hostname(),
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  const deadline = Date.now() + 30_000;
  let unreadableSince = null;
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return { lockPath, owner };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
      } catch {
        unreadableSince ??= Date.now();
        if (Date.now() - unreadableSince < 500) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw new WorkspaceError(
          `${what} has no readable owner`,
          `Inspect ${lockPath}; it was not removed automatically because ownership is ambiguous.`,
        );
      }
      unreadableSince = null;
      if (existing.hostname !== os.hostname() || processIsAlive(existing.pid)) {
        if (Date.now() >= deadline) {
          throw new WorkspaceError(
            `timed out waiting for the ${what}`,
            `Lock owner: pid ${existing.pid} on ${existing.hostname}, started ${existing.startedAt}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      const stalePath = `${lockPath}.stale-${owner.token}`;
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    }
  }
}

export function acquireRepositoryLock(commonDirectory) {
  return acquireLock(path.join(commonDirectory, LOCK_DIRECTORY), "repository lifecycle lock");
}

export async function releaseRepositoryLock(lock) {
  try {
    const existing = JSON.parse(await readFile(path.join(lock.lockPath, "owner.json"), "utf8"));
    if (existing.token === lock.owner.token) {
      await rm(lock.lockPath, { recursive: true, force: true });
    }
  } catch {
    // A missing or replaced lock must not cause a successful Git operation to fail.
  }
}

export async function withRepositoryLock(commonDirectory, operation) {
  const lock = await acquireRepositoryLock(commonDirectory);
  try {
    return await operation();
  } finally {
    await releaseRepositoryLock(lock);
  }
}

// Machine-wide state, such as which ports each workspace holds, spans every
// repository, so its lock lives under paths.worktreeRoot rather than in one
// repository's Git directory.
export const MACHINE_STATE_DIRECTORY = ".ibni";

export async function withMachineLock(worktreeRoot, name, operation) {
  const directory = path.join(worktreeRoot, MACHINE_STATE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const lock = await acquireLock(path.join(directory, `${name}.lock`), `machine-wide ${name} lock`);
  try {
    return await operation();
  } finally {
    await releaseRepositoryLock(lock);
  }
}
