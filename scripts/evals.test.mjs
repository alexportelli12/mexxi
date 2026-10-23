import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "evals/triggers");
// The skills whose triggering is evaluated. verifika ships from npm, so its
// SKILL.md is read from the installed package; the others live in skills/.
const coreSkills = ["rendered-qa", "repo-context", "commit-pr-writing", "test-design", "verifika"];
const skillFile = (name) => name === "verifika"
  ? path.join(root, "node_modules/verifika/skills/verifika/SKILL.md")
  : path.join(root, "skills", name, "SKILL.md");

test("every core skill has a trigger eval set, and nothing else is in the folder", async () => {
  assert.deepEqual((await readdir(directory)).sort(), coreSkills.map((name) => `${name}.json`).sort());
});

for (const name of coreSkills) {
  test(`${name}'s trigger evals are well formed and match its skill`, async () => {
    const frontmatter = (await readFile(skillFile(name), "utf8")).match(/^---\nname: (.+)\ndescription: .+\n/);
    assert.equal(frontmatter?.[1], name, "the skill the eval set names exists with a description");
    const evals = JSON.parse(await readFile(path.join(directory, `${name}.json`), "utf8"));
    assert.ok(Array.isArray(evals), "skill-creator's run_eval.py reads a JSON array");
    for (const item of evals) {
      assert.deepEqual(Object.keys(item).sort(), ["query", "should_trigger"]);
      assert.equal(typeof item.should_trigger, "boolean");
      assert.ok(typeof item.query === "string" && item.query.trim().length >= 20, `query is substantive: ${item.query}`);
    }
    // Near-miss negatives matter as much as positives, so both sides need weight.
    const positives = evals.filter((item) => item.should_trigger).length;
    assert.ok(positives >= 6 && evals.length - positives >= 6, `${name} needs at least 6 queries on each side`);
    assert.equal(new Set(evals.map((item) => item.query)).size, evals.length, "queries are unique");
  });
}
