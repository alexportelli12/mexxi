// The `segwi` key of config.json, read by the same loader the installer uses,
// with repository paths expanded and the pieces a run needs gathered in one place.
import os from "node:os";
import path from "node:path";
import { ConfigError, expandHome, loadConfig } from "../../lib/config.mjs";

export const ACTIONS = ["build", "ready", "ask"];
const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Names that never reach a real mailbox or site. Push services (Apple's in particular) refuse
// a VAPID subject on them, so segwi refuses it first, with a clearer message.
const PLACEHOLDER_SUFFIXES = ["localhost", "local", "internal", "invalid", "test", "example", "lan", "home.arpa"];
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;

/** Why a VAPID subject would be refused by push services, or null when it is usable (or empty). */
export function vapidSubjectProblem(subject) {
  if (subject === "") return null;
  let host = null;
  if (subject.startsWith("mailto:")) {
    const address = subject.slice("mailto:".length);
    const at = address.lastIndexOf("@");
    host = at > 0 && !/[\s/?]/.test(address) ? address.slice(at + 1) : null;
  } else if (subject.startsWith("https://")) {
    try {
      const url = new URL(subject);
      host = url.username || url.password ? null : url.hostname;
    } catch {
      host = null;
    }
  }
  if (!host) return "must be a mailto: address or an https:// URL";
  const name = host.toLowerCase().replace(/\.$/, "");
  if (IP_LITERAL.test(name)) return `uses the address ${host}; push services want a real domain name`;
  if (!name.includes(".") || PLACEHOLDER_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) {
    return `uses ${host}, which push services refuse as a placeholder; use a domain you own`;
  }
  return null;
}

/**
 * @typedef {{ name: string, path: string, actions: string[] }} Repository
 * @typedef {{
 *   segwi: { enabled: boolean, bind: { host: string, port: number }, runner: string, repositories: Repository[],
 *            auth: { web: { mode: string, header: string, allowed: string[], hostname: string } },
 *            limits: Record<string, number>, push: boolean, vapidSubject: string },
 *   deny: string[], worktreeRoot: string, browser: object }} Settings
 */

/** Turns a resolved config into segwi settings, or throws a ConfigError saying what is wrong. */
export function settingsFromConfig(config, { home = os.homedir() } = {}) {
  const segwi = structuredClone(config.segwi);
  const seen = new Set();
  segwi.repositories = segwi.repositories.map((repository) => {
    if (!REPO_NAME.test(repository.name)) {
      throw new ConfigError(`segwi.repositories: name "${repository.name}" must be lower-case letters, digits, dots, dashes or underscores (up to 64)`);
    }
    if (seen.has(repository.name)) throw new ConfigError(`segwi.repositories: name "${repository.name}" appears twice`);
    seen.add(repository.name);
    const unknown = repository.actions.filter((action) => !ACTIONS.includes(action));
    if (unknown.length) throw new ConfigError(`segwi.repositories: ${repository.name} has unknown actions ${unknown.join(", ")}`);
    return { ...repository, path: path.resolve(expandHome(repository.path, home)) };
  });
  const names = new Set();
  segwi.extensions = (segwi.extensions ?? []).map((folder) => {
    const resolved = path.resolve(expandHome(folder, home));
    const name = path.basename(resolved);
    if (!REPO_NAME.test(name)) throw new ConfigError(`segwi.extensions: folder name "${name}" must be lower-case letters, digits, dots, dashes or underscores (up to 64)`);
    if (names.has(name)) throw new ConfigError(`segwi.extensions: two folders are named "${name}"`);
    if (name === "tokens.css") throw new ConfigError(`segwi.extensions: "${name}" is a name segwi serves itself; rename the folder`);
    names.add(name);
    return resolved;
  });
  const subjectProblem = vapidSubjectProblem(segwi.vapidSubject ?? "");
  if (subjectProblem) throw new ConfigError(`segwi.vapidSubject: "${segwi.vapidSubject}" ${subjectProblem}`);
  return { segwi, deny: [...config.guard.deny], worktreeRoot: config.paths.worktreeRoot, browser: config.browser, workflowPorts: config.workflow.ports };
}

/**
 * Reads config.json for segwi. A config from before decision 0016 may still name the sandbox and permissions keys;
 * they are ignored, and `warn` hears one line naming each to delete.
 */
export async function readSettings({ file, home = os.homedir(), warn = (message) => console.warn(message) } = {}) {
  const { config, retired, file: source } = await loadConfig({ ...(file ? { file } : {}), home });
  if (retired.length) warn(`segwi ignores these keys in ${source}, which no longer do anything; delete them: ${retired.join(", ")}`);
  return settingsFromConfig(config, { home });
}
