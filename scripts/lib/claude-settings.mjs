// Claude Code's settings.json belongs to the user, so the installer merges only
// what it owns: the production deny rules from config.json, the Bash timeout
// cap and the guard and loop-breaker hooks. A state file records exactly which
// deny entries, env keys and hook groups were added, so a later config change
// removes only those, and `install --check` can tell a hand-removed owned entry
// from the user's own settings.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeHooks, mergeOwnedHooks, readJson } from "./host-hooks.mjs";

export const TIMEOUT_KEY = "BASH_MAX_TIMEOUT_MS";

// Prefix rules, as the plan's starter list spells them: "firebase deploy"
// denies Bash(firebase deploy:*).
export function desiredSettings(config) {
  return {
    deny: config.guard.deny.map((pattern) => `Bash(${pattern}:*)`),
    env: { [TIMEOUT_KEY]: String(config.claude.bashMaxTimeoutMs) },
    hooks: claudeHooks(config),
  };
}

// Works out the merge without writing anything. `drift` lists what --check
// reports; `conflicts` stops an install; `settings` and `owned` are what an
// install writes, or null when nothing changes.
export async function planSettingsMerge({ settingsFile, stateFile, desired }) {
  const current = await readJson(settingsFile, "settings.json");
  const state = await readJson(stateFile, "its state file");
  const previous = { deny: state?.deny ?? [], env: state?.env ?? {}, hooks: state?.hooks ?? {} };
  const settings = structuredClone(current ?? {});
  const drift = [];
  const conflicts = [];
  const rawDeny = settings.permissions?.deny;
  if (rawDeny !== undefined && !Array.isArray(rawDeny)) conflicts.push(`${settingsFile}: permissions.deny is not an array`);
  const deny = Array.isArray(rawDeny) ? rawDeny : [];
  const owned = { deny: [], env: {}, hooks: {} };

  const nextDeny = deny.filter((entry) => {
    if (desired.deny.includes(entry) || !previous.deny.includes(entry)) return true;
    drift.push(`${settingsFile}: deny entry ${entry} was added by mexxi and is no longer in config.json`);
    return false;
  });
  for (const entry of desired.deny) {
    if (nextDeny.includes(entry)) {
      if (previous.deny.includes(entry)) owned.deny.push(entry);
      continue;
    }
    drift.push(`${settingsFile}: deny entry ${entry} is missing`);
    nextDeny.push(entry);
    owned.deny.push(entry);
  }

  const env = settings.env ?? {};
  for (const [key, value] of Object.entries(desired.env)) {
    const present = env[key];
    if (present !== undefined && String(present) === value) {
      if (key in previous.env) owned.env[key] = value;
    } else if (present === undefined || key in previous.env) {
      drift.push(`${settingsFile}: env.${key} is ${present === undefined ? "missing" : `${present}, config.json asks for ${value}`}`);
      env[key] = value;
      owned.env[key] = value;
    } else {
      conflicts.push(`${settingsFile}: env.${key} is ${present}, not set by mexxi; remove it, or set claude.bashMaxTimeoutMs to ${present} in config.json`);
    }
  }
  for (const key of Object.keys(previous.env)) {
    if (key in desired.env) continue;
    drift.push(`${settingsFile}: env.${key} was added by mexxi and is no longer in config.json`);
    delete env[key];
  }

  const hooks = mergeOwnedHooks({ current: settings.hooks, previous: previous.hooks, desired: desired.hooks ?? {}, file: settingsFile });
  drift.push(...hooks.drift);
  conflicts.push(...hooks.conflicts);
  owned.hooks = hooks.owned;
  if (!hooks.conflicts.length) {
    if (Object.keys(hooks.hooks).length) settings.hooks = hooks.hooks;
    else delete settings.hooks;
  }

  // Empty containers mexxi emptied go; ones the user left empty stay.
  if (nextDeny.length) settings.permissions = { ...settings.permissions, deny: nextDeny };
  else if (settings.permissions?.deny) delete settings.permissions.deny;
  if (settings.permissions && !Object.keys(settings.permissions).length) delete settings.permissions;
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;

  const same = JSON.stringify(settings) === JSON.stringify(current ?? {});
  return {
    drift, conflicts, owned,
    settings: same ? null : settings,
    stateChanged: JSON.stringify(owned) !== JSON.stringify(previous),
  };
}

export async function writeSettingsMerge({ settingsFile, stateFile }, plan) {
  if (plan.settings) {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    // Written in place, not renamed over, so a settings.json the user keeps
    // symlinked into dotfiles stays a link.
    await writeFile(settingsFile, `${JSON.stringify(plan.settings, null, 2)}\n`);
  }
  if (plan.stateChanged) {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(plan.owned, null, 2)}\n`);
  }
}
