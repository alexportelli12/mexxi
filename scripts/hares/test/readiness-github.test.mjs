// Readiness through the service (issue #67), keyed by repo and pull request number: the GitHub
// reader is read-only and goes only to the listed repository, readiness says why it is not
// ready without a token, and only accept() (the web app's call) can accept a gate-weakening
// change, for one head commit of one pull request. GitHub is a fake fetch and the store is
// the small interface readiness.mjs documents.
import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { githubTokenFile, readGithubToken, saveGithubToken } from "../lib/github.mjs";
import { runGithubToken } from "../lib/github-token-cli.mjs";
import { ibniSnapshot } from "../lib/ibni-link.mjs";
import { createReadinessService } from "../lib/readiness.mjs";
import { createLinkIndex } from "../lib/serve.mjs";
import { openStore } from "../lib/store.mjs";
import { tempDir } from "./helpers.mjs";

const HEAD = "c".repeat(40);
const TOKEN = `github_pat_${"A1b2C3d4E5".repeat(8)}`;
const REPO = { name: "my-app", path: "/nonexistent/my-app", github: "example/my-app", actions: ["build"] };
const GITHUB_CHECKS = ["verify-in-ci", "reviewed-head", "ci-green", "no-flaky-checks", "no-merge-conflicts", "not-draft", "no-gate-weakening"];
const REVIEWED = { review: { rounds: 1, findings: 1, accepted: 1, history: [{ findings: 1, open: 0, accepted: 1, headSha: HEAD }] } };

/** A fake api.github.com for example/my-app, serving pull request 7 that passes every check. */
function fakeGithub({ patch = "@@ -1 +1 @@\n-old\n+new", fail = {} } = {}) {
  const state = { head: HEAD, patch };
  const calls = [];
  const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...init.headers }, ...init });
  const pull = (number) => json({ state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { sha: state.head }, base: { ref: "main" }, changed_files: 2, number });
  const routes = {
    "/repos/example/my-app/pulls/7": () => pull(7),
    "/repos/example/my-app/pulls/8": () => pull(8),
    "/repos/example/my-app/contents/.mexxi.json": () => json({ content: Buffer.from(JSON.stringify({ ciCheck: "verify" })).toString("base64") }),
    [`/repos/example/my-app/commits/${HEAD}/check-runs`]: () => json({ total_count: 1, check_runs: [{ id: 1, name: "verify", app: { id: 15368 }, head_sha: HEAD, status: "completed", conclusion: "success" }] }),
    [`/repos/example/my-app/commits/${HEAD}/statuses`]: () => json([]),
    "/repos/example/my-app/branches/main": () => json({ name: "main", protection: { enabled: true, required_status_checks: { contexts: ["verify"], checks: [{ context: "verify" }] } } }),
    "/repos/example/my-app/rules/branches/main": () => json([]),
    // Two pages, so the reader must follow GitHub's next link to see the whole diff.
    "/repos/example/my-app/pulls/7/files": (url) => (url.searchParams.get("page") === "2"
      ? json([{ filename: "src/b.mjs", status: "modified", changes: 2, patch: state.patch }])
      : json([{ filename: "src/a.mjs", status: "modified", changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" }], { headers: { Link: "<https://api.github.com/repos/example/my-app/pulls/7/files?per_page=100&page=2>; rel=\"next\"" } })),
  };
  routes["/repos/example/my-app/pulls/8/files"] = routes["/repos/example/my-app/pulls/7/files"];
  const fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init.method, authorization: init.headers.Authorization });
    if (fail[url.pathname]) return new Response("{}", { status: fail[url.pathname] });
    const route = routes[url.pathname];
    return route ? route(url) : new Response("{}", { status: 404 });
  };
  return { fetch, calls, state };
}

/** The store interface readiness.mjs documents, in memory. */
function fakeStore({ session = { state: "idle", snapshot: REVIEWED, pendingPermissions: 0 }, linked = true } = {}) {
  const acceptances = new Map();
  return {
    session,
    acceptances,
    sessionForPr: (repo, number) => (linked && repo === "my-app" && number === 7 ? "s-1" : null),
    sessionFacts: (id) => (id === "s-1" ? session : null),
    gateAcceptance: (repo, number, headSha) => acceptances.get(`${repo}#${number}@${headSha}`) ?? null,
    acceptGateChange({ repo, number, headSha, acceptedBy, detail }) {
      acceptances.set(`${repo}#${number}@${headSha}`, { acceptedBy, acceptedAt: "2026-11-28T10:00:00Z", detail });
    },
  };
}

function boot(t, { github = fakeGithub(), token = TOKEN, store = fakeStore(), repositories = [REPO] } = {}) {
  const stateDir = tempDir(t, "hares-state-");
  if (token) saveGithubToken(stateDir, token);
  const service = createReadinessService({ store, settings: { hares: { repositories } }, stateDir, fetch: github.fetch, now: () => 1_000 });
  return { service, stateDir, github, store };
}

const target = { repo: "my-app", number: 7 };
const detailOf = (readiness, name) => readiness.checks.find((entry) => entry.name === name).detail;

test("with a scoped token, a linked finished session and a pull request that meets every rule, readiness is ready, and the reader only sent GETs to the listed repository", async (t) => {
  const { service, github } = boot(t);
  const readiness = await service.forPr(target);
  for (const entry of readiness.checks) assert.equal(entry.pass, true, `${entry.name}: ${entry.detail}`);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.headSha, HEAD);
  assert.ok(github.calls.some((call) => call.url.includes("page=2")), "the second page of files was read");
  for (const call of github.calls) {
    assert.equal(call.method, "GET");
    assert.ok(call.url.startsWith("https://api.github.com/repos/example/my-app/"), call.url);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
  }
});

test("without the GitHub data source, readiness is not ready and every GitHub check says how to set it up, without calling GitHub", async (t) => {
  const { service, github } = boot(t, { token: null });
  const readiness = await service.forPr(target);
  assert.equal(readiness.ready, false);
  for (const name of GITHUB_CHECKS) {
    const entry = readiness.checks.find((check) => check.name === name);
    assert.equal(entry.pass, false, name);
    assert.match(entry.detail, /^Can't tell: The GitHub data source isn't set up\. Run hares github-token set/, name);
  }
  assert.equal(readiness.checks.find((check) => check.name === "run-completed").pass, true, "what hares recorded itself is still checked");
  assert.equal(github.calls.length, 0);
});

test("a pull request with no linked session never passes run-completed, reviewed-head or review-findings-closed", async (t) => {
  const { service } = boot(t, { store: fakeStore({ linked: false }) });
  const readiness = await service.forPr(target);
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "run-completed"), /^No session is linked/);
  assert.match(detailOf(readiness, "reviewed-head"), /^Can't tell: no session is linked/);
  assert.equal(readiness.checks.find((check) => check.name === "not-draft").pass, true, "GitHub's side is still judged");
});

test("a session with a permission still waiting, or one still working, keeps the pull request from ready", async (t) => {
  const waiting = boot(t, { store: fakeStore({ session: { state: "idle", snapshot: REVIEWED, pendingPermissions: 1 } }) });
  assert.match(detailOf(await waiting.service.forPr(target), "no-pending-approval"), /1 permission is still waiting/);
  const working = boot(t, { store: fakeStore({ session: { state: "working", snapshot: REVIEWED, pendingPermissions: 0 } }) });
  const readiness = await working.service.forPr(target);
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "run-completed"), /linked session is working/);
});

// Break caught: the link index ħares serves readiness from drops ibni's snapshot (it was always null), so
// reviewed-head and review-findings-closed fail and no pull request a session made can ever be ready.
test("a pull request a session made, with a review recorded at its head by ibni in the session's worktree, can be ready through the link index", async (t) => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const worktree = "/worktrees/my-app/fix-thing";
  const session = { id: SESSION, repo: "my-app", cwd: `${worktree}/src`, alive: true, status: "idle" };
  const sessions = { list: async () => [session], get: async () => ({ links: { pull: { number: 7 } } }), on: () => () => {} };
  const asked = [];
  // ibni's own JSON for that workspace, read the way ibni-link.mjs reads it (ibniSnapshot).
  const ibni = {
    list: async (repoPath) => [{ sessionId: "other", worktreePath: "/worktrees/my-app/other" }, { sessionId: "ws-1", worktreePath: worktree, repoPath }],
    summary: async (repoPath, workspaceId) => {
      asked.push([repoPath, workspaceId]);
      return { snapshot: ibniSnapshot({ branch: "fix-thing" }, { review: { rounds: 1, findings: 1, accepted: 1, history: [{ findings: 1, open: 0, accepted: 1, headSha: HEAD }] } }) };
    },
  };
  const store = openStore(":memory:");
  t.after(() => store.close());
  const linkIndex = createLinkIndex({ sessions, store, approvals: { forSession: () => [] }, settings: { hares: { repositories: [REPO] } }, ibni });
  await linkIndex.refresh();
  const { service } = boot(t, { store: linkIndex });
  const readiness = await service.forPr(target);
  for (const entry of readiness.checks) assert.equal(entry.pass, true, `${entry.name}: ${entry.detail}`);
  assert.equal(readiness.ready, true);
  assert.deepEqual(asked, [[REPO.path, "ws-1"]], "ibni was asked about the workspace that holds the session's folder");
});

test("a token hares can't trust is refused before any request: a classic token, or a file others can read", async (t) => {
  const classic = boot(t);
  writeFileSync(githubTokenFile(classic.stateDir), `ghp_${"x".repeat(36)}\n`, { mode: 0o600 });
  assert.match(detailOf(await classic.service.forPr(target), "ci-green"), /not a fine-grained token/);
  assert.equal(classic.github.calls.length, 0);

  const open = boot(t);
  chmodSync(githubTokenFile(open.stateDir), 0o644);
  const openDetail = detailOf(await open.service.forPr(target), "not-draft");
  assert.match(openDetail, /can be read by other users/);
  assert.ok(!openDetail.includes(open.stateDir), "no local path reaches the answer");
  assert.equal(open.github.calls.length, 0);
});

test("a repository that is not in the config is never read: its pull request can't be determined", async (t) => {
  const { service, github } = boot(t);
  const readiness = await service.forPr({ repo: "someone-else", number: 7 });
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "not-draft"), /no longer in hares\.repositories/);
  assert.equal(github.calls.length, 0);
});

test("a GitHub endpoint that fails leaves the checks that need it failing with GitHub's answer", async (t) => {
  const { service } = boot(t, { github: fakeGithub({ fail: { [`/repos/example/my-app/commits/${HEAD}/check-runs`]: 500 } }) });
  const readiness = await service.forPr(target);
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "verify-in-ci"), /^Can't tell: GitHub answered 500 for \/repos\/example\/my-app\/commits\/c+\/check-runs/);
  assert.equal(readiness.checks.find((entry) => entry.name === "not-draft").pass, true, "the pull request itself was still read");
});

test("a repository with no .mexxi.json on its base branch names no CI check that runs verify, so verify-in-ci fails", async (t) => {
  const { service } = boot(t, { github: fakeGithub({ fail: { "/repos/example/my-app/contents/.mexxi.json": 404 } }) });
  const readiness = await service.forPr(target);
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "verify-in-ci"), /names no ciCheck, so no CI check is known to run the full verify command/);
});

test("an acceptance is refused when there is nothing to accept, so none can be stored ahead of a diff nobody saw", async (t) => {
  const clean = boot(t);
  await assert.rejects(clean.service.accept(target, HEAD, "alex"), (error) => error.status === 409 && /no gate-weakening change to accept/.test(error.message));
  assert.equal(clean.store.acceptances.size, 0);
  // GitHub didn't return the diff: there is nothing a person could have seen, so nothing to accept either.
  const unseen = boot(t, { github: fakeGithub({ fail: { "/repos/example/my-app/pulls/7/files": 502 } }) });
  assert.equal((await unseen.service.forPr(target)).canAccept, false);
  await assert.rejects(unseen.service.accept(target, HEAD, "alex"), (error) => error.status === 409);
  assert.equal(unseen.store.acceptances.size, 0);
});

test("an acceptance is for one head of one pull request: a stale head is refused, a new push or another pull request needs its own", async (t) => {
  const github = fakeGithub({ patch: "@@ -1 +1,2 @@\n-a\n+b\n+test.only('focus', () => {});" });
  const { service, store } = boot(t, { github });
  const before = await service.forPr(target);
  assert.equal(before.ready, false);
  assert.equal(before.canAccept, true);
  assert.match(detailOf(before, "no-gate-weakening"), /a skipped or focused test \(src\/b\.mjs\)/);

  await assert.rejects(service.accept(target, "d".repeat(40), "alex"), (error) => error.status === 409 && /head has moved/.test(error.message));
  assert.equal(store.acceptances.size, 0);

  const accepted = await service.accept(target, HEAD, "alex");
  assert.equal(accepted.ready, true);
  assert.match(detailOf(accepted, "no-gate-weakening"), /^alex accepted these on ccccccc/);
  assert.match(store.gateAcceptance("my-app", 7, HEAD).detail, /a skipped or focused test \(src\/b\.mjs\)/, "the record says what was accepted");

  // Another pull request at the same commit was not accepted.
  const other = await service.forPr({ repo: "my-app", number: 8 });
  assert.equal(other.checks.find((entry) => entry.name === "no-gate-weakening").pass, false);

  // A push moves the head: the acceptance was for the old commit only.
  github.state.head = "e".repeat(40);
  const after = await service.forPr(target, { fresh: true });
  assert.equal(after.headSha, "e".repeat(40));
  assert.equal(after.checks.find((entry) => entry.name === "no-gate-weakening").pass, false);
});

test("hares github-token set stores a fine-grained token readable only by you, and refuses a classic one", async (t) => {
  const stateDir = tempDir(t, "hares-state-");
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  await runGithubToken(["set", "--state-dir", stateDir], { stdin: Readable.from([`${TOKEN}\n`]), stderr });
  assert.equal(readGithubToken(stateDir), TOKEN);
  assert.equal(statSync(githubTokenFile(stateDir)).mode & 0o777, 0o600);
  const before = process.exitCode;
  await runGithubToken(["set", "--state-dir", stateDir], { stdin: Readable.from([`ghp_${"y".repeat(36)}`]), stderr });
  assert.match(stderr.text, /won't store that token: it is not a fine-grained token/);
  assert.equal(readGithubToken(stateDir), TOKEN, "the stored token is kept");
  process.exitCode = before;
  await runGithubToken(["remove", "--state-dir", stateDir], { stderr });
  assert.throws(() => readGithubToken(stateDir), /isn't set up/);
});
