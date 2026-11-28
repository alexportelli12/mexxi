// Where hares keeps its files. Tests pass an explicit directory instead.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir({ env = process.env, home = os.homedir(), log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const base = env.XDG_DATA_HOME ? path.resolve(env.XDG_DATA_HOME) : path.join(home, ".local", "share");
  const dir = path.join(base, "mexxi", "hares");
  // hares kept its files in mexxi/segwi under its old name: move them once, and only while hares has no store of
  // its own yet. The hook may have made mexxi/hares/pending before ħares first started, so a hares folder
  // without segwi.db is no reason to strand segwi's store, push subscriptions and extension data.
  const legacy = path.join(base, "mexxi", "segwi");
  if (existsSync(legacy) && !existsSync(path.join(dir, "segwi.db"))) {
    if (existsSync(dir)) mergeInto(legacy, dir);
    else renameSync(legacy, dir);
    log(`hares: moved its data from ${legacy} to ${dir}`);
  }
  return dir;
}

/**
 * Moves each entry of `from` into `to` (same filesystem, so each move is a rename), into folders both have,
 * and never over a file `to` already has: those are the hook's, newer than anything segwi left. `from` goes
 * once it is empty. Entry by entry, so a record the hook writes meanwhile is never lost.
 */
function mergeInto(from, to) {
  for (const name of readdirSync(from)) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    if (!existsSync(target)) renameSync(source, target);
    else if (lstatSync(source).isDirectory() && lstatSync(target).isDirectory()) mergeInto(source, target);
  }
  if (readdirSync(from).length === 0) rmdirSync(from);
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
