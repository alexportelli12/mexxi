// Pins the exact ibni JSON fields segwi reads by running the repository's real
// ibni against a temporary repository, so an ibni change that breaks segwi
// fails mexxi's own verify.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createIbniLink, IBNI_FIELDS, parsePrepareOutput } from "../lib/ibni-link.mjs";
import { tempDir } from "./helpers.mjs";

const ibniEntry = fileURLToPath(new URL("../../ibni/ibni.mjs", import.meta.url));

function fixture(t) {
  const root = tempDir(t, "segwi-ibni-");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const control = path.join(root, "control");
  const worktrees = path.join(root, "worktrees");
  git(root, "init", "-q", "--bare", remote);
  git(root, "-C", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "init", "-q", "--initial-branch=main", seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(path.join(seed, "README.md"), "initial\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, control);
  // prepare may ask gh about merged workspaces; the stub always fails, so the test never reaches GitHub.
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(path.join(bin, "gh"), 0o755);
  const config = path.join(root, "config.json");
  writeFileSync(config, JSON.stringify({ paths: { worktreeRoot: worktrees } }));
  const env = { ...process.env, MEXXI_CONFIG: config, PATH: `${bin}:${process.env.PATH}` };
  return { control, worktrees, env };
}

const hasField = (value, field) => field.split(".").reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), value) !== undefined;

test("the ibni fields segwi reads exist in prepare, list, info and stats output", async (t) => {
  const { control, worktrees, env } = fixture(t);
  const ibni = (...args) => JSON.parse(execFileSync(process.execPath, [ibniEntry, ...args], { cwd: control, env, encoding: "utf8" }));
  const prepareText = execFileSync(process.execPath, [ibniEntry, "prepare", "--slug", "segwi contract"], { cwd: control, env, encoding: "utf8" });
  const prepared = JSON.parse(prepareText);
  for (const field of IBNI_FIELDS.prepare) assert.ok(hasField(prepared, field), `prepare prints ${field}`);
  assert.deepEqual(parsePrepareOutput(`output:\n${prepareText}\n`, worktrees), {
    sessionId: prepared.sessionId, worktreePath: prepared.worktreePath, branch: prepared.branch,
  });
  assert.equal(parsePrepareOutput(prepareText, path.join(worktrees, "elsewhere")), null, "a worktree outside the root is not linked");

  const listed = ibni("list");
  const entry = listed.workspaces.find((workspace) => workspace.sessionId === prepared.sessionId);
  for (const field of IBNI_FIELDS.list) assert.ok(hasField(entry, field), `list shows ${field}`);
  const info = ibni("info", "--session", prepared.sessionId);
  for (const field of IBNI_FIELDS.info) assert.ok(field in info, `info shows ${field}`);
  assert.equal(info.prUrl, null);

  // ibni verify records its own runs where segwi reads them; this repository has no verify command, so it fails.
  const verified = spawnSync(process.execPath, [ibniEntry, "verify", "--session", prepared.sessionId], { cwd: control, env, encoding: "utf8" });
  assert.equal(verified.status, 1);
  assert.equal(JSON.parse(verified.stdout).passed, false);
  ibni("record", "--session", prepared.sessionId, "--verify", "fail");
  ibni("record", "--session", prepared.sessionId, "--verify", "pass");
  const stats = ibni("stats", "--session", prepared.sessionId);
  for (const field of IBNI_FIELDS.stats) assert.ok(hasField(stats, field), `stats shows ${field}`);
  assert.deepEqual(stats.verify.history.map((record) => record.outcome), ["fail", "fail", "pass"]);

  // The link module reads the same output the same way.
  const previousPath = process.env.MEXXI_CONFIG;
  process.env.MEXXI_CONFIG = env.MEXXI_CONFIG;
  t.after(() => { if (previousPath === undefined) delete process.env.MEXXI_CONFIG; else process.env.MEXXI_CONFIG = previousPath; });
  const link = createIbniLink({ command: [process.execPath, ibniEntry] });
  const { snapshot, ...summary } = await link.summary(control, prepared.sessionId);
  assert.deepEqual(summary, { branch: prepared.branch, prUrl: null, verify: "pass", worktreePath: prepared.worktreePath });
  // The snapshot the app draws the journey from: ibni's own record of the run, without any filesystem path.
  assert.equal(snapshot.branch, prepared.branch);
  assert.equal(snapshot.createdAt, info.createdAt);
  assert.deepEqual(snapshot.steps.map((step) => [step.step, step.outcome]).slice(0, 2), [["prepare", "succeeded"], ["verify", "failed"]]);
  assert.ok(snapshot.steps.every((step) => typeof step.endedAt === "string" && typeof step.durationMs === "number"));
  assert.deepEqual({ ...snapshot.verify, history: snapshot.verify.history.map((entry) => entry.outcome) }, { attempts: 3, passed: 1, failed: 2, history: ["fail", "fail", "pass"] });
  assert.deepEqual(snapshot.review, { rounds: 0, findings: 0, byReviewer: { cross: { rounds: 0 } } });
  assert.deepEqual(snapshot.qa, { rounds: 0, findings: 0 });
  assert.ok(!JSON.stringify(snapshot).includes(worktrees), "no path reaches the snapshot");
  assert.equal((await link.findNewWorkspace(control, "1970-01-01T00:00:00.000Z", [prepared.worktreePath])), null);
  assert.equal((await link.findNewWorkspace(control, "1970-01-01T00:00:00.000Z"))?.sessionId, prepared.sessionId);
  assert.equal((await link.findNewWorkspace(control, "2999-01-01T00:00:00.000Z")), null);
});
