// The `segwi` key of config.json, read by the same loader the installer uses,
// with repository paths expanded and the pieces a run needs gathered in one place.
import os from "node:os";
import path from "node:path";
import { ConfigError, expandHome, loadConfig } from "../../lib/config.mjs";

export const ACTIONS = ["build", "ready", "ask"];
const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @typedef {{ name: string, path: string, actions: string[] }} Repository
 * @typedef {{
 *   segwi: { enabled: boolean, bind: { host: string, port: number }, runner: string, repositories: Repository[],
 *            auth: { web: { mode: string, header: string, allowed: string[], hostname: string } },
 *            limits: Record<string, number>, push: boolean },
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
  return { segwi, deny: [...config.guard.deny], worktreeRoot: config.paths.worktreeRoot, browser: config.browser, workflowPorts: config.workflow.ports };
}

export async function readSettings({ file, home = os.homedir() } = {}) {
  const { config } = await loadConfig({ ...(file ? { file } : {}), home });
  return settingsFromConfig(config, { home });
}
