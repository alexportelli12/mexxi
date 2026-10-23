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

test("colour functions outside tokens.css are refused wherever they are written", async (t) => {
  const css = "a { color: rgb(1 2 3); background: rgba(0,0,0,.5); border-color: hsl(10 20% 30%); outline-color: hsla(1,2%,3%,.4); "
    + "fill: oklch(70% 0.1 200); stroke: oklab(0.5 0.1 0.1); caret-color: hwb(10 20% 30%); }";
  const problems = checkDesign(await tree(t, { "site/styles.css": css }));
  assert.equal(problems.length, 7, problems.join("\n"));
  assert.match(problems[0], /site\/styles\.css:1: colour rgb\(/);
  const ts = checkDesign(await tree(t, { "scripts/segwi/web/src/app/app.ts": "el.style.background = 'rgb(1, 2, 3)';" }));
  assert.equal(ts.length, 1);
});

test("named colours and lab/lch/color() are refused in CSS values: files, style blocks and attributes, component styles, Tailwind", async (t) => {
  const cases = {
    "site/styles.css": "a { color: red; }\n.b {\n  border: 1px solid RebeccaPurple;\n  --x: lab(50% 10 10);\n  background: lch(50% 10 10) color(display-p3 1 0 0);\n}",
    "site/index.html": '<meta name="theme-color" content="#0a0b0d" /><style>p { color: navy }</style><p style="background: white">x</p>',
    "scripts/segwi/web/src/app/app.ts": "@Component({ styles: [`:host { color: tomato; }`], template: `<p class=\"bg-[red] text-[rgb(1_2_3)] [color:teal]\">x</p>` })",
    "scripts/docs/vitepress/theme/custom.css": ".dark { --vp-c-bg: black }",
  };
  const problems = checkDesign(await tree(t, cases));
  const found = problems.map((problem) => problem.replace(/ belongs.*/, ""));
  assert.deepEqual(found.sort(), [
    "scripts/docs/vitepress/theme/custom.css:1: colour black",
    "scripts/segwi/web/src/app/app.ts:1: colour red",
    "scripts/segwi/web/src/app/app.ts:1: colour rgb(…)",
    "scripts/segwi/web/src/app/app.ts:1: colour teal",
    "scripts/segwi/web/src/app/app.ts:1: colour tomato",
    "site/index.html:1: colour navy",
    "site/index.html:1: colour white",
    "site/styles.css:1: colour red",
    "site/styles.css:3: colour RebeccaPurple",
    "site/styles.css:4: colour lab(",
    "site/styles.css:5: colour color(",
    "site/styles.css:5: colour lch(",
  ]);
});

test("named colour words outside CSS values, and keywords that are not colours, pass", async (t) => {
  const cases = {
    "site/styles.css": "/* a red line, once */\na:hover { color: currentColor; background: transparent; border-color: inherit; }\n"
      + ".tan-box { content: \"red\"; background: url(red.png) var(--red); color: color-mix(in srgb, var(--text) 50%, var(--bg)); }",
    "site/index.html": '<meta name="theme-color" content="#0a0b0d" /><p class="red">Black and white, red and gold.</p>',
    "scripts/segwi/web/src/app/app.ts": "const red = 'green'; function color(x) { return lab(x); } const label = 'Stop the white run'; const grid = 'grid-cols-[auto_1fr] text-[15px]';",
    "scripts/segwi/web/src/app/words.ts": "export const word = 'wettaq'; // navy",
  };
  assert.deepEqual(checkDesign(await tree(t, cases)), []);
});

test("site/tokens.css may hold any colour", async (t) => {
  assert.deepEqual(checkDesign(await tree(t, { "site/tokens.css": ":root { --bg: #0a0b0d; --soft: rgb(1 2 3 / 0.1); --x: red; --y: oklch(70% 0.1 200); }" })), []);
});
