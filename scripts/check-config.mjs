#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { links } from "./install.mjs";
import { desiredSettings } from "./lib/claude-settings.mjs";
import { loadSchema, resolveConfig, supportedKeywords, validate, withDefaults } from "./lib/config.mjs";
import { agentRoles, commandAliases, renderHostFiles } from "./lib/render.mjs";

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

const sentences = (text) => text.replace(/\s+/g, " ").split(/(?<=[.;:!?])\s+/);

// Claims in the instructions that a reader acts on and that drift silently.
async function checkInstructionClaims(base, defaults) {
  const read = (name) => readFile(path.join(base, name), "utf8");
  // The guard hook covers only some commands, and Codex skips it until
  // trusted, so the red lines stay rules in prose and the guard is named only
  // as their backup.
  const wettaq = (await read("commands/wettaq.md")).replace(/\s+/g, " ");
  assert.match(wettaq, /Do not [^.]*rewrite shared history, force push, stash, discard work,[^.]* or improvise destructive recovery\./,
    "commands/wettaq.md must keep its delivery red lines as a rule, not leave them to the guard hook");
  const agents = (await read("AGENTS.md")).replace(/\s+/g, " ");
  const redLines = agents.match(/Never merge;[^.]*\./)?.[0] ?? "";
  for (const line of ["push to the default branch", "force push", "rewrite published or unrelated history", "stash, discard, or overwrite changes you did not make", "include unrelated changes"]) {
    assert.ok(redLines.includes(line), `AGENTS.md must keep "${line}" in its "Never merge; ..." rule, not leave it to the guard hook`);
  }
  for (const name of ["AGENTS.md", "commands/wettaq.md"]) {
    for (const sentence of sentences(await read(name))) {
      if (/\bguard\b/i.test(sentence)) assert.match(sentence, /\bbackup\b/, `${name} must name the guard hook only as a backup to its rules: "${sentence}"`);
    }
  }
  // ibda runs the installer, which merges keys into the user's own Claude Code
  // settings.json: the skill must name each one, and ask before both a first
  // install and an upgrade.
  const ibda = await read("skills/ibda/SKILL.md");
  const merged = desiredSettings(defaults);
  const named = ["permissions.deny", ...Object.keys(merged.env), ...Object.keys(merged.hooks),
    ...Object.entries(merged.keys).map(([key, value]) => `${key}: ${value}`)];
  for (const item of named) assert.ok(ibda.includes(item), `skills/ibda/SKILL.md must tell the user the installer merges ${item} into ~/.claude/settings.json`);
  for (const heading of ["## 4. Install", "## Upgrade and repair"]) {
    const section = ibda.slice(ibda.indexOf(heading) + heading.length).split("\n## ")[0];
    assert.match(section.replace(/\s+/g, " "), /explicit yes/, `skills/ibda/SKILL.md: "${heading}" must get an explicit yes before running the installer`);
  }
  // The schema says which hosts have only one model family; on those the
  // review is always same-family, and the review skill must not promise
  // otherwise. `--reviewer cross` records the reviewer's family, whichever
  // route got it there.
  const review = await read("skills/implement-review/SKILL.md");
  const models = (await loadSchema()).properties.models.properties;
  const singleFamily = Object.values(models)
    .filter((host) => /only one family/.test(host.properties.crossFamilyReviewer.description))
    .map((host) => host.description.match(/^(.+?) models\b/)[1]);
  assert.ok(singleFamily.length, "config.schema.json no longer marks a single-family host; update this check with it");
  for (const host of singleFamily) {
    for (const paragraph of review.split(/\n\s*\n/).map((text) => text.replace(/\s+/g, " "))) {
      if (paragraph.includes(host) && /\b(?:another|other|different) family\b/.test(paragraph)) {
        assert.match(paragraph, new RegExp(`${host}[^.]*\\b(?:only one|the same) (?:model )?family`), `skills/implement-review/SKILL.md must say ${host}'s review is always same-family, as config.schema.json does`);
      }
    }
  }
  const recording = wettaq.match(/--reviewer same\|cross` \(([^)]*)\)/)?.[1] ?? "";
  assert.match(recording, /`cross`[^,]*\bfamily\b/, "commands/wettaq.md must record --reviewer cross by the reviewer's model family, not by whether ibni cross-review ran");
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
  assert.ok(!template.mcp, "opencode/opencode.json: the Playwright MCP server comes from config.json's browser group");
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
  assert.ok(config.mcp.playwright.command.includes(`@playwright/mcp@${defaults.browser.playwrightMcpVersion}`) &&
    config.mcp.playwright.command.includes(`--output-dir=${defaults.browser.outputDir}`), "OpenCode must run the pinned Playwright MCP");
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
  // An alias only runs its new command, so it must name a real one and list
  // with that command's description.
  for (const [file, target] of Object.entries(commandAliases)) {
    const alias = await readFile(path.join(base, "commands", file), "utf8");
    const description = (await readFile(path.join(base, "commands", `${target}.md`), "utf8")).match(/^---\ndescription: ([^\n]+)\n/)[1];
    assert.ok(!(`${target}.md` in commandAliases), `alias ${file} must point at a command, not another alias`);
    assert.ok(alias.includes(`commands/${target}.md`), `alias ${file} must run commands/${target}.md`);
    assert.ok(alias.startsWith(`---\ndescription: Old name for /${target}, kept for one release. ${description}\n`), `alias ${file} must keep /${target}'s description`);
  }
  // names.json is the one place the Maltese names, meanings and old names are
  // written; the docs generator reads it. Every command, the CLI and the setup
  // skill must have an entry, and every alias must be the name an entry replaces.
  const names = JSON.parse(await readFile(path.join(base, "names.json"), "utf8"));
  const byName = new Map(names.map((entry) => [entry.name, entry]));
  assert.equal(byName.size, names.length, "names.json has a duplicate name");
  for (const entry of names) {
    assert.deepEqual(Object.keys(entry), ["name", "kind", "meaning", "replaces", "does", "pronunciation"], `names.json: ${entry.name} has the wrong fields`);
    assert.ok(["repo", "cli", "command", "skill"].includes(entry.kind), `names.json: ${entry.name} has an unknown kind`);
    for (const field of ["meaning", "does", "pronunciation"]) assert.ok(typeof entry[field] === "string" && entry[field].trim(), `names.json: ${entry.name} has no ${field}`);
    assert.ok(entry.replaces === null || typeof entry.replaces === "string", `names.json: ${entry.name}.replaces is a name or null`);
  }
  const commandFiles = (await readdir(path.join(base, "commands"))).filter((name) => name.endsWith(".md") && !(name in commandAliases));
  assert.deepEqual(names.filter((entry) => entry.kind === "command").map((entry) => `${entry.name}.md`).sort(), commandFiles.sort(), "names.json must list each command, and only commands");
  assert.deepEqual(names.filter((entry) => entry.kind === "cli").map((entry) => entry.name), ["ibni"]);
  assert.deepEqual(names.filter((entry) => entry.kind === "repo").map((entry) => entry.name), ["mexxi"]);
  const skillEntries = names.filter((entry) => entry.kind === "skill");
  assert.deepEqual(skillEntries.map((entry) => entry.name), ["ibda"]);
  for (const entry of skillEntries) await access(path.join(base, "skills", entry.name, "SKILL.md"));
  for (const [file, target] of Object.entries(commandAliases)) {
    assert.equal(byName.get(target)?.replaces, file.slice(0, -3), `names.json: ${target} must replace ${file.slice(0, -3)}`);
  }
  // The prompts the README, landing page and docs copy come from prompts.json.
  const prompts = JSON.parse(await readFile(path.join(base, "prompts.json"), "utf8"));
  assert.deepEqual(Object.keys(prompts), ["install", "prepare"]);
  assert.match(prompts.install.text, /skills\/ibda\/SKILL\.md/);
  assert.match(prompts.prepare.text, /\/lesti/);
  const setupSkill = await readFile(path.join(base, "skills/ibda/SKILL.md"), "utf8");
  assert.ok(setupSkill.includes(prompts.prepare.text), "skills/ibda/SKILL.md must quote the prepare prompt from prompts.json");
  assert.ok(setupSkill.includes(prompts.install.text.match(/https:\/\/\S+SKILL\.md/)[0]), "skills/ibda/SKILL.md must name the URL the install prompt fetches");
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
  // Rules for Claude Code's own tools live only in its overlay: the hosts that
  // read the shared files have no Read tool, run_in_background or Monitor.
  const overlay = await readFile(path.join(base, "claude/overlay.md"), "utf8");
  const claudeOnly = [/\brun_in_background\b/, /\bMonitor\b/, /\bthe Read tool\b/];
  for (const pattern of claudeOnly) assert.match(overlay, pattern, `claude/overlay.md no longer names ${pattern}; update this check with the overlay`);
  const rules = overlay.split(/\n(?=- )/).filter((item) => item.startsWith("- ")).map((item) => item.slice(2).replace(/\s+/g, " ").trim());
  assert.ok(rules.length >= 3, "claude/overlay.md must list its rules as bullets");
  const sharedInstructions = ["AGENTS.md",
    ...(await readdir(path.join(base, "agent"))).map((name) => `agent/${name}`),
    ...(await readdir(path.join(base, "commands"))).map((name) => `commands/${name}`),
    ...(await readdir(path.join(base, "skills"), { recursive: true })).map((name) => `skills/${name.split(path.sep).join("/")}`),
  ].filter((name) => name.endsWith(".md"));
  for (const name of sharedInstructions) {
    const text = (await readFile(path.join(base, name), "utf8"));
    for (const pattern of claudeOnly) assert.doesNotMatch(text, pattern, `${name} names a Claude Code-only tool; that rule belongs in claude/overlay.md`);
    const flat = text.replace(/\s+/g, " ");
    for (const rule of rules) assert.ok(!flat.includes(rule), `${name} repeats the Claude Code-only rule "${rule}"`);
  }
  await checkInstructionClaims(base, defaults);
  // Every mod config.json can name is in the marketplace the installer adds,
  // read from its own folder under claude/mods/.
  const marketplace = JSON.parse(await readFile(path.join(base, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "mexxi", "the installer installs mods as <mod>@mexxi");
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name).sort(), [...schema.properties.mods.items.enum].sort(), "config.schema.json's mods must match .claude-plugin/marketplace.json");
  for (const plugin of marketplace.plugins) {
    assert.equal(plugin.source, `./claude/mods/${plugin.name}`, `mod ${plugin.name} must be read from claude/mods/${plugin.name}`);
    const manifest = JSON.parse(await readFile(path.join(base, plugin.source, ".claude-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.name, plugin.name);
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
    for (const executable of ["scripts/ibni/ibni", "scripts/implementation-workspace"]) {
      assert.ok((await stat(path.join(base, executable))).mode & 0o111, `${executable} is not executable`);
    }
  }
  const pkg = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"));
  assert.equal(pkg.scripts.verify, "verifika --all", "npm run verify must run every Verifika check");
  assert.match(pkg.devDependencies?.verifika ?? "", /^\d+\.\d+\.\d+$/, "Verifika must be pinned to an exact version");
  const verifika = JSON.parse(await readFile(path.join(base, "verifika.config.json"), "utf8"));
  assert.ok((verifika.defaults?.concurrency ?? 1) === 1, "Verifika checks run sequentially until concurrency is shown to be safe");
  // A test file no check names would silently drop out of the delivery gate.
  const commands = Object.values(verifika.checks).map((entry) => entry.command);
  const tests = [
    ...(await readdir(path.join(base, "scripts"), { recursive: true })).filter((name) => name.endsWith(".test.mjs")).map((name) => `scripts/${name.split(path.sep).join("/")}`),
    ...(await readdir(path.join(base, "skills"), { recursive: true })).filter((name) => /\/tests\/[^/]+\.test\.m?js$/.test(name)).map((name) => `skills/${name.split(path.sep).join("/")}`),
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
