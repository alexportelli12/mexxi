import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDesign } from "../check-design.mjs";

const files = {
  "site/tokens.css": ":root { --bg: #0a0b0d; --accent: #f4b860; }",
  "site/styles.css": "body { background: var(--bg); }",
  "site/index.html": '<meta name="theme-color" content="#0a0b0d" /><a href="#add">Add</a>',
  "scripts/docs/vitepress/theme/custom.css": ".dark { --vp-c-bg: var(--bg); }",
  "scripts/segwi/web/src/app/app.ts": "const title = 'Runs';",
  "scripts/segwi/web/src/app/words.ts": "export const word = 'wettaq';",
  "names.json": JSON.stringify([{ name: "wettaq" }, { name: "lesti", verified: true }]),
};

async function tree(t, changes = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "segwi-design-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({ ...files, ...changes })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

test("the repository itself passes", () => {
  assert.deepEqual(checkDesign(), []);
});

test("tokens, the one theme-color meta, anchors and words.ts are allowed", async (t) => {
  assert.deepEqual(checkDesign(await tree(t)), []);
});

test("a hex colour outside tokens.css is refused in the site, the docs theme and the web app", async (t) => {
  for (const file of ["site/styles.css", "scripts/docs/vitepress/theme/custom.css", "scripts/segwi/web/src/styles.css"]) {
    const problems = checkDesign(await tree(t, { [file]: "a { color: #abc; border-color: #aabbccdd; }" }));
    assert.equal(problems.length, 2, file);
    assert.match(problems[0], new RegExp(`${file}:1: hex colour #abc`));
  }
});

test("a theme-color meta that differs from --bg, or a second one, is refused", async (t) => {
  assert.equal(checkDesign(await tree(t, { "site/index.html": '<meta name="theme-color" content="#111111" />' })).length, 1);
  const twice = '<meta name="theme-color" content="#0a0b0d" /><meta name="theme-color" content="#0a0b0d" />';
  assert.equal(checkDesign(await tree(t, { "site/index.html": twice })).length, 1);
});

test("a Maltese name typed into the web app is refused, unless names.json verifies it", async (t) => {
  const problems = checkDesign(await tree(t, { "scripts/segwi/web/src/app/app.html": "<h1>Wettaq</h1><p>lesti</p><segwi-root></segwi-root>" }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /app\.html:1: "wettaq" is typed in/);
});

test("the product name is held to the same rule", async (t) => {
  const problems = checkDesign(await tree(t, { "scripts/segwi/web/src/app/app.ts": "const title = 'segwi';" }));
  assert.match(problems[0], /"segwi" is typed in/);
});
