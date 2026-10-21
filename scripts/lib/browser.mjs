// The Playwright MCP server rendered QA drives, described once from config.json
// so every host registers the same package, version, browser and output
// directory. OpenCode's entry is rendered into its opencode.json; Claude Code
// and Codex keep MCP servers in files that belong to the user, so the installer
// prints the exact registration commands, never runs them, and `install --check`
// reads those files back to catch a version or output directory that drifted.
import { readFile } from "node:fs/promises";
import path from "node:path";

// --output-max-size is deliberately absent: it makes Playwright evict old files
// from the output directory, which is the worktree root by default.
export function playwrightArguments(browser) {
  return [
    `@playwright/mcp@${browser.playwrightMcpVersion}`,
    "--headless",
    "--isolated",
    `--executable-path=${browser.executablePath}`,
    `--output-dir=${browser.outputDir}`,
  ];
}

export function opencodePlaywright(browser) {
  return { type: "local", command: ["npx", "-y", ...playwrightArguments(browser)], enabled: true };
}

function shellQuote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

// The lines for hosts whose MCP registry is the user's own.
export function registrationCommands(browser) {
  const server = ["npx", "-y", ...playwrightArguments(browser)].map(shellQuote).join(" ");
  return {
    claude: `claude mcp add --scope user playwright -- ${server}`,
    codex: `codex mcp add playwright -- ${server}`,
  };
}

// Compares a registered server's arguments with config. Returns the reasons it
// does not match, empty when it does.
export function playwrightMismatches(args, browser) {
  const problems = [];
  const version = args.map((arg) => arg.match(/^@playwright\/mcp@(.+)$/)?.[1]).find(Boolean);
  if (version !== browser.playwrightMcpVersion) {
    problems.push(`runs @playwright/mcp@${version ?? "(unpinned)"}, config.json pins ${browser.playwrightMcpVersion}`);
  }
  const index = args.findIndex((arg) => arg === "--output-dir" || arg.startsWith("--output-dir="));
  const outputDir = index === -1 ? undefined
    : args[index].includes("=") ? args[index].slice("--output-dir=".length) : args[index + 1];
  if (outputDir === undefined || path.resolve(outputDir) !== browser.outputDir) {
    problems.push(`writes to ${outputDir ?? "(no --output-dir)"}, config.json expects ${browser.outputDir}`);
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
  return { status: "found", args: server.args ?? [] };
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
  try {
    if (!array) throw new Error("no args array");
    return { status: "found", args: JSON.parse(array[1].replace(/,\s*\]$/, "]")) };
  } catch {
    return { status: "unreadable", detail: `could not read args of [mcp_servers.playwright] in ${file}` };
  }
}

// Problems per enabled host whose registration is not exactly what config.json
// asks for. Unregistered fails: with the host enabled, rendered QA cannot run
// there, which is as incomplete as a missing link. The fix is the printed line.
export async function registrationDrift({ browser, hosts, claudeJson, codexConfig }) {
  const commands = registrationCommands(browser);
  const removals = { claude: "claude mcp remove --scope user playwright", codex: "codex mcp remove playwright" };
  const drift = [];
  for (const [host, inspect, file] of [
    ["claude", claudePlaywrightArguments, claudeJson],
    ["codex", codexPlaywrightArguments, codexConfig],
  ]) {
    if (!hosts[host]) continue;
    const found = await inspect(file);
    if (found.status === "found") {
      for (const problem of playwrightMismatches(found.args, browser)) {
        drift.push(`${host}: Playwright MCP ${problem}; run ${removals[host]}, then ${commands[host]}`);
      }
    } else {
      drift.push(`${host}: Playwright MCP ${found.status === "unreadable" ? "unreadable" : "not registered"} (${found.detail}); run: ${commands[host]}`);
    }
  }
  return drift;
}
