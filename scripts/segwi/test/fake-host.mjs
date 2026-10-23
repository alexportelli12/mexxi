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
const report = () => writeFileSync(reportFile, JSON.stringify({ args, stdin, segwiEnv, approverReplies }));
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
  const reply = JSON.parse((await client.callTool({ name: "approve", arguments: { tool_name, input, tool_use_id } })).content[0].text);
  await client.close();
  approverReplies.push(reply);
  report();
  const allowed = reply.behavior === "allow";
  const content = [{ type: "tool_result", tool_use_id, is_error: !allowed, content: allowed ? "(fake host) the call ran" : reply.message }];
  process.stdout.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
}

await nextInput();
for (const line of lines) {
  let marker = null;
  let parsed = null;
  try { parsed = JSON.parse(line); marker = parsed?.segwi_fixture ?? null; } catch { /* a garbage line is replayed as is */ }
  if (marker === "await_input") await nextInput();
  else if (marker === "approve") await askApprover(parsed);
  else process.stdout.write(`${line}\n`);
}
