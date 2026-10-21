#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { links } from "./install.mjs";
import { loadSchema, resolveConfig, supportedKeywords, validate, withDefaults } from "./lib/config.mjs";
import { agentRoles, renderHostFiles } from "./lib/render.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const generated = path.join(path.sep, "rendered");

// Every schema key needs a description and a default, so the schema doubles as
// the configuration reference, and only keywords lib/config.mjs implements.
function checkSchema(schema, at = "config") {
  for (const keyword of Object.keys(schema)) assert.ok(supportedKeywords.has(keyword), `${at}: ${keyword} is not supported by lib/config.mjs`);
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    assert.ok(property.description, `${at}.${key} has no description`);
    assert.ok("default" in property, `${at}.${key} has no default`);
    assert.deepEqual(validate(property.default, property, `${at}.${key}`), []);
    checkSchema(property, `${at}.${key}`);
  }
  if (schema.items) checkSchema(schema.items, `${at}[]`);
}

export async function check(base = root) {
  const schema = await loadSchema();
  checkSchema(schema);
  const example = JSON.parse(await readFile(path.join(base, "config.example.json"), "utf8"));
  assert.deepEqual(validate(example, schema), []);
  assert.deepEqual({ ...example, $schema: undefined }, { ...withDefaults({}, schema), $schema: undefined }, "config.example.json must spell out every default");
  // Host files are rendered with the default config, as a fresh install would.
  const defaults = await resolveConfig({});
  const rendered = await renderHostFiles({ checkout: base, config: { ...defaults, paths: { ...defaults.paths, checkout: base } } });
  const config = JSON.parse(rendered.get("opencode/opencode.json"));
  const template = JSON.parse(await readFile(path.join(base, "opencode/opencode.json"), "utf8"));
  const claude = JSON.parse(await readFile(path.join(base, "claude/agents.json"), "utf8"));
  const codex = JSON.parse(await readFile(path.join(base, "codex/agents.json"), "utf8"));
  // Models and paths come from config.json only.
  for (const [name, agent] of Object.entries(template.agent)) {
    assert.ok(!("model" in agent) && !("prompt" in agent), `opencode/opencode.json: ${name} must take its model and prompt from the renderer`);
  }
  assert.ok(!template.permission?.external_directory, "opencode/opencode.json: worktree roots come from config.json");
  for (const [host, metadata] of [["claude", claude], ["codex", codex]]) {
    for (const [name, fields] of Object.entries(metadata)) assert.ok(!("model" in fields), `${host}/agents.json: ${name}'s model belongs in config.json`);
  }
  assert.deepEqual(Object.keys(codex).sort(), Object.keys(claude).sort(), "each shared agent must have a Codex adapter");
  assert.deepEqual(Object.keys(agentRoles).sort(), Object.keys(claude).sort(), "each shared agent must have a models role");
  for (const host of ["opencode", "claude", "codex"]) {
    for (const role of Object.values(agentRoles)) assert.ok(schema.properties.models.properties[host].properties[role], `models.${host}.${role} is missing from the schema`);
  }
  assert.match(rendered.get("codex/agents/code-reviewer.toml"), /^sandbox_mode = "read-only"$/m);
  assert.deepEqual(
    (await readdir(path.join(base, "agent"))).filter((name) => name.endsWith(".md")).sort(),
    Object.keys(claude).map((name) => `${name}.md`).sort(),
    "each shared agent must have a Claude Code adapter",
  );
  assert.deepEqual(Object.keys(config.agent).filter((name) => name in claude).sort(), Object.keys(claude).sort());
  assert.ok(config.permission.external_directory[`${defaults.paths.worktreeRoot}/**`], "OpenCode must reach the configured worktree root");
  for (const name of Object.keys(claude)) {
    assert.equal(config.agent[name].prompt, `{file:${path.join(base, "agent", `${name}.md`)}}`);
    assert.equal(config.agent[name].mode, "subagent");
    assert.equal(config.agent[name].description, claude[name].description);
    assert.equal(codex[name].description, claude[name].description);
    const body = await readFile(path.join(base, "agent", `${name}.md`), "utf8");
    assert.doesNotMatch(body, /(?:openai|opencode-go)\/[a-z0-9.-]+/i);
  }
  for (const name of await readdir(path.join(base, "commands"))) {
    if (!name.endsWith(".md")) continue;
    const text = await readFile(path.join(base, "commands", name), "utf8");
    assert.match(text, /^---\ndescription: [^\n]+\n---\n/);
    assert.match(text, /\$ARGUMENTS/, `command ${name} lost argument substitution`);
    assert.doesNotMatch(text, /(?:openai|opencode-go)\/[a-z0-9.-]+/i);
  }
  for (const name of await readdir(path.join(base, "skills"))) {
    const file = path.join(base, "skills", name, "SKILL.md");
    const text = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (text) {
      assert.doesNotMatch(text, /opencode\/autoinvoke/);
      assert.doesNotMatch(text, /(?:openai|opencode-go)\/[a-z0-9.-]+/i);
    }
  }
  const installation = await links({ checkout: base, generated });
  assert.equal(new Set(installation.map(([destination]) => destination)).size, installation.length, "installation destinations must be unique");
  for (const [destination, source] of installation) {
    assert.ok(destination && source);
    if (source.startsWith(`${generated}${path.sep}`)) {
      const relative = path.relative(generated, source).split(path.sep).join("/");
      assert.ok([...rendered.keys()].some((name) => name === relative || name.startsWith(`${relative}/`)), `${source} is not rendered`);
    } else {
      await access(source);
    }
  }
  if (process.platform !== "win32") {
    assert.ok((await stat(path.join(base, "scripts/implementation-workspace"))).mode & 0o111, "implementation-workspace is not executable");
  }
  const pkg = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"));
  assert.equal(pkg.scripts.verify, "verifika --all", "npm run verify must run every Verifika check");
  assert.match(pkg.devDependencies?.verifika ?? "", /^\d+\.\d+\.\d+$/, "Verifika must be pinned to an exact version");
  const verifika = JSON.parse(await readFile(path.join(base, "verifika.config.json"), "utf8"));
  assert.ok((verifika.defaults?.concurrency ?? 1) === 1, "Verifika checks run sequentially until concurrency is shown to be safe");
  // A test file no check names would silently drop out of the delivery gate.
  const commands = Object.values(verifika.checks).map((entry) => entry.command);
  const tests = [
    ...(await readdir(path.join(base, "scripts"))).filter((name) => name.endsWith(".test.mjs")).map((name) => `scripts/${name}`),
    ...(await readdir(path.join(base, "skills/repo-context/tests"))).filter((name) => name.endsWith(".test.js")).map((name) => `skills/repo-context/tests/${name}`),
  ];
  for (const test of tests) {
    assert.ok(commands.some((command) => command.split(/\s+/).includes(test)), `${test} is not run by any Verifika check`);
  }
  assert.ok(!JSON.stringify(config).includes("verify-env"), "OpenCode must not own the shared PATH");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await check();
    process.stdout.write("Configuration integration passed\n");
  } catch (error) {
    process.stderr.write(`Configuration integration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
