// Drives the real Claude Code binary through segwi's own server, adapter,
// rendered settings and approval path, with a scripted fake model in place of
// the API. A test gives the model's turns and gets back the tool results Claude
// Code produced, the approvals segwi raised and the server's audit log. Claude
// Code runs with a throwaway home and config directory, so the developer's own
// settings and hooks never apply.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCodeAdapter } from "../runners/claude-code.mjs";
import { startServer } from "../lib/serve.mjs";
import { startFakeAnthropic, toolUseId } from "./fake-anthropic.mjs";
import { makeRepo, makeSettings, request, tempDir, waitFor } from "./helpers.mjs";

const noIbni = { findNewWorkspace: async () => null, summary: async () => null, list: async () => [] };
const RUN_LIMIT_MS = 120_000;
// This checkout's ibni, so a run uses the ibni under test rather than whatever is installed.
const IBNI_DIR = fileURLToPath(new URL("../../ibni/", import.meta.url));

// For control runs and experiments only: merges a patch into segwi's rendered settings (objects merge, everything else
// replaces), then runs the real `claude` with the same arguments. The patch is the first argument; its "$cwd", if
// any, is the directory Claude Code starts in instead of the repository.
const PATCHED_CLAUDE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [patchJson, ...args] = process.argv.slice(1);
const at = args.indexOf("--settings");
const { $cwd, ...patch } = JSON.parse(patchJson);
const merge = (target, patch) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") merge(target[key], value);
    else target[key] = value;
  }
  return target;
};
if (at !== -1) fs.writeFileSync(args[at + 1], JSON.stringify(merge(JSON.parse(fs.readFileSync(args[at + 1], "utf8")), patch)));
const child = spawn("claude", args, { stdio: "inherit", cwd: $cwd ?? process.cwd() });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? 1));
`;

/** Why the sandbox test can't run here, or null when it can. */
export function sandboxPrerequisiteProblem() {
  const missing = ["claude", "bwrap", "socat"].filter((name) => {
    try {
      execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) return `${missing.join(", ")} not on PATH`;
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "true"], { stdio: "ignore", timeout: 10_000 });
  } catch {
    return "bubblewrap can't create a network namespace (unprivileged user namespaces are off or restricted)";
  }
  return null;
}

/**
 * Runs one `ask` or `build` run of the real `claude` against a fake model that plays `script`. A turn may be a
 * function of `{ segwiPort, repo, worktreeRoot, home, hostDataDir, result }`, called when the model reaches it;
 * `hostDataDir` is the adapter's data folder (runs/<id>/ holds the rendered settings and MCP config) and
 * `result(i)` is the tool result of an earlier turn i.
 * A build run gets what it needs to reach the model and run `ibni prepare`: a stub /wettaq command that passes
 * the task on, a bare local origin for the repository, this checkout's ibni first on PATH and an ibni config whose
 * worktree root is the run's.
 * `decide(approval)` answers each approval segwi raises ("allow" or "deny"; allow by default).
 * `prepare({ repo, worktreeRoot, home })` runs before the run starts, to lay out files.
 * `settingsPatch` is for control runs and experiments: it is merged into segwi's rendered settings before Claude Code
 * reads them, for example `{ sandbox: { enabled: false } }`, or a function of `{ repo, worktreeRoot, home, hostDataDir }` that
 * returns one. A "$cwd" key in the patch starts Claude Code in that directory instead of the repository. Without a
 * patch, Claude Code gets exactly what segwi renders and starts where segwi starts it.
 * `otherRepository` adds a second configured repository (`other-app`), passed to `prepare` and returned as `otherRepo`.
 * `headlessShell` is the browser a build run's CHROME_BIN starts (see lib/headless-shell.mjs); without one it has none.
 * `segwi` overrides segwi's own settings, such as `{ permissions: "sandboxed", branchPrefixes: ["security/"] }`. Auto mode
 * needs Claude Code's real classifier, which the fake model can't play, so these runs are strict unless a test says otherwise.
 * @returns {Promise<{ results: Array<{ isError: boolean, text: string } | undefined>, approvals: object[], audit: object[],
 *   run: object, server: object, repo: string, worktreeRoot: string, home: string }>}
 *   `results[i]` is the tool result for script turn i. The segwi server is closed when the test ends.
 */
export async function runScripted(t, { script, action = "ask", decide = () => "allow", prepare = async () => {}, settingsPatch = null, segwi = {}, otherRepository = false,
  headlessShell = null }) {
  const context = {};
  const model = await startFakeAnthropic(script.map((turn) => (typeof turn === "function" ? () => turn(context) : turn)));
  t.after(() => model.close());
  const home = tempDir(t, "segwi-sbx-home-");
  const worktreeRoot = tempDir(t, "segwi-sbx-worktrees-");
  const repo = makeRepo(t);
  const configDir = path.join(home, ".claude");
  const build = action !== "ask";
  if (build) {
    // A bare clone, not a push: the repository's origin, so ibni prepare has something to fast-forward from.
    const origin = path.join(home, "origin.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, origin]);
    for (const args of [["remote", "add", "origin", origin], ["fetch", "-q", "origin"], ["branch", "-q", "--set-upstream-to=origin/main"]]) {
      execFileSync("git", ["-C", repo, ...args]);
    }
    mkdirSync(path.join(configDir, "commands"), { recursive: true });
    writeFileSync(path.join(configDir, "commands", "wettaq.md"), "$ARGUMENTS\n");
    writeFileSync(path.join(home, "mexxi-config.json"), JSON.stringify({ paths: { worktreeRoot } }));
  }
  const otherRepo = otherRepository ? makeRepo(t) : null;
  await prepare({ repo, worktreeRoot, home, otherRepo });

  // The adapter hands Claude Code this process's environment, so the run's environment is set here for the run's length.
  const env = {
    HOME: home, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "sk-ant-fake",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    // The rendered MCP config starts the Playwright server through npx; offline, it fails at once instead of downloading.
    npm_config_offline: "true",
    ...(build ? { MEXXI_CONFIG: path.join(home, "mexxi-config.json"), PATH: `${IBNI_DIR}${path.delimiter}${process.env.PATH}` } : {}),
  };
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  // A Claude Code session running this test must not leak its own session variables into the nested run.
  const inherited = Object.keys(process.env).filter((key) => /^(CLAUDE|AI_AGENT)/.test(key));
  const saved = Object.fromEntries([...inherited, ...Object.keys(env)].map((key) => [key, process.env[key]]));
  inherited.forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const dataDir = tempDir(t, "segwi-sbx-data-");
  const hostDataDir = path.join(dataDir, "host");
  const patch = typeof settingsPatch === "function" ? settingsPatch({ repo, worktreeRoot, home, hostDataDir }) : settingsPatch;
  const host = patch ? { bin: process.execPath, binArgs: ["-e", PATCHED_CLAUDE, "--", JSON.stringify(patch)] } : { bin: "claude" };
  // The run's home is a throwaway one, so the browser a test wants is named here rather than found there.
  const adapter = createClaudeCodeAdapter({ ...host, dataDir: hostDataDir, killGraceMs: [2000, 2000], headlessShell: () => headlessShell });
  // The run finishes before Claude Code exits; the test waits for the exit so nothing still writes to the temporary folders.
  let exited;
  const hostExit = new Promise((resolve) => { exited = resolve; });
  const start = adapter.start;
  adapter.start = (spec, emit) => start(spec, (event) => {
    if (event.kind === "exit") exited();
    emit(event);
  });
  const repos = [{ name: "my-app", path: repo, actions: [action] }, ...(otherRepo ? [{ name: "other-app", path: otherRepo, actions: ["build"] }] : [])];
  const settings = makeSettings({ repos, worktreeRoot, segwi });
  const server = await startServer({ settings, dataDir, runner: adapter, ibni: noIbni, staticRoot: null });
  t.after(() => server.close());
  // Once in a while Claude Code's last session writes race the first removal of its home; this one runs after the server is closed.
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  Object.assign(context, { segwiPort: server.port, repo, otherRepo, worktreeRoot, home, hostDataDir, result: (index) => model.toolResults()[toolUseId(index)] });

  const started = await request(server, "POST", "/api/runs", { body: { repo: "my-app", action, task: "Follow the script." } });
  if (started.status !== 201 && started.status !== 200) throw new Error(`segwi refused the run: ${started.status} ${started.text}`);
  const runId = started.json.run.id;
  t.after(() => request(server, "POST", `/api/runs/${runId}/stop`, { body: { confirm: true } }).catch(() => {}));

  const approvals = [];
  const deadline = Date.now() + RUN_LIMIT_MS;
  const finished = await waitFor(async () => {
    for (const approval of (await request(server, "GET", "/api/approvals?status=pending")).json.approvals) {
      approvals.push(approval);
      await request(server, "POST", `/api/approvals/${approval.id}`, { body: { decision: decide(approval) } });
    }
    const run = server.store.getRun(runId);
    // A build run that finished its turn waits for more input; that is the end of a scripted run too.
    return ["completed", "failed", "stopped", "timed_out", "needs_input"].includes(run.status) ? run : null;
  }, { timeoutMs: deadline - Date.now(), intervalMs: 100, what: "the Claude Code run to finish" });
  if (finished.status === "needs_input") await request(server, "POST", `/api/runs/${runId}/stop`, { body: { confirm: true } });

  const exitedInTime = await Promise.race([hostExit.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10_000).unref())]);
  if (!exitedInTime) t.diagnostic("Claude Code had not exited 10 s after the run finished");
  const toolResults = model.toolResults();
  return {
    results: script.map((_, index) => toolResults[toolUseId(index)]),
    approvals, audit: server.store.listAudit(1000), run: finished, server, repo, otherRepo, worktreeRoot, home, hostDataDir, model,
  };
}
