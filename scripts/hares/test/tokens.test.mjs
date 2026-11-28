import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../../../site/tokens.css", import.meta.url)), "utf8");
const declarations = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

function resolve(name) {
  const value = declarations.get(name);
  assert.ok(value, `${name} is declared in tokens.css`);
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  return reference ? resolve(reference[1]) : value;
}

function luminance(hex) {
  const [r, g, b] = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i).slice(1).map((part) => {
    const channel = parseInt(part, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("the contrast ratio matches the WCAG reference values", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrast("#777777", "#ffffff").toFixed(2), "4.48");
});

for (const status of ["needs-you", "done", "failed", "stopped"]) {
  for (const surface of ["--bg", "--surface", "--surface-raised"]) {
    test(`--status-${status} reaches WCAG AA (4.5:1) on ${surface}`, () => {
      const ratio = contrast(resolve(`--status-${status}`), resolve(surface));
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
    });
  }
}

test("body text and the accent reach AA on every surface", () => {
  for (const colour of ["--text", "--muted", "--accent"]) {
    for (const surface of ["--bg", "--surface", "--surface-raised"]) {
      assert.ok(contrast(resolve(colour), resolve(surface)) >= 4.5, `${colour} on ${surface}`);
    }
  }
});

// The app's own colours: each theme's text colours must be readable on the page and on a card. Each
// block is read on its own, because the two themes declare the same names.
function themeBlock(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} is in tokens.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map([...body.matchAll(/--hares-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(([, name, value]) => [name, value]));
}

for (const [theme, selector] of [["dark", ':root[data-theme="dark"] {'], ["light", ':root[data-theme="light"] {']]) {
  const colours = themeBlock(selector);
  for (const text of ["text", "muted", "faint", "amber-text"]) {
    for (const surface of ["bg", "surface"]) {
      test(`hares ${theme}: --hares-${text} reaches WCAG AA (4.5:1) on --hares-${surface}`, () => {
        const ratio = contrast(colours.get(text), colours.get(surface));
        assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
      });
    }
  }
  for (const [text, surface] of [["on-amber", "amber"], ["on-teal", "teal"], ["on-red", "red"]]) {
    test(`hares ${theme}: text on the ${surface} fill reaches AA`, () => {
      const ratio = contrast(colours.get(text), colours.get(surface));
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
    });
  }
}
