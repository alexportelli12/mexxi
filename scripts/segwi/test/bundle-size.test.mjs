import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { initialGzipBytes } from "../web-check.mjs";

test("the initial size counts the linked script and stylesheet once, and no lazy chunk", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "segwi-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = "console.log('main');".repeat(50);
  const style = "body{color:red}".repeat(50);
  await writeFile(path.join(directory, "main.js"), script);
  await writeFile(path.join(directory, "styles.css"), style);
  await writeFile(path.join(directory, "chunk-lazy.js"), "x".repeat(10000));
  await writeFile(
    path.join(directory, "index.html"),
    '<link rel="stylesheet" href="styles.css" media="print"><noscript><link rel="stylesheet" href="styles.css"></noscript><script src="main.js" type="module"></script>',
  );
  const expected = gzipSync(script, { level: 9 }).length + gzipSync(style, { level: 9 }).length;
  assert.equal(initialGzipBytes(directory), expected);
});
