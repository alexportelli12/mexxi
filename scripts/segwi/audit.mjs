#!/usr/bin/env node
// The audit check: known vulnerabilities in what ships. It audits the server's
// dependencies at the repository root and the web app's, and fails on a high or
// critical finding. It needs the network: in CI an unreachable registry fails the
// check, so a pull request never passes unaudited; on a machine that is offline it
// warns and passes, because nothing in the change itself is wrong.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// How npm reports a registry it could not reach: a system error code in the
// message of its JSON error, or a 5xx answer from the registry itself.
const UNREACHABLE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|network timeout)\b|^5\d\d\b/i;
const SERIOUS = ["high", "critical"];

/**
 * What one `npm audit --json` run found: "clean", "findings" (a high or critical
 * vulnerability), "unreachable" (the registry was out of reach) or "error"
 * (anything else, which is never treated as clean).
 */
export function classifyAudit({ status, stdout }) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { result: "error", detail: `npm audit printed no JSON report (exit ${status})` };
  }
  const counts = report?.metadata?.vulnerabilities;
  if (counts && typeof counts === "object") {
    const serious = SERIOUS.reduce((sum, severity) => sum + (counts[severity] ?? 0), 0);
    if (serious > 0) {
      const packages = Object.entries(report.vulnerabilities ?? {})
        .filter(([, finding]) => SERIOUS.includes(finding?.severity))
        .map(([name, finding]) => `${name} (${finding.severity})`);
      return { result: "findings", detail: `${serious} high or critical: ${packages.join(", ") || "see npm audit"}` };
    }
    if (status === 0) return { result: "clean", detail: "no high or critical vulnerabilities" };
    return { result: "error", detail: `npm audit exited ${status} without a high or critical finding` };
  }
  const message = typeof report?.message === "string" ? report.message : "";
  if (UNREACHABLE.test(message)) return { result: "unreachable", detail: message };
  return { result: "error", detail: message || `npm audit exited ${status} with an unrecognised report` };
}

/**
 * Whether the check passes, from each directory's classification. Only an
 * unreachable registry outside CI is forgiven, and it is still reported.
 */
export function auditVerdict(outcomes, { ci }) {
  const lines = [];
  let ok = true;
  for (const { directory, result, detail } of outcomes) {
    if (result === "clean") {
      lines.push(`ok: ${directory}: ${detail}`);
    } else if (result === "unreachable" && !ci) {
      lines.push(`warning: ${directory} was not audited, because the registry is out of reach (${detail}). CI audits it.`);
    } else {
      ok = false;
      lines.push(`failed: ${directory}: ${result === "unreachable" ? `the registry is out of reach (${detail})` : detail}`);
    }
  }
  return { ok, lines };
}

function auditDirectory(cwd) {
  // --offline=false: with npm's offline setting on, audit prints an empty, clean
  // report without asking the registry, which would pass for the wrong reason.
  // npm's own warnings go unshown: the JSON report carries the same message.
  const { status, stdout, stderr, error } = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json", "--offline=false"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  if (error) return { result: "error", detail: `could not run npm: ${error.message}` };
  const outcome = classifyAudit({ status, stdout });
  if (outcome.result === "error" && stderr.trim()) outcome.detail += `\n${stderr.trim()}`;
  return outcome;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = [new URL("../../", import.meta.url), new URL("./web/", import.meta.url)].map((url) => fileURLToPath(url));
  const outcomes = directories.map((directory) => ({ directory, ...auditDirectory(directory) }));
  const ci = Boolean(process.env.CI) && process.env.CI !== "false";
  const { ok, lines } = auditVerdict(outcomes, { ci });
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!ok) process.stdout.write("Run `npm audit --omit=dev` in the directory named above for the full report.\n");
  process.exit(ok ? 0 : 1);
}
