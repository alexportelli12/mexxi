// The sandbox is what keeps a run's agent away from segwi's own port, so segwi
// need not tell the agent's machine from a phone by headers. This proves it with
// the real Claude Code binary, segwi's real rendered settings, arguments and
// approval path, and a scripted fake model. A control run with only the sandbox
// turned off shows the same command does reach segwi, so the proof can't pass
// because the harness never ran anything.
import assert from "node:assert/strict";
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

test("control: with only the sandbox turned off, the same command reaches segwi once a person allows it", { skip, timeout: 180_000 }, async (t) => {
  const { results, audit, approvals, run } = await runScripted(t, { script: [direct, { text: "Done." }], settingsPatch: { sandbox: { enabled: false } } });

  assert.equal(run.status, "completed", run.reason ?? "");
  assert.equal(approvals.length, 1, "curl is off the allow list, so it went to a person");
  assert.match(approvals[0].exact, /^curl -sS -m 5 http:\/\/127\.0\.0\.1:\d+\/api\/health$/);
  assert.equal(results[0]?.isError, false, results[0]?.text);
  assert.match(results[0].text, /"runner":\{"id":"claude-code"/, "segwi's health answer came back");
  assert.equal(healthRequests(audit).length, 1);
});
