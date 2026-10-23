// The sandbox is what keeps a run's agent away from segwi's own port, so segwi
// need not tell the agent's machine from a phone by headers. This proves it with
// the real Claude Code binary, segwi's real rendered settings, arguments and
// approval path, and a scripted fake model. A control run with only the sandbox
// turned off shows the same command does reach segwi, so the proof can't pass
// because the harness never ran anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runScripted, sandboxPrerequisiteProblem } from "./sandbox-harness.mjs";

const problem = sandboxPrerequisiteProblem();
// CI sets this, so a runner without the prerequisites fails instead of skipping the proof.
const required = process.env.SEGWI_REQUIRE_SANDBOX_TEST === "1";
const skip = problem && !required ? `Claude Code's sandbox can't run here: ${problem}` : false;

test("the sandbox test's prerequisites are present", { skip: !required }, () => {
  assert.equal(problem, null, `SEGWI_REQUIRE_SANDBOX_TEST=1, but ${problem}`);
});

const health = (port) => `http://127.0.0.1:${port}/api/health`;
const healthRequests = (audit) => audit.filter((row) => row.action === "GET /api/health");
const echo = { tool: "Bash", input: { command: "echo sandbox-harness-ok", description: "Show the harness runs commands" } };
const direct = ({ segwiPort }) => ({ tool: "Bash", input: { command: `curl -sS -m 5 ${health(segwiPort)}`, description: "Reach segwi" } });
// The sandbox's own proxy runs outside it, so the agent must not be able to reach segwi by asking the proxy either.
const throughProxy = ({ segwiPort }) => ({
  tool: "Bash", input: { command: `curl -sS -m 3 --noproxy "" --proxy "$HTTP_PROXY" ${health(segwiPort)}`, description: "Reach segwi through the proxy" },
});

test("a sandboxed run can't reach segwi's port, directly or through the sandbox's proxy", { skip, timeout: 180_000 }, async (t) => {
  // Any approval is allowed, so it is the sandbox, not a person's answer, that stops the request.
  const { results, audit, run } = await runScripted(t, { script: [echo, direct, throughProxy, { text: "Done." }] });

  assert.equal(run.status, "completed", run.reason ?? "");
  assert.deepEqual(results[0], { isError: false, text: "sandbox-harness-ok" }, "an ordinary command ran and its output came back");
  assert.equal(results[1]?.isError, true, results[1]?.text);
  assert.match(results[1].text, /curl: \(7\) Failed to connect to 127\.0\.0\.1/);
  assert.equal(results[2]?.isError, true, results[2]?.text);
  assert.match(results[2].text, /curl: \((7|28|56)\)/, "the proxy refused or never answered");
  assert.deepEqual(healthRequests(audit), [], "segwi saw no request from the run");
});

test("inside the sandbox a command off the allow list still waits for a person, and a denial stops it", { skip, timeout: 180_000 }, async (t) => {
  const marker = ({ worktreeRoot }) => ({ tool: "Bash", input: { command: `touch ${worktreeRoot}/segwi-unasked`, description: "Write a marker" } });
  const { results, approvals } = await runScripted(t, { script: [marker, { text: "Done." }], decide: () => "deny" });
  assert.equal(approvals.length, 1, "touch is off the allow list, so the sandbox doesn't let it run unasked");
  assert.match(approvals[0].exact, /^touch .*segwi-unasked$/);
  assert.equal(results[0]?.isError, true, results[0]?.text);
});

test("git --output is refused wherever it appears, and git fetch with options or git grep goes to a person", { skip, timeout: 180_000 }, async (t) => {
  const bash = (command) => ({ tool: "Bash", input: { command, description: "check" } });
  const { results, approvals } = await runScripted(t, {
    script: [bash("git diff HEAD --output=diff.txt"), bash("git log -1 --output log.txt"), bash("git fetch --upload-pack=touch origin"), bash("git grep -O cat README"), bash("git status --short"), { text: "Done." }],
    decide: () => "deny",
  });
  for (const index of [0, 1]) assert.match(results[index]?.text ?? "", /has been denied/, `turn ${index}`);
  assert.deepEqual(approvals.map((approval) => approval.exact), ["git fetch --upload-pack=touch origin", "git grep -O cat README"]);
  assert.equal(results[4]?.isError, false, "an ordinary git command still runs unasked");
});

test("control: with only the sandbox turned off, the same command reaches segwi once a person allows it", { skip, timeout: 180_000 }, async (t) => {
  const { results, audit, approvals, run } = await runScripted(t, { script: [direct, { text: "Done." }], settingsPatch: { sandbox: { enabled: false } } });

  assert.equal(run.status, "completed", run.reason ?? "");
  assert.equal(approvals.length, 1, "curl is off the allow list, so it went to a person");
  assert.match(approvals[0].exact, /^curl -sS -m 5 http:\/\/127\.0\.0\.1:\d+\/api\/health$/);
  assert.equal(results[0]?.isError, false, results[0]?.text);
  assert.match(results[0].text, /"runner":\{"id":"claude-code"/, "segwi's health answer came back");
  assert.equal(healthRequests(audit).length, 1);
});

// --- the control checkout (the clone a person works in) stays untouched ---
// A file planted there runs later as the person, outside any sandbox. Writes go through `sh -c` so Claude Code's
// own path checks can't see them: they reach a person, the test allows them, and only the sandbox is left to refuse.

const bash = (command) => ({ tool: "Bash", input: { command, description: "check" } });
const PLANTED = "segwi-planted";
// The sandbox's refusal, as the shell reports it.
const REFUSED = /[Rr]ead-only file system|Permission denied|Operation not permitted/;

/** What a run must never change in the control checkout: its status, its top-level names, its hooks and its git config. */
function controlState(repo) {
  return {
    status: execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }),
    // Claude Code itself (outside the sandbox) makes an empty .claude/.cc-writes where an ask run starts. It holds
    // nothing and git doesn't show it, so it is left out here, but anything else under .claude would show.
    entries: readdirSync(repo).filter((name) => name !== ".claude").sort(),
    claude: existsSync(path.join(repo, ".claude")) ? readdirSync(path.join(repo, ".claude"), { recursive: true }).filter((name) => name !== ".cc-writes") : [],
    readme: readFileSync(path.join(repo, "README.md"), "utf8"),
    hooks: readdirSync(path.join(repo, ".git", "hooks")).filter((name) => !name.endsWith(".sample")),
    configPlanted: readFileSync(path.join(repo, ".git", "config"), "utf8").includes(PLANTED),
  };
}
const UNTOUCHED = { status: "", entries: [".git", "README.md"], claude: [], readme: "# demo\n", hooks: [], configPlanted: false };

const plantingWrites = (repo) => [
  `touch ${repo}/${PLANTED}`,
  `echo ${PLANTED} >> ${repo}/README.md`,
  `echo ${PLANTED} > ${repo}/.git/hooks/pre-commit`,
  `echo '# ${PLANTED}' >> ${repo}/.git/config`,
].map((command) => bash(`sh -c "${command}"`));

const show = (results, approvals) => JSON.stringify({ results, approvals: approvals.map((approval) => approval.exact) }, null, 1);

test("a build run prepares its worktree with ibni and commits there, unasked", { skip, timeout: 180_000 }, async (t) => {
  const worktree = ({ result }) => JSON.parse(result(0).text).worktreePath;
  const script = [
    bash("ibni prepare --slug sbx"),
    (context) => ({ tool: "Write", input: { file_path: path.join(worktree(context), "note.txt"), content: "first\n" } }),
    (context) => ({ tool: "Edit", input: { file_path: path.join(worktree(context), "note.txt"), old_string: "first", new_string: "second" } }),
    (context) => bash(`cd ${worktree(context)}`),
    bash("git add note.txt"),
    bash('git commit -q -m "sandboxed commit"'),
    { text: "Done." },
  ];
  const { results, approvals, repo, worktreeRoot } = await runScripted(t, { action: "build", script, decide: () => "deny" });
  const report = show(results, approvals);

  // ibni prepare runs outside the sandbox (it fast-forwards the control checkout and adds the worktree) without asking.
  assert.equal(results[0]?.isError, false, report);
  const prepared = JSON.parse(results[0].text);
  assert.ok(prepared.worktreePath.startsWith(worktreeRoot), report);
  assert.ok(existsSync(prepared.worktreePath), "the worktree exists");
  // Everything here is on the allow list; the cd may ask, the rest must not.
  assert.deepEqual(approvals.filter((approval) => !approval.exact.startsWith("cd ")), [], report);

  // The file tools and git work in the worktree; the commit's objects land in the control checkout's git directory.
  for (const index of [1, 2, 4, 5]) assert.equal(results[index]?.isError, false, `turn ${index}: ${report}`);
  assert.equal(readFileSync(path.join(prepared.worktreePath, "note.txt"), "utf8"), "second\n");
  assert.equal(execFileSync("git", ["-C", repo, "log", "-1", "--format=%s", prepared.branch], { encoding: "utf8" }).trim(), "sandboxed commit");
  assert.deepEqual(controlState(repo), UNTOUCHED);
});

test("a build run can't write the control checkout, even when a person allows it", { skip, timeout: 180_000 }, async (t) => {
  const script = [
    ...[0, 1, 2, 3].map((index) => ({ repo }) => plantingWrites(repo)[index]),
    ({ repo }) => ({ tool: "Write", input: { file_path: path.join(repo, `${PLANTED}-write`), content: "x\n" } }),
    // ibni runs outside the sandbox only as a single plain command; a compound one stays inside as a whole.
    ({ repo }) => bash(`ibni --help && sh -c "touch ${repo}/${PLANTED}-escaped"`),
    { text: "Done." },
  ];
  // Every approval is allowed, so whatever stops a write is the sandbox or a deny rule, not a person.
  const { results, approvals, repo } = await runScripted(t, { action: "build", script });
  const report = show(results, approvals);

  for (const index of [0, 1, 2, 3]) {
    assert.ok(approvals.some((approval) => approval.exact === script[index]({ repo }).input.command), `turn ${index} reached a person: ${report}`);
    assert.equal(results[index]?.isError, true, `turn ${index}: ${report}`);
    assert.match(results[index].text, REFUSED, `turn ${index}: ${report}`);
  }
  assert.match(results[4]?.text ?? "", /denied/, `the Write tool is denied: ${report}`);
  assert.ok(!approvals.some((approval) => approval.exact.includes(`${PLANTED}-write`)), "the Write tool never asked");
  assert.match(results[5]?.text ?? "", new RegExp(`${PLANTED}-escaped.*(${REFUSED.source})`), `the compound's touch ran and was refused: ${report}`);
  assert.deepEqual(controlState(repo), UNTOUCHED);
});

test("an ask run can't write the control checkout, even when a person allows it", { skip, timeout: 180_000 }, async (t) => {
  const script = [...[0, 1].map((index) => ({ repo }) => plantingWrites(repo)[index]), { text: "Done." }];
  const { results, approvals, repo } = await runScripted(t, { script });
  const report = show(results, approvals);
  assert.equal(approvals.length, 2, report);
  for (const index of [0, 1]) {
    assert.equal(results[index]?.isError, true, `turn ${index}: ${report}`);
    assert.match(results[index].text, REFUSED, `turn ${index}: ${report}`);
  }
  assert.deepEqual(controlState(repo), UNTOUCHED);
});
