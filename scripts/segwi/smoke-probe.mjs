#!/usr/bin/env node
// Runs inside a run's sandbox and checks what repositories' verify commands need from it. smoke.mjs runs it in a
// real run's sandbox, and sandbox.test.mjs in a test run's. Each check prints one line, "ok <check>" or
// "fail <check>: <why>", and the probe exits non-zero when any fails.
//   node smoke-probe.mjs browser                 the run's CHROME_BIN starts a headless browser
//   node smoke-probe.mjs domain <host> [...]     that browser loads https://<host>/robots.txt through the sandbox's proxy
//   node smoke-probe.mjs refused <host> [...]    and can't load a host the run may not reach
//   node smoke-probe.mjs firebase                the Firestore and Storage emulators start (needs firebase on PATH)
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MARK = "segwi-smoke";
// A load that failed, such as a host the sandbox's proxy refuses: the headless shell leaves the page empty, or,
// while the sandbox holds the connection, gives up on it.
const failedLoad = (dom) => /^<html><head><\/head><body><\/body><\/html>\s*$/.test(dom) || /class="neterror"/.test(dom);
const TIMED_OUT = /Page load timed out/;

function dumpDom(url) {
  const browser = process.env.CHROME_BIN;
  if (!browser) return { error: "CHROME_BIN is not set" };
  const run = spawnSync(browser, ["--headless", "--disable-gpu", "--timeout=15000", "--dump-dom", url], { encoding: "utf8", timeout: 60_000 });
  if (run.error) return { error: run.error.message };
  if (run.status !== 0) return { error: `exit ${run.status ?? run.signal}: ${run.stderr.trim().split("\n").at(-1)}` };
  return { dom: run.stdout };
}

const checks = {
  browser() {
    const { dom, error } = dumpDom(`data:text/html,<p>${MARK}</p>`);
    return error ?? (dom.includes(`<p>${MARK}</p>`) ? null : "the page didn't render");
  },
  // robots.txt, because a home page may load assets from hosts the run can't reach, and the load then never ends.
  domain(host) {
    const { dom, error } = dumpDom(`https://${host}/robots.txt`);
    return error ?? (failedLoad(dom) ? "the browser couldn't load it" : null);
  },
  refused(host) {
    const { dom, error } = dumpDom(`https://${host}/robots.txt`);
    if (error) return TIMED_OUT.test(error) ? null : error;
    return failedLoad(dom) ? null : "the browser loaded it";
  },
  firebase() {
    const project = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `${MARK}-firebase-`));
    writeFileSync(path.join(project, "firebase.json"), JSON.stringify({
      firestore: { rules: "firestore.rules" }, storage: { rules: "storage.rules" },
      emulators: { firestore: { port: 8080 }, storage: { port: 9199 }, ui: { enabled: false }, singleProjectMode: true },
    }));
    writeFileSync(path.join(project, "firestore.rules"), "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if false; } } }\n");
    writeFileSync(path.join(project, "storage.rules"), "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{all=**} { allow read, write: if false; } } }\n");
    // As a repository's own script must run them here: firebase-tools sends even its calls between emulators through
    // HTTPS_PROXY, ignoring NO_PROXY, and the sandbox's proxy refuses this machine; and it fails on exit when it
    // can't save its config store, which lives in the read-only ~/.config.
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(project, "config") };
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[name];
    const run = spawnSync("firebase", ["emulators:exec", "--project", "demo-segwi-smoke", "--only", "firestore,storage", "node -e 0"],
      { cwd: project, env, encoding: "utf8", timeout: 180_000 });
    if (run.error) return run.error.code === "ENOENT" ? "firebase is not on PATH" : run.error.message;
    return run.status === 0 ? null : `exit ${run.status ?? run.signal}: ${`${run.stdout}\n${run.stderr}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ")}`;
  },
};

const [check, ...hosts] = process.argv.slice(2);
if (!(check in checks)) {
  process.stderr.write(`usage: smoke-probe.mjs ${Object.keys(checks).join("|")} [host ...]\n`);
  process.exit(2);
}
let failed = false;
for (const target of check === "domain" || check === "refused" ? hosts : [null]) {
  const problem = checks[check](target);
  const name = target ? `${check} ${target}` : check;
  process.stdout.write(problem ? `fail ${name}: ${problem}\n` : `ok ${name}\n`);
  failed ||= Boolean(problem);
}
process.exit(failed ? 1 : 0);
