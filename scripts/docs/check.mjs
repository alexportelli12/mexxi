#!/usr/bin/env node
// The `docs` check: builds the whole site (which fails on a broken internal
// link or a skill without `description`), then checks that the copies of
// shared facts on the landing page, the README and the docs still match.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./build.mjs";
import { checkConsistency } from "./consistency.mjs";
import { readAllowed } from "./lib/source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

try {
  const files = await readAllowed(root);
  const problems = checkConsistency(files);
  if (problems.length) throw new Error(problems.join("\n"));
  const { pages } = await buildDocs({ root });
  process.stdout.write(`Docs check passed: ${pages.length} pages built, links resolve, copies match\n`);
} catch (error) {
  process.stderr.write(`Docs check failed: ${error.message}\n`);
  process.exitCode = 1;
}
