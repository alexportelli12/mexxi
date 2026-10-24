// The shared runner contract: every adapter is driven against recorded host
// output replayed by the fake host. Add a runner to RUNNERS to hold it to the same rules.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { mapMessage } from "../runners/claude-code.mjs";
import { assertRunEvent, statusAfterResult } from "../runners/contract.mjs";
import { fakeAdapter, makeRepo, makeSettings, tempDir, waitFor } from "./helpers.mjs";

const RUNNERS = [{ id: "claude-code", adapter: (t, scenario, options) => fakeAdapter(t, scenario, options) }];
const TASK = "What files are in this repository? Answer in one line.";

function specFor(repoPath, overrides = {}) {
  const settings = makeSettings({ repos: [] });
  return {
    runId: "run-1", repoPath, action: "ask", task: TASK, limits: { maxTurns: 6, approvalTimeoutMinutes: 60 }, worktreeRoot: settings.worktreeRoot,
    browser: settings.browser, serverUrl: "http://127.0.0.1:1", runSecret: "per-run-secret",
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

  /** Starts a run with `overrides` and returns its argument array, its prompt and the host's report. */
  async function started(t, overrides = {}) {
    const { adapter, dir, report } = runner.adapter(t, "ask-completed");
    const spec = specFor(makeRepo(t), overrides);
    const events = await drive(adapter, spec, (all) => results(all).length === 1);
    adapter.close(spec.runId);
    await waitFor(() => exited(events));
    const host = report();
    return { spec, dir, events, args: host.args, prompt: host.args.at(-1), report: host };
  }

  test(`${runner.id}: a build run's command line is a session you start by hand, in auto mode, with segwi's approval tool and browser`, async (t) => {
    const { spec, dir, args, prompt } = await started(t, { action: "build", task: "add a flag", model: "haiku" });
    const runDir = path.join(dir, "data", "runs", spec.runId);
    const sessionId = args[args.indexOf("--session-id") + 1];
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    // No --settings and no --setting-sources: your own settings (the guard hook, the loop breaker, guard.deny) apply as
    // they do in a session you start yourself, and segwi renders no allow, ask or deny list and no sandbox.
    assert.deepEqual(args, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--session-id", sessionId, "--permission-mode", "auto",
      "--max-turns", "6", "--model", "haiku",
      "--add-dir", spec.worktreeRoot, "--permission-prompt-tool", "mcp__segwi__approve",
      "--mcp-config", path.join(runDir, "mcp.json"), "--strict-mcp-config",
      "--append-system-prompt", prompt,
    ]);
    assert.ok(!existsSync(path.join(runDir, "settings.json")), "no per-run settings file");
    // Auto mode refuses some calls; the agent stops and asks rather than working around one.
    assert.match(prompt, /If an action is refused, never retry it in pieces or rephrase it/);
    assert.match(prompt, /stop and ask the person what to do/);
  });

  test(`${runner.id}: a build run starts in your checkout with your own environment, less NODE_ENV and segwi's own variables`, async (t) => {
    process.env.NODE_ENV = "production";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "You";
    t.after(() => { for (const key of ["NODE_ENV", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[key]; });
    const { spec, report } = await started(t, { action: "build", task: "x" });
    // Where you would run claude yourself, so /wettaq's ibni prepare finds the checkout as it does for you.
    assert.equal(report.cwd, spec.repoPath);
    // segwi's service runs with NODE_ENV=production, under which npm ci would leave out the repository's dev tools.
    assert.equal(report.nodeEnv, null);
    assert.deepEqual(report.gitConfig, { count: "1", first: ["user.name", "You"], second: [null, null] }, "your git config entries, and nothing added");
    assert.deepEqual(report.ibniEnv, Object.keys(process.env).filter((key) => key.startsWith("IBNI_")), "segwi adds no IBNI_ variable to steer ibni");
    assert.equal(report.npmCache, process.env.npm_config_cache ?? null);
  });

  test(`${runner.id}: an ask run is the same auto-mode session without the file-writing tools, told to change nothing`, async (t) => {
    const ask = await started(t);
    const build = await started(t, { action: "build", task: "x" });
    const disallowed = (args) => (args.includes("--disallowedTools") ? args[args.indexOf("--disallowedTools") + 1] : null);
    assert.equal(disallowed(ask.args), "Edit,Write,NotebookEdit");
    assert.equal(disallowed(build.args), null, "a build run keeps every tool");
    // Not plan mode: it let curl run unasked and switched to a larger model than --model names (decision 0011).
    assert.equal(ask.args[ask.args.indexOf("--permission-mode") + 1], "auto");
    assert.match(ask.prompt, /change nothing\.$/);
    assert.doesNotMatch(build.prompt, /change nothing/);
    assert.equal(ask.report.cwd, ask.spec.repoPath);
  });

  test(`${runner.id}: no caller-supplied value reaches the command line or the environment`, async (t) => {
    process.env.SEGWI_TEST_SECRET = "must-not-leak";
    t.after(() => delete process.env.SEGWI_TEST_SECRET);
    const { spec, args, report } = await started(t, { task: "unique-task-marker --dangerously-skip-permissions" });
    for (const word of [spec.task, spec.repoPath, "per-run-secret"]) {
      assert.ok(!args.some((arg) => arg.includes(word)), `${word} is not in argv`);
    }
    assert.ok(JSON.parse(report.stdin[0]).message.content.includes("unique-task-marker"));
    assert.deepEqual(report.segwiEnv, [], "SEGWI_ variables are not passed to the host");
  });

  test(`${runner.id}: the MCP config holds only segwi's approval tool and its own marked browser`, async (t) => {
    const { spec, dir } = await started(t, { action: "build", task: "x" });
    const mcp = JSON.parse(readFileSync(path.join(dir, "data", "runs", spec.runId, "mcp.json"), "utf8"));
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
    assert.equal(report().args[report().args.indexOf("--permission-mode") + 1], "auto");
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

  test(`${runner.id}: detect reports the version, tested or not`, async (t) => {
    const { adapter } = runner.adapter(t, "ask-completed");
    const detected = await adapter.detect();
    assert.equal(detected.available, true);
    assert.equal(detected.version, "2.1.309");
    assert.deepEqual(detected.testedVersions, ["2.1.309"]);
    assert.deepEqual(detected.problems, []);
    assert.ok(!("sandbox" in detected), "there is no sandbox to report on");
    assert.throws(() => adapter.answer("r", "a", "allow"), /later version/);
  });
}

test("the recorded real fixture notes the CLI version it came from", () => {
  const sidecar = JSON.parse(readFileSync(new URL("./fixtures/claude-code/ask-completed.json", import.meta.url), "utf8"));
  assert.equal(sidecar.cliVersion, "2.1.309");
});

// The refusal texts as real Claude Code 2.1.309 runs wrote them: the auto mode classifier's, a deny rule's and a guard hook's.
const CLASSIFIER_REFUSAL = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation). If you have other tasks that don't depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal.";
const DENY_RULE_REFUSAL = "Permission to use Bash with command npm publish --dry-run has been denied.";
const HOOK_REFUSAL = "PreToolUse:Bash hook error: [node /home/someone/mexxi/scripts/hooks/guard.mjs]: mexxi guard blocked this command: git push to main changes a protected branch (the default branch or guard.protectedBranches); deliver through a feature branch and a pull request. Do not retry it in pieces.\n";
const toolResult = (text, isError = true) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: isError, content: text }] } });

test("claude-code: a refused call maps to its result and a refusal with the reason, whoever refused it", () => {
  const refusal = (text) => mapMessage(toolResult(text)).map(assertRunEvent).filter((event) => event.kind === "refusal");
  assert.deepEqual(refusal(CLASSIFIER_REFUSAL), [{ kind: "refusal", toolUseId: "toolu_1", reason: "auto mode: The server-side auto mode classifier judged this action dangerous (it gave no explanation)" }]);
  assert.deepEqual(refusal(DENY_RULE_REFUSAL), [{ kind: "refusal", toolUseId: "toolu_1", reason: "a deny rule" }]);
  assert.deepEqual(refusal(HOOK_REFUSAL), [{ kind: "refusal", toolUseId: "toolu_1", reason: "mexxi guard blocked this command: git push to main changes a protected branch (the default branch or guard.protectedBranches)" }]);
  assert.equal(mapMessage(toolResult(CLASSIFIER_REFUSAL))[0].kind, "step", "the call's own result still comes first");
  // A person's denial is already on the run as an approval, and a failing command is a failed step.
  for (const text of ["A person denied this in segwi.", "touch: cannot touch 'x': Read-only file system", "Exit code 1\nnpm ERR! Permission to use the registry has been denied."]) {
    assert.deepEqual(refusal(text), [], text);
  }
  assert.deepEqual(mapMessage(toolResult(DENY_RULE_REFUSAL, false)).filter((event) => event.kind === "refusal"), [], "only an error result is a refusal");
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
