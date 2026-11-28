import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../server.mjs";
import { tempDir, waitFor } from "./helpers.mjs";

const server = fileURLToPath(new URL("../server.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [server, ...args], { encoding: "utf8" });

test("--help lists every subcommand with its why, and every one works", () => {
  const { status, stdout } = run("--help");
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /not yet implemented/);
  for (const [name, { why }] of Object.entries(COMMANDS)) {
    assert.ok(stdout.includes(name), name);
    assert.ok(stdout.includes(`Why: ${why}`), `${name} shows its why`);
  }
});

test("the file runs through a symlink, which is how the installer links it as `hares`", (t) => {
  const link = path.join(tempDir(t, "hares-link-"), "hares");
  symlinkSync(server, link);
  const { status, stdout } = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
  assert.equal(status, 0);
  assert.match(stdout, /Usage: hares <command>/);
});

test("doctor rejects a flag it does not take before it checks anything", () => {
  const { status, stderr } = run("doctor", "--bogus");
  assert.equal(status, 2);
  assert.match(stderr, /hares doctor takes only --json/);
});

test("the retired approver and canary subcommands are gone, so nothing can start segwi's runner pieces", () => {
  for (const name of ["approver", "canary"]) {
    assert.ok(!(name in COMMANDS), name);
    assert.equal(run(name).status, 2, name);
  }
});

test("an unknown subcommand is refused with the list to choose from", () => {
  const { status, stderr } = run("nonsense");
  assert.equal(status, 2);
  assert.match(stderr, /expected serve, token, vapid, github-token, doctor/);
});

test("serve takes the operator's --config and --data-dir, prints its URL and stops on SIGTERM", async (t) => {
  const dir = tempDir(t, "hares-serve-");
  const config = path.join(dir, "config.json");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  writeFileSync(config, JSON.stringify({ hares: { enabled: true, bind: { host: "127.0.0.1", port } } }));
  // A temp HOME: the server must not read this machine's herdr socket, transcripts or hook records in a test.
  const env = { ...process.env, HOME: dir, XDG_DATA_HOME: path.join(dir, "xdg"), XDG_CONFIG_HOME: path.join(dir, "config") };
  const child = spawn(process.execPath, [server, "serve", "--config", config, "--data-dir", path.join(dir, "data")], { stdio: ["ignore", "pipe", "pipe"], env });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await waitFor(() => /hares listening on http:\/\/127\.0\.0\.1:\d+/.test(out), { what: "the listening line" });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(run("serve", "--bogus", "x").status, 2);
});
