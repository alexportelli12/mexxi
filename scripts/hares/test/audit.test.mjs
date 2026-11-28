// The audit check's decision, from npm audit --json reports captured with npm 11
// (the network ones by pointing --registry at a closed port and an unknown host),
// so these tests never need the network.
import assert from "node:assert/strict";
import test from "node:test";
import { auditVerdict, classifyAudit } from "../audit.mjs";

const counts = (overrides = {}) => ({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...overrides });
const report = (vulnerabilities, metadata) => JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: metadata, dependencies: { prod: 110, dev: 287, optional: 51, peer: 1, peerOptional: 0, total: 396 } } });

const CLEAN = { status: 0, stdout: report({}, counts()) };
const MODERATE = { status: 0, stdout: report({ "some-lib": { name: "some-lib", severity: "moderate", isDirect: false, via: [], effects: [], range: "<1.2.3", nodes: [], fixAvailable: true } }, counts({ moderate: 1, total: 1 })) };
const HIGH = {
  status: 1,
  stdout: report(
    { "path-to-regexp": { name: "path-to-regexp", severity: "high", isDirect: false, via: [{ source: 1, title: "ReDoS", severity: "high" }], effects: ["express"], range: "<0.1.12", nodes: ["node_modules/path-to-regexp"], fixAvailable: true },
      express: { name: "express", severity: "moderate", isDirect: true, via: ["path-to-regexp"], effects: [], range: "<4.21.2", nodes: ["node_modules/express"], fixAvailable: true } },
    counts({ moderate: 1, high: 1, total: 2 }),
  ),
};
const networkError = (message) => ({ status: 1, stdout: JSON.stringify({ message, error: { summary: "", detail: "" } }, null, 2) });
const REFUSED = networkError("request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:9");
const NOT_FOUND = networkError("request to http://nonexistent.invalid/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND nonexistent.invalid");
const NOT_FOUND_404 = { status: 1, stdout: JSON.stringify({ message: "404 Not Found - POST https://registry.example/-/npm/v1/security/advisories/bulk", method: "POST" }) };

test("a report with no high or critical finding is clean, moderate ones included", () => {
  assert.equal(classifyAudit(CLEAN).result, "clean");
  assert.equal(classifyAudit(MODERATE).result, "clean");
});

test("a high or critical finding names the packages", () => {
  const outcome = classifyAudit(HIGH);
  assert.equal(outcome.result, "findings");
  assert.match(outcome.detail, /path-to-regexp \(high\)/);
  assert.doesNotMatch(outcome.detail, /express/);
  assert.equal(classifyAudit({ status: 1, stdout: report({}, counts({ critical: 2, total: 2 })) }).result, "findings");
});

test("network errors are unreachable; any other failure is an error, never clean", () => {
  for (const reason of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ENETUNREACH"]) {
    assert.equal(classifyAudit(networkError(`request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: ${reason}`)).result, "unreachable", reason);
  }
  assert.equal(classifyAudit(REFUSED).result, "unreachable");
  assert.equal(classifyAudit(NOT_FOUND).result, "unreachable");
  assert.equal(classifyAudit(networkError("503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk")).result, "unreachable");
  assert.equal(classifyAudit(NOT_FOUND_404).result, "error");
  assert.equal(classifyAudit({ status: 1, stdout: "" }).result, "error");
  assert.equal(classifyAudit({ status: 1, stdout: report({}, counts()) }).result, "error", "a non-zero exit with nothing serious is not clean");
});

test("locally an unreachable registry warns and passes, but a finding still fails", () => {
  const unreachable = { directory: "/repo/", ...classifyAudit(REFUSED) };
  const clean = { directory: "/repo/web/", ...classifyAudit(CLEAN) };
  const local = auditVerdict([unreachable, clean], { ci: false });
  assert.equal(local.ok, true);
  assert.match(local.lines[0], /^warning: \/repo\/ was not audited, because the registry is out of reach/);
  assert.match(local.lines[1], /^ok: \/repo\/web\//);

  assert.equal(auditVerdict([unreachable, { directory: "/repo/web/", ...classifyAudit(HIGH) }], { ci: false }).ok, false);
  assert.equal(auditVerdict([{ directory: "/repo/", ...classifyAudit(NOT_FOUND_404) }], { ci: false }).ok, false);
});

test("in CI every failure fails, an unreachable registry included", () => {
  const verdict = auditVerdict([{ directory: "/repo/", ...classifyAudit(NOT_FOUND) }], { ci: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.lines[0], /^failed: \/repo\/: the registry is out of reach \(.*ENOTFOUND/);
  assert.equal(auditVerdict([{ directory: "/repo/", ...classifyAudit(CLEAN) }], { ci: true }).ok, true);
});
