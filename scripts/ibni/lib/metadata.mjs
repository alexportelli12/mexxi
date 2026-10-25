import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_VERIFY_COMMAND } from "./baseline.mjs";
import { WorkspaceError } from "./errors.mjs";
import { canonicalPath, pathExists } from "./fs.mjs";
import { cleanOutput, git } from "./git.mjs";

// The on-disk names predate ibni; renaming them would strand retained workspaces.
export const METADATA_FILE = "implementation-workspace.json";
export const LEGACY_METADATA_FILE = "opencode-implementation.json";

export async function writeMetadata(gitDirectory, metadata) {
  const legacy = path.join(gitDirectory, LEGACY_METADATA_FILE);
  const current = path.join(gitDirectory, METADATA_FILE);
  const destination = await pathExists(legacy) && !await pathExists(current) ? legacy : current;
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function readMetadata(gitDirectory) {
  try {
    const current = path.join(gitDirectory, METADATA_FILE);
    const legacy = path.join(gitDirectory, LEGACY_METADATA_FILE);
    if (await pathExists(current) && await pathExists(legacy)) {
      throw new WorkspaceError("implementation ownership metadata is ambiguous", `Both ${current} and ${legacy} exist.`);
    }
    return JSON.parse(await readFile(await pathExists(current) ? current : legacy, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("implementation ownership metadata is invalid", error.message);
  }
}

export async function linkedWorktreeDirectories(root) {
  const result = await git(root, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let currentPath = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line === "" && currentPath) {
      entries.push(currentPath);
      currentPath = null;
    }
  }
  if (currentPath) entries.push(currentPath);
  return entries;
}

export async function inspectImplementationWorktrees(root) {
  const inspected = [];
  for (const worktreePath of await linkedWorktreeDirectories(root)) {
    const entry = { worktreePath, root };
    let gitDirectory;
    try {
      gitDirectory = await canonicalPath(cleanOutput(
        await git(worktreePath, ["rev-parse", "--absolute-git-dir"]),
      ));
      const existing = await pathExists(worktreePath);
      entry.gitDirectory = gitDirectory;
      entry.worktreeExists = existing;
      const metadata = await readMetadata(gitDirectory);
      if (metadata) {
        entry.metadata = metadata;
        entry.branch = metadata.branch;
      }
    } catch (error) {
      entry.error = error.message;
    }
    inspected.push(entry);
  }
  return inspected;
}

// Transient evidence (screenshots, recordings, reports) lives beside the
// worktree rather than inside it: untracked files in the worktree would block
// record-evidence, publish, and cleanup, which all require a clean tree.
export const EVIDENCE_SUFFIX = ".evidence";

export function evidenceDirectoryFor(worktreePath) {
  return `${worktreePath}${EVIDENCE_SUFFIX}`;
}

export async function updateMetadata(session, changes) {
  const metadata = {
    ...session.metadata,
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  await writeMetadata(session.repository.gitDirectory, metadata);
  session.metadata = metadata;
}

// Sessions prepared before repositories could name their verify command used
// the default.
export function sessionVerifyCommand(metadata) {
  return metadata.verifyCommand ?? DEFAULT_VERIFY_COMMAND;
}

// The lockfile blob ids are bookkeeping for adopt, not something to print.
export function summarizeSetup(setup) {
  if (!setup) return null;
  const { lockfiles: _lockfiles, ...rest } = setup;
  return rest;
}

export function workspaceSummary(entry) {
  const { metadata } = entry;
  if (!metadata) return null;
  return {
    sessionId: metadata.sessionId,
    worktreePath: metadata.worktreePath,
    evidenceDir: evidenceDirectoryFor(metadata.worktreePath),
    branch: metadata.branch,
    state: metadata.state,
    prUrl: metadata.prUrl,
    port: metadata.port ?? null,
    // Workspaces from before blocks hold their one port.
    ports: metadata.ports
      ? { ...metadata.ports, last: metadata.ports.first + metadata.ports.size - 1 }
      : metadata.port ? { first: metadata.port, size: 1, last: metadata.port } : null,
    verifyCommand: sessionVerifyCommand(metadata),
    defaultBranch: metadata.defaultBranch,
    baseSha: metadata.baseSha,
    publishedSha: metadata.publishedSha,
    // Absent from sessions prepared before ibni ran setup and verify itself.
    setup: summarizeSetup(metadata.setup),
    verification: metadata.verification ?? null,
    evidenceTreeSha: metadata.evidenceTreeSha,
    evidenceRecordedAt: metadata.evidenceRecordedAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}
