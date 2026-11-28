// Readiness through the real server (issue #67): the GitHub reader is read-only
// and goes only to the listed repository, readiness says why it is not ready
// without a token, get_run and the app's route return it, and only a person in
// the web app can accept a gate-weakening change. GitHub itself is a fake fetch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { githubTokenFile, readGithubToken, saveGithubToken } from "../lib/github.mjs";
import { runGithubToken } from "../lib/github-token-cli.mjs";
import { startServer } from "../lib/serve.mjs";
import { rotate } from "../lib/token.mjs";
import { fakeAdapter, makeRepo, makeSettings, request, tempDir } from "./helpers.mjs";

const HEAD = "c".repeat(40);
const TOKEN = `github_pat_${"A1b2C3d4E5".repeat(8)}`;
const PR_URL = "https://github.com/example/my-app/pull/7";
const noIbni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("no ibni in this test"); }, list: async () => [] };
const GITHUB_CHECKS = ["verify-in-ci", "reviewed-head", "ci-green", "no-flaky-checks", "no-merge-conflicts", "not-draft", "no-gate-weakening"];

/** A fake api.github.com for example/my-app, serving a pull request that passes every check. */
function fakeGithub({ patch = "@@ -1 +1 @@\n-old\n+new", fail = {} } = {}) {
  const state = { head: HEAD, patch };
  const calls = [];
  const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...init.headers }, ...init });
  const routes = {
    "/repos/example/my-app/pulls/7": () => json({ state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { sha: state.head }, base: { ref: "main" }, changed_files: 2 }),
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
  const fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init.method, authorization: init.headers.Authorization });
    if (fail[url.pathname]) return new Response("{}", { status: fail[url.pathname] });
    const route = routes[url.pathname];
    return route ? route(url) : new Response("{}", { status: 404 });
  };
  return { fetch, calls, state };
}

async function boot(t, { github = fakeGithub(), remote = "https://github.com/example/my-app.git", token = TOKEN } = {}) {
  const repo = makeRepo(t);
  if (remote) execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  const stateDir = tempDir(t, "hares-state-");
  if (token) saveGithubToken(stateDir, token);
  const { adapter } = fakeAdapter(t, "ask-completed");
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions: ["build", "ask"] }] });
  const server = await startServer({ settings, dataDir: tempDir(t, "hares-data-"), stateDir, runner: adapter, ibni: noIbni, staticRoot: null, githubFetch: github.fetch });
  t.after(() => server.close());
  return { server, stateDir, github };
}

/** A completed build run with a pull request, reviewed on HEAD with nothing left open. */
function completedRun(server, { prUrl = PR_URL } = {}) {
  const id = randomUUID();
  server.store.createRun({ id, repo: "my-app", action: "build", task: "Add a thing" });
  server.store.updateRun(id, {
    status: "completed", prUrl, branch: "agent/thing",
    snapshot: { steps: [], review: { rounds: 1, findings: 1, accepted: 1, history: [{ findings: 1, open: 0, accepted: 1, headSha: HEAD }] } },
  });
  return id;
}

const readinessOf = async (server, id) => {
  const response = await request(server, "GET", `/api/runs/${id}/readiness`);
  assert.equal(response.status, 200, response.text);
  return response.json.readiness;
};
const detailOf = (readiness, name) => readiness.checks.find((entry) => entry.name === name).detail;

test("with a scoped token and a pull request that meets every rule, the app's route reports ready, and the reader only sent GETs to the listed repository", async (t) => {
  const { server, github } = await boot(t);
  const readiness = await readinessOf(server, completedRun(server));
  for (const entry of readiness.checks) assert.equal(entry.pass, true, `${entry.name}: ${entry.detail}`);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.headSha, HEAD);
  assert.ok(github.calls.some((call) => call.url.includes("page=2")), "the second page of files was read");
  assert.ok(github.calls.length >= 7);
  for (const call of github.calls) {
    assert.equal(call.method, "GET");
    assert.ok(call.url.startsWith("https://api.github.com/repos/example/my-app/"), call.url);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
  }
});

test("without the GitHub data source, readiness is not ready and every GitHub check says how to set it up, without calling GitHub", async (t) => {
  const { server, github } = await boot(t, { token: null });
  const readiness = await readinessOf(server, completedRun(server));
  assert.equal(readiness.ready, false);
  for (const name of GITHUB_CHECKS) {
    const entry = readiness.checks.find((check) => check.name === name);
    assert.equal(entry.pass, false, name);
    assert.match(entry.detail, /^Can't tell: The GitHub data source isn't set up\. Run hares github-token set/, name);
  }
  assert.equal(readiness.checks.find((check) => check.name === "run-completed").pass, true, "what hares recorded itself is still checked");
  assert.equal(github.calls.length, 0);
});

test("get_run returns the same readiness over MCP, and no MCP tool can accept, set or override a check", async (t) => {
  const { server, stateDir } = await boot(t, { token: null });
  const id = completedRun(server);
  const client = new Client({ name: "hares-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${rotate(stateDir)}` } } }));
  t.after(() => client.close());
  assert.equal(client.getServerVersion().version, "1.3.0");
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.ok(!/accept|override|readiness|ready|merge|approve/i.test(tool.name), tool.name);
    assert.ok(!/accept|override|headSha|readiness|checks/i.test(JSON.stringify(Object.keys(tool.inputSchema.properties ?? {}))), `${tool.name}'s input names no readiness field`);
  }
  const result = await client.callTool({ name: "get_run", arguments: { id } });
  const run = JSON.parse(/<untrusted[^>]*>\n([\s\S]*)\n<\/untrusted>/.exec(result.content[1].text)[1]);
  assert.equal(run.readiness.ready, false);
  assert.equal(run.readiness.checks.length, 10);
  assert.deepEqual(Object.keys(run.readiness).sort(), ["checks", "ready"]);
  assert.match(run.readiness.checks.find((entry) => entry.name === "ci-green").detail, /isn't set up/);
});

test("a token hares can't trust is refused before any request: a classic token, or a file others can read", async (t) => {
  const classic = await boot(t);
  writeFileSync(githubTokenFile(classic.stateDir), `ghp_${"x".repeat(36)}\n`, { mode: 0o600 });
  assert.match(detailOf(await readinessOf(classic.server, completedRun(classic.server)), "ci-green"), /not a fine-grained token/);
  assert.equal(classic.github.calls.length, 0);

  const open = await boot(t);
  chmodSync(githubTokenFile(open.stateDir), 0o644);
  const openDetail = detailOf(await readinessOf(open.server, completedRun(open.server)), "not-draft");
  assert.match(openDetail, /can be read by other users/);
  assert.ok(!openDetail.includes(open.stateDir), "no local path reaches the check's detail");
  assert.equal(open.github.calls.length, 0);

  // A token file hares can't read is a reason readiness gives, not an error that takes get_run down.
  const unreadable = await boot(t, { token: null });
  mkdirSync(githubTokenFile(unreadable.stateDir), { mode: 0o700 });
  const readiness = await readinessOf(unreadable.server, completedRun(unreadable.server));
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "ci-green"), /can't read its GitHub token file/);
});

test("the reader never reads a repository hares doesn't list: a pull request elsewhere can't be determined", async (t) => {
  const { server, github } = await boot(t);
  const readiness = await readinessOf(server, completedRun(server, { prUrl: "https://github.com/someone/else/pull/7" }));
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "not-draft"), /is in someone\/else, but my-app's checkout is example\/my-app; hares reads only the listed repositories/);
  assert.equal(github.calls.length, 0);
  const elsewhere = await boot(t, { remote: "git@gitlab.com:example/my-app.git" });
  assert.match(detailOf(await readinessOf(elsewhere.server, completedRun(elsewhere.server)), "not-draft"), /not on github\.com/);
});

test("a GitHub endpoint that fails leaves the checks that need it failing with GitHub's answer", async (t) => {
  const { server } = await boot(t, { github: fakeGithub({ fail: { [`/repos/example/my-app/commits/${HEAD}/check-runs`]: 500 } }) });
  const readiness = await readinessOf(server, completedRun(server));
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "verify-in-ci"), /^Can't tell: GitHub answered 500 for \/repos\/example\/my-app\/commits\/c+\/check-runs/);
  assert.equal(readiness.checks.find((entry) => entry.name === "not-draft").pass, true, "the pull request itself was still read");
});

test("a repository with no .mexxi.json on its base branch names no CI check that runs verify, so verify-in-ci fails", async (t) => {
  const { server } = await boot(t, { github: fakeGithub({ fail: { "/repos/example/my-app/contents/.mexxi.json": 404 } }) });
  const readiness = await readinessOf(server, completedRun(server));
  assert.equal(readiness.ready, false);
  assert.match(detailOf(readiness, "verify-in-ci"), /names no ciCheck, so no CI check is known to run the full verify command/);
  assert.match(detailOf(readiness, "ci-green"), /^Can't tell: without a ciCheck/);
});

test("an acceptance is refused when there is nothing to accept, so none can be stored ahead of a diff nobody saw", async (t) => {
  const clean = await boot(t);
  const id = completedRun(clean.server);
  const refused = await request(clean.server, "POST", `/api/runs/${id}/readiness/accept`, { body: { headSha: HEAD } });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /no gate-weakening change to accept/);
  assert.equal(clean.server.store.gateAcceptance(id, HEAD), null);
  // GitHub didn't return the diff: there is nothing a person could have seen, so nothing to accept either.
  const unseen = await boot(t, { github: fakeGithub({ fail: { "/repos/example/my-app/pulls/7/files": 502 } }) });
  const other = completedRun(unseen.server);
  assert.equal((await readinessOf(unseen.server, other)).canAccept, false);
  assert.equal((await request(unseen.server, "POST", `/api/runs/${other}/readiness/accept`, { body: { headSha: HEAD } })).status, 409);
  assert.equal(unseen.server.store.gateAcceptance(other, HEAD), null);
});

test("only a person in the web app accepts a gate-weakening change, for the head they saw; a new push needs a new acceptance", async (t) => {
  const github = fakeGithub({ patch: "@@ -1 +1,2 @@\n-a\n+b\n+test.only('focus', () => {});" });
  const { server } = await boot(t, { github });
  const id = completedRun(server);
  const before = await readinessOf(server, id);
  assert.equal(before.ready, false);
  assert.equal(before.canAccept, true);
  assert.match(detailOf(before, "no-gate-weakening"), /a skipped or focused test \(src\/b\.mjs\)/);

  const stale = await request(server, "POST", `/api/runs/${id}/readiness/accept`, { body: { headSha: "d".repeat(40) } });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /head has moved/);
  const crossSite = await request(server, "POST", `/api/runs/${id}/readiness/accept`, { body: { headSha: HEAD }, origin: false });
  assert.equal(crossSite.status, 403, "a write without hares's own origin is refused");
  assert.equal(server.store.gateAcceptance(id, HEAD), null);

  const accepted = await request(server, "POST", `/api/runs/${id}/readiness/accept`, { body: { headSha: HEAD } });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.readiness.ready, true);
  assert.match(detailOf(accepted.json.readiness, "no-gate-weakening"), /^local accepted these on ccccccc/);
  assert.match(server.store.gateAcceptance(id, HEAD).detail, /a skipped or focused test \(src\/b\.mjs\)/, "the record says what was accepted");
  assert.ok(server.store.listAudit(50).some((row) => row.action === "POST /api/runs/:id/readiness/accept" && row.actor === "local" && row.outcome === "ok" && row.target === id));

  // A push moves the head: the acceptance was for the old commit only.
  github.state.head = "e".repeat(40);
  server.store.updateRun(id, { reason: null });
  const after = await readinessOf(server, id);
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
