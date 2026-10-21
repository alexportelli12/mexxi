import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { COMMANDS } from "./ibni.mjs";
import { MEDIA_EXTENSIONS } from "./lib/media.mjs";

const cli = fileURLToPath(new URL("./ibni.mjs", import.meta.url));

function run(command, args, { cwd, env, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code, stdout, stderr };
      if (!allowedExitCodes.includes(code)) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stderr || stdout}`));
      } else {
        resolve(result);
      }
    });
  });
}

async function git(cwd, ...args) {
  return run("git", args, { cwd });
}

async function commit(cwd, filename, content, message) {
  await writeFile(path.join(cwd, filename), content);
  await git(cwd, "add", filename);
  await git(cwd, "commit", "--quiet", "-m", message);
  return (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "implementation-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const control = path.join(root, "control");
  const worktrees = path.join(root, "worktrees");

  await run("git", ["init", "--quiet", "--bare", remote]);
  await run("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
  await run("git", ["init", "--quiet", "--initial-branch=trunk", seed]);
  await git(seed, "config", "user.name", "Workspace Test");
  await git(seed, "config", "user.email", "workspace@example.test");
  await commit(seed, "README.md", "initial\n", "initial");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "--quiet", "--set-upstream", "origin", "trunk");
  await run("git", ["clone", "--quiet", remote, control]);
  await git(control, "config", "user.name", "Workspace Test");
  await git(control, "config", "user.email", "workspace@example.test");
  // prepare sweeps merged workspaces through gh; tests must never reach the
  // real CLI, so every fixture gets an unconfigured (always failing) stub.
  const gh = await ghStub(t);
  const config = path.join(root, "mexxi-config.json");
  await writeFile(config, JSON.stringify({ paths: { worktreeRoot: worktrees } }));
  return { root, remote, seed, control, worktrees, gh, config };
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function lifecycle(fixture, cwd, operation, options = {}, allowedExitCodes = [0], extraEnv = {}) {
  const args = [cli, operation];
  for (const [key, value] of Object.entries(options)) args.push(`--${key}`, value);
  const result = await run(process.execPath, args, {
    cwd,
    env: {
      MEXXI_CONFIG: fixture.config,
      IMPLEMENTATION_WORKTREE_ROOT: "",
      OPENCODE_WORKTREE_ROOT: "",
      ...ghEnv(fixture.gh),
      ...extraEnv,
    },
    allowedExitCodes,
  });
  return {
    ...result,
    json: result.code === 0 ? JSON.parse(result.stdout) : null,
  };
}

async function recordEvidence(fixture, prepared) {
  return lifecycle(
    fixture,
    prepared.json.worktreePath,
    "record-evidence",
    { session: prepared.json.sessionId },
  );
}

async function advanceRemote(fixture, filename = "upstream.txt") {
  const sha = await commit(fixture.seed, filename, `${Date.now()}\n`, `update ${filename}`);
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
  return sha;
}

test("prepares independent worktrees from an up-to-date custom default branch", async (t) => {
  const fixture = await createFixture(t);
  const [first, second] = await Promise.all([
    lifecycle(fixture, fixture.control, "prepare", { slug: "first change" }),
    lifecycle(fixture, fixture.control, "prepare", { slug: "second change" }),
  ]);

  assert.notEqual(first.json.sessionId, second.json.sessionId);
  assert.notEqual(first.json.branch, second.json.branch);
  assert.notEqual(first.json.worktreePath, second.json.worktreePath);
  assert.equal(first.json.defaultBranch, "trunk");
  assert.equal((await git(fixture.control, "branch", "--show-current")).stdout.trim(), "trunk");
  assert.equal((await git(first.json.worktreePath, "branch", "--show-current")).stdout.trim(), first.json.branch);
  assert.equal((await git(second.json.worktreePath, "branch", "--show-current")).stdout.trim(), second.json.branch);
});

test("uses readable slug names and numeric suffixes for repeated requests", async (t) => {
  const fixture = await createFixture(t);
  const first = await lifecycle(fixture, fixture.control, "prepare", { slug: "same change" });
  const second = await lifecycle(fixture, fixture.control, "prepare", { slug: "same change" });

  assert.equal(path.basename(first.json.worktreePath), "same-change");
  assert.equal(first.json.branch, "agent/same-change");
  assert.equal(path.basename(second.json.worktreePath), "same-change-2");
  assert.equal(second.json.branch, "agent/same-change-2");
  assert.notEqual(first.json.sessionId, second.json.sessionId);
});

test("keeps workspaces retained under a legacy root available while new ones use the configured root", async (t) => {
  const fixture = await createFixture(t);
  const identity = createHash("sha256").update(path.join(fixture.control, ".git")).digest("hex").slice(0, 10);
  const legacyRoot = path.join(fixture.root, "data", "opencode", "implementation-worktrees");
  const legacyConfig = path.join(fixture.root, "legacy-config.json");
  await writeFile(legacyConfig, JSON.stringify({ paths: { worktreeRoot: legacyRoot } }));
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "retained", prefix: "opencode" }, [0], { MEXXI_CONFIG: legacyConfig });
  assert.equal(prepared.json.worktreePath, path.join(legacyRoot, `control-${identity}`, "retained"));
  assert.equal(prepared.json.branch, "opencode/retained");
  const gitDirectory = (await git(prepared.json.worktreePath, "rev-parse", "--absolute-git-dir")).stdout.trim();
  await rename(path.join(gitDirectory, "implementation-workspace.json"), path.join(gitDirectory, "opencode-implementation.json"));

  // The fixture's config names a different root: the retained session is still found.
  const info = await lifecycle(fixture, fixture.control, "info", { session: prepared.json.sessionId });
  assert.equal(info.json.worktreePath, prepared.json.worktreePath);
  const listed = await lifecycle(fixture, fixture.control, "list");
  assert.deepEqual(listed.json.workspaces.map((workspace) => workspace.worktreePath), [prepared.json.worktreePath]);
  await lifecycle(fixture, fixture.control, "record-evidence", { session: prepared.json.sessionId });
  assert.equal(await pathExists(path.join(gitDirectory, "implementation-workspace.json")), false);
  const next = await lifecycle(fixture, fixture.control, "prepare", { slug: "next" });
  assert.equal(next.json.worktreePath, path.join(fixture.worktrees, `control-${identity}`, "next"));
});

test("takes the branch prefix from config.json unless --prefix overrides it", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, workflow: { branchPrefix: "team/bots/" } }));
  const configured = await lifecycle(fixture, fixture.control, "prepare", { slug: "configured" });
  assert.equal(configured.json.branch, "team/bots/configured");
  const explicit = await lifecycle(fixture, fixture.control, "prepare", { slug: "explicit", prefix: "fix" });
  assert.equal(explicit.json.branch, "fix/explicit");
});

test("refuses retired worktree-root variables and invalid configuration before touching Git", async (t) => {
  const fixture = await createFixture(t);
  for (const name of ["IMPLEMENTATION_WORKTREE_ROOT", "OPENCODE_WORKTREE_ROOT"]) {
    const result = await lifecycle(fixture, fixture.control, "prepare", { slug: "retired" }, [2], { [name]: fixture.worktrees });
    assert.match(result.stderr, new RegExp(`${name} is retired[\\s\\S]*paths\\.worktreeRoot`));
  }
  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: "relative/path" } }));
  const invalid = await lifecycle(fixture, fixture.control, "prepare", { slug: "invalid" }, [2]);
  assert.match(invalid.stderr, /mexxi configuration is invalid[\s\S]*paths\.worktreeRoot/);
  assert.equal(await pathExists(fixture.worktrees), false);
  assert.equal((await git(fixture.control, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm).length, 1);
});

test("fast-forwards a clean behind control branch before creating the worktree", async (t) => {
  const fixture = await createFixture(t);
  const latest = await advanceRemote(fixture);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "behind base" });

  assert.equal((await git(fixture.control, "rev-parse", "HEAD")).stdout.trim(), latest);
  assert.equal(prepared.json.baseSha, latest);
  assert.equal((await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim(), latest);
});

test("refuses diverged default-branch history without changing it", async (t) => {
  const fixture = await createFixture(t);
  await commit(fixture.control, "local.txt", "local\n", "local default work");
  const localSha = (await git(fixture.control, "rev-parse", "HEAD")).stdout.trim();
  await advanceRemote(fixture);

  const result = await lifecycle(
    fixture,
    fixture.control,
    "prepare",
    { slug: "unsafe base" },
    [2],
  );
  assert.match(result.stderr, /default branch is diverged/);
  assert.equal((await git(fixture.control, "rev-parse", "HEAD")).stdout.trim(), localSha);
});

test("refuses and preserves dirty control state", async (t) => {
  const fixture = await createFixture(t);
  const dirtyPath = path.join(fixture.control, "notes.txt");
  await writeFile(dirtyPath, "user work\n");

  const result = await lifecycle(
    fixture,
    fixture.control,
    "prepare",
    { slug: "dirty control" },
    [2],
  );
  assert.match(result.stderr, /control worktree contains uncommitted or untracked work/);
  assert.equal(await readFile(dirtyPath, "utf8"), "user work\n");
});

test("rebases session-owned unpublished commits when the default branch advances", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "rebase feature" });
  const oldFeatureSha = await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  const latest = await advanceRemote(fixture);

  const synchronized = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
  );
  const newFeatureSha = (await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim();
  assert.equal(synchronized.json.strategy, "rebase");
  assert.equal(synchronized.json.requiresRevalidation, true);
  assert.notEqual(newFeatureSha, oldFeatureSha);
  await git(prepared.json.worktreePath, "merge-base", "--is-ancestor", latest, newFeatureSha);
  assert.equal(await readFile(path.join(prepared.json.worktreePath, "feature.txt"), "utf8"), "feature\n");
});

test("refuses synchronization from the wrong session and preserves both worktrees", async (t) => {
  const fixture = await createFixture(t);
  const first = await lifecycle(fixture, fixture.control, "prepare", { slug: "owner one" });
  const second = await lifecycle(fixture, fixture.control, "prepare", { slug: "owner two" });
  const secondHead = (await git(second.json.worktreePath, "rev-parse", "HEAD")).stdout.trim();

  const result = await lifecycle(
    fixture,
    second.json.worktreePath,
    "sync",
    { session: first.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /session token does not own/);
  assert.equal((await git(first.json.worktreePath, "status", "--porcelain")).stdout, "");
  assert.equal((await git(second.json.worktreePath, "rev-parse", "HEAD")).stdout.trim(), secondHead);
});

test("refuses to rewrite a branch published outside the owning lifecycle", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "external publish" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await git(prepared.json.worktreePath, "push", "--quiet", "origin", prepared.json.branch);
  const featureHead = (await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim();
  await advanceRemote(fixture);

  const result = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /published outside this session/);
  assert.equal((await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim(), featureHead);
});

test("refuses and preserves dirty implementation state during synchronization", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "dirty feature" });
  const dirtyPath = path.join(prepared.json.worktreePath, "feature.txt");
  await writeFile(dirtyPath, "unfinished\n");
  await advanceRemote(fixture);

  const result = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /implementation worktree contains uncommitted or untracked work/);
  assert.equal(await readFile(dirtyPath, "utf8"), "unfinished\n");
});

test("refuses rewritten upstream default-branch history", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "rewritten upstream" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await git(fixture.seed, "checkout", "--quiet", "--orphan", "replacement");
  await git(fixture.seed, "rm", "--quiet", "-rf", ".");
  await commit(fixture.seed, "replacement.txt", "replacement\n", "replacement root");
  await git(fixture.seed, "push", "--quiet", "--force", "origin", "HEAD:trunk");

  const featureHead = (await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim();
  const result = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /default branch history was rewritten/);
  assert.equal((await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim(), featureHead);
});

test("aborts a conflicting synchronization and restores the implementation branch", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "conflicting sync" });
  const featureHead = await commit(
    prepared.json.worktreePath,
    "README.md",
    "feature version\n",
    "change readme in feature",
  );
  await commit(fixture.seed, "README.md", "upstream version\n", "change readme upstream");
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");

  const result = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /operation was aborted/);
  assert.equal((await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim(), featureHead);
  assert.equal((await git(prepared.json.worktreePath, "status", "--porcelain")).stdout, "");
  assert.equal(await readFile(path.join(prepared.json.worktreePath, "README.md"), "utf8"), "feature version\n");
});

test("merges current default history into a workflow-published follow-up branch", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "published followup" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);
  const published = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(published.json.published, true);
  const marked = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "mark-pr",
    { session: prepared.json.sessionId, url: "https://example.test/pull/1" },
  );
  assert.equal(marked.json.state, "pr-open");
  const worktreeList = (await git(fixture.control, "worktree", "list", "--porcelain")).stdout;
  assert.match(worktreeList, new RegExp(`worktree ${prepared.json.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(worktreeList, /locked Coding agent implementation/);
  const latest = await advanceRemote(fixture);

  const synchronized = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
  );
  assert.equal(synchronized.json.strategy, "merge");
  assert.equal(synchronized.json.requiresRevalidation, true);
  await git(prepared.json.worktreePath, "merge-base", "--is-ancestor", latest, "HEAD");
  const parents = (await git(prepared.json.worktreePath, "show", "-s", "--format=%P", "HEAD"))
    .stdout.trim().split(" ");
  assert.equal(parents.length, 2);
});

test("publish stops before pushing when a final synchronization changes the tree", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "publish guard" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);
  await advanceRemote(fixture);

  const result = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(result.json.published, false);
  assert.equal(result.json.requiresRevalidation, true);
  assert.equal(result.json.requiresEvidence, true);
  const retry = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(retry.json.published, false);
  assert.equal(retry.json.requiresEvidence, true);
  assert.notEqual(await run("git", ["--git-dir", fixture.remote, "show-ref", "--verify", `refs/heads/${prepared.json.branch}`], {
    allowedExitCodes: [0, 1, 128],
  }).then(({ code }) => code), 0);

  await recordEvidence(fixture, prepared);
  const published = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(published.json.published, true);
});

test("checks and publishes against a distinct configured push URL", async (t) => {
  const fixture = await createFixture(t);
  const fork = path.join(fixture.root, "fork.git");
  await run("git", ["init", "--quiet", "--bare", fork]);
  await git(fixture.control, "remote", "set-url", "--add", "--push", "origin", fork);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "triangular workflow" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);

  const published = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(published.json.published, true);
  assert.equal(await run("git", ["--git-dir", fork, "show-ref", "--verify", `refs/heads/${prepared.json.branch}`], {
    allowedExitCodes: [0, 1, 128],
  }).then(({ code }) => code), 0);
  assert.notEqual(await run("git", ["--git-dir", fixture.remote, "show-ref", "--verify", `refs/heads/${prepared.json.branch}`], {
    allowedExitCodes: [0, 1, 128],
  }).then(({ code }) => code), 0);
});

test("canonicalizes a relative remote for the external worktree", async (t) => {
  const fixture = await createFixture(t);
  await git(fixture.control, "remote", "set-url", "origin", "../remote.git");
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "relative remote" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);

  const published = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(published.json.published, true);
  assert.equal(await run("git", ["--git-dir", fixture.remote, "show-ref", "--verify", `refs/heads/${prepared.json.branch}`], {
    allowedExitCodes: [0, 1, 128],
  }).then(({ code }) => code), 0);
});

test("redacts credentials and query values from remote failure diagnostics", async (t) => {
  const fixture = await createFixture(t);
  await git(
    fixture.control,
    "remote",
    "set-url",
    "origin",
    "https://user:secret@127.0.0.1:9/repository.git?token=hidden",
  );

  const result = await lifecycle(
    fixture,
    fixture.control,
    "prepare",
    { slug: "redacted remote" },
    [2],
  );
  assert.doesNotMatch(result.stderr, /secret|hidden/);
  assert.match(result.stderr, /redacted/);
});

test("retains pending ownership when the remote ref changes during publication", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "ambiguous push" });
  const featureHead = await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);
  const hook = path.join(fixture.remote, "hooks", "post-receive");
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  case "$ref" in
    refs/heads/agent/*)
      git update-ref "$ref" "$(git rev-parse refs/heads/trunk)" "$new"
      ;;
  esac
done
`);
  await chmod(hook, 0o755);

  const result = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /publication outcome is ambiguous/);
  assert.equal((await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim(), featureHead);

  const retry = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "sync",
    { session: prepared.json.sessionId },
    [2],
  );
  assert.match(retry.stderr, /incomplete publication operation/);
});

async function withEnvGitignore(t) {
  const fixture = await createFixture(t);
  await commit(fixture.seed, ".env.example", "template\n", "env template");
  await writeFile(path.join(fixture.seed, ".gitignore"), ".env*\nscratch.txt\n", "utf8");
  await git(fixture.seed, "add", ".gitignore");
  await git(fixture.seed, "commit", "--quiet", "-m", "ignore local env files");
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
  await git(fixture.control, "pull", "--quiet", "--ff-only");
  return fixture;
}

test("provisions gitignored env files from the control checkout into the new worktree", async (t) => {
  const fixture = await withEnvGitignore(t);
  await writeFile(path.join(fixture.control, ".env"), "LOCAL=control\n", "utf8");
  await writeFile(path.join(fixture.control, ".env.dev"), "DEV=1\n", "utf8");
  await writeFile(path.join(fixture.control, "scratch.txt"), "ignored but not env\n", "utf8");

  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "env provisioning" });

  assert.deepEqual(prepared.json.provisionedEnv, [".env", ".env.dev"]);
  assert.equal(
    await readFile(path.join(prepared.json.worktreePath, ".env"), "utf8"),
    "LOCAL=control\n",
  );
  assert.equal(
    await readFile(path.join(prepared.json.worktreePath, ".env.dev"), "utf8"),
    "DEV=1\n",
  );
  assert.equal(
    await readFile(path.join(prepared.json.worktreePath, ".env.example"), "utf8"),
    "template\n",
  );
  assert.equal((await pathExists(path.join(prepared.json.worktreePath, "scratch.txt"))), false);
  assert.equal((await git(prepared.json.worktreePath, "status", "--porcelain")).stdout, "");
});

test("a repository without local env files is unaffected by provisioning", async (t) => {
  const fixture = await withEnvGitignore(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "no env files" });

  assert.deepEqual(prepared.json.provisionedEnv, []);
});

test("lifecycle operations resolve the owned worktree from session metadata in any cwd", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "cwd free" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await advanceRemote(fixture);

  const synchronized = await lifecycle(
    fixture,
    fixture.control,
    "sync",
    { session: prepared.json.sessionId },
  );
  assert.equal(synchronized.json.operation, "sync");
  assert.equal(synchronized.json.strategy, "rebase");

  const recorded = await lifecycle(
    fixture,
    fixture.control,
    "record-evidence",
    { session: prepared.json.sessionId },
  );
  assert.equal(recorded.json.operation, "record-evidence");
});

test("an unknown session fails deterministically from any location", async (t) => {
  const fixture = await createFixture(t);
  await lifecycle(fixture, fixture.control, "prepare", { slug: "owned session" });

  const result = await lifecycle(
    fixture,
    fixture.control,
    "record-evidence",
    { session: "does-not-exist" },
    [2],
  );
  assert.match(result.stderr, /no implementation worktree for this session/);
});

test("info and list expose retained workspace summaries", async (t) => {
  const fixture = await createFixture(t);
  await lifecycle(fixture, fixture.control, "prepare", { slug: "summary one" });
  const second = await lifecycle(fixture, fixture.control, "prepare", { slug: "summary two" });

  const info = await lifecycle(
    fixture,
    fixture.control,
    "info",
    { session: second.json.sessionId },
  );
  assert.equal(info.json.operation, "info");
  assert.equal(info.json.worktreePath, second.json.worktreePath);
  assert.equal(info.json.branch, second.json.branch);

  const list = await lifecycle(fixture, fixture.control, "list");
  assert.equal(list.json.workspaces.length, 2);
  assert.ok(list.json.workspaces.every((workspace) => workspace.worktreePath && workspace.branch));
});

async function ghStub(t) {
  const stubDirectory = await mkdtemp(path.join(os.tmpdir(), "implementation-workspace-gh-"));
  t.after(() => rm(stubDirectory, { recursive: true, force: true }));
  const stub = path.join(stubDirectory, "gh");
  await writeFile(stub, `#!/bin/sh
pr=""
for arg in "$@"; do
  case "$arg" in */pull/*) pr="\${arg##*/pull/}";; esac
done
case "$pr" in ""|*[!0-9]*)
  echo "gh: unresolvable pull request from arguments" >&2
  exit 1
;; esac
if [ ! -f "\${GH_STUB_DIR}/\${pr}" ]; then
  echo "gh: state not configured for pr \${pr}" >&2
  exit 1
fi
state="\$(cat "\${GH_STUB_DIR}/\${pr}")"
if [ -f "\${GH_STUB_DIR}/\${pr}.head" ]; then
  read -r headRef headOid < "\${GH_STUB_DIR}/\${pr}.head"
  printf '{"state":"%s","headRefName":"%s","headRefOid":"%s"}\\n' "$state" "$headRef" "$headOid"
  exit 0
fi
if [ "$state" = "MERGED" ] && [ -f "\${GH_STUB_DIR}/\${pr}.merge" ]; then
  mergeOid="\$(cat "\${GH_STUB_DIR}/\${pr}.merge")"
  printf '{"state":"MERGED","mergeCommit":{"oid":"%s"}}\\n' "$mergeOid"
  exit 0
fi
printf '{"state":"%s"}\\n' "$state"
`, "utf8");
  await chmod(stub, 493);
  return stubDirectory;
}

function ghEnv(stubDirectory) {
  return { PATH: `${stubDirectory}:${process.env.PATH ?? ""}`, GH_STUB_DIR: stubDirectory };
}

async function setGhState(stubDirectory, prNumber, state) {
  await writeFile(path.join(stubDirectory, String(prNumber)), state);
}

async function setGhHead(stubDirectory, prNumber, branch, sha) {
  await writeFile(path.join(stubDirectory, `${prNumber}.head`), `${branch} ${sha}\n`);
}

async function setGhMergeCommit(stubDirectory, prNumber, sha) {
  await writeFile(path.join(stubDirectory, `${prNumber}.merge`), sha);
}

async function publishAndMark(fixture, prepared, content = "feature\n", prNumber = 7, filename = "feature.txt") {
  await commit(prepared.json.worktreePath, filename, content, "feature");
  await recordEvidence(fixture, prepared);
  const published = await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "publish",
    { session: prepared.json.sessionId },
  );
  assert.equal(published.json.published, true);
  await lifecycle(
    fixture,
    prepared.json.worktreePath,
    "mark-pr",
    { session: prepared.json.sessionId, url: `https://example.test/pull/${prNumber}` },
  );
}

async function pretendMerged(fixture, prepared) {
  await git(fixture.seed, "fetch", "--quiet", "origin", prepared.json.branch);
  await git(fixture.seed, "merge", "--quiet", "--ff-only", `origin/${prepared.json.branch}`);
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
  await git(fixture.control, "pull", "--quiet", "--ff-only");
}

test("cleanup protects closed, dirty, and no-PR worktrees without touching them", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await ghStub(t);
  const first = await lifecycle(fixture, fixture.control, "prepare", { slug: "protect closed" });
  await publishAndMark(fixture, first);
  const second = await lifecycle(fixture, fixture.control, "prepare", { slug: "protect dirty" });
  await publishAndMark(fixture, second);
  await writeFile(path.join(second.json.worktreePath, "feature.txt"), "unfinished\n");
  const third = await lifecycle(fixture, fixture.control, "prepare", { slug: "protect no pr" });
  await setGhState(stub, 7, "CLOSED");

  const result = await lifecycle(
    fixture,
    fixture.control,
    "cleanup",
    { "dry-run": "false" },
    [0],
    ghEnv(stub),
  );
  assert.equal(result.json.operation, "cleanup");
  const byPath = new Map(result.json.results.map((row) => [row.worktreePath, row]));
  const closed = byPath.get(first.json.worktreePath);
  assert.equal(closed.decision, "protect");
  assert.match(closed.reason, /closed but its history could not be established as consumed/);
  assert.equal(byPath.get(second.json.worktreePath).decision, "protect");
  assert.match(byPath.get(second.json.worktreePath).reason, /uncommitted or untracked work/);
  assert.equal(byPath.get(third.json.worktreePath).decision, "protect");
  assert.match(byPath.get(third.json.worktreePath).reason, /no recorded pull request/);
  assert.equal(result.json.removedCount, 0);
  for (const survivor of [first, second, third]) {
    assert.equal(await pathExists(survivor.json.worktreePath), true);
  }
});

test("cleanup dry-run reports decisions without removing anything", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await ghStub(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "dry run" });
  await publishAndMark(fixture, prepared);
  await pretendMerged(fixture, prepared);
  await setGhState(stub, 7, "MERGED");

  const dryRun = await lifecycle(
    fixture,
    fixture.control,
    "cleanup",
    { "dry-run": "true" },
    [0],
    ghEnv(stub),
  );
  assert.equal(dryRun.json.dryRun, true);
  assert.equal(dryRun.json.removedCount, 0);
  const dryRow = dryRun.json.results.find((row) => row.worktreePath === prepared.json.worktreePath);
  assert.equal(dryRow.decision, "remove");
  assert.equal(dryRow.prState, "MERGED");
  assert.match(dryRow.reason, /confirmed consumed/);
  assert.equal(await pathExists(prepared.json.worktreePath), true);
  assert.ok((await run("git", ["branch", "--list", prepared.json.branch], { cwd: fixture.control })).stdout.includes(prepared.json.branch));

  const removed = await lifecycle(
    fixture,
    fixture.control,
    "cleanup",
    { "dry-run": "false" },
    [0],
    ghEnv(stub),
  );
  assert.equal(removed.json.removedCount, 1);
  assert.equal(await pathExists(prepared.json.worktreePath), false);
  assert.ok(!(await run("git", ["branch", "--list", prepared.json.branch], { cwd: fixture.control })).stdout.includes(prepared.json.branch));
});

test("cleanup removes a merged-PR worktree and protects a closed unmerged one", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await ghStub(t);
  const mergedScenario = await lifecycle(fixture, fixture.control, "prepare", { slug: "merged branch" });
  await publishAndMark(fixture, mergedScenario, "merged feature\n", 1);
  await pretendMerged(fixture, mergedScenario);
  await setGhState(stub, 1, "MERGED");

  const closedScenario = await lifecycle(fixture, fixture.control, "prepare", { slug: "closed branch" });
  await publishAndMark(fixture, closedScenario, "closed feature\n", 2);
  await setGhState(stub, 2, "CLOSED");

  const result = await lifecycle(
    fixture,
    fixture.control,
    "cleanup",
    { "dry-run": "false" },
    [0],
    ghEnv(stub),
  );
  const byPath = new Map(result.json.results.map((row) => [row.worktreePath, row]));
  const merged = byPath.get(mergedScenario.json.worktreePath);
  assert.equal(merged.decision, "remove");
  assert.equal(merged.removed, true);
  assert.equal(merged.branchDeleted, true);
  const closed = byPath.get(closedScenario.json.worktreePath);
  assert.equal(closed.decision, "protect");
  assert.match(closed.reason, /not contained in the remote default branch/);
  assert.equal(await pathExists(closedScenario.json.worktreePath), true);
  assert.ok((await run("git", ["branch", "--list", closedScenario.json.branch], { cwd: fixture.control })).stdout.includes(closedScenario.json.branch));
});

test("cleanup removes a squash-merged PR worktree through the recorded merge commit", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await ghStub(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "squash merge" });
  await publishAndMark(fixture, prepared);

  await git(fixture.seed, "fetch", "--quiet", "origin", prepared.json.branch);
  await git(fixture.seed, "merge", "--squash", `origin/${prepared.json.branch}`);
  await git(fixture.seed, "commit", "--quiet", "-m", "squash feature");
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
  await git(fixture.control, "pull", "--quiet", "--ff-only");
  const squashSha = (await git(fixture.seed, "rev-parse", "HEAD")).stdout.trim();
  await setGhState(stub, 7, "MERGED");
  await setGhMergeCommit(stub, 7, squashSha);

  const result = await lifecycle(
    fixture,
    fixture.control,
    "cleanup",
    { "dry-run": "false" },
    [0],
    ghEnv(stub),
  );
  const row = result.json.results.find((candidate) => candidate.worktreePath === prepared.json.worktreePath);
  assert.equal(row.decision, "remove");
  assert.equal(row.removed, true);
  assert.equal(row.branchRetained, true);
  assert.equal(row.branchDeleted, undefined);
  assert.equal(await pathExists(prepared.json.worktreePath), false);
});

test("cleanup protects a merged PR whose consumption cannot be proven from Git", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await ghStub(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "unprovable merge" });
  await publishAndMark(fixture, prepared);
  await setGhState(stub, 7, "MERGED");

  const result = await lifecycle(
    fixture,
    fixture.control,
    "cleanup",
    { "dry-run": "false" },
    [0],
    ghEnv(stub),
  );
  const row = result.json.results.find((candidate) => candidate.worktreePath === prepared.json.worktreePath);
  assert.equal(row.decision, "protect");
  assert.match(row.reason, /could not be established as consumed/);
  assert.equal(await pathExists(prepared.json.worktreePath), true);
});

test("cleanup protects the worktree it is invoked from and undeterminable pull-request state", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await ghStub(t);
  const active = await lifecycle(fixture, fixture.control, "prepare", { slug: "active from here" });
  await publishAndMark(fixture, active);
  await pretendMerged(fixture, active);

  const result = await lifecycle(
    fixture,
    active.json.worktreePath,
    "cleanup",
    { "dry-run": "false" },
    [0],
    ghEnv(stub),
  );
  const row = result.json.results.find((candidate) => candidate.worktreePath === active.json.worktreePath);
  assert.equal(row.decision, "protect");
  assert.equal(await pathExists(active.json.worktreePath), true);
});

async function mergeIntoTrunk(fixture, prepared) {
  await git(fixture.seed, "fetch", "--quiet", "origin", prepared.json.branch);
  await git(fixture.seed, "merge", "--quiet", "--no-ff", "--no-edit", `origin/${prepared.json.branch}`);
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
  return (await git(fixture.seed, "rev-parse", "HEAD")).stdout.trim();
}

test("prepare provides an evidence directory outside the worktree that cleanup removes", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "evidence home" });
  const { evidenceDir, worktreePath, sessionId } = prepared.json;

  assert.equal(evidenceDir, `${worktreePath}.evidence`);
  assert.equal(await pathExists(evidenceDir), true);
  assert.ok(!evidenceDir.startsWith(`${worktreePath}${path.sep}`));
  // Playwright writes screenshots into browser.outputDir, which defaults to the
  // worktree root, so rendered QA can save straight into evidenceDir.
  const { config } = await loadConfig({ file: fixture.config });
  assert.ok(evidenceDir.startsWith(`${config.browser.outputDir}${path.sep}`), `${evidenceDir} is outside ${config.browser.outputDir}`);
  const info = await lifecycle(fixture, fixture.control, "info", { session: sessionId });
  assert.equal(info.json.evidenceDir, evidenceDir);

  // Evidence written there must not block the clean-tree lifecycle gates.
  await writeFile(path.join(evidenceDir, "desktop.png"), "png");
  await publishAndMark(fixture, prepared);
  await pretendMerged(fixture, prepared);
  await setGhState(fixture.gh, 7, "MERGED");
  const result = await lifecycle(fixture, fixture.control, "cleanup", { "dry-run": "false" });
  assert.equal(result.json.removedCount, 1);
  assert.equal(await pathExists(worktreePath), false);
  assert.equal(await pathExists(evidenceDir), false);
});

test("prepare sweeps consumed workspaces and keeps everything it cannot prove safe", async (t) => {
  const fixture = await withEnvGitignore(t);
  // An in-progress session in another terminal: no PR recorded yet.
  const concurrent = await lifecycle(fixture, fixture.control, "prepare", { slug: "sweep concurrent" });

  const open = await lifecycle(fixture, fixture.control, "prepare", { slug: "sweep open" });
  await publishAndMark(fixture, open, "open\n", 1, "open.txt");

  const dirty = await lifecycle(fixture, fixture.control, "prepare", { slug: "sweep dirty" });
  await publishAndMark(fixture, dirty, "dirty\n", 2, "dirty.txt");
  await mergeIntoTrunk(fixture, dirty);
  await writeFile(path.join(dirty.json.worktreePath, "dirty.txt"), "unfinished\n");

  const consumed = await lifecycle(fixture, fixture.control, "prepare", { slug: "sweep consumed" });
  await publishAndMark(fixture, consumed, "consumed\n", 3, "consumed.txt");
  await mergeIntoTrunk(fixture, consumed);

  const extra = await lifecycle(fixture, fixture.control, "prepare", { slug: "sweep extra" });
  await publishAndMark(fixture, extra, "extra\n", 4, "extra.txt");
  const extraMerge = await mergeIntoTrunk(fixture, extra);
  await commit(extra.json.worktreePath, "local-only.txt", "local\n", "unpublished local work");

  // PR states become visible only now, so earlier prepares kept everything.
  await setGhState(fixture.gh, 1, "OPEN");
  await setGhState(fixture.gh, 2, "MERGED");
  await setGhState(fixture.gh, 3, "MERGED");
  await setGhState(fixture.gh, 4, "MERGED");
  await setGhMergeCommit(fixture.gh, 4, extraMerge);

  const next = await lifecycle(fixture, fixture.control, "prepare", { slug: "sweep next" });
  const { removed, kept } = next.json.cleanup;
  const keptReason = (prepared) => kept.find((row) => row.worktreePath === prepared.json.worktreePath)?.reason;
  assert.match(keptReason(open), /pull request is open/);
  assert.match(keptReason(dirty), /uncommitted or untracked work/);
  assert.match(keptReason(concurrent), /no recorded pull request/);

  const consumedRow = removed.find((row) => row.worktreePath === consumed.json.worktreePath);
  assert.equal(consumedRow.branchDeleted, true);
  assert.equal(await pathExists(consumed.json.worktreePath), false);
  assert.equal(await pathExists(consumed.json.evidenceDir), false);

  const extraRow = removed.find((row) => row.worktreePath === extra.json.worktreePath);
  assert.equal(extraRow.branchDeleted, false);
  assert.ok(extraRow.branchRetainedReason);
  assert.equal(await pathExists(extra.json.worktreePath), false);
  assert.ok((await git(fixture.control, "branch", "--list", extra.json.branch)).stdout.includes(extra.json.branch));

  assert.equal(removed.length, 2);
  for (const survivor of [open, dirty, concurrent, next]) {
    assert.equal(await pathExists(survivor.json.worktreePath), true);
  }
});

test("prepare keeps workspaces and still succeeds when gh cannot report state", async (t) => {
  const fixture = await withEnvGitignore(t);
  const merged = await lifecycle(fixture, fixture.control, "prepare", { slug: "gh failure" });
  await publishAndMark(fixture, merged);
  await pretendMerged(fixture, merged);
  // The fixture's gh stub has no state for this PR, so it exits non-zero.

  const next = await lifecycle(fixture, fixture.control, "prepare", { slug: "after gh failure" });
  assert.equal(next.code, 0);
  assert.equal(next.json.cleanup.removed.length, 0);
  const row = next.json.cleanup.kept.find((candidate) => candidate.worktreePath === merged.json.worktreePath);
  assert.match(row.reason, /could not determine pull request state/);
  assert.equal(await pathExists(merged.json.worktreePath), true);
});

test("publish explains how to proceed when evidence is missing or stale", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "publish guidance" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");

  const missing = await lifecycle(fixture, prepared.json.worktreePath, "publish", { session: prepared.json.sessionId });
  assert.equal(missing.json.requiresEvidence, true);
  assert.equal(missing.json.requiresRevalidation, false);
  assert.match(missing.json.nextAction, /record-evidence/);

  await recordEvidence(fixture, prepared);
  await advanceRemote(fixture);
  const stale = await lifecycle(fixture, prepared.json.worktreePath, "publish", { session: prepared.json.sessionId });
  assert.equal(stale.json.requiresRevalidation, true);
  assert.match(stale.json.nextAction, /npm run verify.*record-evidence.*publish again/);
});

// The configured URL names a GitHub repository while insteadOf routes the
// transport to the local bare remote, as a credential helper or mirror would.
async function useGithubRemote(fixture) {
  const github = "https://github.com/acme/widgets.git";
  await git(fixture.control, "config", `url.${fixture.remote}.insteadOf`, github);
  await git(fixture.control, "remote", "set-url", "origin", github);
}

async function mediaTree(fixture) {
  const listing = await run("git", ["--git-dir", fixture.remote, "ls-tree", "-r", "--name-only", "pr-media"], {
    allowedExitCodes: [0, 128],
  });
  return listing.code === 0 ? listing.stdout.trim().split("\n").filter(Boolean) : [];
}

async function mediaParents(fixture) {
  return (await run("git", ["--git-dir", fixture.remote, "show", "-s", "--format=%P", "pr-media"])).stdout.trim();
}

test("publish-media commits evidence to pr-media without touching the feature branch or control checkout", async (t) => {
  const fixture = await createFixture(t);
  await useGithubRemote(fixture);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "media demo" });
  const { evidenceDir, worktreePath, sessionId, branch } = prepared.json;
  const featureHead = await commit(worktreePath, "feature.txt", "feature\n", "feature");
  const controlHead = (await git(fixture.control, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(evidenceDir, "after-home-desktop.png"), "png");
  await writeFile(path.join(evidenceDir, "review-background.md"), "private context");

  const first = await lifecycle(fixture, worktreePath, "publish-media", { session: sessionId });
  assert.deepEqual(first.json.files.map((file) => file.path), [`${branch}/after-home-desktop.png`]);
  assert.equal(
    first.json.files[0].url,
    `https://github.com/acme/widgets/blob/${first.json.commit}/agent/media-demo/after-home-desktop.png?raw=true`,
  );
  assert.deepEqual(await mediaTree(fixture), [`${branch}/after-home-desktop.png`]);
  assert.equal(await mediaParents(fixture), "", "the first media commit is an orphan");

  await writeFile(path.join(evidenceDir, "after-home-mobile.png"), "png");
  const second = await lifecycle(fixture, fixture.control, "publish-media", { session: sessionId, files: "after-home-mobile.png" });
  assert.equal(await mediaParents(fixture), first.json.commit, "later media commits are additive");
  assert.equal(second.json.files.length, 1);
  assert.equal((await mediaTree(fixture)).length, 2);

  assert.equal((await git(worktreePath, "rev-parse", "HEAD")).stdout.trim(), featureHead);
  assert.equal((await git(worktreePath, "status", "--porcelain")).stdout, "");
  assert.equal((await git(fixture.control, "rev-parse", "HEAD")).stdout.trim(), controlHead);
  assert.equal((await git(fixture.control, "status", "--porcelain")).stdout, "");
  assert.equal((await git(fixture.control, "branch", "--list", "pr-media")).stdout, "");
  assert.notEqual(await run("git", ["--git-dir", fixture.remote, "show-ref", "--verify", `refs/heads/${branch}`], {
    allowedExitCodes: [0, 1, 128],
  }).then(({ code }) => code), 0, "the feature branch is not pushed");
});

test("publish-media refuses files outside evidenceDir and non-media files", async (t) => {
  const fixture = await createFixture(t);
  await useGithubRemote(fixture);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "media guard" });
  const { evidenceDir, sessionId } = prepared.json;
  const outside = path.join(fixture.root, "outside.png");
  await writeFile(outside, "png");
  await writeFile(path.join(evidenceDir, "notes.md"), "notes");
  await symlink(outside, path.join(evidenceDir, "escape.png"));

  for (const files of ["../../outside.png", outside, "escape.png"]) {
    const result = await lifecycle(fixture, fixture.control, "publish-media", { session: sessionId, files }, [2]);
    assert.match(result.stderr, /outside evidenceDir/);
  }
  const notes = await lifecycle(fixture, fixture.control, "publish-media", { session: sessionId, files: "notes.md" }, [2]);
  assert.match(notes.stderr, /non-media file/);
  assert.deepEqual(await mediaTree(fixture), []);
});

test("publish-media explains when the remote is not on GitHub", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "media local" });
  await writeFile(path.join(prepared.json.evidenceDir, "shot.png"), "png");
  const result = await lifecycle(fixture, fixture.control, "publish-media", { session: prepared.json.sessionId }, [2]);
  assert.match(result.stderr, /needs a GitHub remote/);
});

test("cleanup removes a removed workspace's media folder in one additive commit", async (t) => {
  const fixture = await withEnvGitignore(t);
  await useGithubRemote(fixture);
  const merged = await lifecycle(fixture, fixture.control, "prepare", { slug: "media merged" });
  const open = await lifecycle(fixture, fixture.control, "prepare", { slug: "media open" });
  for (const prepared of [merged, open]) {
    await writeFile(path.join(prepared.json.evidenceDir, "after.png"), "png");
    await lifecycle(fixture, fixture.control, "publish-media", { session: prepared.json.sessionId });
  }
  await publishAndMark(fixture, merged, "merged\n", 1, "merged.txt");
  await publishAndMark(fixture, open, "open\n", 2, "open.txt");
  await mergeIntoTrunk(fixture, merged);
  await setGhState(fixture.gh, 1, "MERGED");
  await setGhState(fixture.gh, 2, "OPEN");
  const before = (await run("git", ["--git-dir", fixture.remote, "rev-parse", "pr-media"])).stdout.trim();

  const next = await lifecycle(fixture, fixture.control, "prepare", { slug: "media next" });
  assert.equal(next.json.cleanup.removed.length, 1);
  assert.deepEqual(next.json.cleanup.media, [{ branches: [merged.json.branch], removed: true }]);
  assert.deepEqual(await mediaTree(fixture), [`${open.json.branch}/after.png`]);
  assert.equal(await mediaParents(fixture), before);
});

test("the tool and every subcommand answer --help and -h with exit 0", async (t) => {
  const fixture = await createFixture(t);
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await run(process.execPath, [cli, ...args], { cwd: fixture.root });
    assert.match(result.stdout, /^Usage: ibni <command>/);
    for (const name of Object.keys(COMMANDS)) assert.match(result.stdout, new RegExp(`^  ${name} `, "m"));
  }
  // Enumerated from the registry, so a subcommand without help fails here.
  for (const name of Object.keys(COMMANDS)) {
    for (const args of [[name, "--help"], [name, "-h"], ["help", name], [name, "--session", "x", "--help"]]) {
      const result = await run(process.execPath, [cli, ...args], { cwd: fixture.root });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, new RegExp(`^Usage: ibni ${name}\\b`), `${args.join(" ")}`);
    }
  }
  const media = await run(process.execPath, [cli, "publish-media", "--help"], { cwd: fixture.root });
  for (const extension of MEDIA_EXTENSIONS) assert.ok(media.stdout.includes(extension), `publish-media help lists ${extension}`);
  const unknown = await run(process.execPath, [cli, "unknown", "--help"], { cwd: fixture.root, allowedExitCodes: [2] });
  assert.match(unknown.stderr, /expected prepare, sync, /);
});

test("session commands find their workspace from evidenceDir and from outside any repository", async (t) => {
  const fixture = await createFixture(t);
  await useGithubRemote(fixture);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "anywhere" });
  const { evidenceDir, sessionId, worktreePath } = prepared.json;
  await mkdir(path.join(evidenceDir, "shots"));
  await writeFile(path.join(evidenceDir, "shots", "after.png"), "png");
  await commit(worktreePath, "feature.txt", "feature\n", "feature");

  const media = await lifecycle(fixture, path.join(evidenceDir, "shots"), "publish-media", { session: sessionId });
  assert.deepEqual(media.json.files.map((file) => file.file), ["shots/after.png"]);
  const info = await lifecycle(fixture, evidenceDir, "info", { session: sessionId });
  assert.equal(info.json.worktreePath, worktreePath);
  const outside = await mkdtemp(path.join(os.tmpdir(), "ibni-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const recorded = await lifecycle(fixture, outside, "record-evidence", { session: sessionId });
  assert.equal(recorded.json.operation, "record-evidence");
  const unknown = await lifecycle(fixture, outside, "info", { session: "does-not-exist" }, [2]);
  assert.match(unknown.stderr, /no implementation worktree for this session/);
});

async function listen(port, host = "127.0.0.1") {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host }, resolve);
  });
  return server;
}

test("prepare assigns each workspace a free port, skipping recorded and bound ones", async (t) => {
  const fixture = await createFixture(t);
  const bound = await listen(0);
  t.after(() => bound.close());
  const busy = bound.address().port;
  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, workflow: { ports: { first: busy, last: busy + 20 } } }));

  const first = await lifecycle(fixture, fixture.control, "prepare", { slug: "port one" });
  const second = await lifecycle(fixture, fixture.control, "prepare", { slug: "port two" });
  for (const prepared of [first, second]) {
    assert.ok(prepared.json.port > busy && prepared.json.port <= busy + 20, `${prepared.json.port} is in range and not the bound port`);
  }
  assert.notEqual(first.json.port, second.json.port);
  const info = await lifecycle(fixture, fixture.control, "info", { session: second.json.sessionId });
  assert.equal(info.json.port, second.json.port);
  const list = await lifecycle(fixture, fixture.control, "list");
  assert.deepEqual(list.json.workspaces.map((workspace) => workspace.port).sort(), [first.json.port, second.json.port].sort());

  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, workflow: { ports: { first: busy, last: busy } } }));
  const exhausted = await lifecycle(fixture, fixture.control, "prepare", { slug: "port none" }, [2]);
  assert.match(exhausted.stderr, /no free port between/);
  assert.equal((await git(fixture.control, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm).length, 3);
});

test("lifecycle steps, verify attempts and finding counts are recorded and reported by stats", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "timed" });
  const { sessionId, worktreePath } = prepared.json;
  await commit(worktreePath, "feature.txt", "feature\n", "feature");
  for (const options of [{ verify: "fail" }, { verify: "pass" }, { review: "3" }, { qa: "0" }, { review: "1" }]) {
    const recorded = await lifecycle(fixture, fixture.control, "record", { session: sessionId, ...options });
    assert.equal(recorded.json.operation, "record");
  }
  for (const options of [{}, { verify: "maybe" }, { review: "-1" }, { verify: "pass", qa: "1" }]) {
    await lifecycle(fixture, fixture.control, "record", { session: sessionId, ...options }, [2]);
  }
  await lifecycle(fixture, worktreePath, "publish", { session: sessionId });
  await writeFile(path.join(worktreePath, "dirty.txt"), "dirty\n");
  await lifecycle(fixture, worktreePath, "sync", { session: sessionId }, [2]);
  await rm(path.join(worktreePath, "dirty.txt"));
  await recordEvidence(fixture, prepared);
  await lifecycle(fixture, worktreePath, "publish", { session: sessionId });

  const stats = await lifecycle(fixture, fixture.root, "stats", { session: sessionId });
  assert.equal(stats.json.operation, "stats");
  assert.deepEqual(
    stats.json.steps.map(({ step, outcome }) => [step, outcome]),
    [["prepare", "succeeded"], ["publish", "requires-evidence"], ["sync", "failed"], ["record-evidence", "succeeded"], ["publish", "succeeded"]],
  );
  for (const step of stats.json.steps) {
    assert.equal(step.sessionId, sessionId);
    assert.ok(step.durationMs >= 0 && Date.parse(step.endedAt) >= Date.parse(step.startedAt));
  }
  assert.match(stats.json.steps[2].error, /uncommitted or untracked work/);
  assert.deepEqual({ ...stats.json.verify, history: undefined }, { attempts: 2, passed: 1, failed: 1, history: undefined });
  assert.deepEqual(stats.json.verify.history.map((entry) => entry.outcome), ["fail", "pass"]);
  assert.deepEqual([stats.json.review.rounds, stats.json.review.findings], [2, 4]);
  assert.deepEqual([stats.json.qa.rounds, stats.json.qa.findings], [1, 0]);
});

async function metadataFile(worktreePath) {
  const gitDirectory = (await git(worktreePath, "rev-parse", "--absolute-git-dir")).stdout.trim();
  return readFile(path.join(gitDirectory, "implementation-workspace.json"), "utf8");
}

test("a fresh session adopts an open pull request's workspace and delivers a follow-up", async (t) => {
  const fixture = await createFixture(t);
  const sessionA = await lifecycle(fixture, fixture.control, "prepare", { slug: "adoptable" });
  const { worktreePath, branch } = sessionA.json;
  await publishAndMark(fixture, sessionA, "first\n", 7);
  const prUrl = "https://example.test/pull/7";
  const publishedSha = (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();

  // Every failed proof leaves the metadata byte for byte and session A in charge.
  const refused = async (pattern) => {
    const before = await metadataFile(worktreePath);
    const result = await lifecycle(fixture, fixture.control, "adopt", { pr: prUrl }, [2]);
    assert.match(result.stderr, pattern);
    assert.equal(await metadataFile(worktreePath), before);
    await lifecycle(fixture, fixture.control, "info", { session: sessionA.json.sessionId });
  };
  const unknownPr = await lifecycle(fixture, fixture.control, "adopt", { pr: "https://example.test/pull/99" }, [2]);
  assert.match(unknownPr.stderr, /no retained workspace records this pull request/);
  await refused(/could not read the pull request/);
  await setGhState(fixture.gh, 7, "CLOSED");
  await setGhHead(fixture.gh, 7, branch, publishedSha);
  await refused(/pull request is closed, not open/);
  await setGhState(fixture.gh, 7, "OPEN");
  await setGhHead(fixture.gh, 7, "agent/someone-else", publishedSha);
  await refused(/head branch does not match/);
  await setGhHead(fixture.gh, 7, branch, "0".repeat(40));
  await refused(/do not all match/);
  await setGhHead(fixture.gh, 7, branch, publishedSha);
  await commit(worktreePath, "unpublished.txt", "a's work\n", "unpublished work by session A");
  await refused(/do not all match[\s\S]*local: (?!${publishedSha})/);
  await git(worktreePath, "reset", "--quiet", "--hard", publishedSha);
  await writeFile(path.join(worktreePath, "scratch.txt"), "a's edit\n");
  await refused(/uncommitted or untracked work/);
  await rm(path.join(worktreePath, "scratch.txt"));

  // Session B knows only the PR URL.
  const adopted = await lifecycle(fixture, fixture.control, "adopt", { pr: prUrl });
  const sessionB = adopted.json.sessionId;
  assert.notEqual(sessionB, sessionA.json.sessionId);
  assert.deepEqual(
    [adopted.json.worktreePath, adopted.json.branch, adopted.json.prUrl, adopted.json.headSha, adopted.json.port],
    [worktreePath, branch, prUrl, publishedSha, sessionA.json.port],
  );
  const stale = await lifecycle(fixture, fixture.control, "sync", { session: sessionA.json.sessionId }, [2]);
  assert.match(stale.stderr, /no implementation worktree for this session/);

  await commit(worktreePath, "follow-up.txt", "follow-up\n", "follow-up");
  await lifecycle(fixture, worktreePath, "record-evidence", { session: sessionB });
  const published = await lifecycle(fixture, worktreePath, "publish", { session: sessionB });
  assert.equal(published.json.published, true);
  const followUpSha = (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
  assert.equal((await run("git", ["--git-dir", fixture.remote, "rev-parse", `refs/heads/${branch}`])).stdout.trim(), followUpSha);
  await lifecycle(fixture, worktreePath, "mark-pr", { session: sessionB, url: prUrl });

  const stats = await lifecycle(fixture, fixture.control, "stats", { session: sessionB });
  assert.deepEqual(stats.json.adoptions.map(({ previousSessionId, sessionId }) => [previousSessionId, sessionId]), [[sessionA.json.sessionId, sessionB]]);
  assert.deepEqual(stats.json.steps.filter((step) => step.step === "adopt").map((step) => step.sessionId), [sessionB]);
});

async function gitStub(t) {
  const stubDirectory = await mkdtemp(path.join(os.tmpdir(), "ibni-git-stub-"));
  t.after(() => rm(stubDirectory, { recursive: true, force: true }));
  const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(path.join(stubDirectory, "git"), `#!/bin/sh
if [ "$1" = "push" ]; then
  echo attempt >> "${stubDirectory}/pushes"
  if [ -f "${stubDirectory}/fail" ]; then
    status="$(cat "${stubDirectory}/fail")"
    rm -f "${stubDirectory}/fail"
    echo "error: RPC failed; HTTP $status curl 22 The requested URL returned error: $status" >&2
    echo "fatal: the remote end hung up unexpectedly" >&2
    exit 128
  fi
fi
exec "${realGit}" "$@"
`, "utf8");
  await chmod(path.join(stubDirectory, "git"), 493);
  return stubDirectory;
}

test("publish retries a push once after an HTTP 5xx and never after other failures", async (t) => {
  const fixture = await createFixture(t);
  const stub = await gitStub(t);
  const env = { PATH: `${stub}:${ghEnv(fixture.gh).PATH}` };
  const pushes = async () => (await readFile(path.join(stub, "pushes"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

  const forbidden = await lifecycle(fixture, fixture.control, "prepare", { slug: "push forbidden" });
  await commit(forbidden.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, forbidden);
  await writeFile(path.join(stub, "fail"), "403");
  const refused = await lifecycle(fixture, forbidden.json.worktreePath, "publish", { session: forbidden.json.sessionId }, [2], env);
  assert.match(refused.stderr, /HTTP 403/);
  assert.equal(await pushes(), 1);

  await rm(path.join(stub, "pushes"));
  const flaky = await lifecycle(fixture, fixture.control, "prepare", { slug: "push flaky" });
  await commit(flaky.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, flaky);
  await writeFile(path.join(stub, "fail"), "502");
  const published = await lifecycle(fixture, flaky.json.worktreePath, "publish", { session: flaky.json.sessionId }, [0], env);
  assert.equal(published.json.published, true);
  assert.equal(await pushes(), 2);
});
