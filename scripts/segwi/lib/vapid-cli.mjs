// `segwi vapid init [--state-dir <dir>] [--data-dir <dir>] [--force]`: only the public
// key goes to stdout. The step is audited when the database already exists.
import { existsSync } from "node:fs";
import path from "node:path";
import { audit } from "./audit.mjs";
import { dataDir as defaultDataDir, stateDir as defaultStateDir } from "./paths.mjs";
import { readSettings } from "./settings.mjs";
import { openStore } from "./store.mjs";
import { initVapid } from "./vapid.mjs";

const USAGE = "usage: segwi vapid init [--state-dir <dir>] [--data-dir <dir>] [--force]";

function flagsFrom(args) {
  const flags = { force: false };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--force") flags.force = true;
    else if ((name === "--state-dir" || name === "--data-dir") && args[index + 1]) flags[name === "--state-dir" ? "stateDir" : "dataDir"] = path.resolve(args[++index]);
    else throw new Error(USAGE);
  }
  return flags;
}

/** What else push needs once the keys exist: the contact address push services require. */
async function subjectHint(settings) {
  try {
    const { segwi } = settings ?? (await readSettings());
    if (segwi.vapidSubject) return "Restart segwi serve to start sending push notifications.";
  } catch (error) {
    return `Push stays off until config.json is fixed: ${error.message}`;
  }
  return "Push stays off until you set segwi.vapidSubject in config.json to a mailto: address or https:// URL you own (push services refuse placeholders such as an address at localhost), then restart segwi serve.";
}

/**
 * @param {string[]} args the arguments after `vapid`
 * @param {{ stdout?: object, stderr?: object, settings?: object }} [io] `settings` is for tests; the CLI reads config.json
 */
export async function runVapid(args, { stdout = process.stdout, stderr = process.stderr, settings } = {}) {
  try {
    if (args[0] !== "init") throw new Error(USAGE);
    const flags = flagsFrom(args.slice(1));
    const publicKey = initVapid(flags.stateDir ?? defaultStateDir(), { force: flags.force });
    const database = path.join(flags.dataDir ?? defaultDataDir(), "segwi.db");
    if (existsSync(database)) {
      const store = openStore(database);
      try {
        audit(store, { actor: "cli", origin: "cli", action: "vapid.init", outcome: "ok", detail: flags.force ? "keys replaced" : "keys created" });
      } finally {
        store.close();
      }
    }
    stdout.write(`${publicKey}\n`);
    stderr.write(`segwi: the private key stays in the state directory. ${await subjectHint(settings)}\n`);
  } catch (error) {
    stderr.write(`segwi: ${error.message}\n`);
    process.exitCode = 2;
  }
}
