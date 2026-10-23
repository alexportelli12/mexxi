// The MCP bearer token (plan section 11.4): only a hash is on disk, the file is
// private, rotation invalidates the old token, and the CLI prints the new one once.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { redact } from "../../lib/redact.mjs";
import { openStore } from "../lib/store.mjs";
import { rotate, verify } from "../lib/token.mjs";
import { tempDir } from "./helpers.mjs";

const entry = fileURLToPath(new URL("../server.mjs", import.meta.url));
const TOKEN_SHAPE = /^segwi_[A-Za-z0-9_-]{43}$/;

test("rotate returns a segwi_ token and stores only its hash in a 0600 file", (t) => {
  const dir = path.join(tempDir(t), "state");
  const token = rotate(dir);
  assert.match(token, TOKEN_SHAPE);
  const file = path.join(dir, "segwi.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(token));
  const state = JSON.parse(text);
  assert.match(state.mcpTokenHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Date.parse(state.rotatedAt) > 0);
});

test("verify accepts the current token only, and nothing before a token exists", (t) => {
  const dir = tempDir(t);
  assert.equal(verify(dir, "segwi_anything"), false);
  const first = rotate(dir);
  assert.equal(verify(dir, first), true);
  assert.equal(verify(dir, `${first}x`), false);
  assert.equal(verify(dir, ""), false);
  const second = rotate(dir);
  assert.equal(verify(dir, first), false);
  assert.equal(verify(dir, second), true);
  assert.equal(statSync(path.join(dir, "segwi.json")).mode & 0o777, 0o600);
});

test("rotate keeps the other keys in the state file", (t) => {
  const dir = tempDir(t);
  rotate(dir);
  const file = path.join(dir, "segwi.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(state).sort(), ["mcpTokenHash", "rotatedAt"]);
});

test("the redaction patterns catch a segwi token", (t) => {
  const token = rotate(tempDir(t));
  const { text, count } = redact(`header was ${token}`);
  assert.ok(count >= 1);
  assert.ok(!text.includes(token));
});

test("segwi token rotate prints the token once on stdout, guidance on stderr, and audits it", (t) => {
  const state = path.join(tempDir(t), "state");
  const data = tempDir(t);
  openStore(path.join(data, "segwi.db")).close();
  const run = () => spawnSync(process.execPath, [entry, "token", "rotate", "--state-dir", state, "--data-dir", data], { encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout.trim(), TOKEN_SHAPE);
  assert.ok(first.stdout.trim().split("\n").length === 1);
  assert.ok(!first.stderr.includes(first.stdout.trim()));
  assert.ok(first.stderr.trim().length > 0);
  assert.equal(verify(state, first.stdout.trim()), true);
  const second = run();
  assert.equal(verify(state, first.stdout.trim()), false);
  assert.equal(verify(state, second.stdout.trim()), true);

  const store = openStore(path.join(data, "segwi.db"));
  const rows = store.listAudit(10).filter((row) => row.action === "token.rotate");
  store.close();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.origin === "cli" && row.outcome === "ok" && !row.detail.includes("segwi_")));
});

test("segwi token rotate works without a database and refuses unknown arguments", (t) => {
  const state = tempDir(t);
  const ok = spawnSync(process.execPath, [entry, "token", "rotate", "--state-dir", state, "--data-dir", path.join(tempDir(t), "none")], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [entry, "token", "show"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.ok(execFileSync(process.execPath, [entry, "--help"], { encoding: "utf8" }).includes("Rotate the bearer token"));
});
