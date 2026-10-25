import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { COMMANDS } from "./ibni.mjs";
import { MEDIA_EXTENSIONS } from "./lib/media.mjs";

const cli = fileURLToPath(new URL("./ibni.mjs", import.meta.url));
const VERIFY_SCRIPT = "node -e \"process.exit(require('fs').existsSync('FAIL') ? 1 : 0)\"";

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
  // The default verify command is npm run verify; this one passes unless the
  // tree holds a file named FAIL, so a test makes it fail with one commit.
  await writeFile(path.join(seed, "package.json"), `${JSON.stringify({ private: true, scripts: { verify: VERIFY_SCRIPT } })}\n`);
  await git(seed, "add", "package.json");
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
  const fixture = { root, remote, seed, control, worktrees, gh, config };
  // Forge calls (pull requests, CI state, issues, media URLs) need a remote on
  // a known forge; useLocalRemote takes it away again.
  await useGithubRemote(fixture);
  return fixture;
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
      // Tests never reach OpenRouter with a real key; triage tests set their own.
      OPENROUTER_API_KEY: "",
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

async function verify(fixture, prepared, allowedExitCodes = [0]) {
  const result = await lifecycle(fixture, prepared.json.worktreePath, "verify", { session: prepared.json.sessionId }, allowedExitCodes);
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

async function recordEvidence(fixture, prepared) {
  await verify(fixture, prepared);
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
  // An agent that passes --prefix with nothing after it gets the configured prefix, not a branch without one.
  const empty = await lifecycle(fixture, fixture.control, "prepare", { slug: "empty", prefix: "" });
  assert.equal(empty.json.branch, "team/bots/empty");
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

test("refuses a session from another repository inside a different session's worktree", async (t) => {
  const fixture = await createFixture(t);
  const other = await createFixture(t);
  // Both repositories share one worktree root, so the other session is
  // discoverable from anywhere; only the worktree cwd stands in may act.
  const mine = await lifecycle(fixture, fixture.control, "prepare", { slug: "mine" });
  const theirs = await lifecycle(fixture, other.control, "prepare", { slug: "theirs" });

  const result = await lifecycle(
    fixture,
    mine.json.worktreePath,
    "record-evidence",
    { session: theirs.json.sessionId },
    [2],
  );
  assert.match(result.stderr, /session token does not own/);
  const fromOutside = await lifecycle(fixture, other.control, "record-evidence", { session: theirs.json.sessionId });
  assert.equal(fromOutside.json.operation, "record-evidence");
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
  assert.equal(info.json.reviewTool, "ocr", "the default review tool");
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
if [ "$1" = "api" ]; then
  if [ -f "\${GH_STUB_DIR}/check-runs.json" ]; then cat "\${GH_STUB_DIR}/check-runs.json"; exit 0; fi
  echo "gh: check runs not configured" >&2
  exit 1
fi
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
  assert.equal(missing.json.requiresVerify, true);
  assert.equal(missing.json.requiresRevalidation, false);
  assert.match(missing.json.nextAction, /ibni verify --session .*record-evidence/);

  await verify(fixture, prepared);
  const unrecorded = await lifecycle(fixture, prepared.json.worktreePath, "publish", { session: prepared.json.sessionId });
  assert.equal(unrecorded.json.requiresEvidence, true);
  assert.equal(unrecorded.json.requiresVerify, undefined);
  assert.match(unrecorded.json.nextAction, /^Run record-evidence/);

  await recordEvidence(fixture, prepared);
  await advanceRemote(fixture);
  const stale = await lifecycle(fixture, prepared.json.worktreePath, "publish", { session: prepared.json.sessionId });
  assert.equal(stale.json.requiresRevalidation, true);
  assert.equal(stale.json.requiresVerify, true);
  assert.match(stale.json.nextAction, new RegExp(`^Run ibni verify --session ${prepared.json.sessionId} in the background \\(it runs the verify command, npm run verify unless the default branch has none, on the integrated tree\\).*record-evidence, then publish again\\.$`));
});

// The configured URL names a forge repository while insteadOf routes the
// transport to the local bare remote, as a credential helper or mirror would.
async function useForgeRemote(fixture, url) {
  await git(fixture.control, "config", `url.${fixture.remote}.insteadOf`, url);
  await git(fixture.control, "remote", "set-url", "origin", url);
}

async function useGithubRemote(fixture) {
  await useForgeRemote(fixture, "https://github.com/acme/widgets.git");
}

// A remote that is a plain local path names no forge.
async function useLocalRemote(fixture) {
  await git(fixture.control, "remote", "set-url", "origin", fixture.remote);
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

test("publish-media explains when the remote is not on a known forge", async (t) => {
  const fixture = await createFixture(t);
  await useLocalRemote(fixture);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "media local" });
  await writeFile(path.join(prepared.json.evidenceDir, "shot.png"), "png");
  const result = await lifecycle(fixture, fixture.control, "publish-media", { session: prepared.json.sessionId }, [2]);
  assert.match(result.stderr, /needs a GitHub or GitLab remote/);
});

test("cleanup removes a removed workspace's media folder in one additive commit", async (t) => {
  const fixture = await withEnvGitignore(t);
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
      assert.match(result.stdout, /^Why: \S.+$/m, `${name} --help says why it exists`);
    }
  }
  const media = await run(process.execPath, [cli, "publish-media", "--help"], { cwd: fixture.root });
  for (const extension of MEDIA_EXTENSIONS) assert.ok(media.stdout.includes(extension), `publish-media help lists ${extension}`);
  const unknown = await run(process.execPath, [cli, "unknown", "--help"], { cwd: fixture.root, allowedExitCodes: [2] });
  assert.match(unknown.stderr, /expected prepare, setup, verify, sync, /);
});

test("session commands find their workspace from evidenceDir and from outside any repository", async (t) => {
  const fixture = await createFixture(t);
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

const portsConfig = (fixture, ports, extra = {}) => writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, workflow: { ports, ...extra } }));

// Break: a block overlapping a bound port or another workspace's block is
// handed out, so two workspaces' test servers collide.
test("prepare gives each workspace a free block of ports, skipping recorded and bound ones", async (t) => {
  const fixture = await createFixture(t);
  const bound = await listen(0);
  t.after(() => bound.close());
  const busy = bound.address().port;
  await portsConfig(fixture, { first: busy, last: busy + 29, blockSize: 10 });

  const first = await lifecycle(fixture, fixture.control, "prepare", { slug: "port one" });
  const second = await lifecycle(fixture, fixture.control, "prepare", { slug: "port two" });
  // The first block holds the bound port, so the workspaces get the next two.
  assert.deepEqual([first.json.ports, second.json.ports], [
    { first: busy + 10, size: 10, last: busy + 19 },
    { first: busy + 20, size: 10, last: busy + 29 },
  ]);
  assert.equal(first.json.port, busy + 10);
  assert.equal(first.json.portEnv.PORT, String(busy + 10));
  assert.equal(first.json.portEnv.MEXXI_PORT_9, String(busy + 19));
  const info = await lifecycle(fixture, fixture.control, "info", { session: second.json.sessionId });
  assert.deepEqual([info.json.port, info.json.ports], [second.json.port, second.json.ports]);
  const list = await lifecycle(fixture, fixture.control, "list");
  assert.deepEqual(list.json.workspaces.map((workspace) => workspace.ports.first).sort(), [busy + 10, busy + 20]);

  const exhausted = await lifecycle(fixture, fixture.control, "prepare", { slug: "port none" }, [2]);
  assert.match(exhausted.stderr, /no free block of 10 ports between/);
  assert.equal((await git(fixture.control, "worktree", "list", "--porcelain")).stdout.match(/^worktree /gm).length, 3);
});

// Break: blocks are chosen under only the repository lock, so prepares in two
// repositories at once both take the first free block.
test("prepares in different repositories at once never share a block", async (t) => {
  const fixtures = await Promise.all([createFixture(t), createFixture(t), createFixture(t)]);
  const probe = await listen(0);
  const first = probe.address().port + 1;
  probe.close();
  const shared = { paths: { worktreeRoot: fixtures[0].worktrees }, workflow: { ports: { first, last: first + 59, blockSize: 10 } } };
  for (const fixture of fixtures) await writeFile(fixture.config, JSON.stringify(shared));
  const prepared = await Promise.all(fixtures.map((fixture, index) => lifecycle(fixture, fixture.control, "prepare", { slug: `race ${index}` })));
  const blocks = prepared.map((result) => result.json.ports.first);
  assert.equal(new Set(blocks).size, 3, `blocks ${blocks.join(", ")} are distinct`);
});

async function envDumper(fixture) {
  const script = path.join(fixture.root, "dump-env.mjs");
  await writeFile(script, "import { writeFileSync } from 'node:fs';\nconst keys = Object.keys(process.env).filter((key) => /PORT/.test(key));\nwriteFileSync(process.argv[2], JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));\n");
  return (name) => `node ${JSON.stringify(script)} ${JSON.stringify(path.join(fixture.root, `${name}.json`))}`;
}
const readDump = async (fixture, name) => JSON.parse(await readFile(path.join(fixture.root, `${name}.json`), "utf8"));

// Break: setup or verify runs with ibni's own environment only (as before
// blocks), so a repository's test servers fall back to fixed ports; or a port
// variable ibni inherited, such as another workspace's, leaks into the run.
test("setup and verify see the block as PORT, MEXXI_PORT_<n> and the repository's mapped variables", async (t) => {
  const fixture = await createFixture(t);
  const dump = await envDumper(fixture);
  const probe = await listen(0);
  const first = probe.address().port + 1;
  probe.close();
  // portVariables is keyed by the checkout's folder name, here "control".
  await portsConfig(fixture, { first, last: first + 9, blockSize: 4 }, { portVariables: { control: { E2E_PORT: 1, MCP_PORT: 3 }, other: { OTHER_PORT: 2 } } });
  await commitToDefaultBranch(fixture, { ".mexxi.json": `${JSON.stringify({ setup: dump("setup"), verify: dump("verify") })}\n` }, "dump env");

  // As if another workspace's portEnv were exported in the agent's shell.
  const leaked = { PORT: "1", MEXXI_PORT_3: "1", MEXXI_PORT_9: "1", E2E_PORT: "1", MCP_PORT: "1", OTHER_PORT: "7" };
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "port env" }, [0], leaked);
  const expected = {
    PORT: String(first), MEXXI_PORT_0: String(first), MEXXI_PORT_1: String(first + 1), MEXXI_PORT_2: String(first + 2), MEXXI_PORT_3: String(first + 3),
    E2E_PORT: String(first + 1), MCP_PORT: String(first + 3),
    // Not mapped for this repository, so ibni leaves it alone.
    OTHER_PORT: "7",
  };
  assert.deepEqual(await readDump(fixture, "setup"), expected);
  const { OTHER_PORT: _other, ...portEnv } = expected;
  assert.deepEqual(prepared.json.portEnv, portEnv);
  const verified = await lifecycle(fixture, prepared.json.worktreePath, "verify", { session: prepared.json.sessionId }, [0], leaked);
  assert.equal(verified.json.passed, true);
  assert.deepEqual(await readDump(fixture, "verify"), expected);
  await rm(path.join(fixture.root, "setup.json"));
  await lifecycle(fixture, prepared.json.worktreePath, "setup", { session: prepared.json.sessionId }, [0], leaked);
  assert.deepEqual(await readDump(fixture, "setup"), expected);
});

// Break: verify starts with a block port taken and the repository's test
// server fails half-way with EADDRINUSE, or a failure is recorded for the tree.
test("verify refuses to run while a port of the workspace's block is bound, recording nothing", async (t) => {
  const fixture = await createFixture(t);
  const probe = await listen(0);
  const first = probe.address().port + 1;
  probe.close();
  await portsConfig(fixture, { first, last: first + 9, blockSize: 5 });
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "port taken" });
  const squatter = await listen(prepared.json.ports.first + 2);
  t.after(() => squatter.close());

  const refused = await verify(fixture, prepared, [2]);
  assert.match(refused.stderr, new RegExp(`port ${first + 2} of this workspace's block is already in use`));
  assert.equal(JSON.parse(await metadataFile(prepared.json.worktreePath)).verification, null);
  squatter.close();
  assert.equal((await verify(fixture, prepared)).json.passed, true);
});

// Break: a workspace from before blocks loses its port, or verify refuses it.
test("a workspace recorded with one port keeps it as a block of one", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "one port" });
  const { worktreePath, sessionId } = prepared.json;
  const gitDirectory = (await git(worktreePath, "rev-parse", "--absolute-git-dir")).stdout.trim();
  const metadata = JSON.parse(await metadataFile(worktreePath));
  delete metadata.ports;
  await writeFile(path.join(gitDirectory, "implementation-workspace.json"), JSON.stringify(metadata));

  const info = await lifecycle(fixture, fixture.control, "info", { session: sessionId });
  assert.deepEqual(info.json.ports, { first: metadata.port, size: 1, last: metadata.port });
  assert.deepEqual(info.json.portEnv, { PORT: String(metadata.port), MEXXI_PORT_0: String(metadata.port) });
  const next = await lifecycle(fixture, fixture.control, "prepare", { slug: "after one port" });
  assert.ok(next.json.ports.first > metadata.port || next.json.ports.last < metadata.port, "the new block leaves the old port alone");
});

// A verify command that logs when it starts and ends in each worktree and
// takes holdMs, so a test can see which runs overlapped.
async function timedVerify(fixture, holdMs) {
  const script = path.join(fixture.root, "timed-verify.mjs");
  const log = path.join(fixture.root, "runs.log");
  await writeFile(script, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, \`start \${process.cwd()} \${Date.now()}\\n\`);
setTimeout(() => appendFileSync(${JSON.stringify(log)}, \`end \${process.cwd()} \${Date.now()}\\n\`), ${holdMs});
`);
  await commitToDefaultBranch(fixture, { ".mexxi.json": `${JSON.stringify({ verify: `node ${JSON.stringify(script)}` })}\n` }, "timed verify");
  return async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => {
    const [event, cwd, at] = line.split(" ");
    return { event, cwd, at: Number(at) };
  });
}

const slotsConfig = (fixture, verifySlots) => writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, workflow: { verifySlots } }));
const queueDirectory = (fixture) => path.join(fixture.worktrees, ".ibni", "slots", "queue");

// Break: verify ignores workflow.verifySlots (or counts it off by one), so a
// third run starts while two hold the machine, or the wait goes unreported.
test("verify runs beyond workflow.verifySlots wait in a readable queue and report queuedMs", async (t) => {
  const fixture = await createFixture(t);
  const runs = await timedVerify(fixture, 1500);
  await slotsConfig(fixture, 2);
  const prepared = [];
  for (const slug of ["slot a", "slot b", "slot c"]) prepared.push(await lifecycle(fixture, fixture.control, "prepare", { slug }));

  const pending = prepared.map((workspace) => verify(fixture, workspace));
  let queued = [];
  for (let attempt = 0; attempt < 100 && !queued.length; attempt += 1) {
    queued = (await readdir(queueDirectory(fixture)).catch(() => [])).filter((name) => name.endsWith(".json"));
    if (!queued.length) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(queued.length, 1, "the third run waits in the queue");
  const waiting = JSON.parse(await readFile(path.join(queueDirectory(fixture), queued[0]), "utf8"));
  assert.equal(waiting.kind, "verify");
  assert.ok(prepared.some((workspace) => workspace.json.sessionId === waiting.sessionId));
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.json.passed && result.json.recorded));

  const log = await runs();
  const starts = log.filter((entry) => entry.event === "start").map((entry) => entry.at).sort((a, b) => a - b);
  const ends = log.filter((entry) => entry.event === "end").map((entry) => entry.at).sort((a, b) => a - b);
  assert.ok(starts[1] < ends[0], "two runs overlap");
  assert.ok(starts[2] >= ends[0], "the third starts only after one has ended");
  const waits = results.map((result) => result.json.queuedMs).sort((a, b) => a - b);
  assert.ok(waits[2] >= 1000, `the queued run reports its wait (${waits.join(", ")} ms)`);
  assert.equal(JSON.parse(await metadataFile(results[0].json.logPath.replace(/\.evidence\/.*$/, ""))).verification.queuedMs, results[0].json.queuedMs);
  assert.deepEqual((await readdir(queueDirectory(fixture))).filter((name) => name.endsWith(".json")), [], "the queue is empty afterwards");
});

// Break: a slot whose holder died is waited on for ever.
test("a run slot left by a process that died is taken over", { timeout: 30_000 }, async (t) => {
  const fixture = await createFixture(t);
  await slotsConfig(fixture, 1);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "stale slot" });
  const dead = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => dead.once("close", resolve));
  const slot = path.join(fixture.worktrees, ".ibni", "slots", "slot-0");
  await mkdir(slot, { recursive: true });
  await writeFile(path.join(slot, "owner.json"), JSON.stringify({ hostname: os.hostname(), pid: dead.pid, token: "gone", startedAt: new Date().toISOString() }));

  const result = await verify(fixture, prepared);
  assert.equal(result.json.passed, true);
  assert.ok(result.json.queuedMs < 1000, `took the dead holder's slot at once (${result.json.queuedMs} ms)`);
});

// A local stand-in for OpenRouter's Decisions API: answers each request from
// a queue ({status, body} or {hang: true}) and keeps what it was sent.
async function jevStub(t, responses) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      const next = responses.shift() ?? { status: 500, body: { error: { code: 500, message: "stub exhausted" } } };
      if (next.hang) return;
      response.writeHead(next.status, { "content-type": "application/json" });
      response.end(JSON.stringify(next.body));
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/api/alpha/decisions` };
}

const JEV_ANSWERS = {
  id: "gen-1",
  model: "typesafe/jev-1.14-20261001",
  answers: {
    existingUi: { type: "noul", noul: 0.2 },
    userFacing: { type: "noul", noul: 0.1 },
    oneWayDoor: { type: "noul", noul: 0.05 },
    size: { type: "choice", choice: "local", confidence: 0.8, probabilities: { local: 0.8, feature: 0.2 } },
    reviewValue: { type: "score", score: 2.4, confidence: 0.6, probabilities: { 0: 0, 1: 0.1, 2: 0.4, 3: 0.5 } },
  },
  usage: { input_tokens: 900, output_tokens: 0, cost: 0.00004 },
};

async function useJev(fixture, jev) {
  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, jev }));
}

// The request and contract files /wettaq writes before calling triage.
async function triageFiles(evidenceDir, request = "Rename the settings page", contract = "Goal: rename the page.") {
  const files = { "request-file": path.join(evidenceDir, "request.md"), "contract-file": path.join(evidenceDir, "contract.md") };
  await writeFile(files["request-file"], request);
  await writeFile(files["contract-file"], contract);
  return files;
}

test("lifecycle steps, verify attempts and finding counts are recorded and reported by stats", async (t) => {
  const fixture = await createFixture(t);
  const jev = await jevStub(t, [{ status: 200, body: JEV_ANSWERS }]);
  await useJev(fixture, { enabled: true, endpoint: jev.endpoint, owners: ["acme"], repositories: ["acme/widgets"] });
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "timed" });
  const { sessionId, worktreePath } = prepared.json;
  const triaged = await lifecycle(fixture, fixture.control, "triage", { session: sessionId, ...await triageFiles(prepared.json.evidenceDir) }, [0], { OPENROUTER_API_KEY: "test-key" });
  assert.equal(triaged.json.outcome, "answered");
  await commit(worktreePath, "feature.txt", "feature\n", "feature");
  for (const options of [{ "before-shots": "skipped" }, { verify: "fail" }, { verify: "pass" }, { review: "3", accepted: "2", reviewer: "same" }, { qa: "0" }, { review: "1", accepted: "1", reviewer: "cross" }]) {
    const recorded = await lifecycle(fixture, fixture.control, "record", { session: sessionId, ...options });
    assert.equal(recorded.json.operation, "record");
  }
  for (const options of [{}, { verify: "maybe" }, { review: "-1" }, { verify: "pass", qa: "1" }, { "before-shots": "maybe" },
    { review: "2", accepted: "1" }, { review: "2", reviewer: "same" }, { review: "2", accepted: "3", reviewer: "same" },
    { review: "2", accepted: "1", reviewer: "other" }, { qa: "2", accepted: "1", reviewer: "same" }]) {
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
    [["prepare", "succeeded"], ["publish", "requires-evidence"], ["sync", "failed"], ["verify", "succeeded"], ["record-evidence", "succeeded"], ["publish", "succeeded"]],
  );
  for (const step of stats.json.steps) {
    assert.equal(step.sessionId, sessionId);
    assert.ok(step.durationMs >= 0 && Date.parse(step.endedAt) >= Date.parse(step.startedAt));
  }
  assert.match(stats.json.steps[2].error, /uncommitted or untracked work/);
  // Two recorded by hand, one by ibni verify.
  assert.deepEqual({ ...stats.json.verify, history: undefined }, { attempts: 3, passed: 2, failed: 1, history: undefined });
  assert.deepEqual(stats.json.verify.history.map((entry) => entry.outcome), ["fail", "pass", "pass"]);
  assert.deepEqual([stats.json.review.rounds, stats.json.review.findings], [2, 4]);
  assert.deepEqual(stats.json.review.byReviewer, {
    same: { rounds: 1, findings: 3, accepted: 2 },
    cross: { rounds: 1, findings: 1, accepted: 1 },
  });
  assert.deepEqual([stats.json.qa.rounds, stats.json.qa.findings], [1, 0]);
  assert.equal(stats.json.triage.status, "answered");
  assert.deepEqual(stats.json.triage.answers.userFacing, { answer: "no", confidence: 0.9 });
  // Triage advised against rendered QA, which the agent ran; the other two gates agree.
  assert.deepEqual(stats.json.triage.agreement.gates, {
    beforeShots: { triage: false, agent: false, agree: true },
    renderedQa: { triage: false, agent: true, agree: false },
    review: { triage: true, agent: true, agree: true },
  });
  assert.deepEqual([stats.json.triage.agreement.compared, stats.json.triage.agreement.agreed], [3, 2]);

  // The run pane mod's tests draw from a recording of this scenario; it must
  // keep the shape ibni prints, or those tests prove nothing.
  await lifecycle(fixture, worktreePath, "mark-pr", { session: sessionId, url: "https://github.com/alexportelli12/example/pull/42" });
  const recorded = await import("../../claude/mods/run-pane/tests/recorded.mjs");
  const shape = (value) => Array.isArray(value) ? [shape(value[0])]
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
      : typeof value;
  for (const [operation, json] of [["info", recorded.info], ["stats", recorded.stats]]) {
    const live = await lifecycle(fixture, fixture.root, operation, { session: sessionId });
    assert.deepEqual(shape(json), shape(live.json), `claude/mods/run-pane/tests/recorded.mjs no longer matches ibni ${operation}; record it again`);
  }
});

test("triage sends nothing unless enabled, listed, owned by you and keyed, and records why", async (t) => {
  const jev = await jevStub(t, []);
  const key = { OPENROUTER_API_KEY: "test-key" };
  const triage = async (fixture, prepared, env = key) => {
    const result = await lifecycle(fixture, fixture.control, "triage", { session: prepared.json.sessionId, ...await triageFiles(prepared.json.evidenceDir) }, [0], env);
    assert.equal(result.json.stage, "shadow");
    assert.equal(result.json.outcome, "skipped");
    return result.json.reason;
  };

  const local = await createFixture(t);
  await useLocalRemote(local);
  const localPrepared = await lifecycle(local, local.control, "prepare", { slug: "local remote" });
  assert.equal(await triage(local, localPrepared), "jev.enabled is false");
  await useJev(local, { enabled: true, endpoint: jev.endpoint, owners: ["acme"], repositories: ["acme/widgets"] });
  assert.match(await triage(local, localPrepared), /^remote origin is not a GitHub repository/);

  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "policy" });
  const reasons = [];
  for (const [jevConfig, env] of [
    [{ enabled: true, endpoint: jev.endpoint, owners: ["acme"], repositories: ["acme/other"] }, key],
    // Listed, but owned by an organisation that is not yours: excluded by default.
    [{ enabled: true, endpoint: jev.endpoint, owners: ["alexportelli12"], repositories: ["acme/widgets"] }, key],
    [{ enabled: true, endpoint: jev.endpoint, owners: ["ACME"], repositories: ["Acme/Widgets"] }, {}],
  ]) {
    await useJev(fixture, jevConfig);
    reasons.push(await triage(fixture, prepared, env));
  }
  assert.deepEqual(reasons, [
    "acme/widgets is not listed in jev.repositories",
    "acme/widgets is owned by acme, which is not one of jev.owners; another organisation's content is not only yours to share",
    "OPENROUTER_API_KEY is not set",
  ]);
  assert.equal(jev.requests.length, 0, "no skipped triage reaches the network");

  const stats = await lifecycle(fixture, fixture.root, "stats", { session: prepared.json.sessionId });
  assert.deepEqual(stats.json.triage.calls.map((call) => [call.outcome, call.reason]), reasons.map((reason) => ["skipped", reason]));
  assert.deepEqual([stats.json.triage.status, stats.json.triage.answers], ["skipped", null]);
  assert.deepEqual(stats.json.triage.agreement.gates.review, { triage: null, agent: null, agree: null });
});

test("triage sends only redacted metadata, records the answers and their cost, and keeps them from the agent", async (t) => {
  const fixture = await createFixture(t);
  const jev = await jevStub(t, [{ status: 200, body: JEV_ANSWERS }]);
  await useJev(fixture, { enabled: true, endpoint: jev.endpoint, owners: ["acme"], repositories: ["acme/widgets"] });
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "metadata only" });
  const { sessionId, worktreePath, evidenceDir } = prepared.json;
  await commit(worktreePath, "committed.txt", "COMMITTED-CONTENT\n", "committed");
  await writeFile(path.join(worktreePath, "README.md"), "initial\nUNCOMMITTED-CONTENT\n");
  await writeFile(path.join(worktreePath, "untracked.txt"), "UNTRACKED-CONTENT\n");
  await writeFile(path.join(worktreePath, ".env"), "API_TOKEN=ENV-CONTENT\n");
  const token = "ghp_abcdefghijklmnopqrstuvwxyz012345";
  const files = await triageFiles(evidenceDir, `Rotate the deploy key; the old one is ${token}`, "Goal: rotate the key.");

  const result = await lifecycle(fixture, fixture.root, "triage", { session: sessionId, ...files }, [0], { OPENROUTER_API_KEY: "test-key" });
  assert.deepEqual(result.json, { operation: "triage", sessionId, stage: "shadow", outcome: "answered", reason: null });

  assert.equal(jev.requests.length, 1);
  const [{ headers, body }] = jev.requests;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.equal(body.model, "typesafe/jev-1.14");
  // Paths and counts only: an untracked .env is named, never read.
  assert.deepEqual(body.state.changedPaths, [".env", "README.md", "committed.txt", "untracked.txt"]);
  assert.deepEqual(body.state.diffStats, { files: 4, insertions: 2, deletions: 0, untracked: 2 });
  const sent = JSON.stringify(body);
  for (const secret of ["CONTENT", token, "test-key"]) assert.ok(!sent.includes(secret), `${secret} never leaves`);
  assert.equal(body.state.request, "Rotate the deploy key; the old one is [REDACTED]");

  const metadata = JSON.parse(await metadataFile(worktreePath));
  const [call] = metadata.triage;
  assert.deepEqual(call.sent, body.state, "the metadata keeps exactly what was sent, for retro");
  assert.equal(call.payloadBytes, Buffer.byteLength(JSON.stringify(body)));
  assert.ok(call.payloadBytes < 32768);
  assert.deepEqual([call.outcome, call.model, call.redacted, call.redactions, call.cost, call.attempts], ["answered", "typesafe/jev-1.14", true, 1, 0.00004, 1]);
  assert.deepEqual(call.answers.size, { answer: "local", confidence: 0.8, probabilities: { local: 0.8, feature: 0.2 } });
  assert.ok(call.latencyMs >= 0);

  const stats = await lifecycle(fixture, fixture.root, "stats", { session: sessionId });
  assert.equal(stats.json.triage.calls[0].sent, undefined, "stats leaves the sent text in metadata");
  assert.deepEqual(stats.json.triage.answers.reviewValue, { answer: 2.4, confidence: 0.6 });
});

test("triage fails open on a server error or a timeout and records why", async (t) => {
  const fixture = await createFixture(t);
  const jev = await jevStub(t, [{ status: 503, body: { error: { code: 503, message: "unavailable" } } }, { hang: true }]);
  await useJev(fixture, { enabled: true, endpoint: jev.endpoint, owners: ["acme"], repositories: ["acme/widgets"], timeoutMs: 500 });
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "fails open" });
  const options = { session: prepared.json.sessionId, ...await triageFiles(prepared.json.evidenceDir) };
  const env = { OPENROUTER_API_KEY: "test-key" };
  const unavailable = await lifecycle(fixture, fixture.control, "triage", options, [0], env);
  assert.deepEqual([unavailable.json.outcome, unavailable.json.reason], ["failed", "HTTP 503: unavailable"]);
  const timedOut = await lifecycle(fixture, fixture.control, "triage", options, [0], env);
  assert.deepEqual([timedOut.json.outcome, timedOut.json.reason], ["failed", "timed out after 500 ms"]);
  const stats = await lifecycle(fixture, fixture.root, "stats", { session: prepared.json.sessionId });
  assert.deepEqual(stats.json.triage.calls.map((call) => call.httpStatus), [503, null]);
  assert.equal(stats.json.triage.status, "failed");
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
  await lifecycle(fixture, worktreePath, "verify", { session: sessionB });
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

  // Only git's stderr decides a retry: the failed command's line names the branch.
  await rm(path.join(stub, "pushes"));
  const misleading = await lifecycle(fixture, fixture.control, "prepare", { slug: "http500 fix" });
  assert.match(misleading.json.branch, /http500-fix/);
  await commit(misleading.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, misleading);
  await writeFile(path.join(stub, "fail"), "403");
  await lifecycle(fixture, misleading.json.worktreePath, "publish", { session: misleading.json.sessionId }, [2], env);
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

test("publish works with git before 2.46, which has no ls-remote --branches", async (t) => {
  const fixture = await createFixture(t);
  const stubDirectory = await mkdtemp(path.join(os.tmpdir(), "ibni-old-git-"));
  t.after(() => rm(stubDirectory, { recursive: true, force: true }));
  const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(path.join(stubDirectory, "git"), `#!/bin/sh
if [ "$1" = "ls-remote" ] && [ "$2" = "--branches" ]; then
  echo "error: unknown option \\\`branches'" >&2
  exit 129
fi
exec "${realGit}" "$@"
`, "utf8");
  await chmod(path.join(stubDirectory, "git"), 493);
  const env = { PATH: `${stubDirectory}:${ghEnv(fixture.gh).PATH}` };

  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "old git" });
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);
  const published = await lifecycle(fixture, prepared.json.worktreePath, "publish", { session: prepared.json.sessionId }, [0], env);
  assert.equal(published.json.published, true);
});

async function commitRepositorySettings(fixture, content, message = "set .mexxi.json") {
  await git(fixture.seed, "pull", "--quiet", "origin", "trunk");
  const sha = await commit(fixture.seed, ".mexxi.json", content, message);
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
  return sha;
}

async function optInToBaselineReuse(fixture, ciCheck = "verify") {
  return commitRepositorySettings(fixture, `${JSON.stringify({ ciCheck })}\n`, "name the CI check");
}

async function setCheckRuns(fixture, runs) {
  await writeFile(path.join(fixture.gh, "check-runs.json"), JSON.stringify({ check_runs: runs }));
}

const checkRun = (sha, overrides = {}) => ({
  id: 11,
  name: "verify",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/alexportelli12/example/actions/runs/11/job/1",
  completed_at: "2026-10-21T10:00:00Z",
  ...overrides,
});

test("prepare cites a green CI run of the exact base commit so the local baseline can be skipped", async (t) => {
  const fixture = await createFixture(t);
  const sha = await optInToBaselineReuse(fixture);
  await setCheckRuns(fixture, [checkRun(sha)]);

  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "proven" });
  assert.equal(prepared.json.baseSha, sha);
  const expected = {
    reused: true,
    check: "verify",
    sha,
    url: "https://github.com/alexportelli12/example/actions/runs/11/job/1",
    runId: 11,
    completedAt: "2026-10-21T10:00:00Z",
  };
  assert.deepEqual(prepared.json.baseline, expected);
  assert.deepEqual(JSON.parse(await metadataFile(prepared.json.worktreePath)).baseline, expected);
});

test("prepare runs the baseline when the CI run cannot be proven for the exact base commit", async (t) => {
  const fixture = await createFixture(t);
  const plain = await lifecycle(fixture, fixture.control, "prepare", { slug: "no opt in" });
  assert.equal(plain.json.baseline.reused, false);
  assert.match(plain.json.baseline.reason, /not committed/);

  const sha = await optInToBaselineReuse(fixture);
  const cases = {
    "gh failing": [null, /unavailable/],
    "a different commit": [[checkRun("0".repeat(40))], /no verify run/],
    "a pending run": [[checkRun(sha, { status: "in_progress", conclusion: null })], /in_progress/],
    "a failed run": [[checkRun(sha, { conclusion: "failure" })], /failure/],
    "a skipped run": [[checkRun(sha, { conclusion: "skipped" })], /skipped/],
    "another check": [[checkRun(sha, { name: "lint" })], /no verify run/],
    "a later failed rerun": [[checkRun(sha), checkRun(sha, { id: 12, conclusion: "failure" })], /failure/],
  };
  for (const [name, [runs, reason]] of Object.entries(cases)) {
    await rm(path.join(fixture.gh, "check-runs.json"), { force: true });
    if (runs) await setCheckRuns(fixture, runs);
    const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: name });
    assert.equal(prepared.json.baseline.reused, false, name);
    assert.match(prepared.json.baseline.reason, reason, name);
    assert.equal(prepared.json.baseline.url, undefined, name);
  }
});

test("prepare reports npm run verify as the verify command unless .mexxi.json names one", async (t) => {
  const fixture = await createFixture(t);
  const plain = await lifecycle(fixture, fixture.control, "prepare", { slug: "default verify" });
  assert.equal(plain.json.verifyCommand, "npm run verify");

  await optInToBaselineReuse(fixture);
  const checkOnly = await lifecycle(fixture, fixture.control, "prepare", { slug: "check only" });
  assert.equal(checkOnly.json.verifyCommand, "npm run verify");

  await commitRepositorySettings(fixture, `${JSON.stringify({ verify: "  make check ", ciCheck: "verify" })}\n`);
  const named = await lifecycle(fixture, fixture.control, "prepare", { slug: "named verify" });
  assert.equal(named.json.verifyCommand, "make check");
  assert.equal(JSON.parse(await metadataFile(named.json.worktreePath)).verifyCommand, "make check");
  const info = await lifecycle(fixture, fixture.control, "info", { session: named.json.sessionId });
  assert.equal(info.json.verifyCommand, "make check");
  const earlier = await lifecycle(fixture, fixture.control, "info", { session: plain.json.sessionId });
  assert.equal(earlier.json.verifyCommand, "npm run verify");
});

test("prepare refuses a .mexxi.json whose verify command it cannot trust", async (t) => {
  const fixture = await createFixture(t);
  const cases = {
    "an empty verify": [`${JSON.stringify({ verify: " " })}\n`, /verify that is not a non-empty command string/],
    "a non-string verify": [`${JSON.stringify({ verify: ["make", "check"] })}\n`, /verify that is not a non-empty command string/],
    "invalid JSON": ["{ verify: make check }\n", /not a JSON object/],
    "a JSON array": ["[]\n", /not a JSON object/],
  };
  for (const [name, [content, message]] of Object.entries(cases)) {
    await commitRepositorySettings(fixture, content, name);
    const refused = await lifecycle(fixture, fixture.control, "prepare", { slug: name }, [2]);
    assert.match(refused.stderr, message, name);
  }
  const list = await lifecycle(fixture, fixture.control, "list");
  assert.equal(list.json.workspaces.length, 0);
});

// A gh stand-in that keeps labels and issues in a JSON file, and logs what it
// was asked to create.
async function issueGhStub(t, { labels = [], issues = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-issue-gh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, "state.json");
  await writeFile(state, JSON.stringify({ labels, issues, created: [] }));
  await writeFile(path.join(directory, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
const [group, action] = args;
if (value("--repo") !== "acme/widgets") { console.error("gh stub: no --repo acme/widgets in " + args.join(" ")); process.exit(4); }
if (group === "label" && action === "list") console.log(JSON.stringify(state.labels.map((name) => ({ name }))));
else if (group === "label" && action === "create") { state.labels.push(args[2]); save(); }
else if (group === "issue" && action === "list") {
  if (value("--label") !== "qa-check" || value("--state") !== "all") process.exit(3);
  console.log(JSON.stringify(state.issues.map((title) => ({ title }))));
} else if (group === "issue" && action === "create") {
  if (value("--label") !== "qa-check") process.exit(3);
  state.issues.push(value("--title")); state.created.push({ title: value("--title"), body: value("--body") }); save();
  console.log("https://github.com/example/app/issues/" + (100 + state.issues.length));
} else { console.error("gh stub: unexpected " + args.join(" ")); process.exit(1); }
`);
  await chmod(path.join(directory, "gh"), 493);
  return { directory, env: { PATH: `${directory}:${process.env.PATH ?? ""}` }, read: async () => JSON.parse(await readFile(state, "utf8")) };
}

test("file-qa-checks files each suggestion as a qa-check issue, creating the label and skipping duplicates", async (t) => {
  const fixture = await createFixture(t);
  // The stub refuses any call without --repo acme/widgets, the remote's repository.
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "qa checks" });
  const { sessionId, evidenceDir } = prepared.json;
  const from = path.join(evidenceDir, "qa-checks.txt");
  await writeFile(from, "- Fail on console errors at every route\n\n2. Assert no horizontal overflow at 390px\n* assert no horizontal overflow at  390px\n");

  const gh = await issueGhStub(t, { issues: ["Fail on console errors at every route"] });
  // Run from the evidence directory: the session is found from its metadata.
  const first = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId, from }, [0], gh.env);
  assert.deepEqual(first.json.created.map((issue) => issue.title), ["Assert no horizontal overflow at 390px"]);
  assert.match(first.json.created[0].url, /issues\/\d+$/);
  assert.deepEqual(first.json.skipped, ["Fail on console errors at every route", "assert no horizontal overflow at  390px"]);
  const state = await gh.read();
  assert.deepEqual(state.labels, ["qa-check"]);
  assert.equal(state.created.length, 1);
  assert.match(state.created[0].body, /Suggested by rendered QA of branch /);

  // A repeat delivery files nothing and does not recreate the label.
  const again = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId, from }, [0], gh.env);
  assert.deepEqual(again.json.created, []);
  assert.equal(again.json.skipped.length, 3);
  assert.equal((await gh.read()).labels.length, 1);

  await writeFile(from, `${"x".repeat(201)}\n`);
  const tooLong = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId, from }, [2], gh.env);
  assert.match(tooLong.stderr, /longer than 200 characters/);
  const missing = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId }, [2], gh.env);
  assert.match(missing.stderr, /requires --from/);
});

test("file-qa-checks refuses a remote that is not on a known forge rather than letting gh guess", async (t) => {
  const fixture = await createFixture(t);
  await useLocalRemote(fixture);
  const { sessionId, evidenceDir } = (await lifecycle(fixture, fixture.control, "prepare", { slug: "qa local" })).json;
  const from = path.join(evidenceDir, "qa-checks.txt");
  await writeFile(from, "Fail on console errors\n");
  const gh = await issueGhStub(t);
  const result = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId, from }, [2], gh.env);
  assert.match(result.stderr, /needs remote origin to be a GitHub or GitLab repository/);
  assert.deepEqual((await gh.read()).labels, []);
});

// A codex stand-in: records its arguments and stdin, answers --version, and
// writes the reviewer's final message to the -o file as the real CLI does.
async function codexStub(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-codex-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli stub"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(path.join(directory, "call.json"))}, JSON.stringify({ args, stdin: fs.readFileSync(0, "utf8") }));
fs.writeFileSync(args[args.indexOf("-o") + 1], "Mode: stub review\\nNo findings.\\n");
`);
  await chmod(path.join(directory, "codex"), 493);
  return { directory, env: { PATH: `${directory}:${process.env.PATH ?? ""}` }, call: async () => JSON.parse(await readFile(path.join(directory, "call.json"), "utf8")) };
}

async function crossReviewSetup(t, claudeModels, extraConfig = {}) {
  const fixture = await createFixture(t);
  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, models: { claude: claudeModels }, ...extraConfig }));
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "cross review" });
  const background = path.join(prepared.json.evidenceDir, "review-background.md");
  await writeFile(background, "Purpose: demo\n");
  const options = { session: prepared.json.sessionId, mode: "discovery", background, target: "workspace changes against HEAD" };
  return { fixture, prepared, options };
}

test("cross-review runs the shared reviewer through codex exec in a read-only sandbox with the configured model", async (t) => {
  const { fixture, prepared, options } = await crossReviewSetup(t, { crossFamilyReviewer: "gpt-5.6-review" });
  const codex = await codexStub(t);
  const result = await lifecycle(fixture, prepared.json.evidenceDir, "cross-review", options, [0], codex.env);
  const outputFile = path.join(prepared.json.evidenceDir, "cross-review-discovery.md");
  assert.deepEqual(
    { delegated: result.json.delegated, model: result.json.model, outputFile: result.json.outputFile },
    { delegated: true, model: "gpt-5.6-review", outputFile },
  );
  assert.match(result.json.review, /No findings/);
  const { args, stdin } = await codex.call();
  assert.deepEqual(args, [
    "exec", "--sandbox", "read-only", "--ephemeral", "--color", "never",
    "-C", prepared.json.worktreePath, "-m", "gpt-5.6-review", "-o", outputFile, "-",
  ]);
  assert.match(stdin, /^# Code Reviewer/);
  assert.match(stdin, /- Mode: discovery\n- Worktree: .+\n- Review target: workspace changes against HEAD\n- Review tool: ocr\n- Background file \(read it first\): .+review-background\.md/);

  const badMode = await lifecycle(fixture, prepared.json.worktreePath, "cross-review", { ...options, mode: "polish" }, [2], codex.env);
  assert.match(badMode.stderr, /--mode discovery or confirmation/);
});

test("cross-review and info pass on review.tool, so the reviewer knows whether to run OCR", async (t) => {
  const { fixture, prepared, options } = await crossReviewSetup(t, { crossFamilyReviewer: "gpt-5.6-review" }, { review: { tool: "none" } });
  const info = await lifecycle(fixture, fixture.control, "info", { session: prepared.json.sessionId });
  assert.equal(info.json.reviewTool, "none");
  const codex = await codexStub(t);
  await lifecycle(fixture, prepared.json.evidenceDir, "cross-review", options, [0], codex.env);
  assert.match((await codex.call()).stdin, /^- Review tool: none$/m);
});

test("cross-review falls back to the same-model reviewer and says why", async (t) => {
  const unset = await crossReviewSetup(t, {});
  const codex = await codexStub(t);
  const noModel = await lifecycle(unset.fixture, unset.prepared.json.worktreePath, "cross-review", unset.options, [0], codex.env);
  assert.equal(noModel.json.delegated, false);
  assert.match(noModel.json.reason, /crossFamilyReviewer is not set/);
  await assert.rejects(readFile(path.join(codex.directory, "call.json")), /ENOENT/, "codex was not run");

  const configured = await crossReviewSetup(t, { crossFamilyReviewer: "gpt-5.6-review" });
  // A PATH holding git and nothing else: no codex.
  const bare = await mkdtemp(path.join(os.tmpdir(), "mexxi-bare-path-"));
  t.after(() => rm(bare, { recursive: true, force: true }));
  const gitPath = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await symlink(gitPath, path.join(bare, "git"));
  const missing = await lifecycle(configured.fixture, configured.prepared.json.worktreePath, "cross-review", configured.options, [0], { PATH: bare });
  assert.equal(missing.json.delegated, false);
  assert.match(missing.json.reason, /codex is not installed/);
});

// A glab stand-in for `glab api`: answers merge requests, commit statuses,
// labels and issues from a JSON state file, and logs each call's host and
// endpoint. Any other glab command fails, so a test proves ibni used the API.
async function glabStub(t, state = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-glab-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  await writeFile(file, JSON.stringify({ mergeRequests: {}, statuses: [], labels: [], issues: [], calls: [], ...state }));
  await writeFile(path.join(directory, "glab"), `#!${process.execPath}
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(state));
const fail = (message) => { console.error("glab stub: " + message); process.exit(1); };
if (args[0] !== "api") fail("unexpected " + args.join(" "));
const hostname = args[args.indexOf("--hostname") + 1];
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const fields = {};
args.forEach((arg, index) => { if (args[index - 1] === "-f") { const at = arg.indexOf("="); fields[arg.slice(0, at)] = arg.slice(at + 1); } });
const endpoint = args.find((arg, index) => index > 0 && !arg.startsWith("-") && !["--hostname", "--method", "-f"].includes(args[index - 1]));
const [route, query = ""] = endpoint.split("?");
const params = new URLSearchParams(query);
state.calls.push({ hostname, method, route, query, fields });
save();
let match;
if ((match = route.match(/^projects\\/([^/]+)\\/merge_requests\\/(\\d+)$/))) {
  const request = state.mergeRequests[decodeURIComponent(match[1]) + "!" + match[2]];
  if (!request) fail("no merge request " + route);
  console.log(JSON.stringify(request));
} else if (/^projects\\/[^/]+\\/repository\\/commits\\/[0-9a-f]+\\/statuses$/.test(route)) {
  if (state.statuses === null) fail("statuses unavailable");
  console.log(JSON.stringify(state.statuses));
} else if (/^projects\\/[^/]+\\/labels$/.test(route)) {
  if (method === "POST") { state.labels.push(fields); save(); console.log(JSON.stringify(fields)); }
  else console.log(JSON.stringify(state.labels.filter((label) => label.name.includes(params.get("search") ?? ""))));
} else if (/^projects\\/[^/]+\\/issues$/.test(route)) {
  if (method === "POST") {
    state.issues.push(fields); save();
    console.log(JSON.stringify({ iid: state.issues.length, web_url: "https://" + hostname + "/issues/" + state.issues.length }));
  } else {
    const page = Number(params.get("page")), size = Number(params.get("per_page"));
    const labelled = state.issues.filter((issue) => issue.labels === params.get("labels"));
    console.log(JSON.stringify(labelled.slice((page - 1) * size, page * size)));
  }
} else fail("unexpected endpoint " + endpoint);
`);
  await chmod(path.join(directory, "glab"), 493);
  return {
    env: (fixture) => ({ PATH: `${directory}:${ghEnv(fixture.gh).PATH}` }),
    read: async () => JSON.parse(await readFile(file, "utf8")),
    update: async (change) => writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), ...change })),
  };
}

const glabStatus = (sha, overrides = {}) => ({
  id: 31, sha, name: "verify", status: "success",
  target_url: "https://gitlab.com/group/sub/widgets/-/jobs/31", finished_at: "2026-10-21T10:00:00Z",
  ...overrides,
});

test("a gitlab.com remote with nested groups takes baseline, media, issues, adopt and cleanup through glab", async (t) => {
  const fixture = await createFixture(t);
  await useForgeRemote(fixture, "git@gitlab.com:group/sub/widgets.git");
  const project = "group/sub/widgets";
  const sha = await optInToBaselineReuse(fixture);
  const glab = await glabStub(t, { statuses: [glabStatus(sha)], issues: [{ title: "Fail on console errors at every route", labels: "qa-check" }] });
  const env = glab.env(fixture);

  // Baseline reuse reads the commit's statuses, and only a success on exactly baseSha counts.
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "gitlab" }, [0], env);
  assert.equal(prepared.json.forge, "gitlab");
  assert.equal(prepared.json.forgeReason, null);
  assert.deepEqual(prepared.json.baseline, {
    reused: true, check: "verify", sha, url: "https://gitlab.com/group/sub/widgets/-/jobs/31", runId: 31, completedAt: "2026-10-21T10:00:00Z",
  });
  for (const [index, [statuses, reason]] of [
    [[glabStatus(sha, { status: "running" })], /verify on .* is running/],
    [[glabStatus(sha), glabStatus(sha, { id: 32, status: "failed" })], /is failure/],
    [[glabStatus("0".repeat(40))], /no verify run/],
    [null, /unavailable/],
  ].entries()) {
    await glab.update({ statuses });
    const unproven = await lifecycle(fixture, fixture.control, "prepare", { slug: `unproven ${index}` }, [0], env);
    assert.equal(unproven.json.baseline.reused, false);
    assert.match(unproven.json.baseline.reason, reason);
  }
  const statusCall = (await glab.read()).calls.find((call) => call.route.endsWith("/statuses"));
  assert.deepEqual([statusCall.hostname, statusCall.route, new URLSearchParams(statusCall.query).get("name")],
    ["gitlab.com", `projects/${encodeURIComponent(project)}/repository/commits/${sha}/statuses`, "verify"]);

  const { sessionId, worktreePath, evidenceDir, branch } = prepared.json;
  assert.equal((await lifecycle(fixture, fixture.control, "info", { session: sessionId }, [0], env)).json.forge, "gitlab");
  await writeFile(path.join(evidenceDir, "after home.png"), "png");
  const media = await lifecycle(fixture, worktreePath, "publish-media", { session: sessionId }, [0], env);
  assert.equal(media.json.files[0].url, `https://gitlab.com/${project}/-/raw/${media.json.commit}/agent/gitlab/after%20home.png`);

  const from = path.join(evidenceDir, "qa-checks.txt");
  await writeFile(from, "Fail on console errors at every route\nAssert no horizontal overflow at 390px\n");
  const filed = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId, from }, [0], env);
  assert.deepEqual(filed.json.created, [{ title: "Assert no horizontal overflow at 390px", url: "https://gitlab.com/issues/2" }]);
  assert.deepEqual(filed.json.skipped, ["Fail on console errors at every route"]);
  let state = await glab.read();
  assert.deepEqual(state.labels, [{ name: "qa-check", color: "#0E8A16", description: "A check rendered QA suggested, to become an executable test" }]);
  assert.match(state.issues[1].description, /Suggested by rendered QA of branch /);
  assert.ok(state.calls.every((call) => call.hostname === "gitlab.com" && (call.route.startsWith(`projects/${encodeURIComponent(project)}/`))));
  const again = await lifecycle(fixture, evidenceDir, "file-qa-checks", { session: sessionId, from }, [0], env);
  assert.deepEqual([again.json.created, (await glab.read()).labels.length], [[], 1]);

  // adopt reads the merge request named by the URL mark-pr recorded.
  await commit(worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);
  await lifecycle(fixture, worktreePath, "publish", { session: sessionId });
  const publishedSha = (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
  const mrUrl = `https://gitlab.com/${project}/-/merge_requests/7`;
  await lifecycle(fixture, worktreePath, "mark-pr", { session: sessionId, url: mrUrl });
  const mergeRequests = { [`${project}!7`]: { iid: 7, state: "opened", source_branch: branch, sha: publishedSha, merge_commit_sha: null, squash_commit_sha: null } };
  await glab.update({ mergeRequests });
  const adopted = await lifecycle(fixture, fixture.control, "adopt", { pr: mrUrl }, [0], env);
  assert.equal(adopted.json.headSha, publishedSha);

  // An open merge request is kept; a merged one whose squash commit reached trunk is removed.
  const kept = await lifecycle(fixture, fixture.control, "cleanup", { "dry-run": "true" }, [0], env);
  assert.match(kept.json.results.find((row) => row.worktreePath === worktreePath).reason, /pull request is open/);
  await pretendMerged(fixture, prepared);
  const trunk = (await git(fixture.control, "rev-parse", "HEAD")).stdout.trim();
  await glab.update({ mergeRequests: { [`${project}!7`]: { ...mergeRequests[`${project}!7`], state: "merged", squash_commit_sha: trunk } } });
  const removed = await lifecycle(fixture, fixture.control, "cleanup", { "dry-run": "false" }, [0], env);
  assert.equal(removed.json.results.find((row) => row.worktreePath === worktreePath).decision, "remove");
  assert.equal(await pathExists(worktreePath), false);
  state = await glab.read();
  assert.ok(state.calls.some((call) => call.route === `projects/${encodeURIComponent(project)}/merge_requests/7`));
});

test("a self-hosted remote has no forge until forge.hosts or the repository's .mexxi.json names one", async (t) => {
  const fixture = await createFixture(t);
  await useForgeRemote(fixture, "https://git.example.com/team/widgets.git");
  const glab = await glabStub(t);
  const env = glab.env(fixture);

  const unknown = await lifecycle(fixture, fixture.control, "prepare", { slug: "self hosted" }, [0], env);
  assert.equal(unknown.json.forge, null);
  assert.match(unknown.json.forgeReason, /git\.example\.com, which is not a known forge; map it in forge\.hosts/);
  const from = path.join(unknown.json.evidenceDir, "qa-checks.txt");
  await writeFile(from, "Fail on console errors\n");
  const refused = await lifecycle(fixture, fixture.control, "file-qa-checks", { session: unknown.json.sessionId, from }, [2], env);
  assert.match(refused.stderr, /needs remote origin to be a GitHub or GitLab repository[\s\S]*forge\.hosts/);
  // No forge CLI is guessed for an unknown host.
  assert.deepEqual((await glab.read()).calls, []);

  await writeFile(fixture.config, JSON.stringify({ paths: { worktreeRoot: fixture.worktrees }, forge: { hosts: { "git.example.com": "gitlab" } } }));
  const info = await lifecycle(fixture, fixture.control, "info", { session: unknown.json.sessionId }, [0], env);
  assert.deepEqual([info.json.forge, info.json.forgeReason], ["gitlab", null]);
  await writeFile(path.join(unknown.json.evidenceDir, "shot.png"), "png");
  const media = await lifecycle(fixture, fixture.control, "publish-media", { session: unknown.json.sessionId }, [0], env);
  assert.match(media.json.files[0].url, /^https:\/\/git\.example\.com\/team\/widgets\/-\/raw\/[0-9a-f]{40}\/agent\/self-hosted\/shot\.png$/);

  // The repository's committed choice wins over forge.hosts; an unknown name is refused.
  for (const [forge, expected] of [["github", "github"], ["bitbucket", null]]) {
    await git(fixture.seed, "pull", "--quiet", "origin", "trunk");
    await commit(fixture.seed, ".mexxi.json", `${JSON.stringify({ forge })}\n`, `forge ${forge}`);
    await git(fixture.seed, "push", "--quiet", "origin", "trunk");
    const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: `committed ${forge}` }, [0], env);
    assert.equal(prepared.json.forge, expected);
    if (!expected) assert.match(prepared.json.forgeReason, /names forge "bitbucket"; use one of github, gitlab/);
  }
});

test("remote URLs parse to host, namespace and repository; GitHub owners are never nested", async () => {
  const { parseRemoteUrl } = await import("./lib/forge.mjs");
  const cases = {
    "https://github.com/acme/widgets.git": { host: "github.com", namespace: "acme", repo: "widgets", ssh: false },
    // An http(s) port is part of the web host; an SSH port is transport only.
    "https://user:token@GitLab.example.com:8443/group/sub/widgets/": { host: "gitlab.example.com:8443", namespace: "group/sub", repo: "widgets", ssh: false },
    "ssh://git@git.example.com:2222/team/widgets.git": { host: "git.example.com", namespace: "team", repo: "widgets", ssh: true },
    "git@gitlab.com:group/sub/deeper/widgets.git": { host: "gitlab.com", namespace: "group/sub/deeper", repo: "widgets", ssh: true },
    "/srv/git/widgets.git": null,
    "../remote.git": null,
    "file:///srv/git/widgets.git": null,
    "https://github.com/widgets": null,
    // Never handed to ssh -G as an option.
    "git@-oProxyCommand=x:o/r": null,
    "ssh://-oProxyCommand=x/o/r": null,
  };
  for (const [url, expected] of Object.entries(cases)) assert.deepEqual(parseRemoteUrl(url), expected, url);
});

// An ssh stand-in for `ssh -G`: prints the hostname ssh config would resolve
// for each alias in the map, and the alias itself otherwise, as ssh does.
async function sshStub(t, aliases) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-ssh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "ssh"), `#!${process.execPath}
const [flag, alias] = process.argv.slice(2);
if (flag !== "-G") process.exit(255);
console.log("user git\\nhostname " + (${JSON.stringify(aliases)}[alias] ?? alias) + "\\nport 22");
`);
  await chmod(path.join(directory, "ssh"), 493);
  return directory;
}

test("SSH aliases and ssh.github.com behave as github.com, and an unresolved alias still reads its pull request", async (t) => {
  const fixture = await createFixture(t);
  const ssh = await sshStub(t, { "github-work": "github.com" });
  const env = { PATH: `${ssh}:${ghEnv(fixture.gh).PATH}` };
  await useForgeRemote(fixture, "git@github-work:acme/widgets.git");
  const sha = await optInToBaselineReuse(fixture);
  await setCheckRuns(fixture, [checkRun(sha)]);
  const aliased = await lifecycle(fixture, fixture.control, "prepare", { slug: "alias" }, [0], env);
  assert.equal(aliased.json.forge, "github");
  assert.equal(aliased.json.baseline.reused, true);
  await writeFile(path.join(aliased.json.evidenceDir, "shot.png"), "png");
  const media = await lifecycle(fixture, fixture.control, "publish-media", { session: aliased.json.sessionId }, [0], env);
  assert.match(media.json.files[0].url, /^https:\/\/github\.com\/acme\/widgets\/blob\/[0-9a-f]{40}\/agent\/alias\/shot\.png\?raw=true$/);

  await useForgeRemote(fixture, "ssh://git@ssh.github.com:443/acme/widgets.git");
  assert.equal((await lifecycle(fixture, fixture.control, "info", { session: aliased.json.sessionId }, [0], env)).json.forge, "github");

  // An alias ssh config does not resolve names no forge, but the recorded
  // github.com pull request URL still decides cleanup and adopt.
  await useForgeRemote(fixture, "git@unmapped-alias:acme/widgets.git");
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "unresolved" }, [0], env);
  assert.equal(prepared.json.forge, null);
  assert.match(prepared.json.forgeReason, /unmapped-alias, which is not a known forge/);
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  await recordEvidence(fixture, prepared);
  await lifecycle(fixture, prepared.json.worktreePath, "publish", { session: prepared.json.sessionId });
  const prUrl = "https://github.com/acme/widgets/pull/8";
  await lifecycle(fixture, prepared.json.worktreePath, "mark-pr", { session: prepared.json.sessionId, url: prUrl });
  const head = (await git(prepared.json.worktreePath, "rev-parse", "HEAD")).stdout.trim();
  await setGhState(fixture.gh, 8, "OPEN");
  await setGhHead(fixture.gh, 8, prepared.json.branch, head);
  assert.equal((await lifecycle(fixture, fixture.control, "adopt", { pr: prUrl }, [0], env)).json.headSha, head);
  await pretendMerged(fixture, prepared);
  await rm(path.join(fixture.gh, "8.head"));
  await setGhState(fixture.gh, 8, "MERGED");
  const cleaned = await lifecycle(fixture, fixture.control, "cleanup", { "dry-run": "false" }, [0], env);
  assert.equal(cleaned.json.results.find((row) => row.worktreePath === prepared.json.worktreePath).decision, "remove");
});

// Stubs for the package managers setup runs. Each logs its arguments and
// working directory to calls.log and exits with the code in <tool>.exit (0 if
// none); any npm command but ci goes to the real npm, so npm run verify works.
async function packageManagerStub(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ibni-package-manager-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const realNpm = (await run("sh", ["-c", "command -v npm"])).stdout.trim();
  for (const tool of ["npm", "pnpm"]) {
    await writeFile(path.join(directory, tool), `#!/bin/sh
if [ "${tool}" = "npm" ] && [ "$1" != "ci" ]; then exec "${realNpm}" "$@"; fi
echo "${tool} $* in $(pwd)" >> "${directory}/calls.log"
echo "${tool} installing"
code=0
if [ -f "${directory}/${tool}.exit" ]; then code="$(cat "${directory}/${tool}.exit")"; fi
if [ "$code" != "0" ]; then echo "${tool} ERR! install failed" >&2; fi
exit "$code"
`, "utf8");
    await chmod(path.join(directory, tool), 493);
  }
  const calls = async () => (await readFile(path.join(directory, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { directory, calls, env: (fixture) => ({ PATH: `${directory}:${ghEnv(fixture.gh).PATH}` }) };
}

async function commitToDefaultBranch(fixture, files, message) {
  await git(fixture.seed, "pull", "--quiet", "origin", "trunk");
  for (const [name, content] of Object.entries(files)) {
    if (content === null) await git(fixture.seed, "rm", "--quiet", name);
    else {
      await writeFile(path.join(fixture.seed, name), content);
      await git(fixture.seed, "add", name);
    }
  }
  await git(fixture.seed, "commit", "--quiet", "-m", message);
  await git(fixture.seed, "push", "--quiet", "origin", "trunk");
}

test("prepare installs from the root lockfile after env provisioning and records the setup", async (t) => {
  const fixture = await withEnvGitignore(t);
  const stub = await packageManagerStub(t);
  await writeFile(path.join(fixture.control, ".env"), "SECRET=1\n");
  await commitToDefaultBranch(fixture, { "package-lock.json": "{}\n" }, "lockfile");

  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "npm setup" }, [0], stub.env(fixture));
  const { setup, worktreePath, evidenceDir } = prepared.json;
  assert.deepEqual(prepared.json.provisionedEnv, [".env"]);
  assert.deepEqual(
    { ...setup, durationMs: typeof setup.durationMs, queuedMs: typeof setup.queuedMs, ranAt: typeof setup.ranAt },
    { ran: true, command: "npm ci --prefer-offline --no-audit --no-fund", source: "package-lock.json", passed: true, exitCode: 0, durationMs: "number", queuedMs: "number", logPath: path.join(evidenceDir, "setup.log"), ranAt: "string" },
  );
  assert.deepEqual(await stub.calls(), [`npm ci --prefer-offline --no-audit --no-fund in ${worktreePath}`]);
  assert.match(await readFile(setup.logPath, "utf8"), /npm installing/);
  const metadata = JSON.parse(await metadataFile(worktreePath));
  assert.equal(metadata.setup.passed, true);
  assert.deepEqual(Object.keys(metadata.setup.lockfiles), ["package-lock.json"]);
  assert.equal(metadata.verification, null);
  const stats = await lifecycle(fixture, fixture.control, "stats", { session: prepared.json.sessionId });
  assert.equal(stats.json.setup.source, "package-lock.json");
  assert.equal(stats.json.setup.lockfiles, undefined, "lockfile ids stay in the metadata");

  await commitToDefaultBranch(fixture, { "package-lock.json": null, "pnpm-lock.yaml": "lockfileVersion: 9\n" }, "pnpm");
  const pnpm = await lifecycle(fixture, fixture.control, "prepare", { slug: "pnpm setup" }, [0], stub.env(fixture));
  assert.equal(pnpm.json.setup.command, "pnpm install --frozen-lockfile --prefer-offline");
  assert.equal(pnpm.json.setup.source, "pnpm-lock.yaml");
  assert.equal((await stub.calls()).at(-1), `pnpm install --frozen-lockfile --prefer-offline in ${pnpm.json.worktreePath}`);
});

test("a setup in .mexxi.json wins over the lockfile, and an invalid one stops prepare before anything is made", async (t) => {
  const fixture = await createFixture(t);
  const stub = await packageManagerStub(t);
  await commitToDefaultBranch(fixture, {
    "package-lock.json": "{}\n",
    ".mexxi.json": `${JSON.stringify({ setup: " node -e \"console.log('custom setup ran')\" " })}\n`,
  }, "custom setup");
  const custom = await lifecycle(fixture, fixture.control, "prepare", { slug: "custom" }, [0], stub.env(fixture));
  assert.equal(custom.json.setup.source, ".mexxi.json");
  assert.equal(custom.json.setup.command, "node -e \"console.log('custom setup ran')\"");
  assert.match(await readFile(custom.json.setup.logPath, "utf8"), /custom setup ran/);
  assert.deepEqual(await stub.calls(), []);

  for (const [name, setup] of Object.entries({ "an empty setup": " ", "a non-string setup": ["npm", "ci"] })) {
    await commitRepositorySettings(fixture, `${JSON.stringify({ setup })}\n`, name);
    const refused = await lifecycle(fixture, fixture.control, "prepare", { slug: name }, [2], stub.env(fixture));
    assert.match(refused.stderr, /setup that is not a non-empty command string/, name);
  }
  const listed = await lifecycle(fixture, fixture.control, "list");
  assert.deepEqual(listed.json.workspaces.map((workspace) => workspace.sessionId), [custom.json.sessionId]);
});

test("without a setup or one clear lockfile, prepare installs nothing and says why", async (t) => {
  const fixture = await createFixture(t);
  const stub = await packageManagerStub(t);
  const none = await lifecycle(fixture, fixture.control, "prepare", { slug: "no lockfile" }, [0], stub.env(fixture));
  assert.deepEqual(none.json.setup, { ran: false, command: null, reason: "no lockfile and no setup in .mexxi.json; nothing was installed" });

  await commitToDefaultBranch(fixture, { "yarn.lock": "# yarn\n" }, "yarn");
  const yarn = await lifecycle(fixture, fixture.control, "prepare", { slug: "yarn" }, [0], stub.env(fixture));
  assert.equal(yarn.json.setup.ran, false);
  assert.match(yarn.json.setup.reason, /yarn\.lock does not name one install command; set setup/);

  await commitToDefaultBranch(fixture, { "package-lock.json": "{}\n" }, "two lockfiles");
  const both = await lifecycle(fixture, fixture.control, "prepare", { slug: "two lockfiles" }, [0], stub.env(fixture));
  assert.equal(both.json.setup.ran, false);
  assert.match(both.json.setup.reason, /more than one lockfile \(package-lock\.json, yarn\.lock\)/);
  assert.deepEqual(await stub.calls(), [], "nothing is guessed");
});

test("a failed setup rolls the new workspace back and prints the end of its log", async (t) => {
  const fixture = await createFixture(t);
  const stub = await packageManagerStub(t);
  await commitToDefaultBranch(fixture, { "package-lock.json": "{}\n" }, "lockfile");
  await writeFile(path.join(stub.directory, "npm.exit"), "7");

  const failed = await lifecycle(fixture, fixture.control, "prepare", { slug: "broken install" }, [2], stub.env(fixture));
  assert.match(failed.stderr, /setup failed in the new worktree \(npm ci --prefer-offline --no-audit --no-fund, exit 7\); the workspace was rolled back/);
  assert.match(failed.stderr, /npm ERR! install failed/);
  const worktreePath = path.join(fixture.worktrees, path.basename(fixture.control), "broken-install");
  const leftovers = await run("sh", ["-c", `ls -d ${fixture.worktrees}/*/broken-install* 2>/dev/null || true`]);
  assert.equal(leftovers.stdout.trim(), "", `${worktreePath} and its evidenceDir are gone`);
  assert.equal((await git(fixture.control, "branch", "--list", "agent/broken-install")).stdout.trim(), "");
  assert.deepEqual((await lifecycle(fixture, fixture.control, "list")).json.workspaces, []);
  assert.doesNotMatch((await git(fixture.control, "worktree", "list")).stdout, /broken-install/);
});

test("ibni setup reinstalls a session's dependencies and records it, printing a failure's tail", async (t) => {
  const fixture = await createFixture(t);
  const stub = await packageManagerStub(t);
  await commitToDefaultBranch(fixture, { "package-lock.json": "{}\n" }, "lockfile");
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "reinstall" }, [0], stub.env(fixture));
  const { sessionId, worktreePath } = prepared.json;
  assert.equal(prepared.json.setup.passed, true);

  const setup = await lifecycle(fixture, worktreePath, "setup", { session: sessionId }, [0], stub.env(fixture));
  assert.equal(setup.json.setup.passed, true);
  assert.deepEqual(await stub.calls(), Array(2).fill(`npm ci --prefer-offline --no-audit --no-fund in ${worktreePath}`));
  assert.equal(JSON.parse(await metadataFile(worktreePath)).setup.passed, true);

  await writeFile(path.join(stub.directory, "npm.exit"), "1");
  const failed = await lifecycle(fixture, worktreePath, "setup", { session: sessionId }, [1], stub.env(fixture));
  assert.equal(JSON.parse(failed.stdout).setup.passed, false);
  assert.match(JSON.parse(failed.stdout).setup.logTail, /install failed/);
  assert.equal(JSON.parse(await metadataFile(worktreePath)).setup.logTail, undefined, "the tail is printed, not stored");
});

test("ibni verify runs the verify command on the committed tree and gates record-evidence and publish", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "verified" });
  const { sessionId, worktreePath, evidenceDir, baseSha } = prepared.json;

  // At baseSha, before any commit, it is the baseline run.
  const baseline = await verify(fixture, prepared);
  assert.equal(baseline.json.baseline, true);
  assert.equal(baseline.json.passed, true);
  assert.equal(baseline.json.recorded, true);
  assert.equal(baseline.json.headSha, baseSha);
  assert.equal(baseline.json.commandSource, "default-branch");

  await writeFile(path.join(worktreePath, "feature.txt"), "feature\n");
  const dirty = await verify(fixture, prepared, [2]);
  assert.match(dirty.stderr, /uncommitted or untracked work[\s\S]*binds its result to a committed tree/);
  await git(worktreePath, "add", "feature.txt");
  await git(worktreePath, "commit", "--quiet", "-m", "feature");
  // Only the baseline tree was verified, so the commit's tree has no result.
  const unverified = await lifecycle(fixture, worktreePath, "record-evidence", { session: sessionId });
  assert.equal(unverified.json.recorded, false);
  assert.match(unverified.json.reason, /another tree/);
  assert.match(unverified.json.nextAction, new RegExp(`^Run ibni verify --session ${sessionId} in the background.*run record-evidence again\\.$`));

  await commit(worktreePath, "FAIL", "\n", "break verify");
  const failed = await verify(fixture, prepared, [1]);
  const treeSha = (await git(worktreePath, "rev-parse", "HEAD^{tree}")).stdout.trim();
  assert.deepEqual(
    { ...failed.json, durationMs: typeof failed.json.durationMs, queuedMs: typeof failed.json.queuedMs, ranAt: typeof failed.json.ranAt, logTail: typeof failed.json.logTail },
    {
      operation: "verify", sessionId, baseline: false, treeSha, headSha: (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim(),
      passed: false, exitCode: 1, durationMs: "number", queuedMs: "number", logPath: path.join(evidenceDir, `verify-${treeSha.slice(0, 12)}.log`), ranAt: "string",
      command: "npm run verify", commandSource: "default-branch", recorded: true, logTail: "string",
    },
  );
  assert.equal(failed.stdout.trim().split("\n").length, 1, "stdout is one line of JSON; the output went to the log");
  assert.match(await readFile(failed.json.logPath, "utf8"), /> verify/);
  const refusedEvidence = await lifecycle(fixture, worktreePath, "record-evidence", { session: sessionId });
  assert.equal(refusedEvidence.json.recorded, false);
  assert.equal(refusedEvidence.json.requiresVerify, true);
  assert.match(refusedEvidence.json.reason, /last ibni verify failed on this tree/);
  assert.match(refusedEvidence.json.nextAction, new RegExp(`^Fix the failure \\(see .*verify-.*\\.log\\) and commit, then run ibni verify --session ${sessionId}`));
  const refusedPublish = await lifecycle(fixture, worktreePath, "publish", { session: sessionId });
  assert.equal(refusedPublish.json.published, false);
  assert.equal(refusedPublish.json.requiresVerify, true);

  await git(worktreePath, "rm", "--quiet", "FAIL");
  await git(worktreePath, "commit", "--quiet", "-m", "fix verify");
  const stalePublish = await lifecycle(fixture, worktreePath, "publish", { session: sessionId });
  assert.equal(stalePublish.json.published, false);
  assert.match(stalePublish.json.reason, /last ibni verify ran on another tree/);
  assert.match(stalePublish.json.nextAction, new RegExp(`ibni verify --session ${sessionId}`));
  const passed = await verify(fixture, prepared);
  assert.equal(passed.json.passed, true);

  // Evidence recorded, then another commit: publish refuses the unverified tree.
  assert.equal((await lifecycle(fixture, worktreePath, "record-evidence", { session: sessionId })).json.recorded, true);
  await commit(worktreePath, "later.txt", "later\n", "later change");
  const mismatch = await lifecycle(fixture, worktreePath, "publish", { session: sessionId });
  assert.equal(mismatch.json.published, false);
  assert.equal(mismatch.json.requiresVerify, true);
  assert.match(mismatch.json.reason, /another tree/);
  await recordEvidence(fixture, prepared);
  assert.equal((await lifecycle(fixture, worktreePath, "publish", { session: sessionId })).json.published, true);

  const stats = await lifecycle(fixture, fixture.control, "stats", { session: sessionId });
  assert.deepEqual(stats.json.verify.history.map((entry) => entry.outcome), ["pass", "fail", "pass", "pass"]);
  assert.equal(stats.json.verification.passed, true);
  assert.deepEqual(stats.json.steps.filter((step) => step.step === "verify").map((step) => step.outcome), ["succeeded", "failed", "failed", "succeeded", "succeeded"]);
});

test("ibni verify holds no lock while it runs and records nothing for a tree that changed meanwhile", async (t) => {
  const fixture = await createFixture(t);
  await commitRepositorySettings(fixture, `${JSON.stringify({ verify: "node -e \"setTimeout(() => {}, 2500)\"" })}\n`);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "slow verify" });
  const { sessionId, worktreePath } = prepared.json;
  const running = verify(fixture, prepared, [1]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  // record takes the repository lock; it would wait if verify held it.
  const started = Date.now();
  await lifecycle(fixture, worktreePath, "record", { session: sessionId, qa: "0" });
  assert.ok(Date.now() - started < 2000, "record did not wait for the verify run");
  await commit(worktreePath, "meanwhile.txt", "meanwhile\n", "commit during verify");
  const result = await running;
  assert.equal(result.json.passed, true);
  assert.equal(result.json.recorded, false);
  assert.match(result.json.reason, /HEAD moved while verify ran/);
  assert.equal(JSON.parse(await metadataFile(worktreePath)).verification, null);
});

test("a verify command that leaves untracked files behind is not recorded, and ibni verify names them", async (t) => {
  const fixture = await createFixture(t);
  await commitRepositorySettings(fixture, `${JSON.stringify({ verify: "node -e \"require('fs').writeFileSync('report.txt', 'x')\"" })}\n`);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "messy verify" });
  const result = await verify(fixture, prepared, [1]);
  assert.equal(result.json.passed, true);
  assert.equal(result.json.recorded, false);
  assert.match(result.json.reason, /not clean when verify ended \(\?\? report\.txt\).*gitignore what the verify command writes/);
});

test("ibni verify records a green CI baseline of the exact base tree without running anything", async (t) => {
  const fixture = await createFixture(t);
  // The tree fails verify locally, so a passing result proves nothing ran.
  await commitToDefaultBranch(fixture, { FAIL: "\n" }, "a tree that fails locally");
  const sha = await optInToBaselineReuse(fixture);
  await setCheckRuns(fixture, [checkRun(sha)]);
  const prepared = await lifecycle(fixture, fixture.control, "prepare", { slug: "reused" });
  assert.equal(prepared.json.baseline.reused, true);

  const reused = await verify(fixture, prepared);
  assert.equal(reused.json.passed, true);
  assert.equal(reused.json.baseline, true);
  assert.deepEqual([reused.json.exitCode, reused.json.durationMs, reused.json.logPath], [null, 0, null]);
  assert.deepEqual(reused.json.reused, { check: "verify", sha, url: "https://github.com/alexportelli12/example/actions/runs/11/job/1" });

  // Any other tree runs for real.
  await commit(prepared.json.worktreePath, "feature.txt", "feature\n", "feature");
  const real = await verify(fixture, prepared, [1]);
  assert.equal(real.json.passed, false);
  assert.equal(real.json.reused, undefined);
});

test("ibni verify runs the branch's verify only when the default branch has none at all", async (t) => {
  const fixture = await createFixture(t);
  const branchSettings = `${JSON.stringify({ verify: "node -e \"console.log('branch gate')\"" })}\n`;
  const guarded = await lifecycle(fixture, fixture.control, "prepare", { slug: "has a gate" });
  await commit(guarded.json.worktreePath, ".mexxi.json", branchSettings, "try to swap the gate");
  await commit(guarded.json.worktreePath, "FAIL", "\n", "and fail the real one");
  const kept = await verify(fixture, guarded, [1]);
  assert.equal(kept.json.command, "npm run verify");
  assert.equal(kept.json.commandSource, "default-branch");

  await commitToDefaultBranch(fixture, { "package.json": null }, "no verify command at all");
  const lesti = await lifecycle(fixture, fixture.control, "prepare", { slug: "lesti" });
  await commit(lesti.json.worktreePath, ".mexxi.json", branchSettings, "name a verify command");
  const added = await verify(fixture, lesti);
  assert.equal(added.json.command, "node -e \"console.log('branch gate')\"");
  assert.equal(added.json.commandSource, "branch");
  assert.match(await readFile(added.json.logPath, "utf8"), /branch gate/);
});

test("adopt reports dependencies and verify state without acting on them", async (t) => {
  const fixture = await createFixture(t);
  const stub = await packageManagerStub(t);
  await commitToDefaultBranch(fixture, { "package-lock.json": "{}\n" }, "lockfile");
  const sessionA = await lifecycle(fixture, fixture.control, "prepare", { slug: "adopt deps" }, [0], stub.env(fixture));
  const { worktreePath, branch } = sessionA.json;
  await publishAndMark(fixture, sessionA, "first\n", 7);
  let head = (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
  await setGhState(fixture.gh, 7, "OPEN");
  await setGhHead(fixture.gh, 7, branch, head);

  const current = await lifecycle(fixture, fixture.control, "adopt", { pr: "https://example.test/pull/7" }, [0], stub.env(fixture));
  assert.equal(current.json.dependencies.current, true);
  assert.match(current.json.dependencies.reason, /installed from package-lock\.json/);
  assert.deepEqual(current.json.verified, { current: true });

  // A published lockfile change: adopt says to run setup, and runs nothing.
  const sessionB = { json: { ...sessionA.json, sessionId: current.json.sessionId } };
  await commit(worktreePath, "package-lock.json", "{\"changed\":true}\n", "bump a dependency");
  await recordEvidence(fixture, sessionB);
  assert.equal((await lifecycle(fixture, worktreePath, "publish", { session: sessionB.json.sessionId })).json.published, true);
  head = (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
  await setGhHead(fixture.gh, 7, branch, head);
  const stale = await lifecycle(fixture, fixture.control, "adopt", { pr: "https://example.test/pull/7" }, [0], stub.env(fixture));
  assert.deepEqual(stale.json.dependencies, {
    current: false,
    reason: "the lockfiles changed since the last setup",
    nextAction: `Run ibni setup --session ${stale.json.sessionId} to install dependencies in the worktree.`,
  });
  assert.equal((await stub.calls()).length, 1, "only prepare installed");
});

test("a workspace from before ibni ran setup and verify still adopts and publishes, told what to run", async (t) => {
  const fixture = await createFixture(t);
  const sessionA = await lifecycle(fixture, fixture.control, "prepare", { slug: "legacy" });
  const { worktreePath, branch } = sessionA.json;
  await publishAndMark(fixture, sessionA, "first\n", 7);
  const head = (await git(worktreePath, "rev-parse", "HEAD")).stdout.trim();
  await setGhState(fixture.gh, 7, "OPEN");
  await setGhHead(fixture.gh, 7, branch, head);
  // Metadata as an older ibni wrote it: no setup, no verification, evidence on HEAD's tree.
  const gitDirectory = (await git(worktreePath, "rev-parse", "--absolute-git-dir")).stdout.trim();
  const file = path.join(gitDirectory, "implementation-workspace.json");
  const { setup: _setup, verification: _verification, ...legacy } = JSON.parse(await readFile(file, "utf8"));
  legacy.records = legacy.records.filter((record) => record.source !== "ibni");
  await writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`);

  const adopted = await lifecycle(fixture, fixture.control, "adopt", { pr: "https://example.test/pull/7" });
  const sessionId = adopted.json.sessionId;
  assert.equal(adopted.json.dependencies.current, null);
  assert.match(adopted.json.dependencies.reason, /prepared before ibni recorded its setup/);
  assert.match(adopted.json.dependencies.nextAction, new RegExp(`ibni setup --session ${sessionId}`));
  assert.equal(adopted.json.verified.current, false);
  assert.match(adopted.json.verified.nextAction, new RegExp(`ibni verify --session ${sessionId}`));
  assert.deepEqual([adopted.json.setup, adopted.json.verification], [null, null]);

  await commit(worktreePath, "follow-up.txt", "follow-up\n", "follow-up");
  const evidenced = { ...legacy, sessionId, evidenceTreeSha: (await git(worktreePath, "rev-parse", "HEAD^{tree}")).stdout.trim() };
  await writeFile(file, `${JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), evidenceTreeSha: evidenced.evidenceTreeSha }, null, 2)}\n`);
  const refused = await lifecycle(fixture, worktreePath, "publish", { session: sessionId });
  assert.equal(refused.json.published, false);
  assert.match(refused.json.reason, /evidence predates ibni verify/);
  assert.match(refused.json.nextAction, new RegExp(`^Run ibni verify --session ${sessionId} in the background`));
  await recordEvidence(fixture, { json: { worktreePath, sessionId } });
  assert.equal((await lifecycle(fixture, worktreePath, "publish", { session: sessionId })).json.published, true);
});
