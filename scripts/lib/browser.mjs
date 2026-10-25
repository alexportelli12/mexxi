// The Playwright MCP server rendered QA drives, described once from config.json
// so every host registers the same package, version, browser and output
// directory. OpenCode's entry is rendered into its opencode.json; Claude Code
// and Codex keep MCP servers in files that belong to the user, so the installer
// prints the exact registration commands, never runs them, and `install --check`
// reads those files back to catch a version, browser or output directory that
// drifted.
//
// Hosts run the server with node from a copy the installer keeps, never
// through npx: npx's npm wrapper costs about 100 MiB in every session that
// has the server registered, and resolves the package again at each start.
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Where the installer keeps the pinned server, one folder per version.
export function playwrightMcpRoot(home = os.homedir()) {
  return path.join(home, ".local/share/mexxi/playwright-mcp");
}

export function playwrightMcpCli(browser, home = os.homedir()) {
  return path.join(playwrightMcpRoot(home), browser.playwrightMcpVersion, "node_modules/@playwright/mcp/cli.js");
}

// The version installed for browser, or null when it is missing.
export async function installedPlaywrightMcp(browser, home = os.homedir()) {
  const manifest = path.join(path.dirname(playwrightMcpCli(browser, home)), "package.json");
  const text = await readIfPresent(manifest);
  try {
    return text === null ? null : JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}

// --output-max-size is deliberately absent: it makes Playwright evict old files
// from the output directory, which is the worktree root by default.
// With no executablePath, the server would default to the Google Chrome
// channel; --browser=chromium (accepted, though --help omits it) selects
// Playwright's own Chromium instead, the same one the rendered-QA sweep
// launches, so one `install-browser chromium` serves both.
// npm installs one exact version into its own folder; nothing else is read.
export function npmInstall(directory, spec) {
  const result = spawnSync("npm", ["install", "--prefix", directory, "--no-audit", "--no-fund", "--no-save", spec], { encoding: "utf8", timeout: 300_000, shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm install ${spec} failed: ${(result.stderr || result.error?.message || "").trim().split("\n").slice(-3).join(" ")}`);
}

// Installs the pinned version when it is missing and removes the versions
// config.json no longer pins, except one a host registration still runs:
// Claude Code and Codex keep the old path until you register the new lines,
// so removing it first would break their browser at once. The folder belongs
// to the installer, like the generated directory, so nothing in it is anyone
// else's.
export async function installPlaywrightMcp(browser, { home = os.homedir(), install = npmInstall, keep = [] } = {}) {
  const root = playwrightMcpRoot(home);
  const installed = await installedPlaywrightMcp(browser, home) === browser.playwrightMcpVersion;
  if (!installed) {
    const directory = path.join(root, browser.playwrightMcpVersion);
    await mkdir(directory, { recursive: true });
    await install(directory, `@playwright/mcp@${browser.playwrightMcpVersion}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name !== browser.playwrightMcpVersion && !keep.includes(entry.name)) await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
  return { version: browser.playwrightMcpVersion, installed: !installed };
}

// The installed versions the hosts' own registrations run, read from the
// files registrationDrift already checks.
export async function registeredPlaywrightVersions({ hosts, claudeJson, codexConfig }) {
  const versions = [];
  for (const [host, inspect, file] of [["claude", claudePlaywrightArguments, claudeJson], ["codex", codexPlaywrightArguments, codexConfig]]) {
    if (!hosts[host]) continue;
    const found = await inspect(file);
    const version = found.status === "found" ? found.args[0]?.match(/playwright-mcp[\\/]([^\\/]+)[\\/]node_modules/)?.[1] : undefined;
    if (version) versions.push(version);
  }
  return versions;
}

// The arguments after `node`.
export function playwrightArguments(browser, home = os.homedir()) {
  return [
    playwrightMcpCli(browser, home),
    "--headless",
    "--isolated",
    ...(browser.executablePath === null ? ["--browser=chromium"] : [`--executable-path=${browser.executablePath}`]),
    `--output-dir=${browser.outputDir}`,
  ];
}

export function opencodePlaywright(browser, home = os.homedir()) {
  return { type: "local", command: ["node", ...playwrightArguments(browser, home)], enabled: true };
}

// The value of a --flag=value or --flag value argument, undefined when absent.
function flagValue(args, flag) {
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index === -1) return undefined;
  return args[index].includes("=") ? args[index].slice(flag.length + 1) : args[index + 1];
}

function shellQuote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

// The lines for hosts whose MCP registry is the user's own.
export function registrationCommands(browser, home = os.homedir()) {
  const server = ["node", ...playwrightArguments(browser, home)].map(shellQuote).join(" ");
  return {
    claude: `claude mcp add --scope user playwright -- ${server}`,
    codex: `codex mcp add playwright -- ${server}`,
  };
}

// Compares a registered server's arguments with config. Returns the reasons it
// does not match, empty when it does.
export function playwrightMismatches(command, args, browser, home = os.homedir()) {
  const problems = [];
  const viaNpx = args.map((arg) => arg.match(/^@playwright\/mcp(?:@(.+))?$/)).find(Boolean);
  if (viaNpx) {
    problems.push(`runs @playwright/mcp@${viaNpx[1] ?? "(unpinned)"} through ${command ?? "npx"}, config.json expects node ${playwrightMcpCli(browser, home)}`);
  } else if (command !== "node" || path.resolve(args[0] ?? "") !== playwrightMcpCli(browser, home)) {
    problems.push(`runs ${[command, args[0]].filter(Boolean).join(" ") || "(nothing)"}, config.json expects node ${playwrightMcpCli(browser, home)}`);
  }
  const outputDir = flagValue(args, "--output-dir");
  if (outputDir === undefined || path.resolve(outputDir) !== browser.outputDir) {
    problems.push(`writes to ${outputDir ?? "(no --output-dir)"}, config.json expects ${browser.outputDir}`);
  }
  const executablePath = flagValue(args, "--executable-path");
  if ((executablePath === undefined ? null : path.resolve(executablePath)) !== browser.executablePath) {
    problems.push(`drives ${executablePath ?? "no --executable-path"}, config.json expects ${browser.executablePath ?? "none"}`);
  }
  const browserName = flagValue(args, "--browser");
  const expectedBrowser = browser.executablePath === null ? "chromium" : undefined;
  if (browserName !== expectedBrowser) {
    problems.push(`passes ${browserName === undefined ? "no --browser" : `--browser ${browserName}`}, config.json expects ${expectedBrowser === undefined ? "none" : `--browser ${expectedBrowser}`}`);
  }
  // It would also let the browser open any file:// path on the machine.
  if (args.includes("--allow-unrestricted-file-access")) problems.push("passes --allow-unrestricted-file-access");
  return problems;
}

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Claude Code keeps user-scope servers under mcpServers in ~/.claude.json.
export async function claudePlaywrightArguments(file) {
  const text = await readIfPresent(file);
  if (text === null) return { status: "missing", detail: `${file} does not exist` };
  let server;
  try {
    server = JSON.parse(text).mcpServers?.playwright;
  } catch (error) {
    return { status: "unreadable", detail: `${file} is not valid JSON: ${error.message}` };
  }
  if (!server) return { status: "unregistered", detail: `${file} has no user-scope playwright server` };
  return { status: "found", command: server.command ?? null, args: server.args ?? [] };
}

// Codex keeps them in [mcp_servers.playwright] of config.toml. There is no TOML
// parser to hand, so this reads only the one array it needs; JSON string
// syntax is also valid for TOML basic strings.
export async function codexPlaywrightArguments(file) {
  const text = await readIfPresent(file);
  if (text === null) return { status: "missing", detail: `${file} does not exist` };
  const header = text.match(/^\[mcp_servers\.(?:playwright|"playwright")\][ \t]*$/m);
  if (!header) return { status: "unregistered", detail: `${file} has no [mcp_servers.playwright] table` };
  const rest = text.slice(header.index + header[0].length);
  const section = rest.slice(0, rest.search(/^\[/m) === -1 ? undefined : rest.search(/^\[/m));
  const array = section.match(/^args\s*=\s*(\[[\s\S]*?\])\s*(?:#.*)?$/m);
  const command = section.match(/^command\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/m);
  try {
    if (!array) throw new Error("no args array");
    return { status: "found", command: command ? JSON.parse(command[1]) : null, args: JSON.parse(array[1].replace(/,\s*\]$/, "]")) };
  } catch {
    return { status: "unreadable", detail: `could not read args of [mcp_servers.playwright] in ${file}` };
  }
}

// Problems per enabled host whose registration is not exactly what config.json
// asks for. Unregistered fails: with the host enabled, rendered QA cannot run
// there, which is as incomplete as a missing link. The fix is the printed line.
export async function registrationDrift({ browser, hosts, claudeJson, codexConfig, home = os.homedir() }) {
  const commands = registrationCommands(browser, home);
  const removals = { claude: "claude mcp remove --scope user playwright", codex: "codex mcp remove playwright" };
  const drift = [];
  if (Object.values(hosts).some(Boolean) && await installedPlaywrightMcp(browser, home) !== browser.playwrightMcpVersion) {
    drift.push(`Playwright MCP ${browser.playwrightMcpVersion} is not installed in ${path.join(playwrightMcpRoot(home), browser.playwrightMcpVersion)}; run node scripts/install.mjs`);
  }
  for (const [host, inspect, file] of [
    ["claude", claudePlaywrightArguments, claudeJson],
    ["codex", codexPlaywrightArguments, codexConfig],
  ]) {
    if (!hosts[host]) continue;
    const found = await inspect(file);
    if (found.status === "found") {
      for (const problem of playwrightMismatches(found.command, found.args, browser, home)) {
        drift.push(`${host}: Playwright MCP ${problem}; run ${removals[host]}, then ${commands[host]}`);
      }
    } else {
      drift.push(`${host}: Playwright MCP ${found.status === "unreadable" ? "unreadable" : "not registered"} (${found.detail}); run: ${commands[host]}`);
    }
  }
  return drift;
}
