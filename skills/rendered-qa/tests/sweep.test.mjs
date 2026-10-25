import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../../../scripts/lib/config.mjs";
import { locatePlaywright, parseArgs, parseViewports, routeSlug, screenshotName, viewportHeight } from "../scripts/sweep.mjs";

const script = fileURLToPath(new URL("../scripts/sweep.mjs", import.meta.url));

test("arguments, viewport heights and screenshot names are predictable", () => {
  assert.throws(() => parseArgs(["--url", "http://x"]), /--url and --out are required/);
  assert.throws(() => parseArgs(["--url", "http://x", "--out", "o", "--phase", "during"]), /before or after/);
  assert.throws(() => parseArgs(["--bogus", "1"]), /invalid argument --bogus/);
  assert.deepEqual(parseViewports("1440, 768,390"), [1440, 768, 390]);
  assert.throws(() => parseViewports("1440,narrow"), /comma-separated widths/);
  assert.deepEqual([1440, 768, 390].map(viewportHeight), [900, 1024, 844]);
  assert.equal(routeSlug("http://localhost:4300/Settings/Profile?tab=1"), "settings-profile");
  assert.equal(routeSlug("http://localhost:4300/"), "home");
  assert.equal(screenshotName({ phase: "before", name: "home", width: 390 }), "before-home-390.png");
});

test("Playwright comes from the cache of the pinned MCP version, then from the target repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mexxi-sweep-locate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, "npx");
  const emptyCwd = path.join(root, "empty");
  await mkdir(emptyCwd);
  const install = async (directory, packages) => {
    for (const [name, version] of Object.entries(packages)) {
      await mkdir(path.join(directory, "node_modules", name), { recursive: true });
      await writeFile(path.join(directory, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
  };
  await install(path.join(cache, "aaa"), { "@playwright/mcp": "0.0.1", "playwright-core": "1.0.0" });
  await install(path.join(cache, "bbb"), { "@playwright/mcp": "0.0.83", "playwright-core": "1.64.0" });
  const installed = path.join(root, "installed");
  assert.equal(
    await locatePlaywright({ installRoot: installed, cacheRoot: cache, mcpVersion: "0.0.83", cwd: emptyCwd }),
    path.join(cache, "bbb/node_modules/playwright-core/index.mjs"),
  );
  // The copy mexxi's installer keeps wins over npx's cache.
  await install(path.join(installed, "0.0.83"), { "@playwright/mcp": "0.0.83", "playwright-core": "1.64.0" });
  assert.equal(
    await locatePlaywright({ installRoot: installed, cacheRoot: cache, mcpVersion: "0.0.83", cwd: emptyCwd }),
    path.join(installed, "0.0.83/node_modules/playwright-core/index.mjs"),
  );
  // Node also resolves from NODE_PATH and ~/.node_modules, fixed at startup, so
  // the not-found case runs in a process with neither.
  const notFound = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { locatePlaywright } = await import(${JSON.stringify(pathToFileURL(script).href)});
    await locatePlaywright({ installRoot: process.argv[1], cacheRoot: process.argv[1], mcpVersion: "9.9.9", cwd: process.argv[2] })
      .then(() => process.exit(0), (error) => { process.stderr.write(error.message); process.exit(3); });
  `, cache, emptyCwd], { encoding: "utf8", env: { ...process.env, NODE_PATH: "", HOME: root, USERPROFILE: root } });
  assert.equal(notFound.status, 3, notFound.stderr);
  assert.match(notFound.stderr, /Playwright was not found\. Run `node scripts\/install\.mjs` in the mexxi checkout to install @playwright\/mcp@9\.9\.9/);
  const repository = path.join(root, "repository");
  await install(repository, { "playwright-core": "1.2.3" });
  await writeFile(path.join(repository, "node_modules/playwright-core/index.js"), "");
  await writeFile(path.join(repository, "node_modules/playwright-core/package.json"), JSON.stringify({ name: "playwright-core", version: "1.2.3", main: "index.js" }));
  assert.equal(
    await locatePlaywright({ installRoot: installed, cacheRoot: cache, mcpVersion: "9.9.9", cwd: repository }),
    path.join(repository, "node_modules/playwright-core/index.js"),
  );
});

test("--help documents every option", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  for (const option of ["--url", "--out", "--name", "--phase", "--viewports", "--wait-for", "--executable", "--timeout"]) {
    assert.ok(result.stdout.includes(option), `help lists ${option}`);
  }
});

// The browser run needs a Chromium and a resolvable Playwright; elsewhere it
// is skipped and the parts above still run.
async function browserAvailable() {
  const { config } = await loadConfig();
  try {
    const entry = await locatePlaywright({ mcpVersion: config.browser.playwrightMcpVersion });
    // With no executablePath the sweep launches Playwright's own Chromium.
    const playwright = await import(pathToFileURL(entry).href);
    await access(config.browser.executablePath ?? (playwright.chromium ?? playwright.default.chromium).executablePath());
    return config;
  } catch {
    return null;
  }
}

test("a sweep screenshots every viewport and reports overflow and small touch targets", async (t) => {
  const config = await browserAvailable();
  if (!config) return t.skip("no Chromium or Playwright available");
  const root = await mkdtemp(path.join(os.tmpdir(), "mexxi-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = path.join(root, "good.html");
  const bad = path.join(root, "bad.html");
  await writeFile(good, `<!doctype html><meta name="viewport" content="width=device-width"><body>
    <button style="width:48px;height:48px">OK</button><p>Text with an <a href="#x">inline link</a>.</p></body>`);
  await writeFile(bad, `<!doctype html><meta name="viewport" content="width=device-width"><body>
    <div id="wide" style="width:1600px;height:20px">wide</div>
    <button id="tiny" style="width:16px;height:16px;padding:0">x</button>
    <button id="short" style="width:30px;height:30px;padding:0">y</button>
    <button id="ok" style="width:48px;height:48px">OK</button>
    <script>console.error("planted console error")</script></body>`);
  const sweep = (file, extra = []) => {
    const out = path.join(root, `out-${path.basename(file)}`);
    const result = spawnSync(process.execPath, [script, "--url", pathToFileURL(file).href, "--out", out, "--name", "fixture", ...extra], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return { out, report: JSON.parse(result.stdout) };
  };

  const clean = sweep(good);
  assert.deepEqual(clean.report.viewports.map((viewport) => viewport.width), config.workflow.viewports);
  for (const viewport of clean.report.viewports) {
    assert.equal(viewport.screenshot, path.join(clean.out, `after-fixture-${viewport.width}.png`));
    await access(viewport.screenshot);
    assert.equal(viewport.overflow.overflowing, false);
    assert.deepEqual(viewport.smallTargets, [], "an inline link is exempt and a 48px button is large enough");
    assert.deepEqual(viewport.consoleErrors, []);
  }

  const broken = sweep(bad, ["--phase", "before", "--viewports", "390,1000"]);
  assert.deepEqual(broken.report.viewports.map((viewport) => viewport.width), [390, 1000]);
  const [phone, desktop] = broken.report.viewports;
  assert.equal(phone.overflow.overflowing, true);
  assert.ok(phone.overflow.offenders.some((offender) => offender.startsWith("div#wide")));
  assert.equal(desktop.overflow.overflowing, true, "a 1600px element overflows a 1000px viewport too");
  assert.deepEqual(phone.smallTargets.map(({ element, tier }) => [element, tier]), [["button#tiny", "below-24"], ["button#short", "below-44"]]);
  assert.equal(phone.consoleErrors.length, 1);
  await access(path.join(broken.out, "before-fixture-390.png"));
  await access(path.join(broken.out, "before-fixture-1000.png"));
});
