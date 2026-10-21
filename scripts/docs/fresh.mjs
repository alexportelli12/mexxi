#!/usr/bin/env node
// The `docs-fresh` check. Hand-written pages say what they describe (`sources:`)
// and when someone last checked (`reviewed:`). When a branch changes a source
// but not the page, this fails and names the page to review. The fix is to
// update the page, or to bump its `reviewed` date when nothing needs to change.
//
// Markdown pages in docs/ carry the declaration in frontmatter. README.md and
// site/index.html cannot (a frontmatter block would show on GitHub, and HTML
// has none), so docs/freshness.json holds theirs.
//
// The base is the merge-base of HEAD and origin's default branch, so the
// verdict does not depend on how many commits the branch has. Changes in the
// working tree count, so the check also helps before committing. With no
// origin ref the check fails and says how to supply one: it never skips.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { globToRegExp, matchesAny } from "./lib/glob.mjs";
import { git, trackedPaths } from "./lib/source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIDECAR = "docs/freshness.json";

export class FreshnessError extends Error {}

const tryGit = (root, args) => {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
};

export function resolveBase(root, env = process.env) {
  const candidates = env.MEXXI_DOCS_BASE ? [env.MEXXI_DOCS_BASE] : [tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]), "origin/main", "origin/master"].filter(Boolean);
  const ref = candidates.find((candidate) => tryGit(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]));
  if (!ref) {
    throw new FreshnessError(
      `no base to compare with: none of ${candidates.join(", ")} exists. Fetch origin (git fetch origin) or set MEXXI_DOCS_BASE to the ref the branch started from.`,
    );
  }
  const base = tryGit(root, ["merge-base", "HEAD", ref]);
  if (!base) throw new FreshnessError(`no merge base between HEAD and ${ref}; the clone may be shallow. Run git fetch --unshallow, or set MEXXI_DOCS_BASE.`);
  return base;
}

export function changedFiles(root, base) {
  const lines = (text) => text.split("\0").filter(Boolean);
  return new Set([
    ...lines(git(root, ["diff", "--name-only", "--no-renames", "-z", base])),
    ...lines(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function declaredPages(root, read) {
  const pages = [];
  for (const file of trackedPaths(root).filter((name) => /^docs\/[^/]+\.md$/.test(name))) {
    const { data } = parseFrontmatter(await read(file));
    pages.push({ file, sources: data.sources, reviewed: data.reviewed, own: file });
  }
  const sidecar = JSON.parse(await read(SIDECAR));
  for (const required of ["README.md", "site/index.html"]) {
    if (!sidecar[required]) throw new FreshnessError(`${SIDECAR} must declare sources for ${required}`);
  }
  for (const [file, entry] of Object.entries(sidecar)) pages.push({ file, sources: entry.sources, reviewed: entry.reviewed, sidecar: true });
  return pages;
}

export async function checkFreshness({ root = repoRoot, env = process.env } = {}) {
  const read = (file) => readFile(path.join(root, file), "utf8");
  const base = resolveBase(root, env);
  const changed = changedFiles(root, base);
  const tracked = trackedPaths(root);
  const baseSidecar = tryGit(root, ["show", `${base}:${SIDECAR}`]);
  const baseEntries = baseSidecar ? JSON.parse(baseSidecar) : {};
  const problems = [];
  for (const page of await declaredPages(root, read)) {
    if (!Array.isArray(page.sources) || !page.sources.length) {
      problems.push(`${page.file}: declare what it describes with a non-empty \`sources\` list`);
      continue;
    }
    if (!ISO_DATE.test(page.reviewed ?? "")) {
      problems.push(`${page.file}: \`reviewed\` must be a YYYY-MM-DD date`);
      continue;
    }
    for (const glob of page.sources) {
      if (!tracked.some((file) => globToRegExp(glob).test(file))) problems.push(`${page.file}: source \`${glob}\` matches no tracked file`);
    }
    const touched = [...changed].filter((file) => file !== page.file && !file.startsWith("docs/freshness.json") && matchesAny(page.sources, file)).sort();
    const reviewed = changed.has(page.file) || (page.sidecar && baseEntries[page.file]?.reviewed !== page.reviewed);
    if (touched.length && !reviewed) {
      problems.push(`${page.file}: review it, because ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""} changed. Update the page, or bump its \`reviewed\` date when nothing needs to change.`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const problems = await checkFreshness();
    if (problems.length) {
      process.stderr.write(`docs-fresh failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("Hand-written pages are fresh\n");
    }
  } catch (error) {
    if (!(error instanceof FreshnessError)) throw error;
    process.stderr.write(`docs-fresh failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
