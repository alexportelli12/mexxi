import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthenticator } from "../lib/auth.mjs";
import { haresOrigins, playwrightArguments, registrationDrift } from "../../lib/browser.mjs";

const agentWith = (mark) => `Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36 ${mark}`;
const request = (headers) => ({ socket: { remoteAddress: "127.0.0.1" }, headers });

const modes = {
  "localhost-only": { web: { mode: "localhost-only", header: "Tailscale-User-Login", allowed: [], hostname: "" }, headers: { host: "127.0.0.1:4280" } },
  "tailscale-header": {
    web: { mode: "tailscale-header", header: "Tailscale-User-Login", allowed: ["you@example.com"], hostname: "box.example.ts.net" },
    headers: { host: "box.example.ts.net", "tailscale-user-login": "you@example.com" },
  },
};

for (const [mode, { web, headers }] of Object.entries(modes)) {
  test(`${mode}: a request from the agent's browser (either spelling of the mark) is refused with 403 even for an allowed identity`, () => {
    const authenticate = createAuthenticator(web);
    assert.ok(authenticate(request({ ...headers, "user-agent": agentWith("Safari/537.36") })), "an unmarked browser with the same identity gets in");
    for (const mark of ["hares-run-browser", "segwi-run-browser", "HARES-RUN-BROWSER"]) {
      assert.throws(() => authenticate(request({ ...headers, "user-agent": agentWith(mark) })), (error) => error.status === 403, mark);
    }
  });
}

const hares = { enabled: true, bind: { host: "127.0.0.1", port: 4280 }, auth: { web: { hostname: "box.example.ts.net" } } };
const browser = (home) => ({ playwrightMcpVersion: "0.0.90", executablePath: null, outputDir: path.join(home, "out") });

test("the user-scope Playwright server blocks hares origins and marks its user agent only when hares is enabled", () => {
  const args = playwrightArguments(browser("/h"), "/h", hares);
  assert.ok(args.includes("--blocked-origins=http://127.0.0.1:4280;http://localhost:4280;http://[::1]:4280;https://box.example.ts.net;http://box.example.ts.net"));
  assert.ok(args.some((arg) => arg.startsWith("--user-agent=") && arg.endsWith(" hares-run-browser")));
  const off = playwrightArguments(browser("/h"), "/h", { ...hares, enabled: false });
  assert.ok(!off.some((arg) => arg.startsWith("--blocked-origins") || arg.startsWith("--user-agent")), "hares off leaves the browser alone");
  assert.ok(!playwrightArguments(browser("/h"), "/h").some((arg) => arg.startsWith("--user-agent")));
});

test("a bind host that is another address is blocked too, bracketed when it is IPv6", () => {
  assert.ok(haresOrigins({ bind: { host: "192.168.1.5", port: 9 }, auth: { web: { hostname: "" } } }).includes("http://192.168.1.5:9"));
  assert.ok(haresOrigins({ bind: { host: "fd00::1", port: 9 }, auth: { web: { hostname: "" } } }).includes("http://[fd00::1]:9"));
  assert.deepEqual(haresOrigins({ bind: { host: "0.0.0.0", port: 9 }, auth: { web: { hostname: "" } } }), ["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9"]);
});

test("install --check drift flags a registered Playwright server that lacks the mark or the blocked origins when hares is enabled", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mexxi-mark-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = browser(home);
  const server = path.join(home, ".local/share/mexxi/playwright-mcp/0.0.90/node_modules/@playwright/mcp");
  await mkdir(server, { recursive: true });
  await writeFile(path.join(server, "package.json"), JSON.stringify({ version: "0.0.90" }));
  const claudeJson = path.join(home, ".claude.json");
  const register = (args) => writeFile(claudeJson, JSON.stringify({ mcpServers: { playwright: { command: "node", args } } }));
  const check = (enabled) => registrationDrift({ browser: config, hosts: { claude: true }, claudeJson, codexConfig: path.join(home, "none.toml"), home, hares: { ...hares, enabled } });

  await register(playwrightArguments(config, home)); // registered before hares was enabled
  assert.deepEqual(await check(false), []);
  const drift = (await check(true)).join("\n");
  assert.match(drift, /no --user-agent/);
  assert.match(drift, /blocks no origins/);
  assert.match(drift, /claude mcp add --scope user playwright/);

  await register(playwrightArguments(config, home, hares));
  assert.deepEqual(await check(true), []);
  await register(playwrightArguments(config, home, { ...hares, bind: { host: "127.0.0.1", port: 4281 } }));
  assert.match((await check(true)).join("\n"), /blocks .*4281/, "origins for a different port are drift");
});
