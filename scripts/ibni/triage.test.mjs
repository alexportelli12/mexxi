// Jev triage without the network: the payload builder, redaction, the cap and
// every way the call can fail, with an injected fetch. ibni.test.mjs drives
// the triage subcommand end to end against a local stub server.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadSchema, withDefaults } from "../lib/config.mjs";
import { REDACTION, redact, SECRET_PATTERNS } from "../lib/redact.mjs";
import { askJev, buildRequest, QUESTIONS, TRUNCATION_ORDER } from "./lib/jev.mjs";

const answers = {
  existingUi: { type: "noul", noul: 0.2 },
  userFacing: { type: "noul", noul: 0.9 },
  oneWayDoor: { type: "noul", noul: 0.05 },
  size: { type: "choice", choice: "local", confidence: 0.8, probabilities: { local: 0.8, feature: 0.2 } },
  reviewValue: { type: "score", score: 2.4, confidence: 0.6, probabilities: { 0: 0, 1: 0.1, 2: 0.4, 3: 0.5 } },
};
const success = { id: "gen-1", model: "typesafe/jev-1.14-20261001", provider: "TypeSafe", answers, usage: { input_tokens: 900, output_tokens: 0, cost: 0.00004 } };

function respond(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// A fetch that answers from a queue and records each request it was given.
function fakeFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    return typeof next === "function" ? next(init) : next;
  };
  return { calls, fetchImpl };
}

const base = { model: "typesafe/jev-1.14", request: "Add a dark mode toggle", contract: "Goal: dark mode", changedPaths: ["src/theme.ts"], diffStats: { files: 1, insertions: 3, deletions: 1, untracked: 0 }, maxBytes: 32768, zeroDataRetention: true };
const call = (fetchImpl, extra = {}) => askJev({ endpoint: "https://jev.test/decisions", apiKey: "test-key", body: buildRequest(base).body, timeoutMs: 5000, fetchImpl, sleep: async () => {}, ...extra });

test("the defaults are the plan's safeguards: off, pinned model, shadow only, 32 KB, 5 s", async () => {
  const schema = await loadSchema();
  const { jev } = withDefaults({}, schema);
  assert.deepEqual(
    { enabled: jev.enabled, stage: jev.stage, model: jev.model, owners: jev.owners, repositories: jev.repositories, maxPayloadBytes: jev.maxPayloadBytes, timeoutMs: jev.timeoutMs },
    { enabled: false, stage: "shadow", model: "typesafe/jev-1.14", owners: [], repositories: [], maxPayloadBytes: 32768, timeoutMs: 5000 },
  );
  // Escalate and skip are later stages; nothing may select them until shadow data earns it.
  assert.deepEqual(schema.properties.jev.properties.stage.enum, ["shadow"]);
});

test("the request asks the plan's five questions in the Decisions API's shape", () => {
  const { body } = buildRequest(base);
  assert.equal(body.model, "typesafe/jev-1.14");
  assert.deepEqual(body.provider, { zdr: true });
  assert.deepEqual(Object.keys(body.state).sort(), ["changedPaths", "context", "contract", "diffStats", "request"]);
  assert.deepEqual(Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [name, question.type])), {
    existingUi: "noul", userFacing: "noul", oneWayDoor: "noul", size: "choice", reviewValue: "score",
  });
  assert.deepEqual(Object.keys(QUESTIONS.size.criteria), ["mechanical", "local", "feature", "cross-cutting", "other"]);
  for (const question of Object.values(QUESTIONS).filter((item) => item.type === "noul")) assert.deepEqual(Object.keys(question.criteria), ["true", "false"]);
  assert.equal(buildRequest({ ...base, zeroDataRetention: false }).body.provider, undefined);
});

test("every shared secret pattern compiles and redacts a planted token", async () => {
  const samples = {
    "PEM private key": "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx4\nq9Zr+/w==\n-----END RSA PRIVATE KEY-----",
    "openai-style key": "sk-abcdefghijklmnopqrstuv",
    "GitHub token": "ghp_abcdefghijklmnopqrstuvwxyz012345",
    "GitHub fine-grained token": "github_pat_11ABCDEFGHIJKLMNOPQRSTUV",
    "AWS access key": "AKIAABCDEFGHIJKLMNOP",
    "Google API key": "AIzaSyA1bCdEfGhIjKlMnOpQrStUvWxYz012345",
    "Slack token": "xoxb-1234567890-abcdef",
    "Shopify token": "shpat_0123456789abcdef0123",
    JWT: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij",
    "bearer credential": "BEARER abcdefghijklmnopqrst",
    "secret-named assignment": "db_password=hunter2",
    "long opaque token": "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0e1",
  };
  const source = JSON.parse(await readFile(new URL("../lib/secret-patterns.json", import.meta.url), "utf8"));
  assert.deepEqual(SECRET_PATTERNS.map((pattern) => pattern.name), source.patterns.map((pattern) => pattern.name));
  for (const { name } of SECRET_PATTERNS) {
    const { text, count } = redact(`before ${samples[name]} after`);
    assert.ok(count >= 1 && !text.includes(samples[name]), `${name} is redacted`);
  }
  assert.deepEqual(redact("rename the settings page"), { text: "rename the settings page", count: 0 });
  // A key block spanning lines goes as one, with nothing of its body left.
  assert.deepEqual(redact(`cat id_rsa\n${samples["PEM private key"]}\ndone`), { text: `cat id_rsa\n${REDACTION}\ndone`, count: 1 });
});

test("a planted token in the request is replaced before sending and the call counts as redacted", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz012345";
  const built = buildRequest({ ...base, request: `Use ${token} to call the API`, changedPaths: [`config/${token}.json`] });
  const sent = JSON.stringify(built.body);
  assert.ok(!sent.includes(token));
  assert.equal(built.body.state.request, `Use ${REDACTION} to call the API`);
  assert.equal(built.redactions, 2);
  assert.equal(buildRequest(base).redactions, 0);
});

test("the request stays below the cap, shortening paths, then the request, then the contract", () => {
  const size = (body) => Buffer.byteLength(JSON.stringify(body));
  const paths = Array.from({ length: 2000 }, (_, index) => `src/module-${index}/file.ts`);
  const huge = { ...base, changedPaths: paths, request: "r".repeat(20000), contract: "c".repeat(20000), maxBytes: 8192 };
  assert.deepEqual(TRUNCATION_ORDER, ["changedPaths", "request", "contract"]);

  const onlyPaths = buildRequest({ ...huge, request: "short", contract: "short" });
  assert.deepEqual(onlyPaths.truncated, ["changedPaths"]);
  assert.ok(onlyPaths.bytes < 8192 && size(onlyPaths.body) === onlyPaths.bytes);
  assert.match(onlyPaths.body.state.changedPaths.at(-1), /^\.\.\. and \d+ more$/);
  assert.equal(onlyPaths.body.state.request, "short");

  const pathsAndRequest = buildRequest({ ...huge, contract: "short" });
  assert.deepEqual(pathsAndRequest.truncated, ["changedPaths", "request"]);
  assert.equal(pathsAndRequest.body.state.contract, "short");
  assert.match(pathsAndRequest.body.state.request, /\[truncated\]$/);

  const all = buildRequest(huge);
  assert.deepEqual(all.truncated, ["changedPaths", "request", "contract"]);
  assert.ok(all.bytes < 8192 && all.bytes > 7000, `${all.bytes} uses the room it has`);
  assert.deepEqual(all.body.state.diffStats, base.diffStats);

  assert.deepEqual(buildRequest(base).truncated, []);
  assert.equal(buildRequest({ ...base, maxBytes: 1024 }), null, "a cap the questions alone exceed sends nothing");
});

test("an answered call records answers with confidences, cost and latency", async () => {
  const { calls, fetchImpl } = fakeFetch(respond(200, success));
  const result = await call(fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://jev.test/decisions");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  assert.equal(result.outcome, "answered");
  assert.deepEqual(result.answers.existingUi, { answer: "no", confidence: 0.8, probability: 0.2 });
  assert.deepEqual(result.answers.userFacing, { answer: "yes", confidence: 0.9, probability: 0.9 });
  assert.equal(result.answers.size.answer, "local");
  assert.deepEqual({ ...result.answers.reviewValue, probabilities: undefined }, { answer: 2.4, level: 2, of: 3, confidence: 0.6, probabilities: undefined });
  assert.deepEqual([result.cost, result.inputTokens, result.responseModel, result.attempts, result.httpStatus], [0.00004, 900, success.model, 1, 200]);
  assert.ok(result.latencyMs >= 0);
});

test("a 429 is retried once after a bounded wait, and a second 429 fails open", async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const retried = fakeFetch(respond(429, { error: { code: 429, message: "slow down" } }, { "retry-after": "30" }), respond(200, success));
  const answered = await call(retried.fetchImpl, { sleep });
  assert.deepEqual([answered.outcome, answered.attempts, retried.calls.length], ["answered", 2, 2]);
  assert.deepEqual(waits, [2000], "Retry-After is honoured up to two seconds");

  const limited = fakeFetch(respond(429, {}), respond(429, { error: { code: 429, message: "slow down" } }), respond(200, success));
  const failed = await call(limited.fetchImpl);
  assert.deepEqual([failed.outcome, failed.reason, failed.attempts, limited.calls.length], ["failed", "HTTP 429: slow down", 2, 2]);
});

test("server errors, malformed answers, network errors and timeouts fail open with a reason", async () => {
  const serverError = fakeFetch(respond(502, { error: { code: 502, message: "upstream" } }), respond(200, success));
  const failed = await call(serverError.fetchImpl);
  assert.deepEqual([failed.outcome, failed.reason, serverError.calls.length], ["failed", "HTTP 502: upstream", 1], "a 5xx is not retried");

  for (const [body, reason] of [
    ["not json", /not JSON/],
    [{ answers: {} }, /existingUi is missing/],
    [{ answers: { ...answers, size: { type: "choice", choice: "huge", confidence: 0.9 } } }, /size chose an unknown option/],
    [{ answers: { ...answers, reviewValue: { type: "score", score: 9, confidence: 0.9 } } }, /reviewValue has no score in range/],
    [{ answers: { ...answers, userFacing: { type: "noul" } } }, /userFacing has no noul probability/],
    [[], /no answers/],
  ]) {
    const result = await call(fakeFetch(respond(200, body)).fetchImpl);
    assert.equal(result.outcome, "failed");
    assert.match(result.reason, /^malformed response/);
    assert.match(result.reason, reason);
  }

  const offline = await call(async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }); });
  assert.deepEqual([offline.outcome, offline.reason], ["failed", "request failed: getaddrinfo ENOTFOUND"]);

  // A server that never answers: the per-request timeout aborts it.
  const hang = (init) => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason)); });
  const started = Date.now();
  const timedOut = await call(fakeFetch(hang).fetchImpl, { timeoutMs: 50 });
  assert.deepEqual([timedOut.outcome, timedOut.reason, timedOut.attempts], ["failed", "timed out after 50 ms", 1]);
  assert.ok(Date.now() - started < 2000);
});
