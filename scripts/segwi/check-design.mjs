#!/usr/bin/env node
// The design check: one source of truth for how segwi, the landing page and the docs look.
//
// Rule 1, no stray colour. A colour may be written only in site/tokens.css. It is refused in the
// rest of site/, in the VitePress theme and in scripts/segwi/web/src/. A colour is:
// - a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa), anywhere in a file;
// - rgb(), rgba(), hsl(), hsla(), hwb(), oklab() or oklch(), anywhere in a file;
// - lab(), lch(), color() or a CSS named colour (red, rebeccapurple, ...), but only in a CSS value:
//   a declaration in a .css file, a <style> block, a style="..." attribute, an Angular component's
//   styles, or a Tailwind arbitrary value such as bg-[red]. Those words are ordinary code or English
//   elsewhere. Keywords that name no colour (transparent, currentColor, inherit, ...) are fine.
// Two things are not colours or cannot read a custom property, and are skipped: href="#anchor"
// links, and the single <meta name="theme-color"> in site/index.html, which must equal --bg.
// Image files (site/favicon.svg) are standalone images, so they are not scanned.
//
// Rule 2, no hard-coded Maltese. A name from names.json (and the product name segwi) may not
// be typed into scripts/segwi/web/src/app/. It reaches the interface through words.ts, which
// reads names.json at build time. A name is exempt only when its names.json entry has
// "verified": true, which records that dizzjunarju.mt confirmed the word; none does yet.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const SCANNED = /\.(css|html|js|mjs|ts)$/;
// Dependencies, build output, and the docs the build writes into site/docs/.
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".angular"]);
const GENERATED = path.join("site", "docs");
const HEX = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const ANCHOR = /href=["']#[^"']*["']/g;
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|oklab|oklch)\(/gi;
const VALUE_COLOUR_FUNCTION = /(?<![\w-])(?:lab|lch|color)\(/gi;
// The CSS named colours (CSS Color 4), longest first so a name is never matched by its prefix.
const NAMED_COLOURS = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
  burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
  darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
  darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory
  khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen
  lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
  olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
  slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke
  yellow yellowgreen`.split(/\s+/).sort((a, b) => b.length - a.length);
// A name counts only as a whole value word: not inside var(--red), a url(red.png) or a class name.
const NAMED_COLOUR = new RegExp(`(?<![\\w./-])(?:${NAMED_COLOURS.join("|")})(?![\\w./(-])`, "gi");
const THEME_COLOUR = /<meta\s+name="theme-color"\s+content="(#[0-9a-f]{3,8})"\s*\/?>/gi;

function* walk(directory) {
  if (!existsSync(directory) || directory.endsWith(GENERATED)) return;
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry)) yield* walk(full);
    } else if (SCANNED.test(entry)) {
      yield full;
    }
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Blanks a match out, keeping its length so later indexes (and so line numbers) stay right. */
const blank = (match) => match.replace(/[^\n]/g, " ");

/** Each declaration value in CSS text, with its index in `text` plus `offset`. Comments and strings are blanked first. */
function* declarationValues(css, offset) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/"[^"\n]*"|'[^'\n]*'/g, blank);
  // A value ends at ; or } (or the end of a style attribute); `a:hover {` is a selector, not a declaration.
  for (const match of clean.matchAll(/([\w-]+)\s*:([^;{}]+)(?=[;}]|$)/g)) {
    yield { value: match[2], index: offset + match.index + match[0].length - match[2].length };
  }
}

/** Every stretch of a file that is a CSS value, as { value, index }. */
function* cssValues(text, file) {
  if (file.endsWith(".css")) {
    yield* declarationValues(text, 0);
    return;
  }
  for (const match of text.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/gi)) yield* declarationValues(match[2], match.index + match[1].length);
  for (const match of text.matchAll(/(?<![\w[.-])style\s*=\s*(["'])([^"']*)\1/gi)) yield* declarationValues(match[2], match.index + match[0].length - match[2].length - 1);
  if (file.endsWith(".ts")) {
    for (const match of text.matchAll(/(\bstyles?\s*:\s*)(\[[\s\S]*?\]|`[^`]*`)/g)) {
      const body = match[2].replace(/^[[`]|[\]`]$/g, " ").replace(/`/g, " ");
      yield* declarationValues(body, match.index + match[1].length);
    }
  }
  // Tailwind arbitrary values: bg-[red], text-[rgb(1_2_3)], [color:red].
  for (const match of text.matchAll(/(?:(?<![\w-])[a-z][\w:-]*-\[|(?<![\w-])\[[a-z-]+:)([^\]\s"'`]+)\]/gi)) {
    yield { value: match[1], index: match.index + match[0].length - match[1].length - 1 };
  }
}

/** @returns {string[]} one message per violation, empty when the design holds */
export function checkDesign(root = repositoryRoot) {
  const problems = [];
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const tokens = path.join(root, "site/tokens.css");
  const bg = readFileSync(tokens, "utf8").match(/--bg:\s*(#[0-9a-f]+)/i)?.[1].toLowerCase();

  const colourFiles = [
    ...walk(path.join(root, "site")),
    ...walk(path.join(root, "scripts/docs/vitepress/theme")),
    ...walk(path.join(root, "scripts/segwi/web/src")),
  ].filter((file) => file !== tokens);
  for (const file of colourFiles) {
    let text = readFileSync(file, "utf8");
    if (relative(file) === "site/index.html") {
      const colours = [...text.matchAll(THEME_COLOUR)].map((match) => match[1].toLowerCase());
      if (colours.length !== 1 || colours[0] !== bg) problems.push(`${relative(file)}: the one theme-color meta must equal --bg (${bg})`);
      text = text.replace(THEME_COLOUR, "");
    }
    text = text.replace(ANCHOR, (match) => " ".repeat(match.length));
    for (const match of text.matchAll(HEX)) {
      problems.push(`${relative(file)}:${lineOf(text, match.index)}: hex colour ${match[0]} belongs in site/tokens.css as a token`);
    }
    for (const match of text.matchAll(COLOUR_FUNCTION)) {
      problems.push(`${relative(file)}:${lineOf(text, match.index)}: colour ${match[0]}…) belongs in site/tokens.css as a token`);
    }
    for (const { value, index } of cssValues(text, file)) {
      for (const match of [...value.matchAll(VALUE_COLOUR_FUNCTION), ...value.matchAll(NAMED_COLOUR)]) {
        problems.push(`${relative(file)}:${lineOf(text, index + match.index)}: colour ${match[0]} belongs in site/tokens.css as a token`);
      }
    }
  }

  const names = JSON.parse(readFileSync(path.join(root, "names.json"), "utf8"));
  const unverified = new Set(["segwi", ...names.filter((entry) => entry.verified !== true).map((entry) => entry.name)]);
  const words = path.join(root, "scripts/segwi/web/src/app/words.ts");
  for (const file of walk(path.join(root, "scripts/segwi/web/src/app")).filter((file) => file !== words)) {
    const text = readFileSync(file, "utf8");
    for (const name of unverified) {
      const pattern = new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "gi");
      for (const match of text.matchAll(pattern)) {
        problems.push(`${relative(file)}:${lineOf(text, match.index)}: "${name}" is typed in; take it from words.ts`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkDesign();
  if (problems.length) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("Design check passed.\n");
}
