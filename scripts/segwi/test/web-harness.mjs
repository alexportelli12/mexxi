// A real segwi server for the web app's e2e test and the demo: the fake host replaces
// `claude`, three throwaway git repositories stand in for projects, and `seedDemo`
// fills the database with a run in every state. Nothing here reaches the network.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { audit } from "../lib/audit.mjs";
import { startServer } from "../lib/serve.mjs";
import { createClaudeCodeAdapter } from "../runners/claude-code.mjs";
import { fakeHost, fixturesDir } from "./helpers.mjs";
import { makeSettings } from "./helpers.mjs";

// Which recording a task replays. A task that mentions example.com asks for approval; one that
// starts with "Audit every" produces a long run. Anything else stops to ask for a reply.
const FIXTURES = { default: "build-needs-input", approval: "approval-loop", long: "long-run" };
const FIXTURE_FOR_TASK = [["approval", /example\.com/], ["long", /^Audit every/]];

/** A runner that picks a recording by the task text, so one server can show every flow. */
function createRoutingRunner(dataDir) {
  const adapters = Object.fromEntries(Object.entries(FIXTURES).map(([key, fixture]) => [key, createClaudeCodeAdapter({
    bin: process.execPath,
    binArgs: [fakeHost, path.join(fixturesDir, "claude-code", `${fixture}.jsonl`), path.join(dataDir, `host-${fixture}.json`)],
    dataDir: path.join(dataDir, `adapter-${fixture}`), killGraceMs: [200, 200],
  })]));
  const byRun = new Map();
  return {
    ...adapters.default,
    async start(spec, emit) {
      const key = FIXTURE_FOR_TASK.find(([, pattern]) => pattern.test(spec.task))?.[0] ?? "default";
      byRun.set(spec.runId, adapters[key]);
      return adapters[key].start(spec, emit);
    },
    send: (runId, text) => byRun.get(runId).send(runId, text),
    stop: (runId) => byRun.get(runId)?.stop(runId),
    close: (runId) => byRun.get(runId)?.close(runId),
    shutdown: () => Promise.all(Object.values(adapters).map((adapter) => adapter.shutdown())),
  };
}

function makeRepo(root, name, { dirty = false } = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir);
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  if (dirty) writeFileSync(path.join(dir, "notes.txt"), "unsaved\n");
  return dir;
}

const noIbni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("no ibni in the demo"); }, list: async () => [] };

/**
 * @param {{ port?: number, seed?: boolean, limits?: object, approvalTimeoutMs?: number }} [options]
 * @returns the running server plus `close()`, which also removes everything created here
 */
export async function startHarness({ port = 0, seed = false, limits = {}, approvalTimeoutMs } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "segwi-web-"));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const repos = [
    { name: "my-app", path: makeRepo(root, "my-app"), actions: ["build", "ready", "ask"] },
    { name: "docs-site", path: makeRepo(root, "docs-site"), actions: ["build", "ask"] },
    { name: "scratch-pad", path: makeRepo(root, "scratch-pad", { dirty: true }), actions: ["build", "ask"] },
  ];
  const settings = makeSettings({ repos, limits: { concurrentRuns: 20, runsPerDay: 200, ...limits }, worktreeRoot: path.join(root, "worktrees") });
  settings.segwi.bind.port = port;
  let server;
  try {
    server = await startServer({ settings, dataDir, runner: createRoutingRunner(dataDir), ibni: noIbni, stateDir: path.join(root, "state"), approvalTimeoutMs });
    if (seed) await seedDemo(server);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    server, url: server.url, port: server.port, root, repos,
    async close() {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function addSteps(store, runId, steps) {
  steps.forEach(([tool, input, output, ok = true], index) => {
    const toolUseId = `seed-${runId.slice(0, 6)}-${index}`;
    store.addEvent(runId, "step", { phase: "call", tool, toolUseId, input });
    store.addEvent(runId, "step", { phase: "result", toolUseId, ok, detail: output });
  });
}

function seedRun(server, { repo = "my-app", action = "build", task, status, minutesOld, reason = null, prUrl = null, verify = null, branch = null, cost = null, steps = [], message = null }) {
  const { store } = server;
  const id = randomUUID();
  store.createRun({ id, repo, action, task });
  if (message) store.addEvent(id, "text", { text: message });
  addSteps(store, id, steps);
  const ended = ["completed", "failed", "stopped", "timed_out"].includes(status);
  store.updateRun(id, { status, reason, prUrl, verify, branch, costUsd: cost, ...(ended ? { endedAt: minutesAgo(Math.max(minutesOld - 12, 1)) } : {}) });
  const at = minutesAgo(minutesOld);
  store.db.prepare("UPDATE runs SET created_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?").run(minutesAgo(minutesOld + 12), at, at, id);
  return id;
}

/** One run in every state, a pending approval, and a few audit rows. The two live ones go through the fake host. */
export async function seedDemo(server) {
  const edit = ["Edit", { file_path: "src/settings/theme-toggle.ts" }, "Updated the file."];
  const test = ["Bash", { command: "npm run verify" }, "All checks passed (14 tests)."];
  seedRun(server, { task: "Add a dark-mode toggle to the settings page", status: "queued", minutesOld: 1 });
  seedRun(server, { task: "Replace the footer links with the new sitemap", status: "running", minutesOld: 4, branch: "agent/footer-sitemap", message: "Looking at the footer component first.", steps: [["Read", { file_path: "src/footer.ts" }, "export class Footer {}"], edit] });
  seedRun(server, { task: "Fix the flaky date test in the billing module", status: "completed", minutesOld: 95, branch: "agent/billing-date-test", prUrl: "https://github.com/example/my-app/pull/42", verify: "pass", cost: 0.84, steps: [["Read", { file_path: "src/billing/date.test.ts" }, "it('rounds up')"], edit, test] });
  seedRun(server, { repo: "docs-site", task: "Why does the build take so long on CI?", action: "ask", status: "completed", minutesOld: 180, cost: 0.12, steps: [["Bash", { command: "git log --oneline -5" }, "a1b2c3d Speed up the build"]] });
  seedRun(server, { task: "Get this repository ready for the workflow", action: "ready", status: "completed", minutesOld: 300, branch: "agent/get-ready", prUrl: "https://github.com/example/my-app/pull/41", verify: "fail", cost: 1.4, steps: [edit, ["Bash", { command: "npm run verify" }, "2 checks failed", false]] });
  seedRun(server, { task: "Upgrade the date library to the latest major", status: "failed", minutesOld: 400, reason: "Reached the turn limit", cost: 2.1, steps: [["Bash", { command: "npm install date-lib@latest" }, "added 3 packages"], ["Bash", { command: "npm test" }, "12 tests failed", false]] });
  seedRun(server, { task: "Rename the Orders table to Purchases", status: "stopped", minutesOld: 520, reason: "Stopped by you", steps: [["Read", { file_path: "db/schema.sql" }, "CREATE TABLE orders (...)"]] });
  seedRun(server, { repo: "docs-site", task: "Translate the install guide", status: "timed_out", minutesOld: 700, reason: "No activity for 30 min", steps: [] });

  const run = async (task) => (await server.runs.create({ repo: "my-app", action: "build", task, clientId: randomUUID() })).run.id;
  const needsInput = await run("Tidy the README headings and fix the broken links");
  const needsApproval = await run("Check what example.com serves");
  for (let waited = 0; waited < 100; waited += 1) {
    const ready = server.store.getRun(needsInput).status === "needs_input" && server.approvals.list().length > 0;
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  audit(server.store, { actor: "intruder@example.com", origin: "web", action: "GET /api/runs", outcome: "rejected", detail: "403 That identity is not allowed." });
  audit(server.store, { actor: "mcp", origin: "mcp", action: "tool list_runs", outcome: "ok" });
  return { needsInput, needsApproval };
}
