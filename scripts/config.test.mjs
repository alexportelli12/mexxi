import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, configPath, loadConfig, minimalConfig, resolveConfig } from "./lib/config.mjs";

const home = path.join(path.sep, "home", "someone");

async function temporaryFile(t, content) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.json");
  if (content !== undefined) await writeFile(file, content);
  return file;
}

test("config.json lives in ~/.config/mexxi unless MEXXI_CONFIG names another file", () => {
  assert.equal(configPath({ env: {}, home }), path.join(home, ".config/mexxi/config.json"));
  assert.equal(configPath({ env: { MEXXI_CONFIG: "/tmp/other.json" }, home }), path.resolve("/tmp/other.json"));
});

test("a missing config.json means every default, with ~ expanded", async (t) => {
  const { exists, config } = await loadConfig({ file: await temporaryFile(t), home });
  assert.equal(exists, false);
  assert.equal(config.paths.checkout, path.join(home, "workspace/mexxi"));
  assert.equal(config.paths.worktreeRoot, path.join(home, ".local/share/mexxi/worktrees"));
  assert.equal(config.browser.outputDir, config.paths.worktreeRoot);
  assert.deepEqual(config.hosts, { opencode: true, claude: true, codex: true });
  assert.equal(config.models.opencode.explore, "openai/gpt-5.6-luna");
  assert.equal(config.models.claude.reviewer, null);
  assert.equal(config.workflow.branchPrefix, "agent/");
  assert.deepEqual(config.workflow.viewports, [1440, 768, 390]);
  assert.equal(config.jev.enabled, false);
  assert.deepEqual(config.mods, ["run-pane", "command-fixer"]);
});

test("a user sets only what differs: objects merge, arrays and null replace", async () => {
  const config = await resolveConfig({
    paths: { worktreeRoot: "/srv/worktrees" },
    models: { opencode: { explore: null } },
    workflow: { viewports: [1280] },
    browser: { outputDir: "~/evidence" },
  }, { home });
  assert.equal(config.paths.checkout, path.join(home, "workspace/mexxi"));
  assert.equal(config.paths.worktreeRoot, "/srv/worktrees");
  assert.equal(config.models.opencode.explore, null);
  assert.equal(config.models.opencode.general, "openai/gpt-5.6-luna");
  assert.deepEqual(config.workflow.viewports, [1280]);
  assert.equal(config.workflow.branchPrefix, "agent/");
  assert.equal(config.browser.outputDir, path.join(home, "evidence"));
});

test("validation names every invalid key", async () => {
  await assert.rejects(resolveConfig({
    paths: { worktreeRoot: "relative" },
    hosts: { opencode: "yes" },
    models: { claude: { explore: "haiku" } },
    workflow: { branchPrefix: "agent", viewports: [100], ports: { last: 70000 } },
    jev: { maxPayloadBytes: 1.5 },
    mods: ["unknown"],
    extra: true,
  }, { home, source: "test config" }), (error) => {
    assert.ok(error instanceof ConfigError);
    for (const expected of [
      /^test config is invalid/,
      /config\.paths\.worktreeRoot: does not match/,
      /config\.hosts\.opencode: expected boolean, got string/,
      /config\.models\.claude\.explore: unknown key/,
      /config\.workflow\.branchPrefix: does not match/,
      /config\.workflow\.viewports\[0\]: below 200/,
      /config\.workflow\.ports\.last: above 65535/,
      /config\.jev\.maxPayloadBytes: expected integer, got number/,
      /config\.mods\[0\]: expected one of run-pane, command-fixer/,
      /config\.extra: unknown key/,
    ]) assert.match(error.message, expected);
    return true;
  });
});

test("unreadable JSON is reported against its file", async (t) => {
  const file = await temporaryFile(t, "{ not json");
  await assert.rejects(loadConfig({ file, home }), new RegExp(`${file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} is not valid JSON`));
});

test("the first-run file records only the clone's location", async (t) => {
  const minimal = minimalConfig({ checkout: path.join(home, "code/mexxi"), home });
  assert.deepEqual(minimal.paths, { checkout: "~/code/mexxi" });
  assert.deepEqual(minimalConfig({ checkout: "/opt/mexxi", home }).paths, { checkout: "/opt/mexxi" });
  const file = await temporaryFile(t, JSON.stringify(minimal));
  const { exists, config } = await loadConfig({ file, home });
  assert.equal(exists, true);
  assert.equal(config.paths.checkout, path.join(home, "code/mexxi"));
});

test("Jev's endpoint, which receives the API key, must be HTTPS unless it is on loopback", async () => {
  for (const endpoint of ["http://openrouter.ai/api/alpha/decisions", "http://localhost.example.com/x", "http://127.0.0.1.example.com/x", "ftp://openrouter.ai/x"]) {
    await assert.rejects(resolveConfig({ jev: { endpoint } }, { home }), /config\.jev\.endpoint: does not match/, endpoint);
  }
  for (const endpoint of ["https://openrouter.ai/api/alpha/decisions", "http://127.0.0.1:4100/api/alpha/decisions", "http://localhost/x", "http://[::1]:8080/x"]) {
    assert.equal((await resolveConfig({ jev: { endpoint } }, { home })).jev.endpoint, endpoint);
  }
});

test("workflow.ports must not be empty, counting the defaults", async () => {
  await assert.rejects(resolveConfig({ workflow: { ports: { first: 5000, last: 4000 } } }, { home }), /config\.workflow\.ports: first \(5000\) is above last \(4000\)/);
  await assert.rejects(resolveConfig({ workflow: { ports: { first: 5000 } } }, { home }), /first \(5000\) is above last \(4999\)/);
  assert.deepEqual((await resolveConfig({ workflow: { ports: { first: 4000, last: 4000 } } }, { home })).workflow.ports, { first: 4000, last: 4000 });
});

test("forge.hosts maps any hostname to github or gitlab, and nothing else", async () => {
  const hosts = { "git.example.com": "gitlab", "github.example.com": "github" };
  assert.deepEqual((await resolveConfig({ forge: { hosts } }, { home })).forge.hosts, hosts);
  assert.deepEqual((await resolveConfig({}, { home })).forge.hosts, {});
  await assert.rejects(resolveConfig({ forge: { hosts: { "git.example.com": "bitbucket" }, extra: 1 } }, { home }), (error) => {
    assert.match(error.message, /config\.forge\.hosts\.git\.example\.com: expected one of github, gitlab/);
    assert.match(error.message, /config\.forge\.extra: unknown key/);
    return true;
  });
  await assert.rejects(resolveConfig({ forge: { hosts: { "git.example.com": 1 } } }, { home }), /config\.forge\.hosts\.git\.example\.com: expected string, got integer/);
});
