// A fake `claude` binary. Run as `node fake-host.mjs <fixture.jsonl> <report.json> [claude args...]`
// (the adapter factory's binArgs supply the first two). It waits for the first
// stdin line, replays the recording, pauses at each {"segwi_fixture":"await_input"}
// marker until another stdin line arrives, and exits when stdin closes. The report
// holds the arguments it got and every stdin line, so tests can inspect both.
//
// A recording can also hold {"segwi_fixture":"approve","tool_name":..,"input":..,"tool_use_id":..}.
// There the fake host does what Claude Code does for a call outside the allow list: it starts
// the `segwi` MCP server from the --mcp-config file as a stdio client, calls the `approve`
// tool, and writes the outcome to stdout as a tool_result (an error result for a denial).
// The approver's replies are kept in the report.
//
// {"segwi_fixture":"spawn_grandchild"} starts a child that ignores SIGINT and SIGTERM and would
// outlive a kill of the host alone, the way an MCP server or a background shell can. Its pid is in
// the report, so a test can check that a stop ended it.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [fixture, reportFile, ...args] = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2.1.309 (Claude Code)\n");
  process.exit(0);
}
// A recording never holds a token-shaped value; __FAKE_TOKEN__ becomes $FAKE_HOST_TOKEN, so a test can seed one.
const lines = readFileSync(fixture, "utf8").replaceAll("__FAKE_TOKEN__", process.env.FAKE_HOST_TOKEN ?? "").split("\n").filter((line) => line !== "");
const stdin = [];
const waiting = [];
let available = 0;
const segwiEnv = Object.keys(process.env).filter((key) => key.startsWith("SEGWI_"));
const approverReplies = [];
let grandchild = null;
// Real Claude Code waits for MCP_TOOL_TIMEOUT (segwi sets it per run), not for the MCP SDK's 60 s default.
const toolTimeout = Number(process.env.MCP_TOOL_TIMEOUT) > 0 ? Number(process.env.MCP_TOOL_TIMEOUT) : 2 * 60 * 60_000;
const report = () => writeFileSync(reportFile, JSON.stringify({
  args, stdin, segwiEnv, approverReplies, grandchild,
  cwd: process.cwd(), launchCheckout: process.env.IBNI_LAUNCH_CHECKOUT ?? null, npmCache: process.env.npm_config_cache ?? null,
  gitHooksPath: process.env.GIT_CONFIG_KEY_0 === "core.hooksPath" ? process.env.GIT_CONFIG_VALUE_0 : null,
  lockRoot: process.env.IBNI_LOCK_ROOT ?? null, skipSweep: process.env.IBNI_SKIP_SWEEP ?? null, branchPrefixes: process.env.IBNI_BRANCH_PREFIXES ?? null,
  gitConfig: { count: process.env.GIT_CONFIG_COUNT, first: [process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0], second: [process.env.GIT_CONFIG_KEY_1, process.env.GIT_CONFIG_VALUE_1] },
}));
report();

function nextInput() {
  if (available > 0) { available -= 1; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}

const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  stdin.push(line);
  report();
  if (waiting.length) waiting.shift()();
  else available += 1;
});
reader.on("close", () => process.exit(0));

async function askApprover({ tool_name, input, tool_use_id }) {
  const { command, args: serverArgs, env } = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.segwi;
  const client = new Client({ name: "fake-claude-code", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args: serverArgs, env: { ...getDefaultEnvironment(), ...env } }));
  const reply = JSON.parse((await client.callTool({ name: "approve", arguments: { tool_name, input, tool_use_id } }, undefined, { timeout: toolTimeout })).content[0].text);
  await client.close();
  approverReplies.push(reply);
  report();
  const allowed = reply.behavior === "allow";
  const content = [{ type: "tool_result", tool_use_id, is_error: !allowed, content: allowed ? "(fake host) the call ran" : reply.message }];
  process.stdout.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
}

function spawnGrandchild() {
  const script = "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n');";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve) => child.stdout.once("data", () => {
    grandchild = child.pid;
    report();
    resolve();
  }));
}

await nextInput();
for (const line of lines) {
  let marker = null;
  let parsed = null;
  try { parsed = JSON.parse(line); marker = parsed?.segwi_fixture ?? null; } catch { /* a garbage line is replayed as is */ }
  if (marker === "await_input") await nextInput();
  else if (marker === "approve") await askApprover(parsed);
  else if (marker === "spawn_grandchild") await spawnGrandchild();
  else process.stdout.write(`${line}\n`);
}
