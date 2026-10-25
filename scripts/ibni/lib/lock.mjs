import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "./errors.mjs";

const ORPHANED_LOCK_MS = 60_000;

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
// With wait false, a lock a live process holds returns null at once; about
// is recorded with the owner, for anyone reading who holds it.
async function acquireLock(lockPath, what, { wait = true, about = {} } = {}) {
  const owner = {
    ...about,
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
      // Renamed into place, so a reader never sees half an owner.
      const temporary = path.join(lockPath, `owner.${owner.token}.tmp`);
      await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      await rename(temporary, path.join(lockPath, "owner.json"));
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
        // A run slot is never ambiguous for long: its owner is written within
        // milliseconds of the directory, so one still ownerless after a minute
        // was left by a process that died in between, and every run on the
        // machine would otherwise fail on it.
        if (!wait) {
          const age = Date.now() - ((await stat(lockPath).catch(() => null))?.mtimeMs ?? Date.now());
          if (age < ORPHANED_LOCK_MS) return null;
          await rm(lockPath, { recursive: true, force: true });
          unreadableSince = null;
          continue;
        }
        throw new WorkspaceError(
          `${what} has no readable owner`,
          `Inspect ${lockPath}; it was not removed automatically because ownership is ambiguous.`,
        );
      }
      unreadableSince = null;
      if (existing.hostname !== os.hostname() || processIsAlive(existing.pid)) {
        if (!wait) return null;
        if (Date.now() >= deadline) {
          throw new WorkspaceError(
            `timed out waiting for the ${what}`,
            `Lock owner: pid ${existing.pid} on ${existing.hostname}, started ${existing.startedAt}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      // Another waiter may have taken the dead owner's lock between the read
      // and the rename, so what was moved aside is checked before it goes: a
      // live owner's lock is put back, and the next pass sees it held.
      const stalePath = `${lockPath}.stale-${owner.token}`;
      try {
        await rename(lockPath, stalePath);
        const moved = JSON.parse(await readFile(path.join(stalePath, "owner.json"), "utf8").catch(() => "{}"));
        if (moved.token && moved.token !== existing.token) {
          await rename(stalePath, lockPath).catch(() => {});
          continue;
        }
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

const SLOT_POLL_MS = 250;

// A waiter that was killed never reaches its finally, so its entry stays;
// every waiter drops entries whose process is gone, so the queue stays true.
async function pruneQueue(queue) {
  for (const name of await readdir(queue).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const entry = JSON.parse(await readFile(path.join(queue, name), "utf8").catch(() => "{}"));
    if (entry.hostname === os.hostname() && Number.isInteger(entry.pid) && !processIsAlive(entry.pid)) {
      await rm(path.join(queue, name), { force: true });
    }
  }
}

// At most `slots` setup or verify runs at once on this machine, whatever the
// repository: two eduline verify runs together take 29% longer, and three make
// its unit tests time out. A run beyond that waits for a free slot, for as
// long as it takes, in a queue file others can read, and reports how long it
// waited. A slot whose process died is taken over; its queue entry is pruned.
export async function withRunSlot(worktreeRoot, slots, about, operation) {
  const directory = path.join(worktreeRoot, MACHINE_STATE_DIRECTORY, "slots");
  const queue = path.join(directory, "queue");
  await mkdir(queue, { recursive: true });
  const queuedAt = Date.now();
  const waiting = path.join(queue, `${process.pid}-${randomUUID()}.json`);
  let lock = null;
  try {
    while (!lock) {
      for (let slot = 0; slot < slots && !lock; slot += 1) {
        lock = await acquireLock(path.join(directory, `slot-${slot}`), "run slot", { wait: false, about: { ...about, queuedAt: new Date(queuedAt).toISOString() } });
      }
      if (lock) break;
      await writeFile(waiting, `${JSON.stringify({ ...about, hostname: os.hostname(), pid: process.pid, queuedAt: new Date(queuedAt).toISOString() })}\n`, { flag: "wx", mode: 0o600 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      await pruneQueue(queue);
      await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS));
    }
  } finally {
    await rm(waiting, { force: true });
  }
  const queuedMs = Date.now() - queuedAt;
  try {
    return { queuedMs, result: await operation() };
  } finally {
    await releaseRepositoryLock(lock);
  }
}
