import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "./errors.mjs";
import { cleanOutput, fetchBranch, git, push as pushRef, redactEndpoint, remoteBranchSha } from "./git.mjs";

export const MEDIA_BRANCH = "pr-media";
export const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"]);

// Commits to pr-media through a temporary index and pushes the commit without
// creating local refs, so no checkout, branch, or working tree is touched.
// Pushes are fast-forward only; a concurrent update triggers a rebuild.
export async function updateMediaBranch(root, pushUrl, message, mutateIndex) {
  let lastDiagnostic = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parent = await remoteBranchSha(root, pushUrl, MEDIA_BRANCH)
      ? await fetchBranch(root, pushUrl, MEDIA_BRANCH)
      : null;
    const indexDirectory = await mkdtemp(path.join(os.tmpdir(), "pr-media-index-"));
    try {
      const env = { GIT_INDEX_FILE: path.join(indexDirectory, "index") };
      await git(root, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
      await mutateIndex(env);
      const tree = cleanOutput(await git(root, ["write-tree"], { env }));
      if (parent && tree === cleanOutput(await git(root, ["rev-parse", `${parent}^{tree}`]))) {
        return { commit: parent, changed: false };
      }
      const commit = cleanOutput(await git(root, [
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        message,
      ]));
      const push = await pushRef(root, ["--porcelain", pushUrl, `${commit}:refs/heads/${MEDIA_BRANCH}`], {
        allowedExitCodes: [0, 1],
      });
      if (push.code === 0) return { commit, changed: true };
      lastDiagnostic = redactEndpoint(push.stderr.trim() || push.stdout.trim());
    } finally {
      await rm(indexDirectory, { recursive: true, force: true });
    }
  }
  throw new WorkspaceError(`could not update ${MEDIA_BRANCH} after repeated push rejections`, lastDiagnostic);
}
