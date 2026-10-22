#!/usr/bin/env node
// `npm run docs:build`: turns the repository's own tracked files into the docs
// site. Pages are generated into the gitignored docs-site/, then VitePress
// builds them into site/docs/ (also gitignored), beside the landing page.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSidebar, firstSentenceOf, generatePages } from "./lib/generate.mjs";
import { readAllowed, SITE_URL } from "./lib/source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// VitePress attributes such as {.dictionary} style the built page only; the
// plain copies leave them out.
export const plainMarkdown = (markdown) => markdown.replace(/ \{(?:#[\w-]+ )?\.[\w-]+\}$/gm, "");

// The first prose paragraph after the title, cut to its first sentence.
const summaryOf = (markdown) => {
  let fenced = false;
  let paragraph = [];
  for (const line of markdown.split("\n").slice(1)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const prose = !fenced && !/^(\s*(```|~~~)|#|[-*|:>]|\d+\.)/.test(line.trim()) && line.trim();
    if (prose) paragraph.push(line.trim());
    else if (paragraph.length) break;
  }
  return firstSentenceOf(paragraph.join(" ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, ""));
};

export function llmsText(pages) {
  const lines = ["# mexxi", "", "> A workflow that takes a coding agent's task to a pull request you can review in a minute. These docs are generated from the repository.", ""];
  const sections = [...new Set(pages.map((page) => page.section))];
  for (const section of sections) {
    lines.push(`## ${section}`, "");
    for (const page of pages.filter((candidate) => candidate.section === section)) {
      const summary = summaryOf(page.markdown);
      lines.push(`- [${page.title}](${SITE_URL}${page.route}.md)${summary ? `: ${summary}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function buildDocs({ root = repoRoot, out = path.join(root, "docs-site"), site = path.join(root, "site/docs"), base = "/mexxi/docs/", render = true } = {}) {
  const files = await readAllowed(root);
  const { pages } = await generatePages({ root, files });
  await rm(out, { recursive: true, force: true });
  for (const page of pages) {
    await mkdir(path.dirname(path.join(out, `${page.route}.md`)), { recursive: true });
    // VitePress options such as `outline` go only on the built page; the plain
    // copy stays the Markdown itself.
    const options = Object.entries(page.frontmatter ?? {}).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
    await writeFile(path.join(out, `${page.route}.md`), `${options.length ? `---\n${options.join("\n")}\n---\n\n` : ""}${page.markdown}`);
    // A plain copy of each page, for agents and for reading offline.
    await mkdir(path.dirname(path.join(out, "public", `${page.route}.md`)), { recursive: true });
    await writeFile(path.join(out, "public", `${page.route}.md`), plainMarkdown(page.markdown));
  }
  await writeFile(path.join(out, "public/llms.txt"), llmsText(pages));
  await writeFile(path.join(out, "public/favicon.svg"), files.get("site/favicon.svg"));
  await cp(path.join(here, "vitepress"), path.join(out, ".vitepress"), { recursive: true });
  await writeFile(path.join(out, ".vitepress/site-data.json"), `${JSON.stringify({ sidebar: buildSidebar(pages) }, null, 2)}\n`);
  if (!render) return { pages, out };

  await rm(site, { recursive: true, force: true });
  const require = createRequire(import.meta.url);
  const bin = path.join(path.dirname(require.resolve("vitepress/package.json")), "bin/vitepress.js");
  const result = spawnSync(process.execPath, [bin, "build", out], {
    encoding: "utf8",
    env: { ...process.env, DOCS_BASE: base, DOCS_OUT_DIR: site },
  });
  if (result.status !== 0) throw new Error(`VitePress failed:\n${result.stdout}${result.stderr}`.trim());
  return { pages, out, site };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { pages, site } = await buildDocs();
    process.stdout.write(`Docs built: ${pages.length} pages in ${path.relative(process.cwd(), site)}\n`);
  } catch (error) {
    process.stderr.write(`Docs build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
