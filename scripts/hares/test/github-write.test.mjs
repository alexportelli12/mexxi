// The web app's GitHub writes. gh is never run for real except against a stub on PATH: every other
// test injects the executor and reads the argv and stdin it was handed.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGithubWriter, runGh } from "../lib/github-write.mjs";
import { tempDir } from "./helpers.mjs";

const SHA = "a".repeat(40);
const settings = { hares: { repositories: [{ name: "my-app", path: "/x", github: "example/my-app" }] } };

function writer({ reply = { stdout: "{}" }, fail = null } = {}) {
  const calls = [];
  const audits = [];
  const exec = async (argv, options) => {
    calls.push({ argv, input: options.input });
    if (fail) throw fail;
    return reply;
  };
  return { calls, audits, github: createGithubWriter({ settings, exec, audit: (entry) => audits.push(entry) }) };
}
const body = (call) => JSON.parse(call.input);
const gh = (stderr, code = 1) => Object.assign(new Error("exit"), { stderr, code });

test("rerunFailedJobs posts to the run's rerun-failed-jobs endpoint with a fixed argv", async () => {
  const { github, calls } = writer();
  await github.rerunFailedJobs("my-app", 123456);
  assert.deepEqual(calls[0].argv, ["api", "-X", "POST", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", "repos/example/my-app/actions/runs/123456/rerun-failed-jobs", "--input", "-"]);
});

test("submitReview sends the event and text to the pull request's reviews endpoint, and an approval may go without text", async () => {
  const { github, calls } = writer({ reply: { stdout: '{"id":9,"state":"CHANGES_REQUESTED"}' } });
  const result = await github.submitReview("my-app", 7, { event: "REQUEST_CHANGES", body: "Please add a test." });
  assert.equal(calls[0].argv.at(-3), "repos/example/my-app/pulls/7/reviews");
  assert.deepEqual(body(calls[0]), { event: "REQUEST_CHANGES", body: "Please add a test." });
  assert.deepEqual(result, { id: 9, state: "CHANGES_REQUESTED" });
  await github.submitReview("my-app", 7, { event: "APPROVE" });
  assert.deepEqual(body(calls[1]), { event: "APPROVE" });
});

test("replyToThread posts to the comment's replies endpoint, and comment to the issue comments endpoint", async () => {
  const { github, calls } = writer();
  await github.replyToThread("my-app", 7, 555, "Fixed in the next push.");
  assert.equal(calls[0].argv.at(-3), "repos/example/my-app/pulls/7/comments/555/replies");
  assert.deepEqual(body(calls[0]), { body: "Fixed in the next push." });
  await github.comment("my-app", 7, "Thanks");
  assert.equal(calls[1].argv.at(-3), "repos/example/my-app/issues/7/comments");
});

test("merge is a PUT that hands GitHub the confirmed head sha and method, so a moved head can't be merged", async () => {
  const { github, calls } = writer({ reply: { stdout: JSON.stringify({ merged: true, sha: "b".repeat(40) }) } });
  const result = await github.merge("my-app", 7, { headSha: SHA, method: "squash" });
  assert.equal(calls[0].argv[2], "PUT");
  assert.equal(calls[0].argv.at(-3), "repos/example/my-app/pulls/7/merge");
  assert.deepEqual(body(calls[0]), { sha: SHA, merge_method: "squash" });
  assert.equal(result.merged, true);
});

test("when the head moved GitHub answers 409 and merge refuses with a 409 that says nothing was merged", async () => {
  const { github, audits } = writer({ fail: gh("gh: Head branch was modified. Review and try the merge again. (HTTP 409)") });
  await assert.rejects(github.merge("my-app", 7, { headSha: SHA, method: "merge" }, { actor: "alex" }), (error) => error.status === 409 && /head moved.*nothing was done/.test(error.message));
  assert.deepEqual(audits.map((entry) => [entry.action, entry.outcome, entry.actor]), [["github.merge", "rejected", "alex"]]);
});

test("a successful write is audited with its action, target and actor", async () => {
  const { github, audits } = writer();
  await github.comment("my-app", 7, "hi", { actor: "alex" });
  assert.deepEqual(audits, [{ action: "github.comment", target: "my-app:issues/7/comments", actor: "alex", outcome: "ok" }]);
});

test("invalid parameters are refused with a 400 before gh runs, while the valid form of each runs", async () => {
  const { github, calls } = writer();
  const refused = [
    () => github.rerunFailedJobs("my-app", "1; rm -rf /"),
    () => github.rerunFailedJobs("my-app", -4),
    () => github.rerunFailedJobs("my-app", 1.5),
    () => github.submitReview("my-app", 7, { event: "MERGE", body: "x" }),
    () => github.submitReview("my-app", 7, { event: "COMMENT", body: "   " }),
    () => github.submitReview("my-app", "7", { event: "APPROVE" }),
    () => github.submitReview("my-app", 7, { event: "COMMENT", body: "x".repeat(65_537) }),
    () => github.replyToThread("my-app", 7, "5/../../x", "hi"),
    () => github.comment("my-app", 7, ""),
    () => github.comment("my-app", 7, { text: "x" }),
    () => github.merge("my-app", 7, { headSha: "abc", method: "merge" }),
    () => github.merge("my-app", 7, { headSha: SHA, method: "fast-forward" }),
    () => github.merge("my-app", 0, { headSha: SHA, method: "merge" }),
  ];
  for (const attempt of refused) await assert.rejects(attempt(), (error) => error.status === 400);
  assert.equal(calls.length, 0);
  await github.rerunFailedJobs("my-app", 1);
  assert.equal(calls.length, 1);
});

test("a repository outside hares.repositories is refused, and the repository name is never taken from the caller's slug", async () => {
  const { github, calls } = writer();
  await assert.rejects(github.comment("someone/else", 7, "hi"), (error) => error.status === 404);
  await assert.rejects(github.comment("my-app/../../x", 7, "hi"), (error) => error.status === 404);
  assert.equal(calls.length, 0);
});

test("text with shell metacharacters travels only on stdin, never in the argument list", async () => {
  const { github, calls } = writer();
  const nasty = "$(touch /tmp/pwned); backtick-id \"quoted\" 'single' && echo";
  await github.comment("my-app", 7, nasty);
  assert.deepEqual(body(calls[0]), { body: nasty });
  assert.ok(!calls[0].argv.some((arg) => arg.includes("touch") || arg.includes("pwned")));
});

test("GitHub's refusals and a missing gh come back as clear statuses, and a transport failure as a 502", async () => {
  const cases = [
    [gh("gh: Validation Failed (HTTP 422)"), 422, /refused to submit the review \(422\)/],
    [gh("gh: Resource not accessible by personal access token (HTTP 403)"), 403, /refused/],
    [gh("gh: Bad credentials (HTTP 401)"), 502, /refused/],
    [gh("dial tcp: lookup api.github.com: no such host"), 502, /didn't submit the review/],
    [gh("", "ENOENT"), 503, /gh command isn't installed/],
  ];
  for (const [error, status, message] of cases) {
    const { github } = writer({ fail: error });
    await assert.rejects(github.submitReview("my-app", 7, { event: "COMMENT", body: "x" }), (caught) => caught.status === status && message.test(caught.message), error.stderr);
  }
});

test("runGh uses the person's gh login: the environment's GH_TOKEN and GITHUB_TOKEN are not passed on, and the body arrives on stdin", async (t) => {
  const bin = tempDir(t, "hares-gh-");
  const stub = path.join(bin, "gh");
  writeFileSync(stub, "#!/bin/sh\nenv | grep -E '^(GH_TOKEN|GITHUB_TOKEN)=' || echo no-token\necho \"args=$*\"\ncat\n");
  chmodSync(stub, 0o755);
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.PATH = bin + ":" + saved.PATH;
  process.env.GH_TOKEN = "read-only-token";
  process.env.GITHUB_TOKEN = "other-token";
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { stdout } = await runGh(["api", "-X", "POST", "x"], { input: '{"body":"hi"}' });
  assert.equal(stdout, 'no-token\nargs=api -X POST x\n{"body":"hi"}');
});

test("mcp.mjs never imports the write module and never runs gh, so no MCP client can merge, review or comment", () => {
  const source = readFileSync(new URL("../lib/mcp.mjs", import.meta.url), "utf8");
  assert.ok(!/github-write/.test(source));
  assert.ok(!/["']gh["']|execFile|child_process/.test(source));
});
