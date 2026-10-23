import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../server.mjs";
import { tempDir, waitFor } from "./helpers.mjs";

const server = fileURLToPath(new URL("../server.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [server, ...args], { encoding: "utf8" });

test("--help lists every subcommand with its why, and marks the ones that don't work yet", () => {
  const { status, stdout } = run("--help");
  assert.equal(status, 0);
  assert.match(stdout, /token .*\(not yet implemented\)/);
  assert.doesNotMatch(stdout, /serve .*not yet implemented/);
  for (const [name, { why }] of Object.entries(COMMANDS)) {
    assert.ok(stdout.includes(name), name);
    assert.ok(stdout.includes(`Why: ${why}`), `${name} shows its why`);
  }
});

test("a subcommand that does not exist yet says so and fails", () => {
  const { status, stderr } = run("token");
  assert.equal(status, 2);
  assert.match(stderr, /not yet implemented/);
});

test("an unknown subcommand is refused with the list to choose from", () => {
  const { status, stderr } = run("nonsense");
  assert.equal(status, 2);
  assert.match(stderr, /expected serve, approver/);
});

test("serve takes the operator's --config and --data-dir, prints its URL and stops on SIGTERM", async (t) => {
  const dir = tempDir(t, "segwi-serve-");
  const config = path.join(dir, "config.json");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  writeFileSync(config, JSON.stringify({ segwi: { enabled: true, bind: { host: "127.0.0.1", port } } }));
  const child = spawn(process.execPath, [server, "serve", "--config", config, "--data-dir", path.join(dir, "data")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  await waitFor(() => /segwi listening on http:\/\/127\.0\.0\.1:\d+/.test(out), { what: "the listening line" });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(run("serve", "--bogus", "x").status, 2);
});
