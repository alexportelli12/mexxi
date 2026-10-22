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
import { buildSidebar } from "./lib/generate.mjs";
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
  const { data, body } = parseFrontmatter("---\nname: x\ndescription: >-\n  one\n  two\nsources:\n  - a/**\n  - b.md\nlist: [c, 'd']\nmetadata:\n  optional: \"For x.\"\nreviewed: 2026-10-21\n---\nbody\n");
  assert.deepEqual(data, { name: "x", description: "one two", sources: ["a/**", "b.md"], list: ["c", "d"], metadata: { optional: "For x." }, reviewed: "2026-10-21" });
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

test("the landing page's dictionary entries match names.json, and both pages link the names page", async () => {
  const files = await readAllowed(root);
  const landing = files.get("site/index.html");
  const readme = files.get("README.md");
  files.set("site/index.html", landing.replace("to carry out", "to build").replace('data-name="lesti"', 'data-name="other"').replaceAll('href="docs/names.html"', 'href="docs/"').replace("mexxi</span>: Maltese", "mexxi</span>, Maltese").replace('<span class="entry__pos">verb</span>', '<span class="entry__pos">noun</span>'));
  files.set("README.md", readme.replaceAll("https://alexportelli12.github.io/mexxi/docs/names.html", "https://alexportelli12.github.io/mexxi/docs/"));
  const problems = checkConsistency(files).join("\n");
  assert.match(problems, /the wettaq entry must show its meaning/);
  assert.match(problems, /needs an entry with data-name="lesti"/);
  assert.match(problems, /site\/index\.html: link to the names page/);
  assert.match(problems, /README\.md: link to the names page/);
  assert.match(problems, /give mexxi's meaning/);
  assert.match(problems, /the mexxi entry must show its partOfSpeech/);
});

test("the README runs the problem, solutions, getting started with the prompts, then links", async () => {
  const files = await readAllowed(root);
  const readme = files.get("README.md");
  const problemsSection = readme.match(/^## The problem[\s\S]*?(?=^## )/m)[0];
  files.set("README.md", readme.replace(problemsSection, "").replace(/^## Learn more/m, `${problemsSection}## Learn more`));
  assert.match(checkConsistency(files).join("\n"), /sections must run The problem/);
  const prompts = JSON.parse(files.get("prompts.json"));
  files.set("README.md", readme.replace(prompts.install.text, "").replace(/^## The problem/m, `${prompts.install.text}\n\n## The problem`));
  assert.match(checkConsistency(files).join("\n"), /"install" prompt belongs in Getting started/);
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

test("the build fails on a link to a source file git does not track", async () => {
  const directory = await copyRepo({ edit: { "skills/angular/SKILL.md": (text) => `${text}\nSee [the helper](scripts/no-such-file.mjs).\n` } });
  const { out, site } = outputs(directory);
  await assert.rejects(
    buildDocs({ root: directory, out, site }),
    /skills\/angular\/SKILL\.md: link to scripts\/no-such-file\.mjs .*does not track/,
  );
});

test("the build fails on a skill without a description", async () => {
  const directory = await copyRepo({ edit: { "skills/angular/SKILL.md": (text) => text.replace(/^description:[\s\S]*?(?=\n---)/m, "") } });
  const { out, site } = outputs(directory);
  await assert.rejects(buildDocs({ root: directory, out, site, render: false }), /skills\/angular\/SKILL\.md has no `description`/);
});

test("decision records are published with an index, and a record without a status fails the build", async () => {
  const good = await copyRepo();
  const built = outputs(good);
  await buildDocs({ root: good, ...built, render: false });
  const index = await readFile(path.join(built.out, "decisions/index.md"), "utf8");
  assert.match(index, /\| \[0001\. One shared workflow, thin host adapters\]\(0001-shared-workflow-host-adapters\.md\) \| Accepted \| \d{4}-\d{2}-\d{2} \|/);
  assert.match(await readFile(path.join(built.out, "decisions/0004-isolated-worktree-per-task.md"), "utf8"), /\*\*Status:\*\* Accepted/);

  const bad = await copyRepo({ edit: { "docs/decisions/0001-shared-workflow-host-adapters.md": (text) => text.replace(/^status: .*\n/m, "") } });
  const { out, site } = outputs(bad);
  await assert.rejects(buildDocs({ root: bad, out, site, render: false }), /0001-shared-workflow-host-adapters\.md: state the decision's `status`/);
});

test("a command page leads with its summary and folds the agent instructions; a command without a summary fails the build", async () => {
  const good = await copyRepo();
  const built = outputs(good);
  const { pages } = await buildDocs({ root: good, ...built, render: false });
  const wettaq = await readFile(path.join(built.out, "public/commands/wettaq.md"), "utf8");
  const summary = parseFrontmatter(await readFile(path.join(root, "commands/wettaq.md"), "utf8")).data.summary;
  assert.ok(wettaq.indexOf(summary) < wettaq.indexOf("::: details Full agent instructions"), "the summary comes before the folded instructions");
  // It opens with its dictionary entry from names.json; the plain copy drops the styling attribute.
  assert.match(wettaq, /^# \/wettaq\n\n\*\*wettaq\*\* · verb · “to carry out”  \nTakes a request/);
  assert.doesNotMatch(wettaq, /\{\.dictionary\}/);
  assert.match(await readFile(path.join(built.out, "commands/wettaq.md"), "utf8"), /pull request\. \{\.dictionary\}\n/);
  assert.match(wettaq, /\*Old name: `\/implement`, which still works for one release\.\*\n*$/);
  // The names page has an entry for every name.
  const namesPage = await readFile(path.join(built.out, "names.md"), "utf8");
  for (const entry of JSON.parse(await readFile(path.join(root, "names.json"), "utf8"))) {
    assert.ok(namesPage.includes(`**${entry.name}** · ${entry.partOfSpeech} · “${entry.meaning.join(", ")}”`), `names page has an entry for ${entry.name}`);
  }
  // The headings folded in the instructions stay out of the built page's outline.
  assert.match(await readFile(path.join(built.out, "commands/wettaq.md"), "utf8"), /^---\noutline: false\n---\n\n# \/wettaq/);

  // Start here leads, and Principles, Decisions and History sit under the hood.
  const sidebar = buildSidebar(pages);
  assert.deepEqual(sidebar.map((section) => section.text), ["Start here", "Commands", "Agents", "Skills", "CLI reference", "Configuration", "Under the hood"]);
  assert.deepEqual(sidebar.at(-1).items.map((group) => group.text), ["Principles", "Decisions", "History"]);
  assert.equal(sidebar[0].items[2].link, "/reviewing-a-pull-request");
  // Commands run in names.json's order, by how often people use them.
  assert.deepEqual(sidebar[1].items.slice(1, 4).map((item) => item.text), ["/wettaq", "/lesti", "/ittestja"]);

  // Skills are grouped by purpose, an optional one says so, and every page
  // says first what problem it solves.
  const skills = await readFile(path.join(built.out, "skills/index.md"), "utf8");
  assert.match(skills.split("## UI work")[1].split("## Setup")[0], /\[angular\]\(angular\.md\) \(optional: Angular repositories only\)/);
  assert.match(skills.split("## Setup")[1], /\[ibda\]/);
  assert.match(wettaq, /\n\*\*The problem it solves:\*\* .+\n\nUse it for any change/);
  const cli = await readFile(path.join(built.out, "public/cli/index.md"), "utf8");
  assert.ok(cli.indexOf("## The agent's lifecycle") < cli.indexOf("### ibni prepare") && cli.indexOf("### ibni prepare") < cli.indexOf("### ibni mark-pr") && cli.indexOf("### ibni mark-pr") < cli.indexOf("## Commands you might run"));
  assert.match(cli, /### ibni cleanup\n\n\*\*The problem it solves:\*\* /);
  assert.match(await readFile(path.join(built.out, "public/agents/code-reviewer.md"), "utf8"), /\*\*What it cannot do:\*\* .+\n[\s\S]*::: details Full agent instructions/);
  const configuration = await readFile(path.join(built.out, "public/configuration/index.md"), "utf8");
  assert.ok(configuration.indexOf("## Common changes") < configuration.indexOf("## Settings in config.json"));
  assert.match(configuration, /### jev\n\n::: info Experimental/);
  assert.match(configuration, /## Settings in \.mexxi\.json[\s\S]*`ciCheck`/);

  const bad = await copyRepo({ edit: { "commands/lesti.md": (text) => text.replace(/^summary: >-\n(?: {2}.+\n)+/m, "") } });
  const { out, site } = outputs(bad);
  await assert.rejects(buildDocs({ root: bad, out, site, render: false }), /commands\/lesti\.md has no `summary`/);
});

test("a command, skill, agent, config group or ibni subcommand without a why fails the build", async () => {
  const cases = [
    [{ "commands/lesti.md": (text) => text.replace(/^why: .*\n/m, "") }, /commands\/lesti\.md has no `why`/],
    [{ "skills/angular/SKILL.md": (text) => text.replace(/^ {2}why: .*\n/m, "") }, /skills\/angular\/SKILL\.md has no `metadata\.why`/],
    [{ "docs/agents.json": (text) => text.replace(/"why": "An agent that reviews[^"]*",/, "") }, /docs\/agents\.json has no `code-reviewer\.why`/],
    [{ "config.schema.json": (text) => text.replace(/\n {6}"why": "Session transcripts[^"]*",/, "") }, /config\.schema\.json: retro has no `why`/],
    [{ "scripts/ibni/ibni.mjs": (text) => text.replace(/^ {4}why: "Kept worktrees[^"]*",\n/m, "") }, /ibni cleanup --help has no "Why:" line/],
  ];
  for (const [edit, message] of cases) {
    const directory = await copyRepo({ edit });
    const { out, site } = outputs(directory);
    await assert.rejects(buildDocs({ root: directory, out, site, render: false }), message);
  }
});
