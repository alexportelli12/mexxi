// The browser a run's own tests launch through CHROME_BIN: how the runner finds a headless shell, how the launcher
// starts it, and the relay that lets it through the sandbox's proxy. sandbox.test.mjs launches the real one inside
// the real sandbox.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { BROWSER_LAUNCHER, findHeadlessShell } from "../lib/headless-shell.mjs";
import { proxyAuthorization, startProxyRelay } from "../lib/proxy-relay.mjs";
import { tempDir } from "./helpers.mjs";

const executable = (file, text = "#!/bin/sh\n") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
  return file;
};

test("the runner picks Playwright's newest headless shell, else one on PATH, else none", (t) => {
  const home = tempDir(t, "segwi-browser-home-");
  const browsers = path.join(home, ".cache", "ms-playwright");
  const bin = tempDir(t, "segwi-browser-bin-");
  const env = { PATH: bin };
  assert.equal(findHeadlessShell({ home, env }), null);

  const onPath = executable(path.join(bin, "chromium-headless-shell"));
  assert.equal(findHeadlessShell({ home, env }), onPath);

  executable(path.join(browsers, "chromium_headless_shell-1208", "chrome-headless-shell-linux64", "chrome-headless-shell"));
  const newest = executable(path.join(browsers, "chromium_headless_shell-1243", "chrome-headless-shell-linux64", "chrome-headless-shell"));
  // The full Chromium can't start in the sandbox, so it never counts, however new.
  executable(path.join(browsers, "chromium-1300", "chrome-linux", "chrome"));
  // An unfinished download has no executable yet, and is passed over.
  mkdirSync(path.join(browsers, "chromium_headless_shell-1300", "chrome-headless-shell-linux64"), { recursive: true });
  assert.equal(findHeadlessShell({ home, env }), newest);

  const elsewhere = tempDir(t, "segwi-browser-elsewhere-");
  const moved = executable(path.join(elsewhere, "chromium_headless_shell-1100", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"));
  assert.equal(findHeadlessShell({ home, env: { ...env, PLAYWRIGHT_BROWSERS_PATH: elsewhere } }), moved);
});

/** A stand-in for the sandbox's proxy: it accepts only its own credentials, and tunnels or answers itself. */
async function startUpstream(t, { user = "srt.run", password = "s3cret" } = {}) {
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers["proxy-authorization"] ?? null });
    res.writeHead(req.headers["proxy-authorization"] === expected ? 200 : 407);
    res.end(`plain ${req.url}`);
  });
  server.on("connect", (req, socket) => {
    seen.push({ method: "CONNECT", url: req.url, authorization: req.headers["proxy-authorization"] ?? null });
    if (req.headers["proxy-authorization"] !== expected) return socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    // The tunnel's far end: it echoes what the client sends, so the test can see bytes pass both ways.
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  t.after(() => server.closeAllConnections());
  return { url: `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${server.address().port}`, seen };
}

/** Sends a CONNECT through `port` and then `payload`; resolves to everything that came back. */
function tunnel(port, target, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let received = "";
    let sent = false;
    socket.on("data", (chunk) => {
      received += chunk;
      // The fake upstream keeps its half open, as a server socket may, so the answer ends the exchange, not an end.
      if (!received.startsWith("HTTP/1.1 200") || received.includes("echo:")) {
        socket.destroy();
        resolve(received);
      } else if (!sent && received.includes("\r\n\r\n")) {
        sent = true;
        socket.write(payload);
      }
    });
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
}

test("the relay adds the sandbox proxy's credentials to a tunnel and to a plain request, and passes refusals through", async (t) => {
  const upstream = await startUpstream(t);
  assert.equal(proxyAuthorization("http://127.0.0.1:3128"), null);
  // Chromium sends the bare request: straight to the upstream it is refused, which is what runs saw.
  assert.match(await tunnel(Number(new URL(upstream.url).port), "fonts.googleapis.com:443", "hello"), /^HTTP\/1.1 407/);

  const relay = await startProxyRelay(upstream.url);
  t.after(() => relay.close());
  const answer = await tunnel(relay.port, "fonts.googleapis.com:443", "hello");
  assert.match(answer, /^HTTP\/1.1 200 Connection established/);
  assert.match(answer, /echo:hello/);

  const plain = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: relay.port, path: "http://fonts.gstatic.com/s/inter.woff2" }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
  assert.deepEqual(plain, { status: 200, body: "plain http://fonts.gstatic.com/s/inter.woff2" });
  const authorization = proxyAuthorization(upstream.url);
  assert.deepEqual(upstream.seen.slice(1).map(({ method, authorization: sent }) => [method, sent]), [["CONNECT", authorization], ["GET", authorization]]);

  // With the wrong credentials the upstream's own refusal reaches the browser unchanged.
  const wrong = await startProxyRelay(upstream.url.replace("s3cret", "nope"));
  t.after(() => wrong.close());
  assert.match(await tunnel(wrong.port, "fonts.googleapis.com:443", "hello"), /^HTTP\/1.1 407/);
});

/** Runs the launcher with a fake browser that reports its arguments, environment and the pipe on fd 3. */
function launch(t, env, args = ["--headless", "--remote-debugging-pipe"]) {
  const dir = tempDir(t, "segwi-launcher-");
  const reportFile = path.join(dir, "report.json");
  const fake = executable(path.join(dir, "chrome-headless-shell"), `#!${process.execPath}
const fs = require("node:fs");
let pipe = null;
try { fs.writeSync(3, "over fd 3"); pipe = "written"; } catch { pipe = "closed"; }
fs.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ args: process.argv.slice(2), config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME, pipe }));
process.exit(7);
`);
  return new Promise((resolve, reject) => {
    const child = spawn(BROWSER_LAUNCHER, args, {
      env: { PATH: process.env.PATH, TMPDIR: dir, MEXXI_HEADLESS_SHELL: fake, ...env }, stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    let fd3 = "";
    let stderr = "";
    child.stdio[3].on("data", (chunk) => { fd3 += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      let report = null;
      try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch { /* the browser never ran */ }
      resolve({ code, fd3, stderr, report, dir });
    });
  });
}

test("the launcher starts the headless shell without its own sandbox, with private folders, through the relay, and passes its pipe and exit on", async (t) => {
  const upstream = await startUpstream(t);
  const { code, fd3, report, dir } = await launch(t, { HTTPS_PROXY: upstream.url });
  assert.equal(code, 7);
  assert.equal(fd3, "over fd 3", "Playwright's --remote-debugging-pipe reaches the browser");
  assert.equal(report.args[0], "--no-sandbox");
  assert.match(report.args[1], /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(report.args.slice(2), ["--headless", "--remote-debugging-pipe"]);
  assert.equal(report.config, path.join(dir, "segwi-browser", "config"));
  assert.equal(report.cache, path.join(dir, "segwi-browser", "cache"));

  // Outside the sandbox there is no proxy with credentials, so the browser's own network settings stand.
  const direct = await launch(t, {});
  assert.deepEqual(direct.report.args, ["--no-sandbox", "--headless", "--remote-debugging-pipe"]);

  // Without Playwright's pipe (Karma, say), fds 3 and 4 are the launcher's own, and the browser never gets them.
  const karma = await launch(t, {}, ["--headless", "--remote-debugging-port=9222"]);
  assert.equal(karma.code, 7);
  assert.equal(karma.report.pipe, "closed");
  assert.equal(karma.fd3, "");

  const missing = await launch(t, { MEXXI_HEADLESS_SHELL: "" });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /npx playwright install chromium/);
});
