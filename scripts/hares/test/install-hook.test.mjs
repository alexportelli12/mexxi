// The installer adds the ħares hook groups to Claude Code's settings.json only
// while hares is enabled, records them, and removes exactly them. Every path is
// inside a temporary directory; the real ~/.claude is never opened.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desiredSettings, planSettingsMerge, writeSettingsMerge } from "../../lib/claude-settings.mjs";
import { claudeHooks, haresHookGroups, writeHaresSettingsFile } from "../../lib/host-hooks.mjs";

const CHECKOUT = "/opt/mexxi checkout";
const HERDR_SESSION_START = { matcher: "*", hooks: [{ type: "command", command: "herdr integration claude report-session" }] };
const USER_STOP = { hooks: [{ type: "command", command: "echo my own stop hook" }] };

function config(enabled) {
  return {
    paths: { checkout: CHECKOUT }, guard: { deny: [] }, claude: { bashMaxTimeoutMs: 600000 }, retro: { transcriptRetentionDays: 90 },
    ...(enabled === undefined ? {} : { hares: { enabled } }),
  };
}

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hares-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const settingsFile = path.join(home, ".claude", "settings.json");
  const stateFile = path.join(home, ".local/share/mexxi/state/claude-settings.json");
  const files = { settingsFile, stateFile };
  const settings = () => JSON.parse(readFileSync(settingsFile, "utf8"));
  const install = async (enabled) => {
    const plan = await planSettingsMerge({ ...files, desired: desiredSettings(config(enabled)) });
    assert.deepEqual(plan.conflicts, []);
    await writeSettingsMerge(files, plan);
    return plan;
  };
  return { home, files, settings, install, state: () => JSON.parse(readFileSync(stateFile, "utf8")) };
}

function seed(box, hooks) {
  writeFileSync(box.files.settingsFile, JSON.stringify({ theme: "dark", hooks }));
}

function prepare(box, hooks) {
  mkdirSync(path.dirname(box.files.settingsFile), { recursive: true });
  seed(box, hooks);
}

const HARES_EVENTS = ["PreToolUse", "PermissionRequest", "Notification", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "SessionEnd"];
const isHares = (group) => group.hooks.some((hook) => hook.command.includes("scripts/hares/hook.mjs"));

test("with hares off the settings get no ħares group, and an unset hares key counts as off", () => {
  for (const enabled of [false, undefined]) {
    const hooks = claudeHooks(config(enabled));
    assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse"]);
    assert.equal(Object.values(hooks).flat().some(isHares), false);
  }
});

test("with hares on the settings gain one group per event, with the right matchers, a 5 second timeout and a quoted path", () => {
  const hooks = claudeHooks(config(true));
  const groups = Object.fromEntries(HARES_EVENTS.map((event) => [event, hooks[event].filter(isHares)]));
  for (const event of HARES_EVENTS) assert.equal(groups[event].length, 1, event);
  assert.equal(groups.PreToolUse[0].matcher, "AskUserQuestion|ExitPlanMode|REPL");
  assert.equal(groups.PermissionRequest[0].matcher, "*");
  assert.equal(groups.Notification[0].matcher, "permission_prompt|idle_prompt|elicitation_dialog");
  assert.equal(groups.PostToolUse[0].matcher, "*");
  assert.equal(groups.PostToolUseFailure[0].matcher, "*");
  for (const event of ["UserPromptSubmit", "Stop", "SessionEnd"]) assert.equal("matcher" in groups[event][0], false, event + " takes no matcher");
  for (const group of Object.values(groups).flat()) {
    assert.equal(group.hooks[0].timeout, 5);
    assert.equal(group.hooks[0].command, "node '/opt/mexxi checkout/scripts/hares/hook.mjs'");
  }
});

test("turning hares on leaves the guard and post-tool groups in place beside the new ones", () => {
  const hooks = claudeHooks(config(true));
  assert.equal(hooks.PreToolUse.length, 2);
  assert.ok(hooks.PreToolUse.some((group) => group.matcher === "Bash|Monitor"));
  assert.equal(hooks.PostToolUse.length, 2);
  assert.equal(hooks.PostToolUseFailure.length, 2);
});

test("an install records the groups, a second install changes nothing, and the user's and herdr's own groups stay", async (t) => {
  const box = sandbox(t);
  prepare(box, { SessionStart: [HERDR_SESSION_START], Stop: [USER_STOP] });
  const first = await box.install(true);
  assert.ok(first.settings);
  const settings = box.settings();
  assert.deepEqual(settings.hooks.SessionStart, [HERDR_SESSION_START]);
  assert.deepEqual(settings.hooks.Stop.filter((group) => !isHares(group)), [USER_STOP]);
  assert.equal(settings.hooks.Stop.filter(isHares).length, 1);
  for (const event of HARES_EVENTS) assert.ok(box.state().hooks[event].some(isHares), event + " is recorded as owned");
  assert.equal(box.state().hooks.SessionStart, undefined, "herdr's group is never recorded as ours");
  const second = await box.install(true);
  assert.equal(second.settings, null);
  assert.equal(second.stateChanged, false);
  assert.deepEqual(second.drift, []);
});

test("turning hares off removes exactly the ħares groups and nothing the user or herdr added", async (t) => {
  const box = sandbox(t);
  prepare(box, { SessionStart: [HERDR_SESSION_START], Stop: [USER_STOP] });
  await box.install(false);
  const withoutHares = JSON.stringify(box.settings());
  await box.install(true);
  assert.notEqual(JSON.stringify(box.settings()), withoutHares);
  const off = await box.install(false);
  assert.ok(off.drift.some((line) => line.includes("hares/hook.mjs") && line.includes("no longer wanted")));
  assert.equal(JSON.stringify(box.settings()), withoutHares);
  assert.deepEqual(box.settings().hooks.SessionStart, [HERDR_SESSION_START]);
  assert.deepEqual(box.settings().hooks.Stop, [USER_STOP]);
  assert.equal(box.settings().theme, "dark");
});

test("a ħares group the user added by hand with the same text is not removed when hares goes off", async (t) => {
  const box = sandbox(t);
  prepare(box, { Notification: [haresHookGroups(CHECKOUT).Notification[0]] });
  await box.install(false);
  assert.equal(box.settings().hooks.Notification.length, 1);
});

test("a hand-deleted ħares group is reported as drift and put back", async (t) => {
  const box = sandbox(t);
  prepare(box, {});
  await box.install(true);
  const settings = box.settings();
  delete settings.hooks.SessionEnd;
  writeFileSync(box.files.settingsFile, JSON.stringify(settings));
  const plan = await planSettingsMerge({ ...box.files, desired: desiredSettings(config(true)) });
  assert.ok(plan.drift.some((line) => line.includes("SessionEnd") && line.includes("missing")));
});

test("the standalone settings file holds only the ħares hooks, for claude --settings", async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "hares-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "proof", "settings.json");
  await writeHaresSettingsFile(file, CHECKOUT);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(written), ["hooks"]);
  assert.deepEqual(Object.keys(written.hooks).sort(), [...HARES_EVENTS].sort());
  assert.deepEqual(written.hooks, haresHookGroups(CHECKOUT));
  assert.equal(existsSync(path.join(home, ".claude")), false, "nothing was written to a .claude directory");
});
