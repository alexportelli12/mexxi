// The cross-repository board: grouping, issues, Actions "main red", PR detail, branch lookup and the
// cache, all through a fake fetch serving fixtures/github. GitHub is never called.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { closingIssues, createGithubBoard, summarizeChecks } from "../lib/github-board.mjs";
import { saveGithubToken } from "../lib/github.mjs";
import { tempDir } from "./helpers.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL("./fixtures/github/" + name, import.meta.url), "utf8"));
const TOKEN = "github_pat_" + "A1b2C3d4E5".repeat(8);
const REPOS = [{ name: "my-app", path: "/nonexistent/my-app", github: "example/my-app" }];

function fakeGithub({ runs = "actions-runs-main-red.json", fail = {} } = {}) {
  const calls = [];
  const checks = fixture("check-runs.json");
  const pulls = fixture("pulls-open.json");
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const bySha = (sha) => Object.entries(checks).find(([number]) => pulls.find((entry) => entry.number === Number(number)).head.sha === sha)?.[1] ?? [];
  const fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, search: url.search, method: init.method, accept: init.headers.Accept });
    if (fail[url.pathname]) return new Response("{}", { status: fail[url.pathname] });
    const p = url.pathname.replace("/repos/example/my-app", "");
    let match;
    if (p === "/") return json({ default_branch: "main" });
    if (p === "/pulls") return json(url.searchParams.get("head") ? fixture("pulls-by-branch.json") : pulls);
    if (p === "/issues") return json(fixture("issues-open.json"));
    if (p === "/actions/runs") return json(fixture(runs));
    if ((match = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p))) return json({ total_count: 1, check_runs: bySha(match[1]) });
    if (/^\/commits\/[0-9a-f]{40}\/statuses$/.test(p)) return json([]);
    if ((match = /^\/pulls\/(\d+)\/reviews$/.exec(p))) return json(match[1] === "1" ? fixture("reviews-1.json") : match[1] === "4" ? [{ id: 1, state: "APPROVED" }] : []);
    if (p === "/pulls/1") return json(fixture("pull-1-html.json"));
    if (p === "/issues/1/comments") return json(fixture("issue-comments-1.json"));
    if (p === "/pulls/1/comments") return json(fixture("review-comments-1.json"));
    return new Response("{}", { status: 404 });
  };
  return { fetch, calls };
}

function boot(t, { github = fakeGithub(), readyPulls = [4], token = TOKEN, repositories = REPOS } = {}) {
  const stateDir = tempDir(t, "hares-state-");
  if (token) saveGithubToken(stateDir, token);
  const clock = { now: 1_000_000 };
  const readiness = { forPr: async ({ number }) => ({ ready: readyPulls.includes(number) }) };
  const board = createGithubBoard({ settings: { hares: { repositories } }, stateDir, fetch: github.fetch, now: () => clock.now, readiness });
  return { board, github, clock };
}
const numbers = (list) => list.map((item) => item.number);

test("open pull requests are grouped: review requested, ready, failing and bumps, with a failing bump counted as failing", async (t) => {
  const { board } = boot(t);
  const { pulls } = (await board.board()).repos[0].pulls;
  assert.deepEqual(numbers(pulls.toReview), [1]);
  assert.deepEqual(numbers(pulls.ready), [4]);
  assert.deepEqual(numbers(pulls.failing).sort(), [2, 6]);
  assert.deepEqual(numbers(pulls.bumps), [3]);
  assert.deepEqual(numbers(pulls.other), [5], "a draft is in no review group");
  assert.equal(pulls.failing.find((item) => item.number === 6).bump, true);
  assert.deepEqual(pulls.failing.find((item) => item.number === 2).checks.failing, ["verify"]);
});

test("a bump that passes is judged like any pull request: it is ready when readiness says so", async (t) => {
  const { board } = boot(t, { readyPulls: [3, 4] });
  const { pulls } = (await board.board()).repos[0].pulls;
  assert.deepEqual(numbers(pulls.ready).sort(), [3, 4]);
  assert.deepEqual(pulls.bumps, []);
});

test("nothing is ready when readiness can't be computed", async (t) => {
  const { board } = boot(t);
  const stateDir = tempDir(t, "hares-state-");
  saveGithubToken(stateDir, TOKEN);
  const broken = createGithubBoard({ settings: { hares: { repositories: REPOS } }, stateDir, fetch: fakeGithub().fetch, readiness: { forPr: async () => { throw new Error("boom"); } } });
  const { pulls } = (await broken.board()).repos[0].pulls;
  assert.deepEqual(pulls.ready, []);
  assert.deepEqual(numbers(pulls.toReview), [1]);
  assert.ok(board);
});

test("issues exclude pull requests", async (t) => {
  const { board } = boot(t);
  const { issues } = (await board.board()).repos[0].issues;
  assert.deepEqual(numbers(issues), [12, 13]);
  assert.deepEqual(issues[0].labels, ["bug"]);
});

test("Actions: the latest verdict of each workflow on the default branch decides main red, and a feature branch's red run does not", async (t) => {
  const red = await boot(t).board.board();
  assert.deepEqual(red.mainRed, ["my-app"]);
  assert.deepEqual(red.repos[0].actions.main.failing.map((run) => run.name), ["build"]);
  assert.equal(red.repos[0].actions.runs.length, 5);
  const green = await boot(t, { github: fakeGithub({ runs: "actions-runs-main-green.json" }) }).board.board();
  assert.deepEqual(green.mainRed, []);
  assert.equal(green.repos[0].actions.main.red, false);
});

test("the board only sends GETs to the configured repository, asks for 10 runs, and uses the read token", async (t) => {
  const { board, github } = boot(t);
  await board.board();
  for (const call of github.calls) {
    assert.equal(call.method, "GET");
    assert.ok(call.path.startsWith("/repos/example/my-app"), call.path);
  }
  assert.ok(github.calls.some((call) => call.path === "/repos/example/my-app/actions/runs" && call.search === "?per_page=10"));
});

test("answers are cached for 30 seconds, refetched after, and fresh skips the cache", async (t) => {
  const { board, github, clock } = boot(t);
  await board.board();
  const first = github.calls.length;
  clock.now += 29_000;
  await board.board();
  assert.equal(github.calls.length, first, "inside 30 s nothing is refetched");
  await board.board({ fresh: true });
  assert.equal(github.calls.length, first * 2, "fresh refetches");
  clock.now += 31_000;
  await board.board();
  assert.equal(github.calls.length, first * 3, "after 30 s it refetches");
});

test("one failing part shows its own error and the rest of the repository still loads", async (t) => {
  const { board } = boot(t, { github: fakeGithub({ fail: { "/repos/example/my-app/issues": 500 } }) });
  const repo = (await board.board()).repos[0];
  assert.match(repo.issues.error, /GitHub answered 500 for \/repos\/example\/my-app\/issues/);
  assert.deepEqual(numbers(repo.pulls.pulls.ready), [4]);
  await assert.rejects(board.listIssues("my-app", { fresh: true }), (error) => error.status === 502);
});

test("without a GitHub token every repository shows how to set it up and GitHub is not called", async (t) => {
  const { board, github } = boot(t, { token: null });
  const [repo] = (await board.board()).repos;
  assert.match(repo.error, /GitHub data source isn't set up/);
  assert.equal(github.calls.length, 0);
});

test("a repository that fails doesn't take the others down", async (t) => {
  const { board } = boot(t, { repositories: [...REPOS, { name: "other", path: "/x", github: "not a slug" }] });
  const repos = (await board.board()).repos;
  assert.equal(repos[0].error, null);
  assert.match(repos[1].error, /github setting must be owner\/name/);
});

test("pull request detail sanitizes the description, asks GitHub for HTML, and groups review comments into threads by reply chain", async (t) => {
  const { board, github } = boot(t);
  const detail = await board.prDetail("my-app", 1);
  assert.ok(!/script|steal|javascript:|evil\.example|onclick/.test(JSON.stringify(detail)), "nothing unsafe reaches the page");
  assert.match(detail.bodyHtml, /<h2>Adds search<\/h2>/);
  assert.match(detail.bodyHtml, /camo\.githubusercontent\.com\/abc/);
  assert.match(detail.bodyHtml, /<input type="checkbox" disabled checked>/);
  assert.deepEqual(detail.threads.map((thread) => [thread.id, thread.comments.map((comment) => comment.id)]), [[100, [100, 101, 102]], [200, [200]], [300, [300]]]);
  assert.equal(detail.threads[0].path, "src/search.mjs");
  assert.equal(detail.threads[2].outdated, true);
  assert.equal(detail.threads[0].outdated, false);
  assert.equal(detail.comments[0].bodyHtml, "<p>Looks good <b>overall</b></p>");
  assert.equal(detail.reviews[0].state, "CHANGES_REQUESTED");
  assert.equal(detail.checks.state, "passing");
  assert.equal(detail.filesUrl, "https://github.com/example/my-app/pull/1/files");
  for (const path of ["/pulls/1", "/issues/1/comments", "/pulls/1/comments", "/pulls/1/reviews"]) {
    const call = github.calls.find((entry) => entry.path === "/repos/example/my-app" + path);
    assert.equal(call.accept, "application/vnd.github.html+json", path);
  }
});

test("detail links the issues the description closes in this repository, and not one in another repository", async (t) => {
  const detail = await boot(t).board.prDetail("my-app", 1);
  assert.deepEqual(detail.closes, [
    { number: 12, url: "https://github.com/example/my-app/issues/12" },
    { number: 13, url: "https://github.com/example/my-app/issues/13" },
  ]);
  assert.deepEqual(closingIssues("Closes #1, resolves example/my-app#2, fixes other/repo#3, see #4, Fixed: #5", "example/my-app"), [1, 2, 5]);
});

test("detail passes the linked session to readiness, and a missing pull request is a 404, a bad number a 400", async (t) => {
  const stateDir = tempDir(t, "hares-state-");
  saveGithubToken(stateDir, TOKEN);
  const seen = [];
  const board = createGithubBoard({ settings: { hares: { repositories: REPOS } }, stateDir, fetch: fakeGithub().fetch, readiness: { forPr: async (target) => { seen.push(target); return { ready: false, checks: [] }; } } });
  const detail = await board.prDetail("my-app", 1, { sessionId: "s-1" });
  assert.deepEqual(seen, [{ repo: "my-app", number: 1, sessionId: "s-1" }]);
  assert.equal(detail.readiness.ready, false);
  await assert.rejects(board.prDetail("my-app", 999), (error) => error.status === 404);
  await assert.rejects(board.prDetail("my-app", "1"), (error) => error.status === 400);
  await assert.rejects(board.prDetail("nope", 1), (error) => error.status === 404);
});

test("prForBranch matches the head branch exactly in this repository, preferring an open pull request, and ignores a fork's or a similar name", async (t) => {
  const { board } = boot(t);
  const found = await board.prForBranch("my-app", "agent/search");
  assert.equal(found.number, 19);
  assert.equal(found.state, "open");
  assert.equal(await board.prForBranch("my-app", "agent/other"), null, "no exact match: no guess");
  assert.equal(await board.prForBranch("my-app", "not a branch\n"), null);
});

test("summarizeChecks reads the newest run of each check, so a green rerun clears an earlier red and a pending one is not green", () => {
  const run = (id, conclusion, status = "completed") => ({ id, name: "verify", app: { id: 1 }, status, conclusion });
  assert.equal(summarizeChecks([run(1, "failure"), run(2, "success")]).state, "passing");
  assert.equal(summarizeChecks([run(2, "failure"), run(1, "success")]).state, "failing");
  assert.equal(summarizeChecks([run(1, "success"), run(2, null, "in_progress")]).state, "pending");
  assert.equal(summarizeChecks([run(1, "cancelled")]).state, "passing", "a newer push cancels; cancelled is not red");
  assert.equal(summarizeChecks([], [{ id: 1, context: "ci/x", state: "error" }]).state, "failing");
  assert.equal(summarizeChecks([]).state, "none");
});

/** The board with linkedSession given, and GitHub's per-pull answers (mergeable, size) for #3 and #4. */
function bootLinked(t, { linked = {}, readiness }) {
  const stateDir = tempDir(t, "hares-state-");
  saveGithubToken(stateDir, TOKEN);
  const github = fakeGithub();
  const detail = { "/repos/example/my-app/pulls/4": { mergeable: true, additions: 12, deletions: 3, commits: 2, changed_files: 1 }, "/repos/example/my-app/pulls/3": { mergeable: false } };
  const fetch = async (input, init) => {
    const found = detail[new URL(input).pathname];
    return found ? new Response(JSON.stringify(found), { status: 200 }) : github.fetch(input, init);
  };
  return createGithubBoard({ settings: { hares: { repositories: REPOS } }, stateDir, fetch, readiness, linkedSession: ({ number }) => linked[number] ?? null });
}

test("a pull request no session made is ready on GitHub's facts alone: not a draft, mergeable and every check green", async (t) => {
  const asked = [];
  const board = bootLinked(t, { readiness: { forPr: async (target) => { asked.push(target); return { ready: false }; } } });
  const { pulls } = (await board.board()).repos[0].pulls;
  assert.deepEqual(numbers(pulls.ready).sort(), [1, 4], "mergeable and green (#1's own answer says mergeable too)");
  assert.ok(!numbers(pulls.ready).includes(3), "green but not mergeable is not ready");
  assert.ok(!numbers(pulls.ready).includes(5), "a draft is never ready");
  assert.deepEqual(asked, [], "no session made them, so the session gate is not asked");
  const four = pulls.ready.find((item) => item.number === 4);
  assert.deepEqual([four.additions, four.deletions, four.commits], [12, 3, 2]);
  assert.ok(four.groups.includes("ready"));
});

test("a pull request a session made keeps the readiness gate, asked with that session", async (t) => {
  const asked = [];
  const board = bootLinked(t, { linked: { 4: "11111111-1111-4111-8111-111111111111" }, readiness: { forPr: async (target) => { asked.push(target); return { ready: false }; } } });
  const { pulls } = (await board.board()).repos[0].pulls;
  assert.ok(!numbers(pulls.ready).includes(4), "mergeable and green is not enough once a session made it");
  assert.deepEqual(asked, [{ repo: "my-app", number: 4, sessionId: "11111111-1111-4111-8111-111111111111" }]);
});

test("every group a pull request is in is listed on it, so a failing bump shows as both", async (t) => {
  const { board } = boot(t);
  const items = Object.values((await board.board()).repos[0].pulls.pulls).flat();
  const groupsOf = (number) => items.find((item) => item.number === number).groups.sort();
  assert.deepEqual(groupsOf(6), ["bumps", "failing"]);
  assert.deepEqual(groupsOf(4), ["ready"]);
  assert.deepEqual(groupsOf(5), [], "a draft is in no group");
});
