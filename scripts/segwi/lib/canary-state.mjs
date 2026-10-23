// What the last canary run found, kept beside the other installer state. The
// health route shows it, and the adapter treats a host version it passed on as
// tested. The repository's own claude-code.tested.json stays the reviewed
// baseline; the canary never edits a tracked file.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const canaryStateFile = (stateDir) => path.join(stateDir, "segwi-canary.json");

/**
 * @typedef {{ ok: boolean, at: string, hostVersion: string|null, model: string, problem?: string,
 *   durationMs: number, costUsd?: number, canaryTestedVersions: string[] }} CanaryState
 */

/** The state file, or null when no canary has run (or the file is unreadable). */
export function readCanaryState(stateDir) {
  if (!stateDir) return null;
  try {
    const value = JSON.parse(readFileSync(canaryStateFile(stateDir), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The host versions a canary run has passed on, newest last. */
export function canaryTestedVersions(stateDir) {
  const versions = readCanaryState(stateDir)?.canaryTestedVersions;
  return Array.isArray(versions) ? versions.filter((version) => typeof version === "string") : [];
}

/** What the health route shows: the verdict, never the cost or the model. */
export function canaryHealth(stateDir) {
  const state = readCanaryState(stateDir);
  if (!state) return null;
  return { ok: state.ok === true, at: state.at ?? null, hostVersion: state.hostVersion ?? null, ...(state.problem ? { problem: state.problem } : {}) };
}

export function writeCanaryState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = canaryStateFile(stateDir);
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
