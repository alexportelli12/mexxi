// The `segwi` key of config.json, read by the same loader the installer uses,
// with repository paths expanded and the pieces a run needs gathered in one place.
import os from "node:os";
import path from "node:path";
import { ConfigError, expandHome, loadConfig } from "../../lib/config.mjs";

export const ACTIONS = ["build", "ready", "ask"];
export const PERMISSION_MODES = ["auto", "sandboxed", "strict"];
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

// Names that resolve to this machine or its local network, and public services that answer any name with the
// address it spells, such as 127.0.0.1.nip.io. The sandbox's proxy runs outside the sandbox, so allowing one would
// let a run reach what listens here, segwi's own port included. A guard against the obvious ones, not a guarantee:
// any name can be pointed at this machine.
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "nip.io", "sslip.io", "localtest.me", "lvh.me"];

/** Why a host can't go on a run's network allow list, or null when it can. The schema's pattern checks its shape. */
export function allowedDomainProblem(domain) {
  const name = domain.replace(/^\*\./, "");
  if (LOCAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) return "names a local host, which would let a run reach this machine";
  return null;
}

function checkDomains(domains, at) {
  for (const domain of domains) {
    const problem = allowedDomainProblem(domain);
    if (problem) throw new ConfigError(`${at}: "${domain}" ${problem}`);
  }
}

/** The hosts a run may reach besides the built-in ones: segwi.allowedDomains and then its repository's own. */
export function allowedDomainsFor({ segwi, repository }) {
  return [...new Set([...(segwi.allowedDomains ?? []), ...(repository?.allowedDomains ?? [])])];
}

/**
 * @typedef {{ name: string, path: string, actions: string[], permissions?: string, allowedDomains?: string[] }} Repository
 * @typedef {{
 *   segwi: { enabled: boolean, bind: { host: string, port: number }, runner: string, repositories: Repository[],
 *            auth: { web: { mode: string, header: string, allowed: string[], hostname: string } },
 *            limits: Record<string, number>, push: boolean, vapidSubject: string, allowUnsandboxed: boolean,
 *            permissions: string, branchPrefixes: string[], allowedDomains: string[] },
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
    checkDomains(repository.allowedDomains ?? [], `segwi.repositories: ${repository.name}'s allowedDomains`);
    return { ...repository, path: path.resolve(expandHome(repository.path, home)) };
  });
  checkDomains(segwi.allowedDomains ?? [], "segwi.allowedDomains");
  const subjectProblem = vapidSubjectProblem(segwi.vapidSubject ?? "");
  if (subjectProblem) throw new ConfigError(`segwi.vapidSubject: "${segwi.vapidSubject}" ${subjectProblem}`);
  return { segwi, deny: [...config.guard.deny], worktreeRoot: config.paths.worktreeRoot, browser: config.browser, workflowPorts: config.workflow.ports, branchPrefix: config.workflow.branchPrefix };
}

/**
 * The permissions mode a run uses (see segwi.permissions): its repository's own, else segwi.permissions. An ask
 * run is always strict: it promises to change nothing, and auto mode approves file edits where a run starts,
 * which for an ask run is your checkout.
 */
export function permissionsFor({ segwi, repository, action }) {
  if (action === "ask") return "strict";
  return repository?.permissions || segwi.permissions || "strict";
}

export async function readSettings({ file, home = os.homedir() } = {}) {
  const { config } = await loadConfig({ ...(file ? { file } : {}), home });
  return settingsFromConfig(config, { home });
}
