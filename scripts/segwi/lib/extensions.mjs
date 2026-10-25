// Local extensions (decision 0020): folders named in segwi.extensions, each
// adding a page and a JSON API to segwi behind its own identity check, so a
// personal dashboard can live beside the runs without a server of its own.
//
// An extension folder holds:
//   server.mjs  default export async ({ name, dataDir, worktreeRoot }) =>
//               { title?, routes: { "GET /path": handler, ... }, close?() }
//               where handler({ query, body, identity }) returns JSON.
//   public/     its page, served at /ext/<name>/ (index.html first).
// The page can link /ext/tokens.css for segwi's colours and type.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROUTE = /^(GET|POST) (\/[A-Za-z0-9/_-]*)$/;
// segwi listens only once every extension has loaded or been skipped.
const LOAD_TIMEOUT_MS = 10_000;

export function extensionName(folder) {
  return path.basename(folder);
}

// Loads every extension, skipping (and reporting) one that fails, so a broken
// extension never keeps segwi from starting.
export async function loadExtensions(folders, { dataDir, settings, log = (message) => console.error(message) }) {
  const loaded = [];
  for (const folder of folders) {
    const name = extensionName(folder);
    try {
      const module = await import(pathToFileURL(path.join(folder, "server.mjs")).href);
      if (typeof module.default !== "function") throw new Error("server.mjs has no default export function");
      const ownData = path.join(dataDir, "ext", name);
      mkdirSync(ownData, { recursive: true, mode: 0o700 });
      // Only what the contract names: an extension has no use for sign-in
      // settings or the repository list, so it is not handed them.
      let timer;
      const extension = await Promise.race([
        module.default({ name, dataDir: ownData, worktreeRoot: settings.worktreeRoot }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`it did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s`)), LOAD_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      const routes = new Map();
      for (const [key, handler] of Object.entries(extension?.routes ?? {})) {
        if (!ROUTE.test(key) || typeof handler !== "function") throw new Error(`route "${key}" must be "GET /path" or "POST /path" with a handler`);
        routes.set(key, handler);
      }
      loaded.push({ name, title: typeof extension.title === "string" ? extension.title : name, root: path.join(folder, "public"), routes, close: extension.close });
    } catch (error) {
      log(`segwi: extension ${name} (${folder}) was not loaded: ${error.message}`);
    }
  }
  return loaded;
}

export async function closeExtensions(extensions) {
  for (const extension of extensions) await Promise.resolve(extension.close?.()).catch(() => {});
}
