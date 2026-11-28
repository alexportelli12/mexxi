// Links come from evidence only: a branch git reports, an issue named in the first
// prompt or closed by the pull request, a pull request whose head ref is exactly
// the branch. Never a guess.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createLinkResolver, currentBranch, issueFromPrompt, issuesClosedByPull, pullsForBranch, sessionsForPull } from "../lib/links.mjs";
import { makeRepo } from "./helpers.mjs";

test("an issue is read from /wettaq #N and from any slash command whose argument is #N", () => {
  assert.equal(issueFromPrompt("/wettaq #42 https://github.com/me/app/issues/42").number, 42);
  assert.equal(issueFromPrompt("  /lesti #7").number, 7);
});

test("an issue linked without evidence: a bare #N in prose, or a link to another repository's issue, is no link", () => {
  assert.equal(issueFromPrompt("please fix the #3 bugs in the parser"), null);
  assert.equal(issueFromPrompt("see https://github.com/other/repo/issues/9", "me/app"), null);
  assert.equal(issueFromPrompt("see https://github.com/me/app/issues/9", "me/app").number, 9);
  assert.equal(issueFromPrompt(null), null);
});

test("a pull request's closed issues come from GitHub's references, else from Closes/Fixes/Resolves in its body", () => {
  assert.deepEqual(issuesClosedByPull({ closingIssuesReferences: [{ number: 5 }], body: "Fixes #6" }), [5]);
  assert.deepEqual(issuesClosedByPull({ body: "Closes #6, fixes #7 and resolves #6. Mentions #8." }), [6, 7]);
  assert.deepEqual(issuesClosedByPull({ body: "Related to #8" }), []);
});

test("a PR linked by title or similar branch name: only an exact head ref matches", () => {
  const pulls = [
    { number: 1, headRefName: "agent/fix-parser-2", title: "Fix the parser" },
    { number: 2, headRefName: "agent/fix-parser", title: "Something else" },
  ];
  assert.deepEqual(pullsForBranch(pulls, "agent/fix-parser").map((pull) => pull.number), [2]);
  assert.deepEqual(pullsForBranch(pulls, "agent/fix"), []);
  assert.deepEqual(pullsForBranch(pulls, null), []);
});

test("a pull request maps back to the sessions on its head branch in the same repository only", () => {
  const sessions = [
    { id: "a", repo: "app", links: { branch: { name: "agent/x" } } },
    { id: "b", repo: "other", links: { branch: { name: "agent/x" } } },
    { id: "c", repo: "app", links: { branch: { name: "agent/y" } } },
    { id: "d", repo: "app", links: { branch: null } },
  ];
  assert.deepEqual(sessionsForPull({ repo: "app", headRefName: "agent/x" }, sessions).map((session) => session.id), ["a"]);
});

test("the branch is the one git reports in the session's folder, and a folder that is no repository has none", async (t) => {
  const repo = makeRepo(t);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/linked"]);
  assert.equal(await currentBranch(repo), "agent/linked");
  assert.equal(await currentBranch("/nonexistent/hares-links"), null);
});

test("a session's links carry their evidence, and the issue falls back to what its pull request closes", async () => {
  const asked = [];
  const resolver = createLinkResolver({
    branchOf: async () => "agent/fix-parser",
    slugFor: async () => "me/app",
    findPullsForBranch: async (query) => {
      asked.push(query);
      return [{ number: 3, headRefName: "agent/fix-parser-old" }, { number: 4, headRefName: "agent/fix-parser", url: "https://github.com/me/app/pull/4", body: "Closes #11" }];
    },
  });
  const links = await resolver.resolve({ repo: "app", cwd: "/w/app", firstPrompt: "Fix the parser" });
  assert.deepEqual(asked, [{ repo: "app", branch: "agent/fix-parser" }]);
  assert.equal(links.branch.name, "agent/fix-parser");
  assert.equal(links.pull.number, 4);
  assert.deepEqual(links.pull.evidence, { kind: "head-ref", text: "agent/fix-parser" });
  assert.equal(links.issue.number, 11);
  assert.equal(links.issue.url, "https://github.com/me/app/issues/11");
  assert.equal(links.issue.evidence.kind, "pull-request");
});

test("with no branch, no pull request is looked up and none is linked; a failing lookup links none", async () => {
  let lookups = 0;
  const none = createLinkResolver({ branchOf: async () => null, findPullsForBranch: async () => { lookups += 1; return []; } });
  assert.deepEqual(await none.resolve({ repo: "app", cwd: "/w/app", firstPrompt: "/wettaq #2" }), { branch: null, issue: { number: 2, evidence: { kind: "first-prompt", text: "/wettaq #2" } }, pull: null });
  assert.equal(lookups, 0);
  const failing = createLinkResolver({ branchOf: async () => "main", findPullsForBranch: async () => { throw new Error("offline"); } });
  assert.equal((await failing.resolve({ repo: "app", cwd: "/w/app" })).pull, null);
});

test("links are cached for a minute and looked up again after it", async () => {
  let clock = 0;
  let calls = 0;
  const resolver = createLinkResolver({ now: () => clock, branchOf: async () => { calls += 1; return "b"; } });
  await resolver.resolve({ repo: "app", cwd: "/w" });
  clock = 59_000;
  await resolver.resolve({ repo: "app", cwd: "/w" });
  assert.equal(calls, 1);
  clock = 61_000;
  await resolver.resolve({ repo: "app", cwd: "/w" });
  assert.equal(calls, 2);
});
