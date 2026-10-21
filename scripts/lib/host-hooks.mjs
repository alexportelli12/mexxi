// The hook entries mexxi owns in Claude Code's settings.json and Codex's
// hooks.json: the shared guard before every shell command and the loop
// breaker after it. Both files belong to the user (and to other tools, such
// as herdr), so entries are merged by ownership, the way claude-settings.mjs
// merges deny rules: a state file records the exact groups mexxi added, a
// later install removes only those, and `install --check` reports one that
// went missing.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function command(checkout, script) {
  return { type: "command", command: `node ${shellQuote(path.join(checkout, "scripts/hooks", script))}` };
}

// Claude Code: PreToolUse covers Bash and Monitor (a monitor's script is a
// shell command). A failed command raises PostToolUseFailure, a successful
// one or an edit PostToolUse, so the loop breaker listens to both.
export function claudeHooks(config) {
  const { checkout } = config.paths;
  return {
    PreToolUse: [{ matcher: "Bash|Monitor", hooks: [command(checkout, "guard.mjs")] }],
    PostToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [command(checkout, "loop-breaker.mjs")] }],
    PostToolUseFailure: [{ matcher: "Bash", hooks: [command(checkout, "loop-breaker.mjs")] }],
  };
}

// Codex: shell commands match as Bash and edits as apply_patch; PostToolUse
// fires for failures too.
export function codexHooks(config) {
  const { checkout } = config.paths;
  return {
    PreToolUse: [{ matcher: "Bash", hooks: [command(checkout, "guard.mjs")] }],
    PostToolUse: [{ matcher: "Bash|apply_patch", hooks: [command(checkout, "loop-breaker.mjs")] }],
  };
}

function describe(event, group) {
  return `${event} hook ${group.matcher ?? "*"} -> ${(group.hooks ?? []).map((hook) => hook.command).join(", ")}`;
}

// Merges the desired groups into a hooks object ({ Event: [group] }) without
// writing. Returns the merged object, the groups mexxi now owns, what
// `install --check` reports and what stops an install.
export function mergeOwnedHooks({ current, previous = {}, desired, file }) {
  const drift = [];
  const conflicts = [];
  if (current !== undefined && (current === null || typeof current !== "object" || Array.isArray(current))) {
    return { hooks: current, owned: previous, drift, conflicts: [`${file}: hooks is not an object`] };
  }
  const hooks = structuredClone(current ?? {});
  const owned = {};
  const key = (group) => JSON.stringify(group);
  for (const event of new Set([...Object.keys(previous), ...Object.keys(desired)])) {
    const list = hooks[event] ?? [];
    if (!Array.isArray(list)) {
      conflicts.push(`${file}: hooks.${event} is not an array`);
      continue;
    }
    const wanted = (desired[event] ?? []).map(key);
    const before = (previous[event] ?? []).map(key);
    const next = list.filter((group) => {
      if (wanted.includes(key(group)) || !before.includes(key(group))) return true;
      drift.push(`${file}: ${describe(event, group)} was added by mexxi and is no longer wanted`);
      return false;
    });
    for (const group of desired[event] ?? []) {
      if (next.some((entry) => key(entry) === key(group))) {
        if (before.includes(key(group))) (owned[event] ??= []).push(group);
        continue;
      }
      drift.push(`${file}: ${describe(event, group)} is missing`);
      next.push(group);
      (owned[event] ??= []).push(group);
    }
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  return { hooks, owned, drift, conflicts };
}

export async function readJson(file, what) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw new Error(`${file} is not a JSON object (${error.message}); mexxi will not touch ${what} it cannot read`);
  }
}

// Codex keeps user hooks in hooks.json beside config.toml. Codex skips a new
// or changed hook until it is trusted once in /hooks.
export async function planCodexHooks({ hooksFile, stateFile, desired }) {
  const current = await readJson(hooksFile, "hooks.json");
  const state = await readJson(stateFile, "its state file");
  const merged = mergeOwnedHooks({ current: current?.hooks, previous: state?.hooks ?? {}, desired, file: hooksFile });
  const file = { ...(current ?? {}) };
  if (Object.keys(merged.hooks ?? {}).length) file.hooks = merged.hooks;
  else delete file.hooks;
  return {
    drift: merged.drift,
    conflicts: merged.conflicts,
    owned: { hooks: merged.owned },
    file: JSON.stringify(file) === JSON.stringify(current ?? {}) ? null : file,
    stateChanged: JSON.stringify(merged.owned) !== JSON.stringify(state?.hooks ?? {}),
  };
}

export async function writeCodexHooks({ hooksFile, stateFile }, plan) {
  if (plan.file) {
    await mkdir(path.dirname(hooksFile), { recursive: true });
    await writeFile(hooksFile, `${JSON.stringify(plan.file, null, 2)}\n`);
  }
  if (plan.stateChanged) {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(plan.owned, null, 2)}\n`);
  }
}
