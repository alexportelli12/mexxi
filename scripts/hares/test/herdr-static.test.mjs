// Only lib/herdr/guard.mjs may act on a herdr pane. These checks catch a module
// that names a write method or imports the unguarded writer, and a read path
// that would forward a write.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { herdrRequest } from "../lib/herdr/client.mjs";
import { startFakeHerdr, WRITE, WRITE_METHODS } from "./fake-herdr.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = new Set(["lib/herdr/guard.mjs", "test/fake-herdr.mjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) files.push(...sourceFiles(full));
    } else if (/\.(mjs|js|cjs|ts|tsx|jsx|json|cmd)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

// A method name followed by more name characters is a different word: the close method must not match the "closed" event.
const writePattern = new RegExp(`(${[...WRITE_METHODS].map((name) => name.replace(".", "\\.")).join("|")})(?![A-Za-z0-9_])`);

test("no file under scripts/hares but the guard and the fake names a herdr write method", () => {
  assert.ok(WRITE_METHODS.size >= 11, "the list of write methods is complete");
  const offenders = sourceFiles(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((relative) => !ALLOWED.has(relative))
    .filter((relative) => writePattern.test(readFileSync(path.join(root, relative), "utf8")));
  assert.deepEqual(offenders, []);
  // The scan can see a write method: the guard itself must trip it.
  assert.ok(writePattern.test(readFileSync(path.join(root, "lib/herdr/guard.mjs"), "utf8")));
});

test("no module but the guard imports the unguarded herdrWrite", () => {
  const offenders = sourceFiles(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((relative) => !["lib/herdr/guard.mjs", "lib/herdr/client.mjs", "test/herdr-static.test.mjs"].includes(relative))
    .filter((relative) => /\bherdrWrite\b/.test(readFileSync(path.join(root, relative), "utf8")));
  assert.deepEqual(offenders, []);
});

test("herdrRequest refuses a write method without sending it, and still sends a read", async (t) => {
  const fake = await startFakeHerdr(t);
  await assert.rejects(herdrRequest(WRITE.paneSendKeys, { pane_id: "wT:p1", keys: ["1"] }, { socket: fake.socket }), { code: "not_read_only" });
  assert.deepEqual(fake.requests, []);
  assert.equal((await herdrRequest("ping", {}, { socket: fake.socket })).protocol, 22);
});
