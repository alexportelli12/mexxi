import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { install } from "./install.mjs";
import { playwrightArguments, registrationCommands } from "./lib/browser.mjs";
import { loadConfig } from "./lib/config.mjs";
import { claudeHooks } from "./lib/host-hooks.mjs";
import { check } from "./check-config.mjs";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const verifikaCli = path.join(checkout, "node_modules/verifika/dist/cli.js");

// A stand-in for the claude CLI, first on PATH for every install in this file,
// so no test reaches a real Claude Code installation or the real home. It
// keeps its marketplace and plugins in the home the installer runs it with,
// reads a folder marketplace's plugins from that folder as Claude Code does,
// and logs each call.
const claudeStubSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateFile = path.join(process.env.HOME, ".claude-stub.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { marketplace: null, plugins: [] };
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, ".claude-stub.log"), args.join(" ") + "\\n");
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const listing = () => JSON.parse(fs.readFileSync(path.join(state.marketplace, ".claude-plugin/marketplace.json"), "utf8"));
const [noun, verb, target] = args;
if (noun !== "plugin") process.exit(2);
if (verb === "list") {
  console.log(JSON.stringify(state.plugins.map((id) => {
    const entry = listing().plugins.find((plugin) => plugin.name + "@mexxi" === id);
    return { id, scope: "user", enabled: true, readFromFolder: entry ? path.resolve(state.marketplace, entry.source) : undefined };
  })));
} else if (verb === "marketplace" && target === "add") {
  state.marketplace = path.resolve(args[3]);
  listing();
  save();
} else if (verb === "install") {
  if (!state.marketplace || !listing().plugins.some((plugin) => plugin.name + "@mexxi" === target)) {
    console.error("Plugin not found in marketplace");
    process.exit(1);
  }
  if (!state.plugins.includes(target)) state.plugins.push(target);
  save();
} else if (verb === "uninstall") {
  state.plugins = state.plugins.filter((id) => id !== target);
  save();
} else process.exit(2);
`;
const claudeStub = await mkdtemp(path.join(os.tmpdir(), "mexxi-claude-stub-"));
await writeFile(path.join(claudeStub, "claude"), claudeStubSource, { mode: 0o755 });
process.env.PATH = `${claudeStub}${path.delimiter}${process.env.PATH}`;
process.on("exit", () => rmSync(claudeStub, { recursive: true, force: true }));

// The installer only runs from the clone config.json names, so each throwaway
// home first gets a config.json pointing at the clone under test.
async function configure(home, config = {}, clone = checkout) {
  const file = path.join(home, ".config/mexxi/config.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...config, paths: { checkout: clone, ...config.paths } }));
  return file;
}

// A disposable copy of the clone whose sources a test may change.
async function copyCheckout(base) {
  for (const directory of [".claude-plugin", "agent", "claude", "codex", "commands", "opencode", "scripts", "skills"]) {
    await cp(path.join(checkout, directory), path.join(base, directory), { recursive: true });
  }
  for (const file of ["AGENTS.md", "config.example.json", "config.schema.json", "package.json", "verifika.config.json"]) {
    await cp(path.join(checkout, file), path.join(base, file));
  }
}

// What `claude mcp add` and `codex mcp add` leave behind, so --check has the
// registrations the installer asks the user to make. The installer never writes
// these files itself.
async function registerPlaywright(home, { codex = path.join(home, ".codex") } = {}) {
  const { config } = await loadConfig({ file: path.join(home, ".config/mexxi/config.json"), home });
  const args = ["-y", ...playwrightArguments(config.browser)];
  if (config.hosts.claude) {
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { playwright: { type: "stdio", command: "npx", args, env: {} } } }));
  }
  if (!config.hosts.codex) return;
  await mkdir(codex, { recursive: true });
  const file = path.join(codex, "config.toml");
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, `${existing}[mcp_servers.playwright]\ncommand = "npx"\nargs = ${JSON.stringify(args)}\n`);
}

function execute(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

test("shared setup is idempotent and installs the pinned Verifika skill", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  const options = { home, checkout, hookDirectory: path.join(home, "git-hooks") };
  assert.ok((await install(options)).created > 0);
  assert.equal((await install(options)).created, 0);
  await install({ ...options, check: true });
  const verifikaSkill = await readFile(path.join(checkout, "node_modules/verifika/skills/verifika/SKILL.md"), "utf8");
  assert.equal(await readFile(path.join(home, ".claude/skills/verifika/SKILL.md"), "utf8"), verifikaSkill);
  assert.equal(await readFile(path.join(home, ".agents/skills/verifika/SKILL.md"), "utf8"), verifikaSkill);
  const executables = ["ibni", "implementation-workspace"].map((name) => process.platform === "win32" ? `${name}.cmd` : name);
  assert.deepEqual((await readdir(path.join(home, ".local/bin"))).sort(), executables);
  assert.match(await readFile(path.join(home, ".claude/CLAUDE.md"), "utf8"), /senior engineering deputy/);
  assert.equal(await readFile(path.join(home, ".codex/AGENTS.md"), "utf8"), await readFile(path.join(checkout, "AGENTS.md"), "utf8"));
  assert.equal(await readFile(path.join(home, ".agents/skills/workflow-for-alex/SKILL.md"), "utf8"), await readFile(path.join(checkout, "skills/workflow-for-alex/SKILL.md"), "utf8"));
  assert.match(await readFile(path.join(home, ".codex/agents/code-reviewer.toml"), "utf8"), /sandbox_mode = "read-only"/);
  assert.match(await readFile(path.join(home, ".agents/skills/mexxi-wettaq/SKILL.md"), "utf8"), /ibni prepare/);
  assert.match(await readFile(path.join(home, ".agents/skills/mexxi-wettaq/agents/openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
  // The old wrapper name stays for one release and runs the renamed command.
  assert.match(await readFile(path.join(home, ".agents/skills/workflow-implement/SKILL.md"), "utf8"), /commands\/wettaq\.md/);
  await assert.rejects(lstat(path.join(home, ".agents/skills/mexxi-implement")), /ENOENT/);
  assert.match(await readFile(path.join(home, "git-hooks/post-merge"), "utf8"), /--after-merge/);
  const generated = path.join(home, ".local/share/mexxi/generated");
  assert.equal(await readlink(path.join(home, ".claude/agents/code-reviewer.md")), path.join(generated, "claude/agents/code-reviewer.md"));
  const opencode = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
  assert.equal(opencode.agent["code-reviewer"].prompt, `{file:${path.join(checkout, "agent/code-reviewer.md")}}`);
  assert.equal(opencode.agent.explore.model, "openai/gpt-5.6-luna");
  assert.equal(opencode.permission.external_directory[`${path.join(home, ".local/share/mexxi/worktrees")}/**`], "allow");
});

test("setup removes only dangling links it created for retired agents and skills", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-stale-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  const options = { home, checkout, hookDirectory: path.join(home, "git-hooks") };
  await install(options);
  const retired = path.join(home, ".claude/agents/retired.md");
  const retiredSkill = path.join(home, ".claude/skills/retired");
  const foreign = path.join(home, ".claude/agents/mine.md");
  const retiredCodex = path.join(home, ".codex/agents/retired.toml");
  const retiredCommand = path.join(home, ".agents/skills/workflow-retired");
  const foreignCodex = path.join(home, ".agents/skills/mine");
  await symlink(path.join(checkout, "claude/agents/retired.md"), retired);
  await symlink(path.join(checkout, "skills/retired"), retiredSkill);
  await symlink(path.join(home, "elsewhere.md"), foreign);
  await symlink(path.join(checkout, "codex/agents/retired.toml"), retiredCodex);
  await symlink(path.join(checkout, "codex/skills/workflow-retired"), retiredCommand);
  await symlink(path.join(home, "elsewhere"), foreignCodex);

  await assert.rejects(install({ ...options, check: true }), /retired\.md \(stale\)/);
  assert.equal((await install(options)).removed, 4);
  await assert.rejects(lstat(retired), /ENOENT/);
  await assert.rejects(lstat(retiredSkill), /ENOENT/);
  assert.ok((await lstat(foreign)).isSymbolicLink());
  await assert.rejects(lstat(retiredCodex), /ENOENT/);
  await assert.rejects(lstat(retiredCommand), /ENOENT/);
  assert.ok((await lstat(foreignCodex)).isSymbolicLink());
  await install({ ...options, check: true });
});

test("setup retires verify-runner links it installed and keeps user-owned files", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-retired-runner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  const options = { home, checkout, hookDirectory: path.join(home, "git-hooks") };
  const bin = path.join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  // What earlier versions installed: a POSIX link and a Windows wrapper.
  await symlink(path.join(checkout, "scripts/verify-runner"), path.join(bin, "verify-runner"));
  await writeFile(path.join(bin, "verify-runner.cmd"), `@echo off\r\nnode "${path.join(checkout, "scripts/verify.mjs")}" %*\r\n`);

  await assert.rejects(install({ ...options, check: true }), /verify-runner \(stale\)/);
  assert.equal((await install(options)).removed, 2);
  await assert.rejects(lstat(path.join(bin, "verify-runner")), /ENOENT/);
  await assert.rejects(lstat(path.join(bin, "verify-runner.cmd")), /ENOENT/);
  assert.equal((await install(options)).removed, 0);
  await install({ ...options, check: true });

  // Same names, but not ours: a personal script, an edited wrapper and a link elsewhere.
  await writeFile(path.join(bin, "verify-runner"), "#!/bin/sh\necho mine\n");
  await writeFile(path.join(bin, "verify-runner.cmd"), "@echo off\r\necho mine\r\n");
  await symlink(path.join(home, "elsewhere"), path.join(bin, "vfk"));
  // A personal link into the checkout is still the user's, even when dangling.
  await symlink(path.join(checkout, "node_modules/.bin/missing"), path.join(bin, "personal"));
  assert.equal((await install(options)).removed, 0);
  await install({ ...options, check: true });
  assert.ok((await lstat(path.join(bin, "personal"))).isSymbolicLink());
  assert.equal(await readFile(path.join(bin, "verify-runner"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(await readFile(path.join(bin, "verify-runner.cmd"), "utf8"), "@echo off\r\necho mine\r\n");
  assert.ok((await lstat(path.join(bin, "vfk"))).isSymbolicLink());
});

test("ibni and its implementation-workspace alias run the same CLI", async () => {
  const results = [];
  for (const shim of ["scripts/ibni/ibni", "scripts/implementation-workspace"]) {
    results.push(await execute(process.execPath, [path.join(checkout, shim)], checkout));
  }
  assert.match(results[0].output, /^Implementation workspace error: expected prepare, sync, [\s\S]*Usage: ibni prepare/);
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].code, 2);
});

test("setup explains a missing Verifika install instead of linking a partial skill set", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "coding-agent-no-modules-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await copyCheckout(base);
  const configFile = path.join(base, "mexxi-config.json");
  await writeFile(configFile, JSON.stringify({ paths: { checkout: base } }));
  const home = path.join(base, "home");
  await assert.rejects(install({ home, checkout: base, configFile }), /node_modules.*missing; run npm ci/);
  await assert.rejects(lstat(home), /ENOENT/);
});

test("the repository verify script is Verifika's full run of every configured check", async () => {
  const pkg = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
  assert.equal(pkg.scripts.verify, "verifika --all");
  const config = JSON.parse(await readFile(path.join(checkout, "verifika.config.json"), "utf8"));
  const result = await execute(process.execPath, [verifikaCli, "plan", "--all", "--mode", "json"], checkout);
  assert.equal(result.code, 0, result.output);
  const plan = JSON.parse(result.output);
  assert.deepEqual(plan.checks.filter((entry) => entry.selected).map((entry) => entry.name), Object.keys(config.checks));
  assert.deepEqual(plan.checks.find((entry) => entry.name === "integration").dependsOn, ["config"]);
});

test("Verifika reports passing and failing checks with persisted logs", async (t) => {
  const app = await mkdtemp(path.join(os.tmpdir(), "coding-agent-verifika-"));
  t.after(() => rm(app, { recursive: true, force: true }));
  const verifika = (...args) => execute(process.execPath, [verifikaCli, ...args, "--mode", "agent"], app);
  const configure = (checks) => writeFile(path.join(app, "verifika.config.json"), JSON.stringify({ version: 1, checks }));
  // Node keeps the commands portable across sh and cmd.exe.
  const node = (source) => `node -e "${source}"`;

  await configure({ smoke: { command: node("console.log('ok')") } });
  const passed = await verifika("--all");
  assert.equal(passed.code, 0, passed.output);
  assert.match(passed.output, /^PASS 1\/1 /);

  await configure({
    config: { command: node("console.error('generated agent is stale'); process.exit(3)") },
    integration: { command: node("console.log('ran')"), dependsOn: ["config"] },
  });
  const failed = await verifika("--all");
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /^FAIL /);
  assert.match(failed.output, /config: exit 3/);
  assert.match(failed.output, /generated agent is stale/);
  assert.match(failed.output, /integration: dependency config did not pass/);
  assert.match(failed.output, /logs config/);
  const logs = await execute(process.execPath, [verifikaCli, "logs", "config"], app);
  assert.match(logs.output, /generated agent is stale/);
});

test("setup refuses conflicts without changing unrelated configuration", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-conflict-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await mkdir(path.join(home, ".claude"));
  await writeFile(path.join(home, ".claude/CLAUDE.md"), "personal instructions");
  const hookDirectory = path.join(home, "git-hooks");
  await mkdir(hookDirectory);
  await writeFile(path.join(hookDirectory, "post-merge"), "my existing hook");
  await assert.rejects(install({ home, checkout, hookDirectory }), /existing configuration differs/);
  assert.equal(await readFile(path.join(home, ".claude/CLAUDE.md"), "utf8"), "personal instructions");
  assert.equal(await readFile(path.join(hookDirectory, "post-merge"), "utf8"), "my existing hook");
  await assert.rejects(readFile(path.join(home, ".config/opencode/opencode.json")), /ENOENT/);
});

test("Codex setup respects a custom home and preserves personal settings", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  const codex = path.join(home, "profile");
  await mkdir(codex);
  const settings = '[tui]\nscreen_reader_detection_done = true\n';
  await writeFile(path.join(codex, "config.toml"), settings);
  await install({ home, checkout, codex });
  await registerPlaywright(home, { codex });
  await install({ home, checkout, codex, check: true });
  assert.ok((await readFile(path.join(codex, "config.toml"), "utf8")).startsWith(settings), "personal Codex settings stay as they were");
  assert.match(await readFile(path.join(codex, "AGENTS.md"), "utf8"), /senior engineering deputy/);
  await assert.rejects(lstat(path.join(home, ".codex")), /ENOENT/);
});

test("Codex conflicts stop the whole installation before any writes", async (t) => {
  for (const relative of [".codex/AGENTS.md", ".codex/agents/code-reviewer.toml", ".agents/skills/mexxi-wettaq"]) {
    const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-codex-conflict-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await configure(home);
    const destination = path.join(home, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "personal configuration");
    await assert.rejects(install({ home, checkout }), /existing configuration differs/);
    assert.equal(await readFile(destination, "utf8"), "personal configuration");
    await assert.rejects(lstat(path.join(home, ".claude/CLAUDE.md")), /ENOENT/);
  }
});

test("a fast-forward pull invokes the installed post-merge hook", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-pull-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const remote = path.join(home, "remote.git");
  const seed = path.join(home, "seed");
  const control = path.join(home, "control");
  const git = async (cwd, ...args) => {
    const result = await execute("git", args, cwd);
    assert.equal(result.code, 0, result.output);
  };
  await git(home, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await git(home, "init", "--quiet", "--initial-branch=main", seed);
  await git(seed, "config", "user.name", "Install Test");
  await git(seed, "config", "user.email", "install@example.test");
  await mkdir(path.join(seed, "scripts"));
  await writeFile(path.join(seed, "scripts/install.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HOOK_LOG, 'installed');\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "--quiet", "-m", "initial");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "--quiet", "origin", "main");
  await git(home, "clone", "--quiet", remote, control);
  await configure(path.join(home, "user"));
  await install({ home: path.join(home, "user"), checkout, hookDirectory: path.join(control, ".git/hooks") });
  await writeFile(path.join(seed, "update.txt"), "new workflow\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "--quiet", "-m", "update");
  await git(seed, "push", "--quiet", "origin", "main");
  const log = path.join(home, "hook-ran");
  const result = await execute("git", ["pull", "--ff-only"], control, { ...process.env, HOOK_LOG: log });
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(log, "utf8"), "installed");
});

test("configuration checks canonical prompts and generated adapters", async () => {
  await check(checkout);
});

test("configuration rejects a verify gate that would skip tests", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "coding-agent-gate-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await copyCheckout(base);
  await symlink(path.join(checkout, "node_modules"), path.join(base, "node_modules"), process.platform === "win32" ? "junction" : undefined);
  await check(base);
  await writeFile(path.join(base, "scripts/retired.test.mjs"), "");
  await assert.rejects(check(base), /scripts\/retired\.test\.mjs is not run by any Verifika check/);
  await rm(path.join(base, "scripts/retired.test.mjs"));
  const pkg = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"));
  await writeFile(path.join(base, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, verify: "verifika" } }));
  await assert.rejects(check(base), /npm run verify must run every Verifika check/);
});

test("rendered host files keep command bodies canonical and --check catches drift from sources", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mexxi-render-drift-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clone = path.join(base, "clone");
  const home = path.join(base, "home");
  await copyCheckout(clone);
  await symlink(path.join(checkout, "node_modules"), path.join(clone, "node_modules"), process.platform === "win32" ? "junction" : undefined);
  await configure(home, {}, clone);
  await registerPlaywright(home);
  const options = { home, checkout: clone };
  await install(options);
  await install({ ...options, check: true });
  const command = await readFile(path.join(clone, "commands/wettaq.md"), "utf8");
  const wrapper = await readFile(path.join(home, ".agents/skills/mexxi-wettaq/SKILL.md"), "utf8");
  assert.ok(wrapper.endsWith(command.replace(/^---\n[\s\S]*?\n---\n/, "")));

  await writeFile(path.join(clone, "agent/code-reviewer.md"), "Updated canonical review instructions\n");
  await assert.rejects(install({ ...options, check: true }), /code-reviewer\.toml \(differs/);
  await install(options);
  await install({ ...options, check: true });
  assert.match(await readFile(path.join(home, ".codex/agents/code-reviewer.toml"), "utf8"), /Updated canonical review instructions/);

  await writeFile(path.join(clone, "commands/retired.md"), "---\ndescription: Retired\n---\n$ARGUMENTS\n");
  await install(options);
  assert.ok((await lstat(path.join(home, ".agents/skills/mexxi-retired"))).isSymbolicLink());
  await rm(path.join(clone, "commands/retired.md"));
  await assert.rejects(install({ ...options, check: true }), /mexxi-retired\/SKILL\.md \(no longer generated\)/);
  assert.equal((await install(options)).removed, 1);
  await assert.rejects(lstat(path.join(home, ".agents/skills/mexxi-retired")), /ENOENT/);
  await install({ ...options, check: true });
});

test("models and hosts come from config.json, and --check notices a config change", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-config-render-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home, { hosts: { codex: false }, models: { opencode: { explore: null }, claude: { reviewer: "opus" } } });
  await registerPlaywright(home);
  await install({ home, checkout });
  await install({ home, checkout, check: true });
  assert.match(await readFile(path.join(home, ".claude/agents/code-reviewer.md"), "utf8"), /^model: "opus"$/m);
  assert.doesNotMatch(await readFile(path.join(home, ".claude/agents/ui-designer.md"), "utf8"), /^model:/m);
  const opencode = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
  assert.equal(opencode.agent.explore.model, undefined);
  assert.equal(opencode.agent["ui-designer"].model, "opencode-go/kimi-k2.7-code");
  await assert.rejects(lstat(path.join(home, ".codex")), /ENOENT/);
  await assert.rejects(lstat(path.join(home, ".agents")), /ENOENT/);

  await configure(home, { hosts: { codex: false }, models: { claude: { reviewer: "sonnet" } } });
  await assert.rejects(install({ home, checkout, check: true }), /opencode\.json \(differs[\s\S]*code-reviewer\.md \(differs/);
  await install({ home, checkout });
  await install({ home, checkout, check: true });

  await configure(home, { models: { claude: { reviewer: 42 } } });
  await assert.rejects(install({ home, checkout }), /models\.claude\.reviewer: expected string or null/);
});

test("the cross-family reviewer is the code-reviewer's model on OpenCode and Codex, and stays a Codex model for Claude Code", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-cross-family-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home, { models: {
    opencode: { reviewer: "openai/gpt-5.6-luna", crossFamilyReviewer: "anthropic/claude-opus-4-8" },
    claude: { reviewer: "sonnet", crossFamilyReviewer: "gpt-5.6-review" },
    codex: { crossFamilyReviewer: "gpt-5.6-xhigh" },
  } });
  await registerPlaywright(home);
  await install({ home, checkout });
  const opencode = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
  assert.equal(opencode.agent["code-reviewer"].model, "anthropic/claude-opus-4-8");
  assert.match(await readFile(path.join(home, ".codex/agents/code-reviewer.toml"), "utf8"), /^model = "gpt-5\.6-xhigh"$/m);
  // Claude Code's subagent keeps the reviewer model; the Codex model is only used by ibni cross-review.
  const claude = await readFile(path.join(home, ".claude/agents/code-reviewer.md"), "utf8");
  assert.match(claude, /^model: "sonnet"$/m);
  assert.doesNotMatch(claude, /gpt-5\.6-review/);

  await configure(home, { models: { opencode: { reviewer: "openai/gpt-5.6-luna" } } });
  await install({ home, checkout });
  const fallback = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
  assert.equal(fallback.agent["code-reviewer"].model, "openai/gpt-5.6-luna", "null falls back to the reviewer's model");
  assert.doesNotMatch(await readFile(path.join(home, ".codex/agents/code-reviewer.toml"), "utf8"), /^model =/m);
});

test("first run writes a minimal config.json, and only the configured clone may install", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-first-run-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configFile = path.join(home, ".config/mexxi/config.json");
  // Without config.json the clone must be at the default location.
  await assert.rejects(install({ home, checkout }), /expects the mexxi clone at .*workspace\/mexxi[\s\S]*paths/);
  await assert.rejects(lstat(configFile), /ENOENT/);
  const clone = path.join(home, "workspace/mexxi");
  await mkdir(path.dirname(clone), { recursive: true });
  await symlink(checkout, clone, process.platform === "win32" ? "junction" : undefined);
  await assert.rejects(install({ home, checkout: clone, check: true }), /config\.json \(missing\)/);
  await install({ home, checkout: clone });
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), {
    $schema: path.join(clone, "config.schema.json"),
    paths: { checkout: "~/workspace/mexxi" },
  });
  await registerPlaywright(home);
  await install({ home, checkout: clone, check: true });
  await assert.rejects(install({ home, checkout, check: true }), /expects the mexxi clone at/);
});

test("--migrate-from relinks an old checkout's links, then a hand-edited host file turns --check red", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-migrate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  // What the previous installer left when the clone was ~/.config/opencode;
  // after the move these links dangle into the emptied directory.
  const old = path.join(home, ".config/opencode");
  const previous = {
    ".claude/CLAUDE.md": "AGENTS.md",
    ".claude/commands": "commands",
    ".claude/agents/code-reviewer.md": "claude/agents/code-reviewer.md",
    ".claude/skills/rendered-qa": "skills/rendered-qa",
    ".claude/skills/retired": "skills/retired",
    ".codex/AGENTS.md": "AGENTS.md",
    ".codex/agents/ui-designer.toml": "codex/agents/ui-designer.toml",
    ".agents/skills/workflow-implement": "codex/skills/workflow-implement",
    ".agents/skills/verifika": "node_modules/verifika/skills/verifika",
    ".local/bin/implementation-workspace": "scripts/implementation-workspace",
  };
  for (const [link, target] of Object.entries(previous)) {
    await mkdir(path.dirname(path.join(home, link)), { recursive: true });
    await symlink(path.join(old, target), path.join(home, link));
  }
  const personal = path.join(home, ".claude/skills/mine");
  await symlink(path.join(home, "elsewhere"), personal);
  await mkdir(old, { recursive: true });
  await writeFile(path.join(old, "tui.jsonc"), "{}\n");
  const options = { home, checkout, hookDirectory: path.join(home, "git-hooks") };

  await assert.rejects(install(options), /existing configuration differs; no changes made:[\s\S]*CLAUDE\.md \(links to .*\.config\/opencode\/AGENTS\.md\)/);
  assert.equal(await readlink(path.join(home, ".claude/CLAUDE.md")), path.join(old, "AGENTS.md"));
  await assert.rejects(install({ ...options, migrateFrom: checkout }), /must name the old checkout/);

  const result = await install({ ...options, migrateFrom: old });
  assert.equal(result.relinked, Object.keys(previous).length - 1);
  assert.equal(result.removed, 1);
  await assert.rejects(lstat(path.join(home, ".claude/skills/retired")), /ENOENT/);
  assert.equal(await readlink(personal), path.join(home, "elsewhere"));
  assert.equal(await readFile(path.join(old, "tui.jsonc"), "utf8"), "{}\n");
  assert.equal(await readlink(path.join(home, ".claude/CLAUDE.md")), path.join(home, ".local/share/mexxi/generated/claude/CLAUDE.md"));
  assert.equal(await readlink(path.join(home, ".local/bin/implementation-workspace")), path.join(checkout, "scripts/implementation-workspace"));
  assert.match(await readFile(path.join(home, ".codex/agents/ui-designer.toml"), "utf8"), /^name = "ui-designer"$/m);
  await install({ ...options, check: true });

  const hostFile = path.join(home, ".local/share/mexxi/generated/opencode/opencode.json");
  await writeFile(hostFile, (await readFile(hostFile, "utf8")).replace("kimi-k2.7-code", "hand-edited"));
  await assert.rejects(install({ ...options, check: true }), /opencode\.json \(differs from config\.json/);
  assert.equal((await install(options)).rendered, 1);
  await install({ ...options, check: true });
});

test("Playwright MCP comes from config.json: rendered for OpenCode, printed for the others, and --check reads the hosts back", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-playwright-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const output = path.join(home, "evidence");
  await configure(home, { browser: { playwrightMcpVersion: "0.0.90", executablePath: "/opt/chrome", outputDir: output } });
  const options = { home, checkout };
  const result = await install(options);

  const expected = ["npx", "-y", "@playwright/mcp@0.0.90", "--headless", "--isolated", "--executable-path=/opt/chrome", `--output-dir=${output}`];
  const opencode = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
  assert.deepEqual(opencode.mcp.playwright, { type: "local", command: expected, enabled: true });
  assert.ok(!JSON.stringify(opencode).includes("allow-unrestricted-file-access"));
  const line = `-- ${expected.join(" ")}`;
  assert.deepEqual(result.registration, {
    claude: `claude mcp add --scope user playwright ${line}`,
    codex: `codex mcp add playwright ${line}`,
  });
  assert.deepEqual(result.registration, registrationCommands((await loadConfig({ file: path.join(home, ".config/mexxi/config.json"), home })).config.browser));

  // Nothing registered yet: --check says so and prints the fix.
  await assert.rejects(install({ ...options, check: true }), /claude: Playwright MCP not registered[\s\S]*run: claude mcp add[\s\S]*codex: Playwright MCP not registered[\s\S]*run: codex mcp add/);
  await registerPlaywright(home);
  await install({ ...options, check: true });

  // A different version or output directory in either host is drift.
  const claudeJson = path.join(home, ".claude.json");
  const registered = await readFile(claudeJson, "utf8");
  await writeFile(claudeJson, registered.replace("0.0.90", "latest"));
  await assert.rejects(install({ ...options, check: true }), /claude: Playwright MCP runs @playwright\/mcp@latest, config\.json pins 0\.0\.90; run claude mcp remove/);
  await writeFile(claudeJson, registered.replace(output, "/tmp/opencode-playwright"));
  await assert.rejects(install({ ...options, check: true }), /claude: Playwright MCP writes to \/tmp\/opencode-playwright, config\.json expects/);
  await writeFile(claudeJson, registered.replace('"--headless"', '"--allow-unrestricted-file-access","--headless"'));
  await assert.rejects(install({ ...options, check: true }), /passes --allow-unrestricted-file-access/);
  await writeFile(claudeJson, "{ not json");
  await assert.rejects(install({ ...options, check: true }), /claude: Playwright MCP unreadable/);
  await writeFile(claudeJson, registered);
  const codexConfig = path.join(home, ".codex/config.toml");
  const codexRegistered = await readFile(codexConfig, "utf8");
  await writeFile(codexConfig, codexRegistered.replace("0.0.90", "0.0.83"));
  await assert.rejects(install({ ...options, check: true }), /codex: Playwright MCP runs @playwright\/mcp@0\.0\.83, config\.json pins 0\.0\.90/);
  // Codex users may format the table their own way: multi-line args, a trailing comma, other tables around it.
  const args = JSON.parse(codexRegistered.match(/^args = (.*)$/m)[1]);
  await writeFile(codexConfig, `[tui]\nx = 1\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = [\n  ${args.map((arg) => JSON.stringify(arg)).join(",\n  ")},\n]\n\n[mcp_servers.other]\nargs = ["x"]\n`);
  await install({ ...options, check: true });
  await rm(codexConfig);
  await assert.rejects(install({ ...options, check: true }), /codex: Playwright MCP not registered \(.*does not exist\)/);

  // A host that is switched off is not inspected.
  await configure(home, { hosts: { codex: false }, browser: { playwrightMcpVersion: "0.0.90", executablePath: "/opt/chrome", outputDir: output } });
  await install(options);
  await install({ ...options, check: true });
});

test("settings.json gets only the keys mexxi owns, and --check notices a hand-removed one", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home, { guard: { deny: ["firebase deploy", "npm publish"] } });
  await registerPlaywright(home);
  const settingsFile = path.join(home, ".claude/settings.json");
  const stateFile = path.join(home, ".local/share/mexxi/state/claude-settings.json");
  const options = { home, checkout };
  const mine = {
    model: "opus",
    permissions: { allow: ["Bash(git status:*)"], deny: ["Bash(rm -rf:*)", "Bash(npm publish:*)"] },
    env: { OTHER: "1" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
  };
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(mine));
  const read = async () => JSON.parse(await readFile(settingsFile, "utf8"));

  await assert.rejects(install({ ...options, check: true }), /Bash\(firebase deploy:\*\) is missing[\s\S]*env\.BASH_MAX_TIMEOUT_MS is missing/);
  await install(options);
  // The guard and loop breaker join the user's own hooks; theirs stay first.
  const ours = claudeHooks({ paths: { checkout } });
  assert.deepEqual(await read(), {
    ...mine,
    permissions: { allow: mine.permissions.allow, deny: ["Bash(rm -rf:*)", "Bash(npm publish:*)", "Bash(firebase deploy:*)"] },
    env: { OTHER: "1", BASH_MAX_TIMEOUT_MS: "900000" },
    cleanupPeriodDays: 90,
    hooks: { ...mine.hooks, ...ours },
  });
  assert.match(ours.PreToolUse[0].hooks[0].command, /^node .*scripts\/hooks\/guard\.mjs$/);
  // The user's own copy of npm publish was there first, so it is not ours to remove.
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { deny: ["Bash(firebase deploy:*)"], env: { BASH_MAX_TIMEOUT_MS: "900000" }, keys: { cleanupPeriodDays: 90 }, hooks: ours });
  const written = await readFile(settingsFile, "utf8");
  await install(options);
  await install({ ...options, check: true });
  assert.equal(await readFile(settingsFile, "utf8"), written);

  // A hand-removed owned entry turns --check red, and install puts it back.
  await writeFile(settingsFile, written.replace('"Bash(firebase deploy:*)"', '"Bash(rm:*)"'));
  await assert.rejects(install({ ...options, check: true }), /deny entry Bash\(firebase deploy:\*\) is missing/);
  await install(options);
  await install({ ...options, check: true });
  const unhooked = await read();
  delete unhooked.hooks.PreToolUse;
  await writeFile(settingsFile, JSON.stringify(unhooked));
  await assert.rejects(install({ ...options, check: true }), /PreToolUse hook Bash\|Monitor -> node .*guard\.mjs is missing/);
  await install(options);
  assert.deepEqual((await read()).hooks.PreToolUse, ours.PreToolUse);

  // Changing config removes only what mexxi added; the timeout follows config.
  await configure(home, { guard: { deny: ["gh pr merge"] }, claude: { bashMaxTimeoutMs: 600000 } });
  await assert.rejects(install({ ...options, check: true }), /Bash\(firebase deploy:\*\) was added by mexxi and is no longer in config\.json/);
  await install(options);
  await install({ ...options, check: true });
  const settings = await read();
  assert.deepEqual(settings.permissions.deny, ["Bash(rm -rf:*)", "Bash(npm publish:*)", "Bash(rm:*)", "Bash(gh pr merge:*)"]);
  assert.equal(settings.env.BASH_MAX_TIMEOUT_MS, "600000");
  assert.equal(settings.cleanupPeriodDays, 90);
  assert.equal(settings.model, "opus");
  await configure(home, { guard: { deny: ["gh pr merge"] }, claude: { bashMaxTimeoutMs: 600000 }, retro: { transcriptRetentionDays: 120 } });
  await assert.rejects(install({ ...options, check: true }), /cleanupPeriodDays is 90, config\.json asks for 120/);
  await install(options);
  assert.equal((await read()).cleanupPeriodDays, 120);
  await configure(home, { guard: { deny: ["gh pr merge"] }, claude: { bashMaxTimeoutMs: 600000 } });
  await install(options);
  assert.deepEqual(settings.hooks, { ...mine.hooks, ...ours });

  // A value the user set themselves is a conflict, not something to overwrite.
  await writeFile(settingsFile, JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "120000" } }));
  await rm(stateFile);
  await assert.rejects(install(options), /env\.BASH_MAX_TIMEOUT_MS is 120000, not set by mexxi/);
  assert.equal(await readFile(settingsFile, "utf8"), JSON.stringify({ env: { BASH_MAX_TIMEOUT_MS: "120000" } }));
  await writeFile(settingsFile, JSON.stringify({ cleanupPeriodDays: 30 }));
  await assert.rejects(install(options), /cleanupPeriodDays is 30, not set by mexxi; remove it, or set retro\.transcriptRetentionDays to 30/);
  assert.equal(await readFile(settingsFile, "utf8"), JSON.stringify({ cleanupPeriodDays: 30 }));
  await writeFile(settingsFile, "{ not json");
  await assert.rejects(install(options), /settings\.json is not a JSON object/);
  assert.equal(await readFile(settingsFile, "utf8"), "{ not json");
});

test("the default deny rules are the plan's starter list, and guard has what the Phase 3 guard reads", async () => {
  const { config } = await loadConfig({ file: path.join(os.tmpdir(), "mexxi-no-such-config.json"), home: os.tmpdir() });
  const { desiredSettings } = await import("./lib/claude-settings.mjs");
  assert.deepEqual(desiredSettings(config).deny, [
    "Bash(firebase deploy:*)", "Bash(npm run deploy:*)", "Bash(npm publish:*)", "Bash(gcloud functions deploy:*)",
    "Bash(gcloud run deploy:*)", "Bash(vercel --prod:*)", "Bash(netlify deploy --prod:*)", "Bash(gh pr merge:*)",
    "Bash(gh release create:*)", "Bash(git push --force:*)", "Bash(git push -f:*)",
  ]);
  assert.deepEqual(config.guard.protectedBranches, []);
  assert.equal(desiredSettings(config).env.BASH_MAX_TIMEOUT_MS, "900000");
});

test("Claude Code gets AGENTS.md plus its overlay; the other hosts get AGENTS.md alone", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-overlay-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  await install({ home, checkout });
  const shared = await readFile(path.join(checkout, "AGENTS.md"), "utf8");
  const overlay = await readFile(path.join(checkout, "claude/overlay.md"), "utf8");
  const claudeFile = path.join(home, ".claude/CLAUDE.md");
  assert.equal(await readlink(claudeFile), path.join(home, ".local/share/mexxi/generated/claude/CLAUDE.md"));
  assert.equal(await readFile(claudeFile, "utf8"), `${shared.trimEnd()}\n\n${overlay}`);
  assert.equal(await readFile(path.join(home, ".codex/AGENTS.md"), "utf8"), shared);
  assert.equal(await readFile(path.join(home, ".config/opencode/AGENTS.md"), "utf8"), shared);
  // OpenCode loads the guard plugin from the clone, so its imports resolve.
  const opencode = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
  assert.deepEqual(opencode.plugin, [pathToFileURL(path.join(checkout, "opencode/plugins/mexxi-guard.js")).href]);
});

test("Codex's hooks.json gets the guard and loop breaker beside hooks it does not own", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-codex-hooks-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  const hooksFile = path.join(home, ".codex/hooks.json");
  const herdr = { SessionStart: [{ hooks: [{ command: "bash ~/.codex/herdr-agent-state.sh session", timeout: 10, type: "command" }] }] };
  await writeFile(hooksFile, JSON.stringify({ hooks: herdr }));
  const options = { home, checkout };

  await assert.rejects(install({ ...options, check: true }), /hooks\.json: PreToolUse hook Bash -> node .*guard\.mjs is missing/);
  assert.equal((await install(options)).codexHooksChanged, true);
  const { hooks } = JSON.parse(await readFile(hooksFile, "utf8"));
  assert.deepEqual(hooks.SessionStart, herdr.SessionStart);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${path.join(checkout, "scripts/hooks/guard.mjs")}` }] }]);
  assert.match(hooks.PostToolUse[0].hooks[0].command, /loop-breaker\.mjs$/);
  assert.equal((await install(options)).codexHooksChanged, false);
  await install({ ...options, check: true });

  await writeFile(hooksFile, JSON.stringify({ hooks: { ...hooks, PreToolUse: [] } }));
  await assert.rejects(install({ ...options, check: true }), /PreToolUse hook Bash -> .* is missing/);
  await install(options);
  await install({ ...options, check: true });

  // Turning Codex off leaves its files alone; turning it back on is idempotent.
  await configure(home, { hosts: { codex: false } });
  await install(options);
  assert.deepEqual(JSON.parse(await readFile(hooksFile, "utf8")).hooks.SessionStart, herdr.SessionStart);
});

test("the mods are installed through the claude CLI from this clone, and --check confirms where they are read from", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mexxi-mods-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  await mkdir(home);
  await configure(home);
  await registerPlaywright(home);
  const log = path.join(home, ".claude-stub.log");
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const options = { home, checkout };

  await assert.rejects(install({ ...options, check: true }), /mod run-pane@mexxi is not installed[\s\S]*mod command-fixer@mexxi is not installed/);
  await install(options);
  assert.deepEqual((await calls()).filter((call) => !call.startsWith("plugin list")), [
    `plugin marketplace add ${path.resolve(checkout)} --json`, "plugin install run-pane@mexxi --json", "plugin install command-fixer@mexxi --json",
  ]);
  // Already installed and read from this clone: nothing more is run.
  const before = (await calls()).length;
  await install(options);
  await install({ ...options, check: true });
  assert.deepEqual((await calls()).slice(before), ["plugin list --json", "plugin list --json"]);

  // Left pointing at an old clone (the pre-move ~/.config/opencode), --check
  // says where they are read from; installing adds this clone again.
  const old = path.join(base, "old");
  await copyCheckout(old);
  const stub = await execute("claude", ["plugin", "marketplace", "add", old, "--json"], home, { ...process.env, HOME: home });
  assert.equal(stub.code, 0, stub.output);
  await assert.rejects(install({ ...options, check: true }), new RegExp(`run-pane@mexxi is read from ${old}/claude/mods/run-pane, not ${path.resolve(checkout)}/claude/mods/run-pane`));
  await install(options);
  await install({ ...options, check: true });

  // A mod dropped from config.json is uninstalled.
  await configure(home, { mods: ["run-pane"] });
  await assert.rejects(install({ ...options, check: true }), /command-fixer@mexxi is installed but not in config\.json's mods/);
  await install(options);
  assert.equal((await calls()).at(-1), "plugin uninstall command-fixer@mexxi --json");
  await install({ ...options, check: true });
});

test("hosts without the claude CLI skip the mods", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-no-claude-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await configure(home);
  await registerPlaywright(home);
  const options = { home, checkout, env: { PATH: path.join(home, "no-such-bin") } };
  assert.equal((await install(options)).mods, "skipped: no claude CLI");
  assert.equal((await install({ ...options, check: true })).mods, "skipped: no claude CLI");
});
