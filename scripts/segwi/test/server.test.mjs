import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../server.mjs";

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
