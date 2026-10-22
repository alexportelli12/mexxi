#!/usr/bin/env node
// The rendered-QA sweep: one URL at every viewport in workflow.viewports, with
// predictably named screenshots, a horizontal-overflow check, small touch
// targets, a dev-error-overlay check and console errors. Output is JSON.
//
// Playwright is not a dependency of this repository. It is resolved at run
// time: first the playwright-core that the pinned @playwright/mcp brought into
// npx's cache (the browser tooling agents already use), then the target
// repository's own playwright-core or playwright.
import { createRequire } from "node:module";
import { mkdir, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../../scripts/lib/config.mjs";

// WCAG 2.5.8 (AA) minimum, and the comfortable size used for primary actions.
export const MINIMUM_TARGET = 24;
export const RECOMMENDED_TARGET = 44;
// Playwright's own action timeout is 30s; a click that has not landed after 5s
// is an overlay or a wrong selector, not a slow page.
export const ACTION_TIMEOUT_MS = 5000;

export const USAGE = `Usage: sweep.mjs --url <url> --out <evidence-dir> [options]

Screenshots <url> at every viewport in workflow.viewports (config.json) and
reports horizontal overflow, interactive elements smaller than ${RECOMMENDED_TARGET}x${RECOMMENDED_TARGET} CSS px
(tier "below-${MINIMUM_TARGET}" fails WCAG 2.5.8; "below-${RECOMMENDED_TARGET}" is advisory), a visible
dev-error overlay and console errors, as JSON on stdout.

Options:
  --url <url>          Page to sweep (required).
  --out <dir>          Evidence directory for screenshots (required).
  --name <slug>        Route slug in screenshot names; default derived from the URL path.
  --phase <phase>      before or after; default after. Names are <phase>-<name>-<width>.png.
  --viewports <list>   Comma-separated widths, overriding workflow.viewports.
  --wait-for <css>     Selector that signals the page is ready (otherwise load + fonts).
  --executable <path>  Browser executable; default browser.executablePath, or Playwright's own
                       Chromium when that is null.
  --timeout <ms>       Navigation and readiness timeout; default 15000.
  --help               Show this help.

Playwright is resolved from the npx cache of the pinned @playwright/mcp, then from
the current directory's node_modules.`;

const OPTIONS = ["url", "out", "name", "phase", "viewports", "wait-for", "executable", "timeout"];

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    const name = key?.startsWith("--") ? key.slice(2) : "";
    if (!OPTIONS.includes(name) || args[index + 1] === undefined) throw new Error(`invalid argument ${key ?? ""}`.trim());
    options[name] = args[index + 1];
  }
  if (!options.url || !options.out) throw new Error("--url and --out are required");
  if (options.phase && !["before", "after"].includes(options.phase)) throw new Error("--phase expects before or after");
  return options;
}

export function parseViewports(value) {
  const widths = value.split(",").map((part) => Number(part.trim()));
  if (!widths.length || widths.some((width) => !Number.isInteger(width) || width < 200)) {
    throw new Error("--viewports expects comma-separated widths of at least 200");
  }
  return widths;
}

// The heights rendered-qa names: desktop 900, tablet 1024, phone 844.
export function viewportHeight(width) {
  return width >= 1200 ? 900 : width >= 600 ? 1024 : 844;
}

export function routeSlug(url) {
  const { pathname, hash } = new URL(url);
  const slug = `${pathname}${hash.replace(/^#\/?/, "-")}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 48).replace(/-+$/g, "") || "home";
}

export function screenshotName({ phase = "after", name, width }) {
  return `${phase}-${name}-${width}.png`;
}

async function versionOf(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

// Returns the entry point of a usable playwright-core, or throws naming both
// places it looked and how to provide one.
export async function locatePlaywright({ cacheRoot = path.join(os.homedir(), ".npm", "_npx"), mcpVersion, cwd = process.cwd() } = {}) {
  for (const entry of (await readdir(cacheRoot).catch(() => [])).sort()) {
    const modules = path.join(cacheRoot, entry, "node_modules");
    if (await versionOf(path.join(modules, "@playwright", "mcp")) === mcpVersion) {
      const core = path.join(modules, "playwright-core");
      if (await versionOf(core)) return path.join(core, "index.mjs");
    }
  }
  const require = createRequire(path.join(cwd, "noop.js"));
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return require.resolve(name);
    } catch {
      // try the next package
    }
  }
  throw new Error(
    `Playwright was not found. Run \`npx -y @playwright/mcp@${mcpVersion} --help\` once to fill npx's cache, ` +
    "or install playwright-core in the target repository, then run the sweep again.",
  );
}

// Runs in the page. Kept self-contained: Playwright serialises it.
export function measurePage({ minimum, recommended }) {
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : "";
    const classes = typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const root = document.documentElement;
  const offenders = [...document.body.querySelectorAll("*")]
    .filter((element) => visible(element) && element.getBoundingClientRect().right > root.clientWidth + 1)
    .slice(0, 10)
    .map(describe);
  const interactive = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [tabindex]:not([tabindex='-1'])";
  const smallTargets = [];
  for (const element of document.querySelectorAll(interactive)) {
    if (!visible(element) || element.disabled) continue;
    // WCAG 2.5.8 exempts a link inside a sentence; its inline display marks one.
    if (element.matches("a") && getComputedStyle(element).display === "inline") continue;
    const { width, height } = element.getBoundingClientRect();
    if (width >= recommended && height >= recommended) continue;
    smallTargets.push({
      element: describe(element),
      text: (element.innerText || element.getAttribute("aria-label") || element.value || "").trim().slice(0, 40),
      width: Math.round(width),
      height: Math.round(height),
      tier: width < minimum || height < minimum ? `below-${minimum}` : `below-${recommended}`,
    });
  }
  const overlaySelectors = ["vite-error-overlay", "nextjs-portal", "#webpack-dev-server-client-overlay", "#__next-build-watcher", "[data-nextjs-dialog-overlay]", ".ng-error-overlay", "#vite-error-overlay"];
  return {
    overflow: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, overflowing: root.scrollWidth > root.clientWidth, offenders },
    smallTargets,
    devOverlay: overlaySelectors.filter((selector) => document.querySelector(selector)),
  };
}

export async function sweep({ url, out, name, phase = "after", viewports, waitFor, executable, timeout = 15000, playwright }) {
  // With no executable, channel chromium is Playwright's own full Chromium,
  // the browser the MCP server's --browser=chromium runs, not the separate
  // headless shell a bare launch would pick.
  const browser = await playwright.chromium.launch(executable ? { executablePath: executable, headless: true } : { channel: "chromium", headless: true });
  const results = [];
  try {
    await mkdir(out, { recursive: true });
    for (const width of viewports) {
      const context = await browser.newContext({ viewport: { width, height: viewportHeight(width) } });
      const tab = await context.newPage();
      tab.setDefaultTimeout(ACTION_TIMEOUT_MS);
      const consoleErrors = [];
      tab.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      tab.on("pageerror", (error) => consoleErrors.push(String(error.message ?? error)));
      await tab.goto(url, { waitUntil: "load", timeout });
      // A readiness signal, never a fixed wait: fonts settle layout, and the
      // caller's selector says the app has rendered.
      await tab.evaluate(() => document.fonts.ready);
      if (waitFor) await tab.waitForSelector(waitFor, { state: "visible", timeout });
      const screenshot = path.join(out, screenshotName({ phase, name, width }));
      await tab.screenshot({ path: screenshot, fullPage: true });
      const measured = await tab.evaluate(measurePage, { minimum: MINIMUM_TARGET, recommended: RECOMMENDED_TARGET });
      results.push({ width, height: viewportHeight(width), screenshot, ...measured, consoleErrors });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const { config } = await loadConfig();
    const entry = await locatePlaywright({ mcpVersion: config.browser.playwrightMcpVersion });
    const playwright = await import(pathToFileURL(entry).href);
    const viewports = options.viewports ? parseViewports(options.viewports) : config.workflow.viewports;
    const name = options.name ?? routeSlug(options.url);
    const results = await sweep({
      url: options.url,
      out: path.resolve(options.out),
      name,
      phase: options.phase,
      viewports,
      waitFor: options["wait-for"],
      executable: options.executable ?? config.browser.executablePath,
      timeout: options.timeout ? Number(options.timeout) : undefined,
      playwright: playwright.chromium ? playwright : playwright.default,
    });
    process.stdout.write(`${JSON.stringify({ url: options.url, viewports: results }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`sweep: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
