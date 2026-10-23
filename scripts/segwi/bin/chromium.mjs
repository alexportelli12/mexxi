#!/usr/bin/env node
// CHROME_BIN in a segwi run: starts the chrome-headless-shell the runner found (see lib/headless-shell.mjs) the
// way Claude Code's sandbox lets it run. It passes --no-sandbox, because Chromium's own sandbox needs user
// namespaces the outer sandbox refuses; turning those on for the run would let any command undo the sandbox's
// write denies, so the outer sandbox stays the boundary and the browser runs inside it. It gives the browser
// config and cache folders of its own in the run's temporary folder, since the home's are read-only there. And
// when the sandbox's proxy needs credentials, which Chromium can't send, it puts lib/proxy-relay.mjs in between.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HEADLESS_SHELL_ENV } from "../lib/headless-shell.mjs";
import { proxyAuthorization, proxyFromEnv, startProxyRelay } from "../lib/proxy-relay.mjs";

const browser = process.env[HEADLESS_SHELL_ENV];
if (!browser) {
  process.stderr.write(`segwi's browser launcher: ${HEADLESS_SHELL_ENV} is not set, so there is no browser to start. Install one with npx playwright install chromium.\n`);
  process.exit(1);
}

const profile = path.join(process.env.TMPDIR || os.tmpdir(), "segwi-browser");
const env = { ...process.env, XDG_CONFIG_HOME: path.join(profile, "config"), XDG_CACHE_HOME: path.join(profile, "cache") };
for (const dir of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) mkdirSync(dir, { recursive: true });

const upstream = proxyFromEnv();
const relay = upstream && proxyAuthorization(upstream) ? await startProxyRelay(upstream) : null;
const args = ["--no-sandbox", ...(relay ? [`--proxy-server=http://127.0.0.1:${relay.port}`] : []), ...process.argv.slice(2)];

// Playwright talks to the browser over file descriptors 3 and 4 when it passes --remote-debugging-pipe. Only then do
// they pass through: otherwise they are Node's own (its event loop's), which the browser has no business holding.
const stdio = ["inherit", "inherit", "inherit", ...(process.argv.includes("--remote-debugging-pipe") ? [3, 4] : [])];
const child = spawn(browser, args, { env, stdio });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => {
  process.stderr.write(`segwi's browser launcher could not start ${browser}: ${error.message}\n`);
  process.exit(1);
});
child.once("exit", async (code, signal) => {
  await relay?.close();
  process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0));
});
