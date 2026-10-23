// A fake `claude` binary. Run as `node fake-host.mjs <fixture.jsonl> <report.json> [claude args...]`
// (the adapter factory's binArgs supply the first two). It waits for the first
// stdin line, replays the recording, pauses at each {"segwi_fixture":"await_input"}
// marker until another stdin line arrives, and exits when stdin closes. The report
// holds the arguments it got and every stdin line, so tests can inspect both.
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const [fixture, reportFile, ...args] = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2.1.309 (Claude Code)\n");
  process.exit(0);
}
const lines = readFileSync(fixture, "utf8").split("\n").filter((line) => line !== "");
const stdin = [];
const waiting = [];
let available = 0;
const segwiEnv = Object.keys(process.env).filter((key) => key.startsWith("SEGWI_"));
const report = () => writeFileSync(reportFile, JSON.stringify({ args, stdin, segwiEnv }));
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

await nextInput();
for (const line of lines) {
  let marker = null;
  try { marker = JSON.parse(line)?.segwi_fixture ?? null; } catch { /* a garbage line is replayed as is */ }
  if (marker === "await_input") await nextInput();
  else process.stdout.write(`${line}\n`);
}
