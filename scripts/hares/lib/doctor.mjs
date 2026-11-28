// `hares doctor`: checks, read-only, that what ħares relies on still holds.
// It replaces the nightly canary's "the agent still behaves as expected" role:
// herdr answers on its socket and speaks the protocol ħares was written for, the
// hook that records questions is installed in Claude Code's settings, and the
// Claude Code version is one the screen parser was proven against. It sends
// nothing to any pane and changes no file.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HERDR_PROTOCOL, defaultSocket, herdrRequest } from "./herdr/client.mjs";

/** Claude Code versions the screen fixtures were captured on (gate 1, 2026-11-28). */
export const TESTED_CLAUDE_VERSIONS = ["2.1.332"];
const HOOK_SCRIPT = "scripts/hares/hook.mjs";
/** The hook events ħares needs to see a question or a permission (scripts/lib/host-hooks.mjs haresHookGroups). */
const NEEDED_EVENTS = ["PreToolUse", "PermissionRequest"];

/** Whether herdr answers ping with the pinned protocol. */
export async function checkHerdr({ socket = defaultSocket(), request = herdrRequest } = {}) {
  try {
    const pong = await request("ping", {}, { socket });
    if (pong?.protocol !== HERDR_PROTOCOL) {
      return { name: "herdr", ok: false, detail: `herdr ${pong?.version ?? "?"} speaks protocol ${pong?.protocol ?? "unknown"}; ħares speaks ${HERDR_PROTOCOL}, so it will read but send nothing.` };
    }
    return { name: "herdr", ok: true, detail: `herdr ${pong.version ?? "?"} on ${socket}, protocol ${pong.protocol}.` };
  } catch (error) {
    return { name: "herdr", ok: false, detail: `herdr does not answer on ${socket}: ${error.message}` };
  }
}

/** Whether Claude Code's user settings run the ħares hook on the events it needs. */
export function checkHook({ home = os.homedir() } = {}) {
  const file = path.join(home, ".claude", "settings.json");
  let settings;
  try {
    settings = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { name: "hook", ok: false, detail: `Can't read ${file} (${error.code ?? error.message}); run the mexxi installer with hares.enabled.` };
  }
  const runsHook = (groups) => (Array.isArray(groups) ? groups : []).some((group) => (group?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes(HOOK_SCRIPT)));
  const missing = NEEDED_EVENTS.filter((event) => !runsHook(settings?.hooks?.[event]));
  if (missing.length) return { name: "hook", ok: false, detail: `The ħares hook is not installed for ${missing.join(" and ")}; run the mexxi installer with hares.enabled.` };
  return { name: "hook", ok: true, detail: `The ħares hook runs on ${NEEDED_EVENTS.join(" and ")}.` };
}

/** `claude --version`, compared with the versions ħares was tested on. */
export async function checkClaude({ run = defaultRun } = {}) {
  let output;
  try {
    output = await run("claude", ["--version"]);
  } catch (error) {
    return { name: "claude", ok: false, detail: `claude --version failed: ${error.message}` };
  }
  const version = /\d+\.\d+\.\d+/.exec(output)?.[0] ?? null;
  if (!version) return { name: "claude", ok: false, detail: `claude --version printed no version: ${output.trim().slice(0, 80)}` };
  if (!TESTED_CLAUDE_VERSIONS.includes(version)) {
    return { name: "claude", ok: false, detail: `Claude Code ${version} is not one ħares was tested on (${TESTED_CLAUDE_VERSIONS.join(", ")}); its screens may read differently, and anything ħares can't read falls back to the terminal.` };
  }
  return { name: "claude", ok: true, detail: `Claude Code ${version}, tested.` };
}

function defaultRun(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

/** Every check, in order; ok only when all passed. */
export async function runDoctor(options = {}) {
  const checks = [await checkHerdr(options), checkHook(options), await checkClaude(options)];
  return { ok: checks.every((check) => check.ok), checks };
}

/** The CLI: prints one line per check, or JSON with --json; exit code 1 when any check failed. */
export async function runDoctorCommand(args = [], { out = process.stdout, options = {} } = {}) {
  const unknown = args.filter((arg) => arg !== "--json");
  if (unknown.length) {
    process.stderr.write(`hares doctor takes only --json, not ${unknown.join(" ")}\n`);
    process.exitCode = 2;
    return null;
  }
  const result = await runDoctor(options);
  if (args.includes("--json")) out.write(`${JSON.stringify(result, null, 2)}\n`);
  else for (const check of result.checks) out.write(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}
