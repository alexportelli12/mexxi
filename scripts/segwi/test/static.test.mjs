// The built web app: strict headers on every response, deep links fall back to
// index.html, the service worker is never cached, and the app shell sits behind
// the same identity check as the API.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startServer } from "../lib/serve.mjs";
import { fakeAdapter, makeRepo, makeSettings, request, tempDir } from "./helpers.mjs";

const ibni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("unused"); }, list: async () => [] };

async function boot(t, { staticRoot, auth } = {}) {
  const settings = makeSettings({ repos: [{ name: "my-app", path: makeRepo(t), actions: ["ask"] }], auth });
  const server = await startServer({ settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "ask-completed").adapter, ibni, staticRoot, stateDir: tempDir(t, "segwi-state-") });
  t.after(() => server.close());
  return server;
}

function builtApp(t) {
  const root = tempDir(t, "segwi-dist-");
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(path.join(root, "sw.js"), "// worker");
  writeFileSync(path.join(root, "manifest.webmanifest"), "{}");
  writeFileSync(path.join(root, "assets", "main-abc.js"), "// main");
  return root;
}

test("every web response carries the strict policy, and deep links get the app", async (t) => {
  const server = await boot(t, { staticRoot: builtApp(t) });
  for (const url of ["/", "/runs/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", "/approvals/abc123", "/assets/main-abc.js"]) {
    const response = await request(server, "GET", url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers["content-security-policy"], "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
  }
  assert.match((await request(server, "GET", "/runs/xyz")).text, /<title>app<\/title>/);
  assert.match((await request(server, "GET", "/api/nope")).headers["content-security-policy"], /default-src 'self'/);
});

test("the service worker is never cached and may control the whole site", async (t) => {
  const server = await boot(t, { staticRoot: builtApp(t) });
  const worker = await request(server, "GET", "/sw.js");
  assert.equal(worker.headers["cache-control"], "no-cache");
  assert.equal(worker.headers["service-worker-allowed"], "/");
  assert.match(worker.headers["content-type"], /javascript/);
  assert.equal((await request(server, "GET", "/manifest.webmanifest")).headers["content-type"], "application/manifest+json");
});

test("without a build, the app shell says how to build it and the API still works", async (t) => {
  const server = await boot(t, { staticRoot: path.join(tempDir(t), "missing") });
  const page = await request(server, "GET", "/");
  assert.equal(page.status, 503);
  assert.equal(page.text, "Build the web app: npm --prefix scripts/segwi/web run build\n");
  assert.equal((await request(server, "GET", "/api/health")).status, 200);
});

test("the app shell needs the same identity as the API", async (t) => {
  const server = await boot(t, { staticRoot: builtApp(t), auth: { mode: "tailscale-header", allowed: ["you@example.com"] } });
  assert.equal((await request(server, "GET", "/")).status, 401);
  assert.equal((await request(server, "GET", "/", { headers: { "Tailscale-User-Login": "intruder@example.com" } })).status, 403);
  assert.equal((await request(server, "GET", "/", { headers: { "Tailscale-User-Login": "you@example.com" } })).status, 200);
});
