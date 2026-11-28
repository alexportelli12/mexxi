// A fake `claude`: what fake-herdr's agent start runs in the tests that boot the
// whole server (helpers.mjs startHares). It writes the session's transcript the
// way Claude Code does, ~/.claude/projects/<cwd slug>/<session id>.jsonl under
// the test's HOME, so the session layer reads it as it would a real one, and a
// report of the arguments it was started with.
//
//   node fake-host.mjs <scenario.json> <report.json> --home <dir> --cwd <dir> --session <id> -- [claude args...]
//
// The scenario is a JSON array of steps after the first prompt (which is the last
// argument, as claude takes it):
//   {"say": "text"}                                  an assistant message
//   {"tool": "Bash", "input": {...}, "result": "..."} a tool call and its result
//   {"ask": [{question, header, options, multiSelect}]} an AskUserQuestion call, still open
// A step's strings may hold __FAKE_TOKEN__, replaced by $FAKE_HOST_TOKEN, so a test can seed
// a secret without a fixture ever holding one.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const [scenarioFile, reportFile, ...rest] = process.argv.slice(2);
const flag = (name) => rest[rest.indexOf(name) + 1];
const home = flag("--home");
const cwd = flag("--cwd");
const sessionId = flag("--session");
const args = rest.includes("--") ? rest.slice(rest.indexOf("--") + 1) : [];
if (args[0] === "--version") {
  process.stdout.write("2.1.332 (Claude Code)\n");
  process.exit(0);
}
const steps = JSON.parse(readFileSync(scenarioFile, "utf8").replaceAll("__FAKE_TOKEN__", process.env.FAKE_HOST_TOKEN ?? ""));
const dir = path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${sessionId}.jsonl`);
writeFileSync(reportFile, JSON.stringify({ args, cwd, sessionId, transcript: file }));

let clock = Date.parse("2026-11-28T10:00:00.000Z");
const line = (entry) => {
  clock += 1000;
  appendFileSync(file, `${JSON.stringify({ isSidechain: false, sessionId, cwd, timestamp: new Date(clock).toISOString(), ...entry })}\n`);
};
// claude's positional prompt is the last argument; flags and their values come before it.
const prompt = args.length && !args.at(-1).startsWith("-") && (args.length === 1 || !args.at(-2).startsWith("--")) ? args.at(-1) : null;
writeFileSync(file, "");
if (prompt) line({ type: "user", message: { role: "user", content: prompt } });
let n = 0;
for (const step of steps) {
  n += 1;
  if (step.say !== undefined) line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: step.say }] } });
  else if (step.tool) {
    const id = `toolu_fake_${n}`;
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: step.tool, input: step.input ?? {} }] } });
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: step.result ?? "" }] }, toolUseResult: { stdout: step.result ?? "", interrupted: false } });
  } else if (step.ask) {
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_fake_ask_${n}`, name: "AskUserQuestion", input: { questions: step.ask } }] } });
  }
}
