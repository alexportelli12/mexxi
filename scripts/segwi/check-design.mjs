#!/usr/bin/env node
// The design check: one source of truth for how segwi, the landing page and the docs look.
//
// Rule 1, no stray colour. A hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa) may appear only in
// site/tokens.css. It is refused in the rest of site/, in the VitePress theme and in
// scripts/segwi/web/src/. Two things are not colours or cannot read a custom property, and are
// skipped: href="#anchor" links, and the single <meta name="theme-color"> in site/index.html,
// which must equal --bg. Image files (site/favicon.svg) are standalone images, so they are not scanned.
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
