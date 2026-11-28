// Shared by the hares tests: a throwaway git repository, settings, the whole
// server over a fake herdr whose agent start runs the fake `claude`
// (fake-host.mjs), and small waiting helpers.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../lib/serve.mjs";
import { rotate } from "../lib/token.mjs";
import { claudeAgent, startFakeHerdr, WRITE } from "./fake-herdr.mjs";

/** The tailnet name tests configure; a request must use it, or a loopback name, as Host. */
export const TAILNET_NAME = "my-machine.example.ts.net";
export const fakeHost = fileURLToPath(new URL("./fake-host.mjs", import.meta.url));
export const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function tempDir(t, prefix = "hares-test-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A clean git repository on main with one commit. */
export function makeRepo(t) {
  const dir = tempDir(t, "hares-repo-");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

/** `hares` overrides the rest of the hares key. */
export function makeSettings({ repos, auth = {}, limits = {}, host = "127.0.0.1", worktreeRoot = "/tmp/hares-test-worktrees", hares = {} }) {
  return {
    hares: {
      enabled: true, bind: { host, port: 0 },
      repositories: repos,
      auth: { web: { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: TAILNET_NAME, ...auth } },
      limits: { concurrentRuns: 2, runsPerDay: 20, taskMaxChars: 8000, inputMaxChars: 4000, ...limits },
      notifications: { events: { asks: true, finishes: true, mainRed: true, prReady: false, newBump: false }, quietHours: { enabled: false, start: "23:00", end: "07:00" } },
      push: true, vapidSubject: "mailto:hares-tests@example.com", ...hares,
    },
    deny: ["npm publish", "git push --force"], worktreeRoot, browser: { playwrightMcpVersion: "0.0.1", executablePath: null, outputDir: worktreeRoot },
  };
}

/**
 * The runner and its recordings were retired with segwi's runner; tests that still pass `runner:` to
 * startServer get nothing from this, and startServer ignores the option.
 * @deprecated
 */
export function fakeAdapter() {
  return { adapter: null };
}

const FAST = { debounceMs: 5, backoff: { minMs: 5, maxMs: 20 } };

/**
 * Makes the fake herdr behave like herdr with Claude Code in it: each agent start runs fake-host.mjs
 * (the fake claude) with the start's arguments, which writes the session's transcript under `home`,
 * and adds the new pane as a Claude agent in `status`; each agent prompt (a steer) appends the
 * text to that transcript as the person's message. Returns the reports of every start.
 */
export function armFakeClaude(fake, { home, cwd, scenario = "asks", status = "idle" }) {
  const scenarioFile = path.isAbsolute(scenario) ? scenario : path.join(fixturesDir, "fake-claude", `${scenario}.json`);
  const starts = [];
  let terminal = 100;
  const onStart = (state) => {
    const { params } = fake.requests.findLast((entry) => entry.method === WRITE.agentStart);
    const sessionId = randomUUID();
    const reportFile = path.join(home, `fake-claude-${starts.length}.json`);
    execFileSync(process.execPath, [fakeHost, scenarioFile, reportFile, "--home", home, "--cwd", cwd, "--session", sessionId, "--", ...(params.args ?? [])], { env: process.env });
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    starts.push(report);
    terminal += 1;
    state.agents.push(claudeAgent({ paneId: params.pane_id, terminalId: `term_fake_${terminal}`, sessionId, status, seq: 1, cwd, workspaceId: params.pane_id.split(":")[0], title: "" }));
    fake.afterNext(WRITE.agentStart, onStart);
  };
  const onPrompt = (state) => {
    const { params } = fake.requests.findLast((entry) => entry.method === WRITE.agentPrompt);
    const agent = state.agents.find((candidate) => candidate.pane_id === params.target);
    const report = starts.find((entry) => entry.sessionId === agent?.agent_session?.value);
    if (report) {
      const entry = { isSidechain: false, sessionId: report.sessionId, cwd, timestamp: new Date().toISOString(), type: "user", message: { role: "user", content: params.text } };
      writeFileSync(report.transcript, `${JSON.stringify(entry)}\n`, { flag: "a" });
    }
    fake.afterNext(WRITE.agentPrompt, onPrompt);
  };
  fake.afterNext(WRITE.agentStart, onStart);
  fake.afterNext(WRITE.agentPrompt, onPrompt);
  return { starts };
}

/**
 * The whole server over a fake herdr, a temp HOME (transcripts, hook records) and a fresh MCP token.
 * `server.sessions.sync()` and `server.adapter.refresh()` let a test catch up without sleeping.
 */
export async function startHares(t, { scenario = "asks", status = "idle", agents = [], screens = {}, auth, limits, actions = ["build", "ask"], github, confirmTtlMs, repoPath, stateDir: givenStateDir, settingsPatch = {}, ...options } = {}) {
  const repo = repoPath ?? makeRepo(t);
  const home = tempDir(t, "hares-home-");
  const stateDir = givenStateDir ?? tempDir(t, "hares-state-");
  const dataDir = tempDir(t, "hares-data-");
  const token = rotate(stateDir);
  const fake = await startFakeHerdr(t, { agents, screens });
  for (const agent of fake.state.agents) if (agent.cwd === "/tmp/hares-fake/repo") { agent.cwd = repo; agent.foreground_cwd = repo; }
  const claude = armFakeClaude(fake, { home, cwd: repo, scenario, status });
  const settings = makeSettings({ repos: [{ name: "my-app", path: repo, actions, ...(github ? { github } : {}) }], auth, limits, ...settingsPatch });
  const pendingOptions = { env: { XDG_DATA_HOME: path.join(home, "xdg") }, home };
  const server = await startServer({
    settings, dataDir, stateDir, staticRoot: null, mcpConfirmTtlMs: confirmTtlMs, herdrSocket: fake.socket, adapterOptions: FAST, home, pendingOptions,
    githubFetch: async () => new Response("{}", { status: 404 }), ...options,
  });
  t.after(() => server.close());
  return { server, token, stateDir, dataDir, repo, home, fake, claude, settings, pendingOptions };
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
