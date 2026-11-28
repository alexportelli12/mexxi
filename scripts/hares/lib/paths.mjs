// Where hares keeps its files. Tests pass an explicit directory instead.
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, ".local", "share");
  const dir = path.join(base, "mexxi", "hares");
  // hares kept its files in mexxi/segwi under its old name: move them once, and only when hares has none yet.
  const legacy = path.join(base, "mexxi", "segwi");
  if (!existsSync(dir) && existsSync(legacy)) renameSync(legacy, dir);
  return dir;
}

// The installer's state directory: it holds the MCP token's hash and the VAPID keys.
export function stateDir({ home = os.homedir() } = {}) {
  return path.join(home, ".local", "share", "mexxi", "state");
}

// Private to the user: run files hold per-run secrets.
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
