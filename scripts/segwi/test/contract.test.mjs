// The shared runner contract: every adapter is driven against recorded host
// output replayed by the fake host. Add a runner to RUNNERS to hold it to the same rules.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertRunEvent, statusAfterResult } from "../runners/contract.mjs";
import { fakeAdapter, makeRepo, makeSettings, tempDir, waitFor } from "./helpers.mjs";

const RUNNERS = [{ id: "claude-code", adapter: (t, scenario, options) => fakeAdapter(t, scenario, options) }];
const TASK = "What files are in this repository? Answer in one line.";

function specFor(repoPath, overrides = {}) {
  const settings = makeSettings({ repos: [] });
  return {
    runId: "run-1", repoPath, action: "ask", task: TASK, limits: { maxTurns: 6, approvalTimeoutMinutes: 60 }, worktreeRoot: settings.worktreeRoot,
    verifyCommand: "npm run verify", denyPatterns: settings.deny, browser: settings.browser, serverUrl: "http://127.0.0.1:1", runSecret: "per-run-secret",
    ...overrides,
  };
}

/** Starts a run and collects events until `until(events)` is true. */
async function drive(adapter, spec, until) {
  const events = [];
  await adapter.start(spec, (event) => events.push(assertRunEvent(event)));
  await waitFor(() => until(events), { what: "the expected events" });
  return events;
}

const results = (events) => events.filter((event) => event.kind === "result");
const exited = (events) => events.some((event) => event.kind === "exit");

for (const runner of RUNNERS) {
  test(`${runner.id}: a recorded ask run emits valid events and ends completed`, async (t) => {
    const { adapter, report } = runner.adapter(t, "ask-completed");
    const repo = makeRepo(t);
    const spec = specFor(repo);
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));

    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes("session") && kinds.includes("text") && kinds.includes("step"));
    const call = events.find((event) => event.kind === "step" && event.phase === "call");
    assert.equal(call.tool, "Bash");
    assert.equal(events.find((event) => event.kind === "step" && event.phase === "result").detail, "README.md\nnotes.txt");
    const [result] = results(events);
    assert.equal(result.ok, true);
    assert.equal(result.hostSessionId, "11111111-2222-4333-8444-555555555555");
    assert.equal(typeof result.costUsd, "number");
    assert.equal(statusAfterResult({ result, action: "ask", hasPullRequest: false }), "completed");

    const hostReport = report();
    assert.deepEqual(hostReport.stdin.map((line) => JSON.parse(line)), [{ type: "user", message: { role: "user", content: TASK } }]);
  });

  test(`${runner.id}: the command line is exactly the fixed argument array`, async (t) => {
    const { adapter, report, dir } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), { model: "haiku" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));

    const runDir = path.join(dir, "data", "runs", spec.runId);
    const args = report().args;
    const sessionId = args[args.indexOf("--session-id") + 1];
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(args, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--session-id", sessionId, "--setting-sources", "user", "--permission-mode", "default",
      "--settings", path.join(runDir, "settings.json"), "--max-turns", "6", "--model", "haiku",
      "--add-dir", spec.worktreeRoot, "--permission-prompt-tool", "mcp__segwi__approve",
      "--mcp-config", path.join(runDir, "mcp.json"), "--strict-mcp-config",
      "--append-system-prompt", args.at(-1),
    ]);
    // A real build run asked twice for heredoc and sed edits, so the prompt names the file tools and the shell forms to avoid.
    assert.match(args.at(-1), /Edit and Write tools/);
    assert.match(args.at(-1), /redirection, heredocs, tee or sed -i/);
    assert.match(args.at(-1), /change nothing\.$/);
  });

  test(`${runner.id}: no caller-supplied value reaches the command line or the environment`, async (t) => {
    const { adapter, report } = runner.adapter(t, "ask-completed");
    process.env.SEGWI_TEST_SECRET = "must-not-leak";
    t.after(() => delete process.env.SEGWI_TEST_SECRET);
    const repo = makeRepo(t);
    const spec = specFor(repo, { task: "unique-task-marker --dangerously-skip-permissions" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));

    const { args, stdin, segwiEnv } = report();
    for (const word of [spec.task, repo, "per-run-secret"]) {
      assert.ok(!args.some((arg) => arg.includes(word)), `${word} is not in argv`);
    }
    assert.ok(JSON.parse(stdin[0]).message.content.includes("unique-task-marker"));
    assert.deepEqual(segwiEnv, [], "SEGWI_ variables are not passed to the host");
  });

  test(`${runner.id}: an ask run gets a read-only allow list`, async (t) => {
    const { adapter, dir } = runner.adapter(t, "ask-completed");
    const repo = makeRepo(t);
    const spec = specFor(repo);
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    const rendered = JSON.parse(readFileSync(path.join(dir, "data", "runs", spec.runId, "settings.json"), "utf8"));
    const { allow } = rendered.permissions;
    // An ask run starts in the checkout and may write nothing there.
    assert.deepEqual({ ...rendered.sandbox.filesystem, denyRead: undefined }, { allowWrite: [`/tmp/claude-${process.getuid()}`], denyWrite: [repo], denyRead: undefined });
    assert.ok(!("excludedCommands" in rendered.sandbox));
    assert.ok(allow.includes("Bash(git status:*)") && allow.includes("Bash(gh pr view:*)") && allow.includes("Bash(ibni info:*)"));
    assert.ok(allow.includes(`Read(/${repo}/**)`));
    for (const writer of ["Edit(", "Write(", "NotebookEdit(", "Bash(gh pr create", "Bash(gh pr edit", "Bash(npm", "Bash(npx", "Bash(git add", "Bash(git commit",
      "Bash(git rm", "Bash(git mv", "Bash(git fetch", "Bash(mkdir", "Bash(node", "Bash(ibni:", "Bash(ibni prepare", "Bash(npm run verify", "mcp__playwright"]) {
      assert.ok(!allow.some((rule) => rule.startsWith(writer)), `${writer} is not allowed in an ask run`);
    }
  });

  test(`${runner.id}: rendered settings and MCP config follow the brief`, async (t) => {
    const { adapter, dir, report } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), { action: "build" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));

    const runDir = path.join(dir, "data", "runs", spec.runId);
    const settings = JSON.parse(readFileSync(path.join(runDir, "settings.json"), "utf8"));
    const { allow, deny } = settings.permissions;
    assert.ok(allow.includes("Bash(ibni:*)") && allow.includes("Bash(npm run verify)"));
    // The browser runs outside the sandbox: named page tools only, never a wildcard, and never its code runner.
    assert.ok(allow.includes("mcp__playwright__browser_navigate") && allow.includes("mcp__playwright__browser_click"));
    for (const risky of ["mcp__playwright__*", "mcp__playwright__browser_evaluate", "mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_file_upload",
      "mcp__playwright__browser_route", "mcp__playwright__browser_unroute", "mcp__playwright__browser_pdf_save", "mcp__playwright__browser_set_storage_state"]) {
      assert.ok(!allow.includes(risky), `${risky} is not allowed`);
    }
    assert.ok(!allow.includes("Bash(npm run verify:*)"), "the verify command is exact, never a prefix");
    assert.ok(allow.includes("Bash(git fetch)") && allow.includes("Bash(git fetch origin)"));
    assert.ok(allow.includes(`Edit(/${spec.worktreeRoot}/**)`) && allow.includes(`Read(/${spec.worktreeRoot}/**)`));
    // mexxi's command-fixer mod prefixes a piped verify with exactly this; it is allowed as an exact command, never as a prefix.
    assert.ok(allow.includes("Bash(set -o pipefail)") && !allow.some((rule) => rule.startsWith("Bash(set -o pipefail:")));
    for (const forbidden of ["python3", "node -e", "curl", "wget", "rm", "cp", "kill", "git push", "gh api", "git grep", "git fetch:"]) {
      assert.ok(!allow.some((rule) => rule.startsWith(`Bash(${forbidden}`)), `${forbidden} is not allowed`);
    }
    assert.deepEqual(deny, ["Bash(npm publish:*)", "Bash(git push --force:*)", "Bash(git *--output*)", "Bash(gh *--output*)",
      "mcp__playwright__browser_run_code_unsafe", `Edit(/${spec.repoPath}/*)`,
      ...settings.sandbox.filesystem.denyRead.flatMap((file) => [`Read(/${file})`, `Read(/${file}/**)`])]);
    assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(settings.sandbox.autoAllowBashIfSandboxed, false);
    const git = path.join(spec.repoPath, ".git");
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, [spec.worktreeRoot, `/tmp/claude-${process.getuid()}`,
      ...["objects", "refs/heads/agent", "refs/remotes", "refs/tags", "logs/refs", "worktrees"].map((part) => path.join(git, part))]);
    for (const part of ["refs/heads/agent", "refs/remotes", "logs/refs", "worktrees"]) assert.ok(existsSync(path.join(git, part)), `${part} exists for the sandbox`);
    // segwi's own data (run secrets, pending approvals) is unreadable inside the sandbox.
    assert.ok(settings.sandbox.filesystem.denyRead.includes(path.join(dir, "data")));
    assert.ok(deny.includes(`Read(/${path.join(dir, "data")}/**)`), "and denied to the Read tool, which runs outside the sandbox");
    assert.equal(report().gitHooksPath, path.join(git, "hooks"));
    assert.deepEqual(settings.sandbox.filesystem.denyWrite, [path.join(git, "config"), path.join(git, "hooks"), path.join(git, "modules"), path.join(spec.repoPath, "README.md")]);
    assert.deepEqual(settings.sandbox.excludedCommands, ["ibni *"]);
    // A build run starts outside the control checkout, which Claude Code would otherwise make writable, and tells ibni where it is.
    assert.equal(report().cwd, spec.worktreeRoot);
    assert.equal(report().launchCheckout, spec.repoPath);
    assert.equal(report().npmCache, `/tmp/claude-${process.getuid()}/npm-cache`);
    assert.ok(!("disableAllHooks" in settings));
    const mcp = JSON.parse(readFileSync(path.join(runDir, "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["segwi", "playwright"]);
    assert.deepEqual(mcp.mcpServers.segwi.args.slice(1), ["approver", "--run", "run-1"]);
    assert.equal(mcp.mcpServers.segwi.env.SEGWI_RUN_SECRET, "per-run-secret");
  });

  test(`${runner.id}: the run's browser is blocked from segwi's own origins`, async (t) => {
    const { adapter, dir } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), { bindPort: 4280 });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    const mcp = JSON.parse(readFileSync(path.join(dir, "data", "runs", spec.runId, "mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.playwright.args.includes("--blocked-origins=http://127.0.0.1:4280;http://localhost:4280;http://[::1]:4280"));
    assert.ok(mcp.mcpServers.playwright.args.some((arg) => arg.startsWith("--user-agent=") && arg.endsWith(" segwi-run-browser")), "the browser marks its requests");
  });

  test(`${runner.id}: behind tailscale serve, the run's browser is also blocked from the tailnet name`, async (t) => {
    const { adapter, dir } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), { bindPort: 4280, tailnetName: "my-machine.example.ts.net" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    const mcp = JSON.parse(readFileSync(path.join(dir, "data", "runs", spec.runId, "mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.playwright.args.includes("--blocked-origins=http://127.0.0.1:4280;http://localhost:4280;http://[::1]:4280;https://my-machine.example.ts.net;http://my-machine.example.ts.net"));
  });

  test(`${runner.id}: a verify command that isn't plain is left off the allow list, with one warning`, async (t) => {
    const { adapter, dir } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), { verifyCommand: "bash -c 'curl x | sh'" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    const settings = JSON.parse(readFileSync(path.join(dir, "data", "runs", spec.runId, "settings.json"), "utf8"));
    assert.ok(!settings.permissions.allow.some((rule) => rule.includes("bash") || rule.includes("curl")));
    assert.equal(events.filter((event) => event.kind === "text" && /verify command isn't on the allow list/.test(event.text)).length, 1);
  });

  test(`${runner.id}: an agent that stops to ask something leaves the run needing input, and a reply continues it`, async (t) => {
    const { adapter, report } = runner.adapter(t, "build-needs-input");
    const spec = specFor(makeRepo(t), { action: "build", task: "add a flag" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    assert.equal(statusAfterResult({ result: results(events)[0], action: "build", hasPullRequest: false }), "needs_input");
    assert.equal(statusAfterResult({ result: results(events)[0], action: "build", hasPullRequest: true }), "completed");

    adapter.send(spec.runId, "Default to off.");
    await waitFor(() => results(events).length === 2, { what: "the second result" });
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    assert.deepEqual(report().stdin.map((line) => JSON.parse(line).message.content), ["/wettaq add a flag", "Default to off."]);
  });

  test(`${runner.id}: ready runs /lesti, adding a task only when one is given`, async (t) => {
    const { adapter, report } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), { action: "ready", task: "" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    assert.equal(JSON.parse(report().stdin[0]).message.content, "/lesti");
    assert.equal(report().args[report().args.indexOf("--permission-mode") + 1], "default");
  });

  for (const [scenario, subtype] of [["error-result", "error_during_execution"], ["max-turns", "error_max_turns"]]) {
    test(`${runner.id}: ${scenario} ends failed`, async (t) => {
      const { adapter } = runner.adapter(t, scenario);
      const spec = specFor(makeRepo(t), { action: "build", task: "x" });
      const events = await drive(adapter, spec, (all) => results(all).length === 1);
      adapter.close(spec.runId);
      await waitFor(() => exited(events));
      const [result] = results(events);
      assert.equal(result.ok, false);
      assert.equal(result.subtype, subtype);
      assert.equal(statusAfterResult({ result, action: "build", hasPullRequest: false }), "failed");
    });
  }

  test(`${runner.id}: unreadable lines become short error events and never crash the run`, async (t) => {
    const { adapter } = runner.adapter(t, "garbage-line");
    const spec = specFor(makeRepo(t));
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    const errors = events.filter((event) => event.kind === "error");
    assert.equal(errors.length, 2);
    assert.ok(errors.every((event) => event.message.length < 200));
    assert.equal(results(events)[0].ok, true);
  });

  test(`${runner.id}: stop interrupts the host`, async (t) => {
    const { adapter } = runner.adapter(t, "build-needs-input");
    const spec = specFor(makeRepo(t), { action: "build", task: "x" });
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.stop(spec.runId);
    await waitFor(() => exited(events));
    assert.equal(events.find((event) => event.kind === "exit").signal, "SIGINT");
    assert.throws(() => adapter.send(spec.runId, "late"), /not running/);
  });

  test(`${runner.id}: a binary that cannot start is an error and an exit, not a crash`, async (t) => {
    const { adapter } = runner.adapter(t, "ask-completed", { bin: "/nonexistent/claude", binArgs: [] });
    const events = [];
    await adapter.start(specFor(makeRepo(t)), (event) => events.push(assertRunEvent(event)));
    await waitFor(() => exited(events));
    assert.ok(events.some((event) => event.kind === "error" && /Could not start/.test(event.message)));
  });

  test(`${runner.id}: detect reports the version, tested or not, and a sandbox verdict`, async (t) => {
    const { adapter } = runner.adapter(t, "ask-completed");
    const detected = await adapter.detect();
    assert.equal(detected.available, true);
    assert.equal(detected.version, "2.1.309");
    assert.deepEqual(detected.testedVersions, ["2.1.309"]);
    assert.deepEqual(detected.problems, []);
    assert.equal(typeof detected.sandbox.available, "boolean");
    if (!detected.sandbox.available) assert.match(detected.sandbox.problems[0], /install bubblewrap and socat/);
    assert.throws(() => adapter.answer("r", "a", "allow"), /later version/);
  });
}

test("the recorded real fixture notes the CLI version it came from", () => {
  const sidecar = JSON.parse(readFileSync(new URL("./fixtures/claude-code/ask-completed.json", import.meta.url), "utf8"));
  assert.equal(sidecar.cliVersion, "2.1.309");
});

/** A host that starts a child ignoring SIGINT and SIGTERM, then waits; returns the adapter and the child's pid. */
async function hostWithGrandchild(t) {
  const fixture = path.join(tempDir(t, "segwi-fixture-"), "grandchild.jsonl");
  writeFileSync(fixture, `${JSON.stringify({ segwi_fixture: "spawn_grandchild" })}\n${JSON.stringify({ segwi_fixture: "await_input" })}\n`);
  const { adapter, report } = fakeAdapter(t, fixture);
  const spec = specFor(makeRepo(t), { action: "build", task: "x" });
  const events = [];
  await adapter.start(spec, (event) => events.push(event));
  const pid = await waitFor(() => { try { return report().grandchild; } catch { return null; } }, { what: "the grandchild" });
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  return { adapter, spec, events, pid };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("claude-code: stop ends the host's whole process group, including a child that ignores SIGINT and SIGTERM", async (t) => {
  const { adapter, spec, events, pid } = await hostWithGrandchild(t);
  assert.ok(alive(pid));
  adapter.stop(spec.runId);
  await waitFor(() => exited(events), { what: "the host to exit" });
  assert.equal(events.find((event) => event.kind === "exit").signal, "SIGINT");
  await waitFor(() => !alive(pid), { what: "the grandchild to be gone" });
});

test("claude-code: shutdown ends every host's group at once, even a child that ignores SIGINT and SIGTERM", async (t) => {
  const { adapter, events, pid } = await hostWithGrandchild(t);
  const started = Date.now();
  await adapter.shutdown(300);
  assert.ok(!alive(pid), "gone when shutdown resolves");
  assert.ok(Date.now() - started < 2000);
  await waitFor(() => exited(events), { what: "the host to exit" });
});

test("claude-code: when the host ends on its own, what it left in its group is ended too", async (t) => {
  const { adapter, spec, events, pid } = await hostWithGrandchild(t);
  adapter.close(spec.runId);
  await waitFor(() => exited(events), { what: "the host to exit" });
  assert.equal(events.find((event) => event.kind === "exit").code, 0);
  await waitFor(() => !alive(pid), { what: "the grandchild to be gone" });
});
