import { createHash, randomUUID } from "node:crypto";
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

/**
 * The lock lives in the repository's git directory, unless IBNI_LOCK_ROOT names another folder. segwi sets it:
 * its runs are sandboxed and may not write the git directory itself, so their ibni commands lock there instead.
 */
export function repositoryLockPath(commonDirectory, env = process.env) {
  if (!env.IBNI_LOCK_ROOT) return path.join(commonDirectory, LOCK_DIRECTORY);
  const key = createHash("sha256").update(path.resolve(commonDirectory)).digest("hex").slice(0, 16);
  return path.join(path.resolve(env.IBNI_LOCK_ROOT), `${key}.lock`);
}

export async function acquireRepositoryLock(commonDirectory, env = process.env) {
  const lockPath = repositoryLockPath(commonDirectory, env);
  await mkdir(path.dirname(lockPath), { recursive: true });
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
          "repository lifecycle lock has no readable owner",
          `Inspect ${lockPath}; it was not removed automatically because ownership is ambiguous.`,
        );
      }
      unreadableSince = null;
      if (existing.hostname !== os.hostname() || processIsAlive(existing.pid)) {
        if (Date.now() >= deadline) {
          throw new WorkspaceError(
            "timed out waiting for another implementation workspace operation",
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

/** `env` decides the lock's place; prepare passes `{}` so it always shares the git directory's lock with your own sessions. */
export async function withRepositoryLock(commonDirectory, operation, { env = process.env } = {}) {
  const lock = await acquireRepositoryLock(commonDirectory, env);
  try {
    return await operation();
  } finally {
    await releaseRepositoryLock(lock);
  }
}
