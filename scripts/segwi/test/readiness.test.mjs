// Readiness (issue #67): each of the ten rules passes, fails, and fails when it
// can't be determined; `ready` needs every one; the diff scan catches each kind
// of gate-weakening change. The GitHub reader and the routes are in
// readiness-github.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { RULES, evaluateReadiness, scanDiff, unknown } from "../lib/readiness.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

/** Facts on which every check passes: a completed run, a reviewed head, green and required CI, a clean diff. */
const goodFacts = () => ({
  run: { status: "completed", action: "build", prUrl: "https://github.com/example/my-app/pull/7" },
  ibni: { review: { rounds: 1, findings: 2, history: [{ findings: 2, open: 0, accepted: 2, headSha: HEAD }] } },
  pendingApprovals: 0,
  pr: { state: "open", draft: false, merged: false, mergeable: true, mergeableState: "clean", headSha: HEAD, baseRef: "main", changedFiles: 1 },
  ciCheck: "verify",
  checkRuns: [
    { id: 10, name: "verify", appId: 15368, headSha: HEAD, status: "completed", conclusion: "success" },
    { id: 11, name: "docs", appId: 15368, headSha: HEAD, status: "completed", conclusion: "skipped" },
  ],
  statuses: [],
  required: ["verify"],
  files: [{ filename: "src/a.mjs", previousFilename: null, status: "modified", changes: 2, patch: "@@ -1 +1 @@\n-old\n+new" }],
  acceptance: null,
});

const check = (name, facts) => {
  const entry = RULES.find((candidate) => candidate.name === name);
  assert.ok(entry, `rule ${name} exists`);
  return entry.check(facts);
};
const red = (run) => ({ ...run, status: "completed", conclusion: "failure" });

// Each rule: a change to the good facts that must fail it, the words that say why, and a fact it can't do without.
const CASES = [
  { name: "run-completed", needs: "run", fail: (f) => { f.run.status = "needs_input"; }, why: /needs_input, not completed/ },
  { name: "run-completed", label: "without a pull request", fail: (f) => { f.run.prUrl = null; }, why: /without a pull request/ },
  { name: "run-completed", label: "an ask run", fail: (f) => { f.run.action = "ask"; }, why: /opens no pull request/ },
  { name: "verify-in-ci", needs: "checkRuns", fail: (f) => { f.checkRuns[0] = red(f.checkRuns[0]); }, why: /verify ended failure on aaaaaaa/ },
  { name: "verify-in-ci", label: "no run on the head", fail: (f) => { f.checkRuns[0].headSha = OLD; }, why: /has not run on aaaaaaa/ },
  { name: "verify-in-ci", label: "still running", fail: (f) => { f.checkRuns[0] = { ...f.checkRuns[0], status: "in_progress", conclusion: null }; }, why: /still running/ },
  { name: "verify-in-ci", label: "no ciCheck named", fail: (f) => { f.ciCheck = null; }, why: /names no ciCheck/ },
  { name: "reviewed-head", needs: "ibni", fail: (f) => { f.ibni.review.history[0].headSha = OLD; }, why: /looked at bbbbbbb, but the pull request's head is aaaaaaa/ },
  { name: "reviewed-head", label: "no review", fail: (f) => { f.ibni = {}; }, why: /No review pass/ },
  { name: "review-findings-closed", needs: "ibni", fail: (f) => { Object.assign(f.ibni.review.history[0], { open: 1, accepted: 1 }); }, why: /left 1 finding open/ },
  { name: "review-findings-closed", label: "no round", fail: (f) => { f.ibni.review = { rounds: 0, findings: 0, history: [] }; }, why: /No review round ran/ },
  { name: "review-findings-closed", label: "dismissed without a reason", fail: (f) => { f.ibni.review.history[0].accepted = 1; }, why: /1 finding was neither fixed nor left open, and no written reason/ },
  { name: "ci-green", needs: "required", fail: (f) => { f.checkRuns.push({ id: 12, name: "lint", appId: 15368, headSha: HEAD, status: "completed", conclusion: "failure" }); }, why: /not green: lint \(failure\)/ },
  { name: "ci-green", label: "a pending status", fail: (f) => { f.statuses = [{ id: 1, context: "deploy/preview", state: "pending" }]; }, why: /still running: deploy\/preview/ },
  { name: "ci-green", label: "nothing required", fail: (f) => { f.required = []; }, why: /requires no checks, so CI parity can't be shown/ },
  { name: "ci-green", label: "verify not required", fail: (f) => { f.required = ["docs"]; }, why: /verify, the check that runs verify, is not a required check on main/ },
  { name: "ci-green", label: "a required check never reported", fail: (f) => { f.required = ["verify", "e2e"]; }, why: /required check e2e never reported/ },
  { name: "ci-green", label: "nothing reported", fail: (f) => { f.checkRuns = []; }, why: /No CI has reported on aaaaaaa/ },
  { name: "no-flaky-checks", needs: "checkRuns", fail: (f) => { f.checkRuns.unshift(red({ ...f.checkRuns[0], id: 5 })); }, why: /Green only after a rerun on aaaaaaa: verify/ },
  { name: "no-flaky-checks", label: "a status rerun", fail: (f) => { f.statuses = [{ id: 1, context: "ci/ext", state: "error" }, { id: 2, context: "ci/ext", state: "success" }]; }, why: /rerun.*ci\/ext/ },
  { name: "no-merge-conflicts", needs: "pr", fail: (f) => { f.pr.mergeable = false; f.pr.mergeableState = "dirty"; }, why: /conflicts with main/ },
  { name: "not-draft", needs: "pr", fail: (f) => { f.pr.draft = true; }, why: /is a draft/ },
  { name: "not-draft", label: "closed", fail: (f) => { f.pr.state = "closed"; }, why: /is closed/ },
  { name: "no-pending-approval", needs: "pendingApprovals", fail: (f) => { f.pendingApprovals = 2; }, why: /2 approvals are still waiting/ },
  { name: "no-gate-weakening", needs: "files", fail: (f) => { f.files[0].patch += "\n+// eslint-disable-next-line"; }, why: /needs your acceptance in the web app: a lint or type-check suppression \(src\/a\.mjs\)/ },
];

test("the readiness object has the ten checks of issue #67, in order, each named once", () => {
  assert.deepEqual(evaluateReadiness(goodFacts()).checks.map((entry) => entry.name), [
    "run-completed", "verify-in-ci", "reviewed-head", "review-findings-closed", "ci-green",
    "no-flaky-checks", "no-merge-conflicts", "not-draft", "no-pending-approval", "no-gate-weakening",
  ]);
});

test("every check passes on good facts, and only then is the run ready", () => {
  const readiness = evaluateReadiness(goodFacts());
  for (const entry of readiness.checks) assert.equal(entry.pass, true, `${entry.name}: ${entry.detail}`);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.headSha, HEAD);
  assert.equal(readiness.canAccept, false, "nothing to accept on a clean diff");
});

for (const { name, label, fail, why } of CASES) {
  test(`${name} fails ${label ?? "when its rule is broken"}, and the run is not ready`, () => {
    const facts = goodFacts();
    fail(facts);
    const result = check(name, facts);
    assert.equal(result.pass, false);
    assert.match(result.detail, why);
    assert.equal(evaluateReadiness(facts).ready, false);
  });
}

for (const { name, needs } of CASES.filter((entry) => entry.needs)) {
  test(`${name} fails, saying why, when ${needs} can't be determined`, () => {
    const facts = { ...goodFacts(), [needs]: unknown("GitHub answered 502 for /pulls/7.") };
    const result = check(name, facts);
    assert.deepEqual(result, { name, pass: false, detail: "Can't tell: GitHub answered 502 for /pulls/7." });
    assert.equal(evaluateReadiness(facts).ready, false);
  });
}

test("a check whose own facts leave it open fails rather than passes", () => {
  const facts = goodFacts();
  facts.pr.mergeable = null;
  assert.match(check("no-merge-conflicts", facts).detail, /^Can't tell: GitHub hasn't worked out yet/);
  const unrecorded = goodFacts();
  delete unrecorded.ibni.review.history[0].headSha;
  assert.equal(check("reviewed-head", unrecorded).pass, false);
  assert.match(check("reviewed-head", unrecorded).detail, /^Can't tell: the last review pass recorded no commit/);
  const noOpen = goodFacts();
  delete noOpen.ibni.review.history[0].open;
  assert.match(check("review-findings-closed", noOpen).detail, /^Can't tell: .*didn't record how many findings it left open/);
  const noCiCheck = { ...goodFacts(), ciCheck: null };
  assert.match(check("ci-green", noCiCheck).detail, /^Can't tell: without a ciCheck/);
});

test("a review that found nothing needs no open count", () => {
  const facts = goodFacts();
  facts.ibni.review = { rounds: 2, findings: 3, history: [{ findings: 3, open: 0, accepted: 3, headSha: OLD }, { findings: 0, headSha: HEAD }] };
  assert.equal(check("review-findings-closed", facts).pass, true);
});

test("a cancelled attempt before a green rerun is not a flake, and a green later run of another app's check is kept apart", () => {
  const facts = goodFacts();
  facts.checkRuns.unshift({ ...facts.checkRuns[0], id: 5, conclusion: "cancelled" });
  facts.checkRuns.push({ id: 3, name: "verify", appId: 999, headSha: HEAD, status: "completed", conclusion: "failure" });
  assert.equal(check("no-flaky-checks", facts).pass, true);
  assert.match(check("ci-green", facts).detail, /not green: verify \(failure\)/, "the other app's red verify still counts against CI");
});

test("a person's acceptance passes the gate-weakening check for that head only, and canAccept says when one is needed", () => {
  const facts = goodFacts();
  facts.files[0].patch += "\n+  it.only('focus', () => {});";
  const before = evaluateReadiness(facts);
  assert.equal(before.canAccept, true);
  assert.equal(before.ready, false);
  const accepted = evaluateReadiness({ ...facts, acceptance: { by: "alex@example.com", at: "2026-11-20T10:00:00.000Z" } });
  assert.equal(accepted.ready, true);
  assert.equal(accepted.canAccept, false);
  assert.match(accepted.checks.at(-1).detail, /alex@example\.com accepted these on aaaaaaa/);
});

test("the diff scan flags each kind of gate-weakening change the issue lists", () => {
  const patch = (lines) => `@@ -1,2 +1,2 @@\n${lines.join("\n")}`;
  const flags = scanDiff([
    { filename: "src/a.ts", status: "modified", changes: 5, patch: patch(["+// eslint-disable-next-line no-console", "+const x = y as any;", "+// @ts-ignore", " unchanged as any"]) },
    { filename: "src/a.test.ts", status: "modified", changes: 2, patch: patch(["+describe.skip('slow', () => {});", "+test('x', { skip: true }, () => {});"]) },
    { filename: "vitest.config.ts", status: "modified", changes: 2, patch: patch(["-      thresholds: { lines: 90 },", "+      thresholds: { lines: 60 },"]) },
    { filename: "crap-baseline.json", status: "modified", changes: 1, patch: patch(["+{}"]) },
    { filename: ".github/workflows/verify.yml", status: "modified", changes: 1, patch: patch(["+      - run: echo"]) },
    { filename: "package.json", status: "modified", changes: 2, patch: patch(["-    \"verify\": \"verifika --all\",", "+    \"verify\": \"true\","]) },
    { filename: "docs/logo.png", status: "added", changes: 0, patch: null },
    { filename: "tests/test_slow.py", status: "modified", changes: 1, patch: patch(["+@pytest.mark.skip"]) },
    { filename: "pyproject.toml", status: "modified", changes: 2, patch: patch(["-fail_under = 90", "+fail_under = 60"]) },
  ]);
  assert.deepEqual(flags.sort(), [
    "@ts-ignore (src/a.ts)",
    "a CRAP baseline edit (crap-baseline.json)",
    "a coverage or CRAP threshold change (pyproject.toml)",
    "a coverage or CRAP threshold change (vitest.config.ts)",
    "a lint or type-check suppression (src/a.ts)",
    "a skipped or focused test (src/a.test.ts)",
    "a skipped or focused test (tests/test_slow.py)",
    "an any cast (src/a.ts)",
    "an edit to CI configuration (.github/workflows/verify.yml)",
    "an edit to verify configuration (package.json)",
  ]);
  assert.deepEqual(scanDiff([{ filename: "src/b.ts", status: "modified", changes: 3, patch: patch(["-const skip = 1;", "+const skip = 2;", "+test('x', { skip: false }, () => {});"]) }]), [], "ordinary code is not a flag");
});

test("every flag is listed, however many, so a person accepts only what they were shown", () => {
  const facts = goodFacts();
  facts.files = Array.from({ length: 12 }, (_, index) => ({ filename: `src/f${index}.ts`, status: "modified", changes: 1, patch: "@@ -1 +1 @@\n+// @ts-ignore" }));
  const { detail } = check("no-gate-weakening", facts);
  for (let index = 0; index < 12; index += 1) assert.ok(detail.includes(`@ts-ignore (src/f${index}.ts)`), `f${index} is listed`);
});

test("nothing can be accepted while the diff is unknown", () => {
  assert.equal(evaluateReadiness({ ...goodFacts(), files: unknown("GitHub answered 502.") }).canAccept, false);
});

test("a text file whose diff GitHub didn't return can't be scanned, so the gate check fails", () => {
  const facts = goodFacts();
  facts.files.push({ filename: "src/huge.mjs", status: "modified", changes: 40000, patch: null });
  assert.match(check("no-gate-weakening", facts).detail, /^Can't tell: GitHub didn't return the diff of src\/huge\.mjs/);
});
