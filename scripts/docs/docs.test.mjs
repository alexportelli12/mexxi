import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { buildDocs } from "./build.mjs";
import { checkConsistency } from "./consistency.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { globToRegExp } from "./lib/glob.mjs";
import { readAllowed, trackedPaths } from "./lib/source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A throwaway Git repository holding this repository's tracked files, with
// node_modules linked so VitePress resolves. `extra` writes more files before
// the commit; `untracked` writes files that must never be read.
async function copyRepo({ extra = {}, untracked = {}, edit = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-docs-"));
  for (const file of trackedPaths(root)) {
    const source = path.join(root, file);
    try {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await cp(source, path.join(directory, file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"));
  for (const [file, change] of Object.entries(edit)) {
    await writeFile(path.join(directory, file), change(await readFile(path.join(directory, file), "utf8")));
  }
  for (const [file, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  }
  git(directory, "init", "-q", "-b", "main");
  git(directory, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
  git(directory, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fixture");
  for (const [file, text] of Object.entries(untracked)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), text);
  }
  return directory;
}

const outputs = (directory) => ({ out: path.join(directory, "docs-site"), site: path.join(directory, "site/docs") });

async function listFiles(directory) {
  return (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

test("the frontmatter reader handles folded blocks, lists and quotes", () => {
  const { data, body } = parseFrontmatter("---\nname: x\ndescription: >-\n  one\n  two\nsources:\n  - a/**\n  - b.md\nlist: [c, 'd']\nreviewed: 2026-10-21\n---\nbody\n");
  assert.deepEqual(data, { name: "x", description: "one two", sources: ["a/**", "b.md"], list: ["c", "d"], reviewed: "2026-10-21" });
  assert.equal(body, "body\n");
});

test("globs keep * inside a segment and let ** cross segments", () => {
  assert.ok(globToRegExp("commands/*.md").test("commands/a.md"));
  assert.ok(!globToRegExp("commands/*.md").test("commands/a/b.md"));
  assert.ok(globToRegExp("scripts/**").test("scripts/a/b.mjs"));
  assert.ok(globToRegExp("**/SKILL.md").test("SKILL.md"));
});

test("the landing page and README copies match prompts.json and names.json", async () => {
  assert.deepEqual(checkConsistency(await readAllowed(root)), []);
  const files = await readAllowed(root);
  files.set("site/index.html", files.get("site/index.html").replace("run /lesti here", "run /lesti there"));
  assert.match(checkConsistency(files).join("\n"), /prepare/);
});

test("the build publishes only allowlisted tracked files, and search finds every skill by its description", async () => {
  const directory = await copyRepo({
    extra: { "scripts/not-allowlisted.md": "TRACKED-BUT-NOT-ALLOWLISTED" },
    untracked: {
      "retro/report.md": "RETRO-SECRET",
      "config.json": '{"jev":{"key":"CONFIG-SECRET"}}',
      ".verifika/log.md": "VERIFIKA-SECRET",
      "docs/untracked.md": "UNTRACKED-SECRET",
      "commands/untracked.md": "---\ndescription: UNTRACKED-COMMAND\n---\n# x $ARGUMENTS\n",
    },
  });
  const { out, site } = outputs(directory);
  await buildDocs({ root: directory, out, site });
  const published = [...(await listFiles(out)), ...(await listFiles(site))].filter((file) => !file.includes(`${path.sep}.vitepress${path.sep}cache${path.sep}`));
  for (const file of published) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const secret of ["RETRO-SECRET", "CONFIG-SECRET", "VERIFIKA-SECRET", "UNTRACKED-SECRET", "UNTRACKED-COMMAND", "TRACKED-BUT-NOT-ALLOWLISTED"]) {
      assert.ok(!text.includes(secret), `${file} leaked ${secret}`);
    }
  }
  assert.ok(published.every((file) => !file.includes("node_modules")));
  assert.ok(!published.some((file) => file.includes(`${path.sep}site${path.sep}docs${path.sep}public${path.sep}`)), "plain .md copies must not also be built as pages");
  // llms.txt and a plain .md copy of each page ship with the site.
  assert.match(await readFile(path.join(site, "llms.txt"), "utf8"), /\(https:\/\/alexportelli12\.github\.io\/mexxi\/docs\/commands\/wettaq\.md\)/);
  assert.match(await readFile(path.join(site, "commands/wettaq.md"), "utf8"), /^# \/wettaq/);

  // Search: a word taken from each skill's description finds that skill's page.
  const chunks = path.join(site, "assets/chunks");
  const indexFile = (await readdir(chunks)).find((name) => name.startsWith("@localSearchIndexroot"));
  assert.ok(indexFile, "VitePress wrote its local search index");
  const indexModule = await readFile(path.join(chunks, indexFile), "utf8");
  const serialised = (await import(`data:text/javascript;base64,${Buffer.from(indexModule).toString("base64")}`)).default;
  const search = MiniSearch.loadJSON(serialised, { fields: ["title", "titles", "text"], storeFields: ["title", "titles"] });
  const skills = [];
  for (const file of trackedPaths(root).filter((name) => /^skills\/[^/]+\/SKILL\.md$/.test(name))) {
    skills.push({ name: file.split("/")[1], description: parseFrontmatter(await readFile(path.join(root, file), "utf8")).data.description });
  }
  assert.ok(skills.length >= 10);
  const wordsOf = (text) => new Set(text.toLowerCase().match(/[a-z]{7,}/g));
  for (const skill of skills) {
    const others = new Set(skills.filter((other) => other !== skill).flatMap((other) => [...wordsOf(other.description)]));
    const word = [...wordsOf(skill.description)].filter((candidate) => !others.has(candidate)).sort((a, b) => b.length - a.length)[0];
    assert.ok(word, `${skill.name}'s description has a word no other skill's has`);
    const page = `/mexxi/docs/${skill.name === "workflow-for-alex" ? "principles/workflow" : `skills/${skill.name}`}.html`;
    const hits = search.search(word, { prefix: true }).map((hit) => hit.id);
    assert.ok(hits.some((id) => id.startsWith(page)), `searching "${word}" should find ${page}; found ${hits.slice(0, 5).join(", ")}`);
  }
});

test("the build fails on a planted broken internal link", async () => {
  const directory = await copyRepo({ edit: { "docs/glossary.md": (text) => `${text}\nSee [a page that is not there](no-such-page.md).\n` } });
  const { out, site } = outputs(directory);
  await assert.rejects(buildDocs({ root: directory, out, site }), /dead link/i);
});

test("the build fails on a skill without a description", async () => {
  const directory = await copyRepo({ edit: { "skills/angular/SKILL.md": (text) => text.replace(/^description:[\s\S]*?(?=\n---)/m, "") } });
  const { out, site } = outputs(directory);
  await assert.rejects(buildDocs({ root: directory, out, site, render: false }), /skills\/angular\/SKILL\.md has no `description`/);
});
