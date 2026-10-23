// Claude Code's settings.json belongs to the user, so the installer merges only
// what it owns: the production deny rules from config.json, the Bash timeout
// cap, transcript retention and the guard and loop-breaker hooks. A state file
// records exactly which deny entries, env keys, top-level keys and hook groups
// were added, so a later config change removes only those, and `install --check` can tell a hand-removed owned entry
// from the user's own settings.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeHooks, mergeOwnedHooks, readJson } from "./host-hooks.mjs";

export const TIMEOUT_KEY = "BASH_MAX_TIMEOUT_MS";
// Claude Code deletes transcripts older than this; a retro reads them.
export const RETENTION_KEY = "cleanupPeriodDays";

// Prefix rules, as the plan's starter list spells them: "firebase deploy"
// denies Bash(firebase deploy:*). segwi renders its per-run settings with the same rules.
export function denyRules(patterns) {
  return patterns.map((pattern) => `Bash(${pattern}:*)`);
}

export function desiredSettings(config) {
  return {
    deny: denyRules(config.guard.deny),
    env: { [TIMEOUT_KEY]: String(config.claude.bashMaxTimeoutMs) },
    keys: { [RETENTION_KEY]: config.retro.transcriptRetentionDays },
    hooks: claudeHooks(config),
  };
}

// Works out the merge without writing anything. `drift` lists what --check
// reports; `conflicts` stops an install; `settings` and `owned` are what an
// install writes, or null when nothing changes.
export async function planSettingsMerge({ settingsFile, stateFile, desired }) {
  const current = await readJson(settingsFile, "settings.json");
  const state = await readJson(stateFile, "its state file");
  const previous = { deny: state?.deny ?? [], env: state?.env ?? {}, keys: state?.keys ?? {}, hooks: state?.hooks ?? {} };
  const settings = structuredClone(current ?? {});
  const drift = [];
  const conflicts = [];
  const rawDeny = settings.permissions?.deny;
  if (rawDeny !== undefined && !Array.isArray(rawDeny)) conflicts.push(`${settingsFile}: permissions.deny is not an array`);
  const deny = Array.isArray(rawDeny) ? rawDeny : [];
  const owned = { deny: [], env: {}, keys: {}, hooks: {} };

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
  mergeOwnedValues({
    target: env, desired: desired.env, previous: previous.env, owned: owned.env, drift, conflicts,
    label: (key) => `${settingsFile}: env.${key}`,
    hint: (key, present) => `remove it, or set claude.bashMaxTimeoutMs to ${present} in config.json`,
  });
  mergeOwnedValues({
    target: settings, desired: desired.keys, previous: previous.keys, owned: owned.keys, drift, conflicts,
    label: (key) => `${settingsFile}: ${key}`,
    hint: (key, present) => `remove it, or set retro.transcriptRetentionDays to ${present} in config.json`,
  });

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

// Keys mexxi sets in one object of settings.json (env, or the top level). A
// value the user set themselves is a conflict, not something to overwrite.
function mergeOwnedValues({ target, desired, previous, owned, drift, conflicts, label, hint }) {
  for (const [key, value] of Object.entries(desired)) {
    const present = target[key];
    if (present !== undefined && String(present) === String(value)) {
      if (key in previous) owned[key] = value;
    } else if (present === undefined || key in previous) {
      drift.push(`${label(key)} is ${present === undefined ? "missing" : `${present}, config.json asks for ${value}`}`);
      target[key] = value;
      owned[key] = value;
    } else {
      conflicts.push(`${label(key)} is ${present}, not set by mexxi; ${hint(key, present)}`);
    }
  }
  for (const key of Object.keys(previous)) {
    if (key in desired) continue;
    drift.push(`${label(key)} was added by mexxi and is no longer in config.json`);
    delete target[key];
  }
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
