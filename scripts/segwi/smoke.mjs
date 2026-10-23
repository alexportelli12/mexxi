#!/usr/bin/env node
// A smoke check of what a configured repository's verify command needs from a run's sandbox, on this machine:
//   node scripts/segwi/smoke.mjs --repo <name>
// It starts a real build run for the repository, with your config and segwi's own adapter, rendered settings and
// environment, and plays a scripted model in place of Claude, so it needs no account and costs nothing. The run
// executes smoke-probe.mjs inside the sandbox: the run's CHROME_BIN starts a headless browser, the browser loads each
// host your config adds for the repository and can't load one it doesn't, and, when the repository has a
// firebase.json, the Firestore and Storage emulators start. It changes nothing in the repository.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { allowedDomainsFor, readSettings } from "./lib/settings.mjs";
import { createClaudeCodeAdapter } from "./runners/claude-code.mjs";
import { startFakeAnthropic } from "./test/fake-anthropic.mjs";

const PROBE = fileURLToPath(new URL("./smoke-probe.mjs", import.meta.url));
// A host no configuration allows, so the browser must fail to load it.
const OUTSIDE = "example.com";

const { values } = parseArgs({ options: { repo: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (values.help || !values.repo) {
  process.stdout.write("usage: node scripts/segwi/smoke.mjs --repo <name>\n");
  process.exit(values.help ? 0 : 2);
}
const settings = await readSettings();
const repository = settings.segwi.repositories.find((candidate) => candidate.name === values.repo);
if (!repository) {
  process.stderr.write(`No segwi repository is named ${values.repo}; config.json lists ${settings.segwi.repositories.map((candidate) => candidate.name).join(", ") || "none"}.\n`);
  process.exit(2);
}
const allowedDomains = allowedDomainsFor({ segwi: settings.segwi, repository });
const hosts = ["github.com", ...allowedDomains.filter((domain) => !domain.startsWith("*."))];
const checks = [
  `node ${PROBE} browser`,
  `node ${PROBE} domain ${hosts.join(" ")}`,
  ...(allowedDomains.includes(OUTSIDE) ? [] : [`node ${PROBE} refused ${OUTSIDE}`]),
  ...(existsSync(path.join(repository.path, "firebase.json")) ? [`node ${PROBE} firebase`] : []),
];

// Claude Code gets a throwaway config folder, so your own settings, hooks and account never apply, and a stub
// /wettaq, since a build run's first message invokes it.
const scratch = mkdtempSync(path.join(os.tmpdir(), "segwi-smoke-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const configDir = path.join(scratch, "claude");
mkdirSync(path.join(configDir, "commands"), { recursive: true });
writeFileSync(path.join(configDir, "commands", "wettaq.md"), "$ARGUMENTS\n");
const model = await startFakeAnthropic([...checks.map((command) => ({ tool: "Bash", input: { command, description: "Smoke check", timeout: 300_000 } })), { text: "Done." }]);
for (const key of Object.keys(process.env)) if (/^(CLAUDE|AI_AGENT)/.test(key)) delete process.env[key];
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "sk-ant-smoke", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  // The rendered MCP config starts the Playwright server through npx; offline, it fails at once instead of downloading.
  npm_config_offline: "true",
});

const adapter = createClaudeCodeAdapter({ dataDir: path.join(scratch, "data") });
const sandbox = (await adapter.detect()).sandbox;
if (!sandbox.available) {
  process.stderr.write(`${sandbox.problems.join("\n")}\n`);
  process.exit(1);
}
const runId = randomUUID();
const outputs = new Map();
const finished = new Promise((resolve) => {
  adapter.start({
    runId, repoPath: repository.path, action: "build", task: "Smoke check", limits: { maxTurns: checks.length + 2, approvalTimeoutMinutes: 1 },
    worktreeRoot: settings.worktreeRoot, verifyCommand: "npm run verify", denyPatterns: settings.deny, browser: settings.browser,
    branchPrefix: settings.branchPrefix, branchPrefixes: settings.segwi.branchPrefixes ?? [], controlCheckouts: settings.segwi.repositories.map((candidate) => candidate.path),
    // Sandboxed mode runs each check inside the sandbox unasked, with exactly the sandbox a real run gets.
    permissions: "sandboxed", allowedDomains,
  }, (event) => {
    if (event.kind === "text" && !/^(Done|ok)\.?$/.test(event.text)) process.stdout.write(`segwi: ${event.text}\n`);
    if (event.kind === "step" && event.phase === "result") outputs.set(event.toolUseId, event.detail);
    if (event.kind === "result") adapter.close(runId);
    if (event.kind === "exit") resolve();
  });
});
await finished;
model.close();

const lines = [...outputs.values()].flatMap((detail) => detail.split("\n")).filter((line) => /^(ok|fail) /.test(line));
process.stdout.write(`${lines.join("\n")}\n`);
const passed = outputs.size >= checks.length && !lines.some((line) => line.startsWith("fail "));
process.stdout.write(passed ? `The sandbox gives ${repository.name}'s verify command what it needs.\n` : "Some checks failed or never ran.\n");
process.exit(passed ? 0 : 1);
