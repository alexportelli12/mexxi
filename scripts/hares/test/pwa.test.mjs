// The installable-app files: the manifest agrees with the design tokens, its icons
// exist at the sizes it claims, and the page links them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const web = (file) => fileURLToPath(new URL(`../web/${file}`, import.meta.url));
const manifest = JSON.parse(readFileSync(web("public/manifest.webmanifest"), "utf8"));
const tokens = readFileSync(fileURLToPath(new URL("../../../site/tokens.css", import.meta.url)), "utf8");

function pngSize(file) {
  const bytes = readFileSync(web(`public${file}`));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG", file);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test("the manifest names the app, starts at Now and uses the dark background from the tokens", () => {
  const bg = tokens.match(/--hares-bg:\s*(#[0-9a-f]+)/i)[1].toLowerCase();
  assert.equal(manifest.name, "hares");
  assert.equal(manifest.short_name, "hares");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, bg);
  assert.equal(manifest.theme_color, bg);
});

test("it has 192, 512 and maskable 512 icons that are the size they claim", () => {
  const found = manifest.icons.map((icon) => `${icon.sizes}${icon.purpose === "maskable" ? " maskable" : ""}`);
  assert.deepEqual(found.sort(), ["192x192", "512x512", "512x512 maskable"]);
  for (const icon of manifest.icons) assert.equal(pngSize(icon.src), icon.sizes, icon.src);
  assert.equal(pngSize("/icons/apple-touch-icon.png"), "180x180");
});

test("the page links the manifest, the Home Screen icon and the theme script, and the worker has no fetch handler", () => {
  const html = readFileSync(web("src/index.html"), "utf8");
  assert.match(html, /<script src="\/theme-init\.js"><\/script>/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.doesNotMatch(readFileSync(web("public/sw.js"), "utf8"), /addEventListener\(\s*['"]fetch['"]/);
});

test("the fonts the stylesheet names are self-hosted with their licence, and nothing loads from a font service", () => {
  const css = readFileSync(web("src/styles.css"), "utf8");
  for (const file of css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)) assert.ok(readFileSync(web(`public/fonts/${file[1]}`)).length > 10_000, file[1]);
  assert.match(readFileSync(web("public/fonts/OFL.txt"), "utf8"), /SIL OPEN FONT LICENSE/);
  assert.doesNotMatch(css + readFileSync(web("src/index.html"), "utf8"), /fonts\.(googleapis|gstatic)\.com/);
});
