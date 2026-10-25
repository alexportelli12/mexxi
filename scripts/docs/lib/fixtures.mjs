// The docs suites copy the repository into temporary directories and remove
// them when the file's tests finish. A suite that is killed or times out
// never gets there, and /tmp is often memory that ends up in swap, so each
// suite first removes its own prefix's leftovers. Only directories older
// than an hour go, so a suite running alongside keeps its fixtures.
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STALE_FIXTURE_MS = 60 * 60 * 1000;

export async function sweepStaleFixtures(prefix, { directory = os.tmpdir(), now = Date.now(), maxAgeMs = STALE_FIXTURE_MS } = {}) {
  const removed = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = path.join(directory, entry.name);
    const info = await stat(target).catch(() => null);
    if (!info || now - info.mtimeMs < maxAgeMs || (process.getuid && info.uid !== process.getuid())) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}
