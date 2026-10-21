import { createHash } from "node:crypto";
import path from "node:path";
import { ConfigError, configPath, loadConfig } from "../../lib/config.mjs";
import { WorkspaceError } from "./errors.mjs";

export function sanitizeSegment(value, fallback) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return normalized || fallback;
}

export function sanitizePrefix(value) {
  return value
    .split("/")
    .map((segment) => sanitizeSegment(segment, "work"))
    .join("/");
}

export async function workspaceConfig(environment = process.env) {
  // Both variables are retired in favour of config.json; failing beats
  // silently creating worktrees somewhere other than where they were asked for.
  for (const name of ["IMPLEMENTATION_WORKTREE_ROOT", "OPENCODE_WORKTREE_ROOT"]) {
    if (environment[name]) {
      throw new WorkspaceError(`${name} is retired`, `Set paths.worktreeRoot in ${configPath({ env: environment })} instead and unset ${name}.`);
    }
  }
  try {
    return (await loadConfig({ file: configPath({ env: environment }) })).config;
  } catch (error) {
    if (error instanceof ConfigError) throw new WorkspaceError("mexxi configuration is invalid", error.message);
    throw error;
  }
}

// New workspaces always go under paths.worktreeRoot. Retained ones under the
// earlier coding-agent/ and opencode/ roots stay reachable, because sessions
// are found through Git's worktree list and their metadata, not this path.
export async function workspaceRoot(repository, config) {
  const repositoryName = sanitizeSegment(path.basename(repository.root), "repository");
  const identity = createHash("sha256").update(repository.commonDirectory).digest("hex").slice(0, 10);
  return path.resolve(config.paths.worktreeRoot, `${repositoryName}-${identity}`);
}
