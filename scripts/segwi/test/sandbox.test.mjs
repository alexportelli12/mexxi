// The sandbox is what keeps a run's agent away from segwi's own port, so segwi
// need not tell the agent's machine from a phone by headers. This proves it with
// the real Claude Code binary, segwi's real rendered settings, arguments and
// approval path, and a scripted fake model. A control run with only the sandbox
// turned off shows the same command does reach segwi, so the proof can't pass
// because the harness never ran anything.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { request } from "./helpers.mjs";
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

// --- the control checkout's git directory, hooks, secrets and the file tools ---

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const worktreeOf = ({ result }) => JSON.parse(result(0).text).worktreePath;
const gitDirOf = ({ repo }) => path.join(repo, ".git");

test("a build run writes only the git data its worktree needs, and a repository hooks path never runs", { skip, timeout: 180_000 }, async (t) => {
  const hooksDir = (worktreeRoot) => path.join(worktreeRoot, "repo-hooks");
  const markers = (worktreeRoot, home) => [path.join(worktreeRoot, "hook-ran"), path.join(home, "hook-ran")];
  let mainBefore = "";
  const prepare = ({ repo, worktreeRoot, home }) => {
    // As husky does: the repository points git at a hooks folder the agent can edit (here, inside the worktree root).
    mkdirSync(hooksDir(worktreeRoot));
    writeFileSync(path.join(hooksDir(worktreeRoot), "pre-commit"), `#!/bin/sh\n${markers(worktreeRoot, home).map((file) => `touch ${file}`).join("\n")}\nexit 0\n`, { mode: 0o755 });
    git(repo, "config", "core.hooksPath", hooksDir(worktreeRoot));
    mainBefore = git(repo, "rev-parse", "refs/heads/main");
  };
  const shellWrite = (target) => (context) => bash(`sh -c "echo ${PLANTED} > ${target(context)}"`);
  const script = [
    bash("ibni prepare --slug sbx"),
    (context) => bash(`cd ${worktreeOf(context)}`),
    (context) => ({ tool: "Write", input: { file_path: path.join(worktreeOf(context), "note.txt"), content: "note\n" } }),
    bash("git add note.txt"),
    bash('git commit -q -m "sandboxed commit"'),
    bash("git fetch origin"),
    shellWrite((context) => path.join(gitDirOf(context), "HEAD")),
    shellWrite((context) => path.join(gitDirOf(context), "index")),
    shellWrite((context) => path.join(gitDirOf(context), "packed-refs")),
    shellWrite((context) => path.join(gitDirOf(context), "info", "x")),
    shellWrite((context) => path.join(gitDirOf(context), "refs", "heads", "main")),
    (context) => bash(`git -C ${context.repo} update-ref refs/heads/main ${JSON.parse(context.result(0).text).baseSha}~0`),
    (context) => bash(`git -C ${context.repo} update-ref refs/heads/main ${git(worktreeOf(context), "rev-parse", "HEAD")}`),
    { text: "Done." },
  ];
  const { results, approvals, repo, worktreeRoot, home } = await runScripted(t, { action: "build", script, prepare });
  const report = show(results, approvals);

  assert.equal(results[0]?.isError, false, report);
  const worktree = JSON.parse(results[0].text).worktreePath;
  for (const index of [1, 2, 3, 4, 5]) assert.equal(results[index]?.isError, false, `turn ${index}: ${report}`);
  assert.equal(git(repo, "log", "-1", "--format=%s", "agent/sbx"), "sandboxed commit");
  for (const index of [6, 7, 8, 9, 10]) {
    assert.ok(approvals.some((approval) => approval.exact === script[index]({ repo }).input.command), `turn ${index} reached a person: ${report}`);
    assert.equal(results[index]?.isError, true, `turn ${index}: ${report}`);
    assert.match(results[index].text, REFUSED, `turn ${index}: ${report}`);
  }
  // update-ref to the commit the run just made: the default branch's ref can't move.
  assert.equal(results[12]?.isError, true, `turn 12: ${report}`);
  assert.equal(git(repo, "rev-parse", "refs/heads/main"), mainBefore, "the default branch is where it was");
  assert.equal(readFileSync(path.join(repo, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  for (const name of ["packed-refs", path.join("info", "x")]) assert.ok(!readFileSync(path.join(repo, ".git", name), { flag: "a+" }).includes(PLANTED), name);

  // The pin held: the repository's hooks path never ran, in the sandbox or out of it.
  for (const marker of markers(worktreeRoot, home)) assert.ok(!existsSync(marker), `${marker}: ${report}`);
  // Control: without segwi's pin the same hook does run, so the test above proves the pin and not a broken hook.
  execFileSync("git", ["-C", worktree, "commit", "-q", "--allow-empty", "-m", "unpinned"]);
  assert.ok(existsSync(markers(worktreeRoot, home)[0]), "the hook runs when nothing pins the hooks path");
});

const key = (home) => path.join(home, ".ssh", "id_test");
const plantKey = ({ home }) => {
  mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(key(home), "segwi-test-private-key\n", { mode: 0o600 });
};
// The run's MCP config, which holds its approval secret. The adapter's data folder has this one run.
const mcpFile = ({ hostDataDir }) => {
  const runs = path.join(hostDataDir, "runs");
  return path.join(runs, readdirSync(runs)[0], "mcp.json");
};
const SECRET_TEXT = /segwi-test-private-key|SEGWI_RUN_SECRET/;

test("inside the sandbox the home's keys and segwi's own run files can't be read, even when a person allows it", { skip, timeout: 180_000 }, async (t) => {
  const prepare = plantKey;
  const script = [
    ({ home }) => bash(`sh -c "cat ${key(home)}"`),
    (context) => bash(`sh -c "cat ${mcpFile(context)}"`),
    { text: "Done." },
  ];
  const { results, approvals, home } = await runScripted(t, { action: "build", script, prepare });
  const report = show(results, approvals);
  assert.ok(existsSync(key(home)), "the key was there to read");
  assert.equal(approvals.length, 2, `both reached a person: ${report}`);
  for (const index of [0, 1]) {
    assert.equal(results[index]?.isError, true, `turn ${index}: ${report}`);
    assert.doesNotMatch(results[index].text, SECRET_TEXT, `turn ${index}: ${report}`);
  }
});

test("the Read tool, which runs outside the sandbox, can't read the home's keys or segwi's run files either", { skip, timeout: 180_000 }, async (t) => {
  const script = [
    (context) => ({ tool: "Read", input: { file_path: mcpFile(context) } }),
    ({ home }) => ({ tool: "Read", input: { file_path: key(home) } }),
    { text: "Done." },
  ];
  // Allowed, so only a deny rule can keep the secret out of the conversation.
  const { results, approvals, home } = await runScripted(t, { action: "build", script, prepare: plantKey });
  const report = show(results, approvals);
  assert.ok(existsSync(key(home)), "the key was there to read");
  for (const index of [0, 1]) {
    assert.equal(results[index]?.isError, true, `turn ${index}: ${report}`);
    assert.doesNotMatch(results[index].text, SECRET_TEXT, `turn ${index}: ${report}`);
  }
});

test("the file tools can't write the control checkout below its top level or through a symlink, and ibni works inside the sandbox", { skip, timeout: 180_000 }, async (t) => {
  const prepare = ({ repo, worktreeRoot }) => symlinkSync(repo, path.join(worktreeRoot, "link"));
  const write = (target) => (context) => ({ tool: "Write", input: { file_path: target(context), content: `${PLANTED}\n` } });
  const script = [
    write(({ repo }) => path.join(repo, "src", "new.txt")),
    write(({ repo }) => path.join(repo, ".git", "hooks", "post-checkout")),
    write(({ worktreeRoot }) => path.join(worktreeRoot, "link", "planted.txt")),
    // ibni list lists the current repository's workspaces, so it runs from the worktree ibni prepare makes.
    bash("ibni prepare --slug sbx"),
    (context) => bash(`cd ${JSON.parse(context.result(3).text).worktreePath}`),
    bash("ibni list"),
    ({ repo }) => bash(`ibni list && sh -c "touch ${repo}/${PLANTED}-escaped"`),
    // A command that takes ibni's repository lock: inside the sandbox it locks under IBNI_LOCK_ROOT, not the git directory.
    (context) => bash(`ibni record --session ${JSON.parse(context.result(3).text).sessionId} --verify pass`),
    (context) => bash(`ibni record-evidence --session ${JSON.parse(context.result(3).text).sessionId}`),
    { text: "Done." },
  ];
  // Approvals are allowed, so a write that asks and then lands would show on disk.
  const { results, approvals, repo } = await runScripted(t, { action: "build", script, prepare });
  const report = show(results, approvals);
  for (const index of [0, 1, 2]) assert.equal(results[index]?.isError, true, `turn ${index}: ${report}`);
  assert.ok(!existsSync(path.join(repo, "src")), report);
  assert.ok(!existsSync(path.join(repo, ".git", "hooks", "post-checkout")), report);
  assert.ok(!existsSync(path.join(repo, "planted.txt")), `the symlink led into the control checkout: ${report}`);

  assert.equal(results[5]?.isError, false, `ibni list: ${report}`);
  assert.match(results[5].text, /"sbx"|agent\/sbx/, `ibni list saw the worktree: ${report}`);
  assert.ok(!approvals.some((approval) => approval.exact === "ibni list"), "ibni list needed no approval");
  assert.match(results[6]?.text ?? "", new RegExp(`${PLANTED}-escaped.*(${REFUSED.source})`), `the compound stayed sandboxed: ${report}`);
  assert.equal(results[8]?.isError, false, `ibni record-evidence: ${report}`);
  assert.match(results[8].text, /"operation":"record-evidence"/, report);
  assert.ok(!existsSync(path.join(repo, ".git", "opencode-implementation.lock")), "no lock was left in the git directory");
  assert.deepEqual(controlState(repo), UNTOUCHED);
});

// --- ibni prepare outside the sandbox, and the branches a run may write ---
// A real build run on verifika chained prepare after an echo. Claude Code takes a call out of the sandbox only when
// every command in it matches an excludedCommands entry, so that whole call ran sandboxed and failed at the lock.

const branchesOf = (repo) => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort();

test("ibni prepare runs outside the sandbox in each allowed form, and a call that chains it stays inside", { skip, timeout: 180_000 }, async (t) => {
  const script = [
    bash("ibni prepare --slug plain"),
    bash('ibni prepare --slug "quoted"'),
    bash("ibni prepare --slug listed --prefix security"),
    bash("ibni prepare --prefix security --slug reordered"),
    bash("echo $IBNI_LAUNCH_CHECKOUT; ibni prepare --slug chained --prefix security"),
    bash("ibni prepare --slug unlisted --prefix fix"),
    { text: "Done." },
  ];
  // Every approval is allowed, so the chained call runs once a person says yes, and only the sandbox decides where.
  const { results, approvals, repo } = await runScripted(t, { action: "build", script, segwi: { branchPrefixes: ["security/"] } });
  const report = show(results, approvals);

  // Each plain form updated the checkout's git directory, which only a call outside the sandbox can write.
  const branches = [0, 1, 2, 3].map((index) => {
    assert.equal(results[index]?.isError, false, `turn ${index}: ${report}`);
    return JSON.parse(results[index].text).branch;
  });
  assert.deepEqual(branches, ["agent/plain", "agent/quoted", "security/listed", "security/reordered"]);
  assert.deepEqual(approvals.map((approval) => approval.exact), [script[4].input.command], `only the chained call asked: ${report}`);
  // The chained call stayed inside, so it couldn't take the lock, and ibni says which form works.
  assert.equal(results[4]?.isError, true, report);
  assert.match(results[4].text, /can't write the repository's git directory \(EROFS: .*opencode-implementation\.lock\)/, report);
  assert.match(results[4].text, /a Bash call of its own/, report);
  // A prefix the sandbox won't let the run write later is refused before a branch exists.
  assert.equal(results[5]?.isError, true, report);
  assert.match(results[5].text, /--prefix fix isn't one this run can write/, report);
  assert.deepEqual(branchesOf(repo), [...branches, "main"].sort());
});

test("a run commits on a segwi.branchPrefixes branch, and can't write a branch under any other prefix", { skip, timeout: 180_000 }, async (t) => {
  const script = [
    bash("ibni prepare --slug audit-fix --prefix security"),
    (context) => bash(`cd ${worktreeOf(context)}`),
    (context) => ({ tool: "Write", input: { file_path: path.join(worktreeOf(context), "note.txt"), content: "note\n" } }),
    bash("git add note.txt"),
    bash('git commit -q -m "on a listed prefix"'),
    bash("git branch fix/sneaky"),
    bash("git branch agent/allowed"),
    { text: "Done." },
  ];
  const { results, approvals, repo } = await runScripted(t, { action: "build", script, segwi: { branchPrefixes: ["security/"] } });
  const report = show(results, approvals);
  for (const index of [0, 2, 3, 4]) assert.equal(results[index]?.isError, false, `turn ${index}: ${report}`);
  assert.equal(git(repo, "log", "-1", "--format=%s", "security/audit-fix"), "on a listed prefix");
  // git branch is off the allow list: a person allowed both, and the sandbox let only the rendered prefixes through.
  assert.equal(results[5]?.isError, true, report);
  assert.match(results[5].text, /cannot lock ref 'refs\/heads\/fix\/sneaky': unable to create directory/, report);
  assert.equal(results[6]?.isError, false, report);
  assert.deepEqual(branchesOf(repo), ["agent/allowed", "main", "security/audit-fix"]);
});

// --- the permissions modes ---
// The shapes of the approvals real runs raised (the PR lists them), with this run's paths.
const realRunShapes = ({ repo, worktreeRoot }) => [
  `cd ${worktreeRoot} && ls && git --version`,
  `pwd; git -C ${repo} status --short --branch; ibni prepare --help`,
  "echo $IBNI_LAUNCH_CHECKOUT; ibni prepare --slug audit-fix --prefix security",
  // An inline body with a Markdown heading, as the real one had: a line starting with # is what made it ask.
  'gh pr create --title "Docs" --body "First line.\n\n## Decisions\n- Documented the routes."',
].map(bash);

test("sandboxed mode runs the commands that asked in real runs unasked, while a call outside the sandbox still asks and a deny rule still refuses", { skip, timeout: 240_000 }, async (t) => {
  const shapes = [0, 1, 2, 3].map((index) => (context) => realRunShapes(context)[index]);
  const outside = ({ home }) => ({ tool: "Write", input: { file_path: path.join(home, "outside.txt"), content: "x\n" } });
  const script = [...shapes, outside, bash("npm publish"), { text: "Done." }];
  // security/ is listed, as verifika's would be, so the chained prepare gets as far as the lock.
  const segwi = { branchPrefixes: ["security/"] };
  const sandboxed = await runScripted(t, { action: "build", script, decide: () => "deny", segwi: { ...segwi, permissions: "sandboxed" } });
  const report = show(sandboxed.results, sandboxed.approvals);
  assert.deepEqual(sandboxed.approvals.map((approval) => approval.tool), ["Write"], `only the file write outside the sandbox asked: ${report}`);
  assert.equal(sandboxed.results[0]?.isError, false, report);
  // Still sandboxed, so the chained prepare fails as it did on verifika, now with the form that works.
  assert.match(sandboxed.results[2]?.text ?? "", /a Bash call of its own/, report);
  assert.ok(!existsSync(path.join(sandboxed.home, "outside.txt")), report);
  assert.match(sandboxed.results[5]?.text ?? "", /has been denied/, report);
  const { steps } = (await request(sandboxed.server, "GET", `/api/runs/${sandboxed.run.id}`)).json.run;
  assert.deepEqual(steps.filter((step) => step.type === "refusal").map((step) => step.detail), ["Refused: npm publish — a deny rule"]);
  assert.equal(sandboxed.audit.filter((row) => row.action === "run.refused").length, 1);

  // Control: strict mode, today's behaviour, asks for every one of them.
  const strict = await runScripted(t, { action: "build", script: [...shapes, { text: "Done." }], decide: () => "deny", segwi });
  assert.equal(strict.approvals.length, 4, show(strict.results, strict.approvals));
});

// The file tools run outside the sandbox, so in auto mode only a deny rule, not a person, keeps them from files
// that later run as you. Here every approval is allowed (except one into this checkout), so only a deny rule refuses.
const MEXXI_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

test("the file tools can't write your keys, shell or git config, agent config or mexxi itself, even when a person allows it", { skip, timeout: 180_000 }, async (t) => {
  const prepare = ({ home }) => {
    writeFileSync(path.join(home, ".bashrc"), "# rc\n");
    writeFileSync(path.join(home, ".gitconfig"), "[user]\n");
    mkdirSync(path.join(home, ".ssh"), { mode: 0o700 });
    mkdirSync(path.join(home, ".config"));
  };
  const write = (target) => (context) => ({ tool: "Write", input: { file_path: target(context), content: `${PLANTED}\n` } });
  const script = [
    write(({ home }) => path.join(home, ".bashrc")),
    write(({ home }) => path.join(home, ".gitconfig")),
    write(({ home }) => path.join(home, ".ssh", "authorized_keys")),
    write(({ home }) => path.join(home, ".config", "systemd", "user", "planted.service")),
    write(({ home }) => path.join(home, ".claude", "settings.json")),
    write(() => path.join(MEXXI_ROOT, "scripts", `${PLANTED}.mjs`)),
    { text: "Done." },
  ];
  // A write into this checkout is never allowed here, so a missing rule fails the test instead of planting a file.
  const decide = (approval) => (approval.exact.includes(MEXXI_ROOT) ? "deny" : "allow");
  const { results, approvals, home } = await runScripted(t, { action: "build", script, decide, prepare });
  const report = show(results, approvals);
  for (const index of [0, 1, 2, 3, 4, 5]) assert.match(results[index]?.text ?? "", /denied/, `turn ${index}: ${report}`);
  assert.deepEqual(approvals, [], `a deny rule refused each one before a person was asked: ${report}`);
  assert.equal(readFileSync(path.join(home, ".bashrc"), "utf8"), "# rc\n");
  assert.ok(!existsSync(path.join(home, ".ssh", "authorized_keys")) && !existsSync(path.join(MEXXI_ROOT, "scripts", `${PLANTED}.mjs`)), report);
});

test("in sandboxed mode a push or a GitHub API call still asks, though it would run inside the sandbox", { skip, timeout: 180_000 }, async (t) => {
  const script = [bash("git push origin HEAD:main"), bash("gh api repos/someone/something"), bash("echo still-unasked"), { text: "Done." }];
  const { results, approvals } = await runScripted(t, { action: "build", script, decide: () => "deny", segwi: { permissions: "sandboxed" } });
  const report = show(results, approvals);
  assert.deepEqual(approvals.map((approval) => approval.exact), ["git push origin HEAD:main", "gh api repos/someone/something"], report);
  assert.equal(results[2]?.isError, false, report);
});
