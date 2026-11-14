// Per-session state for the post-tool hooks: one small JSON file per agent
// session under ~/.local/share/mexxi/state/<hook>/, named by a hash of the
// session id, and swept when it has not been touched for a week (an abandoned
// session never cleans up after itself).
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionStateDirectory(hook, home = os.homedir()) {
  return path.join(home, ".local/share/mexxi/state", hook);
}

export function sessionFile(directory, sessionId) {
  const name = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  return path.join(directory, `${name}.json`);
}

export async function pruneStale(directory, now = Date.now()) {
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > STALE_AFTER_MS) await rm(file, { force: true });
  }
}
