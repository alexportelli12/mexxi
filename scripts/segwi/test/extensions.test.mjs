// Local extensions: a folder's page and JSON API under /ext/<name>/, behind
// segwi's own identity check and audit, listed for the menu; a broken one is
// skipped, and without any nothing changes.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startServer } from "../lib/serve.mjs";
import { settingsFromConfig } from "../lib/settings.mjs";
import { resolveConfig } from "../../lib/config.mjs";
import { fakeAdapter, makeRepo, makeSettings, request, tempDir } from "./helpers.mjs";

const ibni = { findNewWorkspace: async () => null, summary: async () => { throw new Error("unused"); }, list: async () => [] };
const you = { "Tailscale-User-Login": "you@example.com" };

function extension(t, name, serverSource) {
  const folder = path.join(tempDir(t, "segwi-ext-"), name);
  mkdirSync(path.join(folder, "public"), { recursive: true });
  writeFileSync(path.join(folder, "server.mjs"), serverSource);
  writeFileSync(path.join(folder, "public", "index.html"), `<!doctype html><title>${name}</title>`);
  writeFileSync(path.join(folder, "public", "app.js"), "// page script");
  return folder;
}

const WORKING = `
export default async function (context) {
  const { name, dataDir } = context;
  let closed = false;
  globalThis.segwiExtensionClosed = () => closed;
  return {
    title: "Ops",
    routes: {
      "GET /status": async ({ query, identity }) => ({ name, dataDir, who: identity, q: query.q ?? null, given: Object.keys(context).sort() }),
      "POST /note": async ({ body }) => ({ saved: body.text }),
    },
    close() { closed = true; },
  };
}
`;

async function boot(t, extensions) {
  const settings = makeSettings({
    repos: [{ name: "my-app", path: makeRepo(t), actions: ["ask"] }],
    auth: { mode: "tailscale-header", allowed: ["you@example.com"] },
    segwi: { extensions },
  });
  const server = await startServer({ settings, dataDir: tempDir(t, "segwi-data-"), runner: fakeAdapter(t, "ask-completed").adapter, ibni, staticRoot: null, stateDir: tempDir(t, "segwi-state-") });
  t.after(() => server.close());
  return server;
}

// Break: an extension's page or API skips segwi's identity check or audit, a
// write skips the same-origin rule, or a path escapes its public folder.
test("an extension's page and API sit behind segwi's identity, same-origin rule and audit", async (t) => {
  const folder = extension(t, "ops", WORKING);
  const server = await boot(t, [folder]);

  assert.deepEqual((await request(server, "GET", "/api/extensions", { headers: you })).json, { extensions: [{ name: "ops", title: "Ops", url: "/ext/ops/" }] });
  const page = await request(server, "GET", "/ext/ops/", { headers: you });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>ops<\/title>/);
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.equal((await request(server, "GET", "/ext/ops/app.js", { headers: you })).headers["content-type"], "text/javascript; charset=utf-8");
  assert.match((await request(server, "GET", "/ext/tokens.css", { headers: you })).text, /--accent:/);
  assert.equal((await request(server, "GET", "/ext/ops", { headers: you })).headers.location, "/ext/ops/");

  const status = await request(server, "GET", "/ext/ops/api/status?q=1", { headers: you });
  assert.deepEqual([status.json.name, status.json.who, status.json.q], ["ops", "you@example.com", "1"]);
  assert.equal(path.basename(status.json.dataDir), "ops", "each extension gets its own data folder");
  assert.deepEqual(status.json.given, ["dataDir", "name", "worktreeRoot"], "and nothing of segwi's sign-in or repository settings");
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await request(server, "GET", "/ext/ops/api/status", { headers: { ...you, "Sec-Fetch-Site": site } })).status, 403, `a ${site} GET is refused`);
  }
  assert.equal((await request(server, "GET", "/ext/ops/api/status", { headers: { ...you, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  assert.equal((await request(server, "GET", "/ext/ops/", { headers: { ...you, "Sec-Fetch-Site": "cross-site" } })).status, 200, "a link from elsewhere still opens the page");
  assert.deepEqual((await request(server, "POST", "/ext/ops/api/note", { headers: you, body: { text: "hi" } })).json, { saved: "hi" });

  // Without sign-in, a configured name and an unknown one answer alike.
  for (const url of ["/ext/ops/", "/ext/ops", "/ext/ops/api/status", "/ext/tokens.css", "/ext/other/", "/ext/other/api/x"]) {
    assert.equal((await request(server, "GET", url)).status, 401, `${url} needs a signed-in user`);
    assert.equal((await request(server, "GET", url, { headers: { "Tailscale-User-Login": "intruder@example.com" } })).status, 403, url);
  }
  assert.equal((await request(server, "POST", "/ext/ops/api/note", { headers: you, body: { text: "x" }, origin: false })).status, 403, "a write from another origin is refused");
  assert.equal((await request(server, "GET", "/ext/ops/api/missing", { headers: you })).status, 404);
  assert.equal((await request(server, "POST", "/ext/ops/api/status", { headers: you, body: {} })).status, 405);
  assert.equal((await request(server, "GET", "/ext/ops/..%2Fserver.mjs", { headers: you })).status, 404, "nothing outside public/ is served");
  assert.equal((await request(server, "GET", "/ext/other/", { headers: you })).status, 404);

  const actions = server.store.listAudit(50).map((row) => `${row.action} ${row.outcome}`);
  assert.ok(actions.includes("GET /ext/ops/api/status ok"), actions.join("\n"));
  assert.ok(actions.some((action) => action.startsWith("POST /ext/ops/api/note rejected")), actions.join("\n"));

  await server.close();
  assert.equal(globalThis.segwiExtensionClosed(), true, "close() runs when segwi stops");
});

// Break: one broken or hanging extension stops segwi from starting (or from
// listening), or hides the others.
test("an extension that fails or hangs while loading is skipped and the rest still work", { timeout: 60_000 }, async (t) => {
  const broken = extension(t, "broken", "export default async function () { throw new Error('boom'); }\n");
  const hanging = extension(t, "hanging", "export default () => new Promise(() => {});\n");
  const good = extension(t, "good", WORKING);
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  t.after(() => { console.error = original; });
  const server = await boot(t, [broken, hanging, good]);
  console.error = original;
  assert.deepEqual((await request(server, "GET", "/api/extensions", { headers: you })).json.extensions.map((entry) => entry.name), ["good"]);
  assert.equal((await request(server, "GET", "/ext/broken/", { headers: you })).status, 404);
  assert.ok(errors.some((message) => /extension broken .* was not loaded: boom/.test(message)), errors.join("\n"));
  assert.ok(errors.some((message) => /extension hanging .* was not loaded: it did not finish loading within 10 s/.test(message)), errors.join("\n"));
});

// Break: an extension folder whose name can't be a URL segment, or two with
// the same name, load anyway; or the setting is required.
test("segwi.extensions is optional, expands ~ and refuses names that clash or can't be a path", async () => {
  const home = "/home/someone";
  const settings = async (extensions) => settingsFromConfig(await resolveConfig({ segwi: { extensions } }, { home }), { home });
  assert.deepEqual((await settingsFromConfig(await resolveConfig({}, { home }), { home })).segwi.extensions, []);
  assert.deepEqual((await settings(["~/workspace/atlas-ops"])).segwi.extensions, ["/home/someone/workspace/atlas-ops"]);
  await assert.rejects(settings(["~/a/ops", "/b/ops"]), /two folders are named "ops"/);
  await assert.rejects(settings(["~/workspace/Atlas Ops"]), /folder name "Atlas Ops" must be lower-case/);
  await assert.rejects(settings(["~/x/tokens.css"]), /"tokens.css" is a name segwi serves itself/);
});
