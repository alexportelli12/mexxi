// `segwi token rotate [--state-dir <dir>] [--data-dir <dir>]`: the new token goes
// to stdout once (nothing else does), the guidance to stderr, and only its hash
// is stored. The rotation is audited when the database already exists.
import { existsSync } from "node:fs";
import path from "node:path";
import { audit } from "./audit.mjs";
import { dataDir as defaultDataDir, stateDir as defaultStateDir } from "./paths.mjs";
import { openStore } from "./store.mjs";
import { rotate } from "./token.mjs";

const USAGE = "usage: segwi token rotate [--state-dir <dir>] [--data-dir <dir>]";

function flagsFrom(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if ((name !== "--state-dir" && name !== "--data-dir") || !value) throw new Error(USAGE);
    flags[name === "--state-dir" ? "stateDir" : "dataDir"] = path.resolve(value);
  }
  return flags;
}

/** @param {string[]} args the arguments after `token` */
export function runToken(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args[0] !== "rotate") throw new Error(USAGE);
    const flags = flagsFrom(args.slice(1));
    const token = rotate(flags.stateDir ?? defaultStateDir());
    const database = path.join(flags.dataDir ?? defaultDataDir(), "segwi.db");
    if (existsSync(database)) {
      const store = openStore(database);
      try {
        audit(store, { actor: "cli", origin: "cli", action: "token.rotate", outcome: "ok" });
      } finally {
        store.close();
      }
    }
    stdout.write(`${token}\n`);
    stderr.write("segwi: this is the only time the token is shown. Put it in your MCP client now; the old token no longer works.\n");
  } catch (error) {
    stderr.write(`segwi: ${error.message}\n`);
    process.exitCode = 2;
  }
}
