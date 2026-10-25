import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { checkFreshness, FreshnessError } from "./fresh.mjs";
import { sweepStaleFixtures } from "./lib/fixtures.mjs";

const run = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = async (directory, file, text) => {
  await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
  await writeFile(path.join(directory, file), text);
};
const page = (sources, reviewed = "2026-01-01") => `---\nsources:\n${sources.map((source) => `  - ${source}`).join("\n")}\nreviewed: ${reviewed}\n---\n# Page\n`;
const sidecar = (reviewed = "2026-01-01") => `${JSON.stringify({ "README.md": { sources: ["src/**"], reviewed }, "site/index.html": { sources: ["src/b.txt"], reviewed } })}\n`;

// Fixtures a killed run left behind are removed before any are made.
await sweepStaleFixtures("mexxi-fresh-");
const fixtures = [];
after(() => Promise.all(fixtures.map((directory) => rm(directory, { recursive: true, force: true }))));

// A repository with an origin whose default branch is main, and a feature
// branch checked out in a clone of it.
async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mexxi-fresh-"));
  fixtures.push(parent);
  const origin = path.join(parent, "origin.git");
  const seed = path.join(parent, "seed");
  run(parent, "init", "-q", "--bare", "-b", "main", origin);
  run(parent, "init", "-q", "-b", "main", seed);
  await write(seed, "src/a.txt", "a\n");
  await write(seed, "src/b.txt", "b\n");
  await write(seed, "docs/page.md", page(["src/a.txt"]));
  await write(seed, "docs/freshness.json", sidecar());
  await write(seed, "README.md", "# R\n");
  await write(seed, "site/index.html", "<html></html>\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "seed");
  run(seed, "remote", "add", "origin", origin);
  run(seed, "push", "-q", "origin", "main");
  const clone = path.join(parent, "clone");
  run(parent, "clone", "-q", origin, clone);
  run(clone, "checkout", "-q", "-b", "feature");
  return clone;
}
const commit = (clone, message) => {
  run(clone, "add", "-A");
  run(clone, "commit", "-qm", message);
};

test("a changed source without its page names the page", async () => {
  const clone = await fixture();
  await write(clone, "src/a.txt", "changed\n");
  commit(clone, "change a source");
  const problems = await checkFreshness({ root: clone, env: {} });
  assert.equal(problems.length, 2, problems.join("\n")); // docs/page.md and README.md
  assert.match(problems[0], /^docs\/page\.md: review it, because src\/a\.txt changed/);
});

test("editing the page, or bumping its reviewed date, satisfies the rule", async () => {
  const clone = await fixture();
  await write(clone, "src/a.txt", "changed\n");
  await write(clone, "docs/page.md", page(["src/a.txt"], "2026-02-02"));
  await write(clone, "docs/freshness.json", sidecar("2026-02-02"));
  commit(clone, "change a source and review the pages");
  assert.deepEqual(await checkFreshness({ root: clone, env: {} }), []);
});

test("README and the landing page are checked through docs/freshness.json", async () => {
  const clone = await fixture();
  await write(clone, "src/b.txt", "changed\n");
  commit(clone, "change b");
  const problems = await checkFreshness({ root: clone, env: {} });
  assert.deepEqual(problems.map((problem) => problem.split(":")[0]).sort(), ["README.md", "site/index.html"]);
  await write(clone, "README.md", "# Reviewed\n");
  assert.deepEqual((await checkFreshness({ root: clone, env: {} })).map((problem) => problem.split(":")[0]), ["site/index.html"]);
});

test("uncommitted and untracked changes count", async () => {
  const clone = await fixture();
  await write(clone, "src/a.txt", "dirty\n");
  assert.match((await checkFreshness({ root: clone, env: {} }))[0], /docs\/page\.md/);
});

test("a branch that changes no source passes", async () => {
  const clone = await fixture();
  await write(clone, "unrelated.txt", "x\n");
  commit(clone, "unrelated");
  assert.deepEqual(await checkFreshness({ root: clone, env: {} }), []);
});

test("a missing declaration, a bad date and a stale glob are reported", async () => {
  const clone = await fixture();
  await write(clone, "docs/page.md", "# No frontmatter\n");
  await write(clone, "docs/other.md", page(["gone/**"], "soon"));
  await write(clone, "docs/third.md", page(["gone/**"]));
  commit(clone, "bad pages");
  const text = (await checkFreshness({ root: clone, env: {} })).join("\n");
  assert.match(text, /docs\/page\.md: declare what it describes/);
  assert.match(text, /docs\/other\.md: `reviewed` must be a YYYY-MM-DD date/);
  assert.match(text, /docs\/third\.md: source `gone\/\*\*` matches no tracked file/);
});

test("with no origin ref it fails loudly instead of skipping, and MEXXI_DOCS_BASE supplies one", async () => {
  const clone = await fixture();
  run(clone, "remote", "remove", "origin");
  await assert.rejects(checkFreshness({ root: clone, env: {} }), (error) => error instanceof FreshnessError && /no base to compare with.*MEXXI_DOCS_BASE/.test(error.message));
  await write(clone, "src/a.txt", "changed\n");
  commit(clone, "change a source");
  const first = run(clone, "rev-list", "--max-parents=0", "HEAD").trim();
  assert.match((await checkFreshness({ root: clone, env: { MEXXI_DOCS_BASE: first } }))[0], /docs\/page\.md/);
});

// Break: the sweep removes a running suite's fresh fixtures, another prefix's
// directories, or nothing at all.
test("sweepStaleFixtures removes only its prefix's directories older than an hour", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-sweep-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const make = async (name, ageMs) => {
    await mkdir(path.join(directory, name, "inside"), { recursive: true });
    const when = new Date(now - ageMs);
    await utimes(path.join(directory, name), when, when);
  };
  await make("mexxi-fresh-old", 2 * 60 * 60 * 1000);
  await make("mexxi-fresh-young", 10 * 60 * 1000);
  await make("mexxi-docs-old", 2 * 60 * 60 * 1000);
  await writeFile(path.join(directory, "mexxi-fresh-file"), "not a directory");

  const removed = await sweepStaleFixtures("mexxi-fresh-", { directory, now });
  assert.deepEqual(removed, [path.join(directory, "mexxi-fresh-old")]);
  for (const kept of ["mexxi-fresh-young", "mexxi-docs-old", "mexxi-fresh-file"]) assert.ok(await stat(path.join(directory, kept)), `${kept} is kept`);
});
