// Build, type-check, lint and test caches a new worktree can start from, copied
// from the control checkout so the first verify run is not a cold one. Each
// tool checks its own cache against the sources, so a stale copy costs only
// a rebuild. Only gitignored paths are considered, so a copy never dirties
// the worktree.
import { cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.mjs";
import { git } from "./git.mjs";

// From one ignored entry, as `git ls-files --directory` names it, the cache
// inside it to copy, or null.
export function cacheFor(entry) {
  const name = path.posix.basename(entry.replace(/\/$/, ""));
  if (entry.endsWith("/")) {
    if (name === ".next") return `${entry}cache`;
    if (name === "node_modules") return `${entry}.vite/vitest`;
    return null;
  }
  return name.endsWith(".tsbuildinfo") || name === ".eslintcache" ? entry : null;
}

// A cache bigger than this is left behind: copying it would slow every
// prepare, and a Next.js cache in particular can reach gigabytes.
export const CACHE_LIMIT_BYTES = 1024 ** 3;

// Its size, measured before copying, or null as soon as it passes limit.
async function sizeWithin(target, limit) {
  const info = await stat(target);
  if (!info.isDirectory()) return info.size <= limit ? info.size : null;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    total += (await stat(path.join(entry.parentPath, entry.name))).size;
    if (total > limit) return null;
  }
  return total;
}

// Runs after setup, since an install such as npm ci replaces node_modules and
// with it a Vitest cache copied earlier. Never overwrites what is there, and
// a cache that fails is removed and reported without stopping the others.
export async function copyWarmCaches(controlRoot, worktreePath, { limit = CACHE_LIMIT_BYTES } = {}) {
  const listing = await git(controlRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  const copied = [];
  const skipped = [];
  let bytes = 0;
  for (const cache of listing.stdout.split("\0").filter(Boolean).map(cacheFor).filter(Boolean)) {
    const name = cache.replace(/\/$/, "");
    const source = path.join(controlRoot, cache);
    const destination = path.join(worktreePath, cache);
    if (!await pathExists(source) || await pathExists(destination)) continue;
    // Without an install there is no node_modules, and creating one for the
    // Vitest cache alone would look like an install that happened.
    if (name.endsWith(".vite/vitest") && !await pathExists(path.join(worktreePath, path.dirname(path.dirname(name))))) continue;
    try {
      const size = await sizeWithin(source, limit);
      if (size === null) {
        skipped.push({ cache: name, reason: `larger than ${Math.round(limit / 1024 ** 2)} MB` });
        continue;
      }
      // Links stay as they are, rather than pointing back into the control checkout.
      await cp(source, destination, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true, verbatimSymlinks: true });
      copied.push(name);
      bytes += size;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      skipped.push({ cache: name, reason: error.message });
    }
  }
  return { copied, skipped, bytes };
}
