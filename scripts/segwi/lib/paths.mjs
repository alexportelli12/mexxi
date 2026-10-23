// Where segwi keeps its files. Tests pass an explicit directory instead.
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, ".local", "share");
  return path.join(base, "mexxi", "segwi");
}

// The installer's state directory: it holds the MCP token's hash.
export function stateDir({ home = os.homedir() } = {}) {
  return path.join(home, ".local", "share", "mexxi", "state");
}

// Used from p5 on for the VAPID keys.
export function secretsFile({ home = os.homedir() } = {}) {
  return path.join(home, ".config", "mexxi", "secrets", "segwi.json");
}

// Private to the user: run files hold per-run secrets.
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
