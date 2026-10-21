#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abbreviateHome, configPath, loadConfig, minimalConfig } from "./lib/config.mjs";
import { codexCommandSkill, renderDrift, renderHostFiles, writeRendered } from "./lib/render.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const postMergeHook = `#!/bin/sh
# coding-agent-config: managed by scripts/install.mjs
root="$(git rev-parse --show-toplevel)" || exit 0
exec node "$root/scripts/install.mjs" --after-merge
`;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function installationWorktree() {
  const primary = git(["rev-parse", "--absolute-git-dir"]) ===
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return primary && git(["branch", "--show-current"]) === "main";
}

function hookDirectory() {
  let custom = "";
  try {
    custom = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (custom) throw new Error("custom core.hooksPath is configured; integrate the post-merge hook deliberately");
  return path.join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hooks");
}
export function generatedDirectory(home = os.homedir()) {
  return path.join(home, ".local/share/mexxi/generated");
}

function within(target, base) {
  return target === base || target.startsWith(`${base}${path.sep}`);
}

// Each entry is [destination, source, host]; "shared" entries install whatever
// hosts are enabled. Host adapters come from the rendered copy in `generated`.
export async function links({
  home = os.homedir(),
  opencode = path.join(home, ".config/opencode"),
  claude = path.join(home, ".claude"),
  codex = path.join(home, ".codex"),
  codexSkills = path.join(home, ".agents/skills"),
  bin = path.join(home, ".local/bin"),
  checkout = root,
  generated = generatedDirectory(home),
  hosts = { opencode: true, claude: true, codex: true },
} = {}) {
  const entries = [
    [path.join(opencode, "opencode.json"), path.join(generated, "opencode/opencode.json"), "opencode"],
    [path.join(opencode, "AGENTS.md"), path.join(checkout, "AGENTS.md"), "opencode"],
    [path.join(opencode, "commands"), path.join(checkout, "commands"), "opencode"],
    [path.join(opencode, "skills"), path.join(checkout, "skills"), "opencode"],
    [path.join(opencode, "agent"), path.join(checkout, "agent"), "opencode"],
    [path.join(claude, "CLAUDE.md"), path.join(checkout, "AGENTS.md"), "claude"],
    [path.join(claude, "commands"), path.join(checkout, "commands"), "claude"],
    [path.join(codex, "AGENTS.md"), path.join(checkout, "AGENTS.md"), "codex"],
  ];
  const skillNames = (await readdir(path.join(checkout, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "synced")
    .map((entry) => entry.name);
  for (const name of skillNames) {
    try {
      await access(path.join(checkout, "skills", name, "SKILL.md"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    entries.push([path.join(claude, "skills", name), path.join(checkout, "skills", name), "claude"]);
    entries.push([path.join(codexSkills, name), path.join(checkout, "skills", name), "codex"]);
  }
  // Verifika's agent skill ships with the pinned npm package, so hosts track
  // the installed CLI version instead of a copy maintained here.
  const verifikaSkill = path.join(checkout, "node_modules/verifika/skills/verifika");
  entries.push([path.join(claude, "skills", "verifika"), verifikaSkill, "claude"]);
  entries.push([path.join(codexSkills, "verifika"), verifikaSkill, "codex"]);
  for (const name of Object.keys(JSON.parse(await readFile(path.join(checkout, "claude/agents.json"), "utf8")))) {
    entries.push([path.join(claude, "agents", `${name}.md`), path.join(generated, "claude/agents", `${name}.md`), "claude"]);
  }
  // implementation-workspace is ibni's one-release alias; it keeps its old
  // source path so links earlier installs made stay valid.
  for (const executable of ["ibni/ibni", "implementation-workspace"]) {
    const source = path.join(checkout, "scripts", process.platform === "win32" ? `${executable}.cmd` : executable);
    entries.push([path.join(bin, path.basename(source)), source, "shared"]);
  }
  for (const name of Object.keys(JSON.parse(await readFile(path.join(checkout, "codex/agents.json"), "utf8")))) {
    entries.push([path.join(codex, "agents", `${name}.toml`), path.join(generated, "codex/agents", `${name}.toml`), "codex"]);
  }
  for (const file of (await readdir(path.join(checkout, "commands"))).filter((name) => name.endsWith(".md"))) {
    const name = codexCommandSkill(file);
    entries.push([path.join(codexSkills, name), path.join(generated, "codex/skills", name), "codex"]);
  }
  return entries.filter(([, , host]) => host === "shared" || hosts[host]);
}

// Host adapters are linked individually, so removing one from the checkout
// leaves a dangling link behind. Only links that point into this checkout or
// the generated directory are ours; anything else in these directories belongs
// to the user. When migrating, links into the old checkout are ours too, and
// any of them the new installation does not recreate is retired.
export async function staleLinks({
  home = os.homedir(),
  claude = path.join(home, ".claude"),
  codex = path.join(home, ".codex"),
  codexSkills = path.join(home, ".agents/skills"),
  bin = path.join(home, ".local/bin"),
  checkout = root,
  generated = generatedDirectory(home),
  migrateFrom = null,
  expected = new Set(),
  rendered = null,
} = {}) {
  const owned = [path.resolve(checkout), path.resolve(generated)];
  // A link into the generated directory is judged against the fresh render,
  // since the files on disk are only replaced after every check has passed.
  const generatedBase = path.resolve(generated);
  const stillRendered = (target) => {
    const relative = path.relative(generatedBase, target).split(path.sep).join("/");
    return [...rendered.keys()].some((name) => name === relative || name.startsWith(`${relative}/`));
  };
  const stale = [];
  // ~/.local/bin is shared with the user's own tools, so only the retired
  // verify-runner is considered there: the link we created, or on Windows the
  // wrapper we generated, while its content is exactly what we wrote.
  for (const installed of [checkout, migrateFrom].filter(Boolean)) {
    const retiredLink = path.join(bin, "verify-runner");
    try {
      if (path.resolve(bin, await readlink(retiredLink)) === path.join(installed, "scripts", "verify-runner")) stale.push(retiredLink);
    } catch (error) {
      if (!["ENOENT", "EINVAL", "UNKNOWN"].includes(error.code)) throw error;
    }
    const retiredWrapper = path.join(bin, "verify-runner.cmd");
    try {
      if (await readFile(retiredWrapper, "utf8") === windowsWrapper(path.join(installed, "scripts", "verify.mjs"))) stale.push(retiredWrapper);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  for (const directory of [path.join(claude, "agents"), path.join(claude, "skills"), path.join(codex, "agents"), codexSkills]) {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      const link = path.join(directory, name);
      if (!(await lstat(link)).isSymbolicLink()) continue;
      const target = path.resolve(directory, await readlink(link));
      if (migrateFrom && within(target, path.resolve(migrateFrom))) {
        if (!expected.has(link)) stale.push(link);
        continue;
      }
      if (!owned.some((base) => target.startsWith(`${base}${path.sep}`))) continue;
      if (rendered && target.startsWith(`${generatedBase}${path.sep}`)) {
        if (!stillRendered(target)) stale.push(link);
        continue;
      }
      try {
        await access(target);
      } catch (error) {
        if (error.code === "ENOENT") stale.push(link);
        else throw error;
      }
    }
  }
  return stale;
}

// Reads config.json and refuses to install from any clone but the one it
// names, so a stray clone (or the old checkout's post-merge hook during the
// move) can never repoint the hosts.
async function installationConfig({ home, checkout, configFile }) {
  const { config, exists } = await loadConfig({ file: configFile, home });
  if (config.paths.checkout !== checkout) {
    const fix = exists
      ? `set paths.checkout in ${configFile}`
      : `create ${configFile} containing {"paths": {"checkout": "${abbreviateHome(checkout, home)}"}}`;
    throw new Error(`config.json expects the mexxi clone at ${config.paths.checkout}, not ${checkout}; ${fix}, or run the installer from that clone`);
  }
  return { config, exists };
}

export async function install(options = {}) {
  const home = options.home ?? os.homedir();
  const checkout = path.resolve(options.checkout ?? root);
  const configFile = options.configFile ?? path.join(home, ".config/mexxi/config.json");
  const generated = options.generated ?? generatedDirectory(home);
  const migrateFrom = options.migrateFrom ? path.resolve(options.migrateFrom) : null;
  if (migrateFrom && within(checkout, migrateFrom)) throw new Error("--migrate-from must name the old checkout, not this one");
  const { config, exists } = await installationConfig({ home, checkout, configFile });
  const rendered = await renderHostFiles({ checkout, config });
  const linkOptions = { ...options, home, checkout, generated, hosts: config.hosts };
  const entries = await links(linkOptions);
  const stale = await staleLinks({ ...linkOptions, migrateFrom, rendered, expected: new Set(entries.map(([destination]) => destination)) });
  const pending = [];
  const relinks = [];
  const conflicts = [];
  const hook = options.hookDirectory ? path.join(options.hookDirectory, "post-merge") : null;
  for (const [destination, source] of entries) {
    // Rendered sources are written below, after every conflict is known.
    if (!within(source, generated)) {
      await access(source).catch((error) => {
        if (error.code === "ENOENT" && source.includes(`${path.sep}node_modules${path.sep}`)) {
          throw new Error(`${source} is missing; run npm ci in the configuration checkout first`);
        }
        throw error;
      });
    }
    const previous = migrateFrom ? path.join(migrateFrom, path.relative(checkout, source)) : null;
    try {
      const info = await lstat(destination);
      if (path.resolve(destination) === path.resolve(source)) continue;
      if (process.platform === "win32" && destination.endsWith(".cmd")) {
        const content = await readFile(destination, "utf8");
        if (content === windowsWrapper(source.replace(/\.cmd$/, ".mjs"))) continue;
        if (previous && content === windowsWrapper(previous.replace(/\.cmd$/, ".mjs"))) relinks.push([destination, source]);
        else conflicts.push(destination);
      } else if (!info.isSymbolicLink()) {
        conflicts.push(destination);
      } else {
        const target = path.resolve(path.dirname(destination), await readlink(destination));
        if (target === source) continue;
        if (migrateFrom && within(target, migrateFrom)) relinks.push([destination, source]);
        else conflicts.push(`${destination} (links to ${target})`);
      }
    } catch (error) {
      if (error.code === "ENOENT") pending.push([destination, source]);
      else throw error;
    }
  }
  if (hook) {
    try {
      const info = await lstat(hook);
      if (!info.isFile() || await readFile(hook, "utf8") !== postMergeHook) conflicts.push(hook);
      else if (!(info.mode & 0o111)) conflicts.push(hook);
    } catch (error) {
      if (error.code === "ENOENT") pending.push([hook, null]);
      else throw error;
    }
  }
  if (conflicts.length) throw new Error(`existing configuration differs; no changes made:\n${conflicts.join("\n")}`);
  const drift = await renderDrift(generated, rendered);
  if (options.check) {
    const incomplete = [
      ...(exists ? [] : [`${configFile} (missing)`]),
      ...drift,
      ...pending.map(([destination]) => destination),
      ...relinks.map(([destination]) => `${destination} (points into the old checkout)`),
      ...stale.map((link) => `${link} (stale)`),
    ];
    if (incomplete.length) throw new Error(`setup incomplete:\n${incomplete.join("\n")}`);
    return { created: 0, relinked: 0, removed: 0, rendered: 0, checked: entries.length };
  }
  if (!exists) {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `${JSON.stringify(minimalConfig({ checkout, home }), null, 2)}\n`, { flag: "wx" });
  }
  await writeRendered(generated, rendered);
  for (const link of stale) await unlink(link);
  for (const [destination, source] of [...relinks, ...pending]) {
    await mkdir(path.dirname(destination), { recursive: true });
    if (destination === hook) {
      await writeFile(destination, postMergeHook, { flag: "wx", mode: 0o755 });
      await chmod(destination, 0o755);
    } else if (process.platform === "win32" && destination.endsWith(".cmd")) {
      await writeFile(destination, windowsWrapper(source.replace(/\.cmd$/, ".mjs")));
    } else {
      if (relinks.some(([relinked]) => relinked === destination)) await unlink(destination);
      await symlink(source, destination, process.platform === "win32" && !source.endsWith(".md") && !source.endsWith(".json") && !source.endsWith(".toml") ? "junction" : undefined);
    }
  }
  return { created: pending.length, relinked: relinks.length, removed: stale.length, rendered: drift.length, checked: entries.length };
}

function windowsWrapper(module) {
  // A symlinked .cmd sees the link's directory as %~dp0, not the script's.
  return `@echo off\r\nnode "${module}" %*\r\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!installationWorktree()) {
      if (process.argv.includes("--after-merge")) process.exit(0);
      throw new Error("install only from the primary configuration checkout on main; never link an unmerged feature worktree");
    }
    const bin = path.join(os.homedir(), ".local/bin");
    if (!(process.env.PATH || "").split(path.delimiter).some((entry) => path.resolve(entry) === bin)) {
      throw new Error(`${bin} is not on PATH; add it to your shell/CI environment before installing`);
    }
    const migrateIndex = process.argv.indexOf("--migrate-from");
    const migrateFrom = migrateIndex === -1 ? undefined : process.argv[migrateIndex + 1];
    if (migrateIndex !== -1 && (!migrateFrom || migrateFrom.startsWith("--"))) throw new Error("--migrate-from needs the old checkout's path");
    const result = await install({
      check: process.argv.includes("--check"), hookDirectory: hookDirectory(),
      codex: process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : undefined,
      configFile: configPath(), migrateFrom,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
