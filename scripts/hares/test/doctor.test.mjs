// `hares doctor`: read-only checks that herdr speaks the pinned protocol, the hook
// is installed and Claude Code is a tested version. A fake herdr and a temp HOME;
// nothing here sends anything to a pane or writes a file.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkClaude, checkHerdr, checkHook, runDoctor, runDoctorCommand, TESTED_CLAUDE_VERSIONS } from "../lib/doctor.mjs";
import { startFakeHerdr } from "./fake-herdr.mjs";
import { tempDir } from "./helpers.mjs";

const hookCommand = "node '/home/me/mexxi/scripts/hares/hook.mjs'";
function settingsWith(home, hooks) {
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks }));
}
const group = (matcher) => [{ matcher, hooks: [{ type: "command", command: hookCommand, timeout: 5 }] }];

test("herdr on protocol 22 passes, another protocol or no socket fails, and only ping is sent", async (t) => {
  const good = await startFakeHerdr(t);
  assert.equal((await checkHerdr({ socket: good.socket })).ok, true);
  assert.deepEqual(good.requests.map((entry) => entry.method), ["ping"]);
  const newer = await startFakeHerdr(t, { protocol: 23 });
  const mismatch = await checkHerdr({ socket: newer.socket });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.detail, /protocol 23/);
  assert.equal((await checkHerdr({ socket: path.join(tempDir(t), "none.sock") })).ok, false);
});

test("the hook counts as installed only when it runs on both PreToolUse and PermissionRequest", (t) => {
  const home = tempDir(t);
  assert.equal(checkHook({ home }).ok, false, "no settings file");
  settingsWith(home, { PreToolUse: group("AskUserQuestion|ExitPlanMode|REPL") });
  const half = checkHook({ home });
  assert.equal(half.ok, false);
  assert.match(half.detail, /PermissionRequest/);
  settingsWith(home, { PreToolUse: group("AskUserQuestion|ExitPlanMode|REPL"), PermissionRequest: group("*") });
  assert.equal(checkHook({ home }).ok, true);
  settingsWith(home, { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node other.mjs" }] }], PermissionRequest: group("*") });
  assert.equal(checkHook({ home }).ok, false, "another hook on the event is not ours");
});

test("a Claude Code version outside the tested list, or none at all, fails with the version named", async () => {
  assert.equal((await checkClaude({ run: async () => `${TESTED_CLAUDE_VERSIONS[0]} (Claude Code)\n` })).ok, true);
  const untested = await checkClaude({ run: async () => "9.9.9 (Claude Code)\n" });
  assert.equal(untested.ok, false);
  assert.match(untested.detail, /9\.9\.9/);
  assert.equal((await checkClaude({ run: async () => { throw new Error("not found"); } })).ok, false);
  assert.equal((await checkClaude({ run: async () => "hello" })).ok, false);
});

test("the command prints one line per check, exits 1 when one fails, and refuses an unknown flag", async (t) => {
  const fake = await startFakeHerdr(t);
  const home = tempDir(t);
  settingsWith(home, { PreToolUse: group("AskUserQuestion"), PermissionRequest: group("*") });
  const options = { socket: fake.socket, home, run: async () => `${TESTED_CLAUDE_VERSIONS[0]} (Claude Code)` };
  assert.equal((await runDoctor(options)).ok, true);
  let out = "";
  const previous = process.exitCode;
  await runDoctorCommand(["--json"], { out: { write: (text) => { out += text; } }, options: { ...options, run: async () => "1.0.0" } });
  const code = process.exitCode;
  process.exitCode = previous;
  const result = JSON.parse(out);
  assert.equal(code, 1);
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [["herdr", true], ["hook", true], ["claude", false]]);
  await runDoctorCommand(["--fix"], { out: { write() {} }, options });
  assert.equal(process.exitCode, 2);
  process.exitCode = previous;
  assert.ok(fake.writes().length === 0, "doctor never acts on herdr");
});
