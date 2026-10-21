import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "../lib/errors.mjs";
import { canonicalPath } from "../lib/fs.mjs";
import { cleanOutput, configuredGithubRepository, git } from "../lib/git.mjs";
import { withRepositoryLock } from "../lib/lock.mjs";
import { MEDIA_BRANCH, MEDIA_EXTENSIONS, updateMediaBranch } from "../lib/media.mjs";
import { evidenceDirectoryFor } from "../lib/metadata.mjs";
import { ownedSession } from "../lib/session.mjs";

async function mediaFiles(evidenceDir, requested) {
  const base = await canonicalPath(evidenceDir);
  let candidates = requested;
  if (!candidates.length) {
    candidates = (await readdir(base, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  }
  const files = [];
  const inside = (candidate) => candidate.startsWith(`${base}${path.sep}`);
  for (const candidate of candidates) {
    const requestedPath = path.resolve(base, candidate);
    let resolved = null;
    if (inside(requestedPath)) {
      try {
        resolved = await canonicalPath(requestedPath);
      } catch (error) {
        throw new WorkspaceError(`media file not found: ${candidate}`, error.message);
      }
    }
    // Check both the requested path and its target so symlinks cannot escape.
    if (!resolved || !inside(resolved)) {
      throw new WorkspaceError(`refusing to publish a file outside evidenceDir: ${candidate}`);
    }
    if (!(await lstat(resolved)).isFile()) {
      throw new WorkspaceError(`media path is not a file: ${candidate}`);
    }
    if (!MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new WorkspaceError(
        `refusing to publish a non-media file: ${candidate}`,
        `Allowed extensions: ${[...MEDIA_EXTENSIONS].join(", ")}`,
      );
    }
    files.push({ absolute: resolved, relative: path.relative(base, resolved).split(path.sep).join("/") });
  }
  if (!files.length) throw new WorkspaceError("evidenceDir contains no media files to publish");
  return files;
}

export async function publishMedia({ cwd = process.cwd(), sessionId, files: requested = [] }) {
  const initial = await ownedSession(cwd, sessionId);
  return withRepositoryLock(initial.repository.commonDirectory, async () => {
    const { repository, metadata } = await ownedSession(cwd, sessionId);
    const github = await configuredGithubRepository(repository.root, metadata.remote);
    if (!github) {
      throw new WorkspaceError(
        "publish-media needs a GitHub remote to build embeddable URLs",
        "Deliver the pull request without media and note why in its Evidence section.",
      );
    }
    const files = await mediaFiles(evidenceDirectoryFor(metadata.worktreePath), requested);
    const published = files.map((file) => ({ ...file, path: `${metadata.branch}/${file.relative}` }));
    const { commit } = await updateMediaBranch(
      repository.root,
      metadata.pushUrl,
      `Add PR media for ${metadata.branch}`,
      async (env) => {
        for (const file of published) {
          const blob = cleanOutput(await git(repository.root, ["hash-object", "-w", "--no-filters", "--", file.absolute]));
          await git(repository.root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`], { env });
        }
      },
    );
    const encode = (value) => value.split("/").map(encodeURIComponent).join("/");
    // URLs pin the media commit rather than the branch tip: cleanup later drops
    // the folder from the tip, and merged PR descriptions must keep rendering.
    return {
      operation: "publish-media",
      mediaBranch: MEDIA_BRANCH,
      commit,
      files: published.map((file) => ({
        file: file.relative,
        path: file.path,
        url: `https://github.com/${github.owner}/${github.repo}/blob/${commit}/${encode(file.path)}?raw=true`,
      })),
    };
  });
}
