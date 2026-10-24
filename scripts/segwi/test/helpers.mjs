// Shared by the segwi tests: a throwaway git repository, settings, a fake host
// adapter and small waiting helpers.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCodeAdapter } from "../runners/claude-code.mjs";

/** The tailnet name tests configure; a request must use it, or a loopback name, as Host. */
export const TAILNET_NAME = "my-machine.example.ts.net";
export const fakeHost = fileURLToPath(new URL("./fake-host.mjs", import.meta.url));
export const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function tempDir(t, prefix = "segwi-test-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clean git repository on main with one commit. */
export function makeRepo(t) {
  const dir = tempDir(t, "segwi-repo-");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** `segwi` overrides the rest of the segwi key. */
export function makeSettings({ repos, auth = {}, limits = {}, host = "127.0.0.1", worktreeRoot = "/tmp/segwi-test-worktrees", segwi = {} }) {
  return {
    segwi: {
      enabled: true, bind: { host, port: 0 }, runner: "claude-code",
      repositories: repos,
      auth: { web: { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: TAILNET_NAME, ...auth } },
      limits: {
        concurrentRuns: 2, runsPerDay: 20, maxTurns: 80, idleTimeoutMinutes: 30, hardTimeoutMinutes: 120,
        approvalTimeoutMinutes: 60, taskMaxChars: 8000, inputMaxChars: 4000, ...limits,
      },
      push: true, vapidSubject: "mailto:segwi-tests@example.com", ...segwi,
    },
    deny: ["npm publish", "git push --force"], worktreeRoot, browser: { playwrightMcpVersion: "0.0.1", executablePath: null, outputDir: worktreeRoot },
  };
}

/** An adapter whose "claude" replays a recording. Returns the adapter and where the host's report lands. */
export function fakeAdapter(t, fixture, options = {}) {
  const dir = tempDir(t, "segwi-host-");
  const reportFile = path.join(dir, "report.json");
  const file = path.isAbsolute(fixture) ? fixture : path.join(fixturesDir, "claude-code", `${fixture}.jsonl`);
  const adapter = createClaudeCodeAdapter({
    bin: process.execPath, binArgs: [fakeHost, file, reportFile], dataDir: path.join(dir, "data"), killGraceMs: [200, 200], ...options,
  });
  return { adapter, report: () => JSON.parse(readFileSync(reportFile, "utf8")), dir };
}

export async function waitFor(check, { timeoutMs = 10_000, intervalMs = 20, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One request to a running test server. A POST carries a same-origin header and JSON unless told otherwise. */
export function request(server, method, urlPath, { headers = {}, body, origin = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const base = { ...(method === "POST" && origin ? { Origin: `http://127.0.0.1:${server.port}` } : {}), ...(payload !== undefined ? { "Content-Type": "application/json" } : {}) };
    const req = http.request({ host: "127.0.0.1", port: server.port, method, path: urlPath, headers: { ...base, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
