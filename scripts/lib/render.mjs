// Renders every host adapter from the shared sources plus config.json. The
// installer writes the result to ~/.local/share/mexxi/generated/ and links the
// hosts to it; `install --check` and `npm run verify` render again and compare,
// so nothing generated is committed and nothing generated can go stale unseen.
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { opencodePlaywright } from "./browser.mjs";

// Shared agents and the models.<host> role that sets each one's model.
export const agentRoles = { "ui-designer": "uiDesigner", "code-reviewer": "reviewer" };
// OpenCode built-in agents whose model config.json may also set.
const opencodeBuiltinRoles = { general: "general", explore: "explore" };
// Retained workspaces under these earlier roots stay reachable until their
// last one is swept; then this list and its permission entries go.
export const legacyWorktreeRoots = [
  "~/.local/share/opencode/implementation-worktrees",
  "~/.local/share/coding-agent/implementation-worktrees",
];

function agentName(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent name: ${name}`);
  return name;
}

async function sharedAgentBody(checkout, name) {
  const body = await readFile(path.join(checkout, "agent", `${name}.md`), "utf8");
  if (body.startsWith("---")) throw new Error(`host frontmatter in shared agent: ${name}`);
  return body;
}

// Claude Code's cross-family reviewer is a Codex model run by `ibni cross-review`
// (the subagent keeps the reviewer model), so only the other hosts render it as
// the code-reviewer's own model; null falls back to the reviewer's model.
function modelFor(models, name, { crossFamily = false } = {}) {
  if (name === "code-reviewer" && crossFamily && models.crossFamilyReviewer) return models.crossFamilyReviewer;
  return agentRoles[name] ? models[agentRoles[name]] ?? null : null;
}

// Claude Code reads one instruction file, so it gets the shared AGENTS.md
// followed by the rules only its tools need (claude/overlay.md). Rendering the
// whole file avoids depending on how @imports resolve through a symlink.
export async function claudeInstructions(checkout) {
  const shared = await readFile(path.join(checkout, "AGENTS.md"), "utf8");
  const overlay = await readFile(path.join(checkout, "claude/overlay.md"), "utf8");
  return `${shared.trimEnd()}\n\n${overlay.trimEnd()}\n`;
}

async function renderClaude(checkout, config, files) {
  files.set("claude/CLAUDE.md", await claudeInstructions(checkout));
  const metadata = JSON.parse(await readFile(path.join(checkout, "claude/agents.json"), "utf8"));
  for (const [name, fields] of Object.entries(metadata)) {
    const body = await sharedAgentBody(checkout, agentName(name));
    const header = ["---", `name: ${name}`];
    const model = modelFor(config.models.claude, name);
    for (const [key, value] of Object.entries({ ...fields, ...(model ? { model } : {}) })) {
      if (typeof value !== "string" || value.includes("\n")) throw new Error(`invalid ${name}.${key}`);
      header.push(`${key}: ${JSON.stringify(value)}`);
    }
    files.set(`claude/agents/${name}.md`, `${header.join("\n")}\n---\n\n${body}`);
  }
}

// Renamed commands keep their old name for one release: the old file in
// commands/ is a thin alias that runs the new one. Maps old file to new name.
export const commandAliases = {
  "implement.md": "wettaq",
  "qa.md": "ittestja",
  "update-my-workflow.md": "sewwi",
  "ux.principles.md": "fassal",
};

// Codex has no slash commands, so each command becomes an explicitly invoked
// skill. An alias keeps the `workflow-` wrapper name Codex users typed before.
export function codexCommandSkill(file) {
  const prefix = file in commandAliases ? "workflow" : "mexxi";
  const name = `${prefix}-${file.slice(0, -3).replaceAll(".", "-")}`;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid command skill name: ${name}`);
  return name;
}

async function renderCodex(checkout, config, files) {
  const metadata = JSON.parse(await readFile(path.join(checkout, "codex/agents.json"), "utf8"));
  for (const [name, fields] of Object.entries(metadata)) {
    const body = await sharedAgentBody(checkout, agentName(name));
    const lines = [`name = ${JSON.stringify(name)}`];
    const model = modelFor(config.models.codex, name, { crossFamily: true });
    for (const [key, value] of Object.entries({ ...fields, ...(model ? { model } : {}) })) {
      if (!["description", "sandbox_mode", "model", "model_reasoning_effort"].includes(key) ||
          typeof value !== "string" || value.includes("\n")) throw new Error(`invalid ${name}.${key}`);
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
    // JSON string escaping is also valid for these TOML basic strings.
    lines.push(`developer_instructions = ${JSON.stringify(body)}`);
    files.set(`codex/agents/${name}.toml`, `${lines.join("\n")}\n`);
  }
  for (const file of (await readdir(path.join(checkout, "commands"))).sort()) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(path.join(checkout, "commands", file), "utf8");
    const match = text.match(/^---\ndescription: ([^\n]+)\n---\n/);
    if (!match) throw new Error(`invalid command header: ${file}`);
    const name = codexCommandSkill(file);
    const body = text.slice(match[0].length);
    const binding = "In this Codex command adapter, `$ARGUMENTS` means the request supplied with\nthis skill invocation. If no request was supplied, treat it as empty.\n";
    files.set(`codex/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${JSON.stringify(match[1])}\n---\n\n${binding}${body}`);
    files.set(`codex/skills/${name}/agents/openai.yaml`, "policy:\n  allow_implicit_invocation: false\n");
  }
}

async function renderOpencode(checkout, config, files) {
  const template = JSON.parse(await readFile(path.join(checkout, "opencode/opencode.json"), "utf8"));
  const agent = structuredClone(template.agent ?? {});
  const models = config.models.opencode;
  for (const [name, role] of Object.entries(opencodeBuiltinRoles)) {
    if (models[role]) agent[name] = { model: models[role], ...agent[name] };
  }
  for (const name of Object.keys(agentRoles)) {
    if (!agent[name]) continue;
    // An absolute prompt path works whether or not OpenCode resolves the
    // opencode.json symlink before reading {file:} references.
    const prompt = `{file:${path.join(checkout, "agent", `${name}.md`)}}`;
    const { description, mode, ...rest } = agent[name];
    agent[name] = { description, mode, ...(modelFor(models, name, { crossFamily: true }) ? { model: modelFor(models, name, { crossFamily: true }) } : {}), prompt, ...rest };
  }
  const worktreeRoots = [config.paths.worktreeRoot, ...legacyWorktreeRoots];
  const permission = {
    ...template.permission,
    external_directory: Object.fromEntries([...new Set(worktreeRoots)].map((root) => [`${root}/**`, "allow"])),
  };
  // The shared guard and loop breaker run in OpenCode through this plugin,
  // loaded from the clone so its imports of scripts/hooks resolve.
  const plugin = [...(template.plugin ?? []), pathToFileURL(path.join(checkout, "opencode/plugins/mexxi-guard.js")).href];
  const rendered = { $schema: template.$schema, plugin, agent, permission, mcp: { playwright: opencodePlaywright(config.browser) } };
  files.set("opencode/opencode.json", `${JSON.stringify(rendered, null, 2)}\n`);
}

// Returns Map<relative path, content> for the generated directory.
export async function renderHostFiles({ checkout, config }) {
  const files = new Map();
  await renderOpencode(checkout, config, files);
  await renderClaude(checkout, config, files);
  await renderCodex(checkout, config, files);
  return files;
}

async function listFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    files.push(...(entry.isDirectory() ? await listFiles(directory, file) : [file]));
  }
  return files;
}

// Every difference between the generated directory and a fresh render: a
// hand edit, a stale render, a missing file or one the render no longer makes.
export async function renderDrift(directory, files) {
  const drift = [];
  for (const [name, content] of files) {
    const current = await readFile(path.join(directory, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === null) drift.push(`${path.join(directory, name)} (missing)`);
    else if (current !== content) drift.push(`${path.join(directory, name)} (differs from config.json and the current clone)`);
  }
  for (const name of await listFiles(directory)) {
    if (!files.has(name)) drift.push(`${path.join(directory, name)} (no longer generated)`);
  }
  return drift;
}

async function pruneEmptyDirectories(directory, relative) {
  for (let current = path.dirname(relative); current !== "."; current = path.dirname(current)) {
    const absolute = path.join(directory, current);
    if ((await readdir(absolute)).length) return;
    await rmdir(absolute);
  }
}

// The generated directory belongs to mexxi alone, so it is replaced outright.
// Emptied directories go too, so a link to a retired one dangles and the
// installer's stale-link sweep removes it.
export async function writeRendered(directory, files) {
  for (const name of await listFiles(directory)) {
    if (files.has(name)) continue;
    await rm(path.join(directory, name));
    await pruneEmptyDirectories(directory, name);
  }
  for (const [name, content] of files) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
}
