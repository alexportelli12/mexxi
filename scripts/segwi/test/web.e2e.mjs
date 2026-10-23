// The web app in a real browser against a real segwi server with the fake host
// (plan sections 6, 11.9 to 11.11). Needs the app built (npm --prefix scripts/segwi/web
// run build) and Playwright's Chromium (npx playwright install chromium). Everything it
// starts is stopped, and its temporary folders removed, when the file ends.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startHarness } from "./web-harness.mjs";
import { waitFor } from "./helpers.mjs";

const webPackage = fileURLToPath(new URL("../web/package.json", import.meta.url));
const dist = fileURLToPath(new URL("../web/dist/web/browser/index.html", import.meta.url));
const requireFromWeb = createRequire(webPackage);
const { chromium } = requireFromWeb("playwright-core");
const { AxeBuilder } = requireFromWeb("@axe-core/playwright");

assert.ok(existsSync(dist), "Build the web app first: npm --prefix scripts/segwi/web run build");

const harness = await startHarness({ seed: true });
const browser = await chromium.launch();
const problems = [];
test.after(async () => {
  await browser.close();
  await harness.close();
});

async function open(path, { width = 390, height = 844, base = harness.url, collect = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  const page = await context.newPage();
  if (collect) {
    page.on("console", (message) => { if (message.type() === "error") problems.push(`${path}: ${message.text()}`); });
    page.on("pageerror", (error) => problems.push(`${path}: ${error.message}`));
  }
  await page.goto(`${base}${path}`);
  return { page, close: () => context.close() };
}

const api = async (path, init) => (await fetch(`${harness.url}${path}`, init)).json();
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: harness.url }, body: JSON.stringify(body) });
const runs = async () => (await api("/api/runs?limit=50")).runs;
const approvals = async () => (await api("/api/approvals?status=pending")).approvals;
const runWith = async (text) => (await runs()).find((run) => run.task.includes(text));

test("a run started from New appears with its steps and waits for a reply", async () => {
  const { page, close } = await open("/new");
  await page.getByLabel("Repository").selectOption("my-app");
  await page.getByRole("radio", { name: /Build/ }).check({ force: true });
  // The line re-renders after the change is detected, so wait for the text rather than reading it straight away.
  const whatHappens = (text) => page.getByTestId("what-happens").filter({ hasText: text }).waitFor({ timeout: 5000 });
  await whatHappens("Runs /wettaq in my-app on a new branch; you'll get a PR");
  await page.getByRole("radio", { name: /Ask/ }).check({ force: true });
  await whatHappens("Answers in my-app without changing anything");
  await page.getByRole("radio", { name: /Build/ }).check({ force: true });
  await page.getByLabel("Task").fill("List the tracked files");
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  await page.getByText("Needs your reply").first().waitFor();
  await page.getByRole("button", { name: /git ls-files/ }).first().waitFor();
  assert.ok(await page.getByRole("textbox", { name: "Your reply" }).isVisible());
  await close();
});

test("scrolling up pauses following, Jump to latest resumes it", async () => {
  const { id } = (await post("/api/runs", { repo: "my-app", action: "build", task: "Audit every source file" })).run;
  const { page, close } = await open(`/runs/${id}`);
  await page.getByText("Needs your reply").first().waitFor();
  await page.getByRole("button", { name: /file-30\.ts/ }).waitFor();
  const metrics = () => page.evaluate(() => ({ y: scrollY, atBottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 160 }));
  assert.equal(await page.getByRole("button", { name: "Jump to latest" }).count(), 0, "not on load, before anyone has scrolled");
  await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.getByRole("button", { name: "Jump to latest" }).waitFor();
  await page.getByRole("textbox", { name: "Your reply" }).fill("Keep going");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: /file-36\.ts/ }).waitFor();
  assert.ok((await metrics()).y < 50, "new steps do not drag a reader who scrolled up");
  assert.ok(await page.getByRole("button", { name: "Jump to latest" }).isVisible());
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await waitFor(async () => (await metrics()).atBottom, { what: "the bottom" });
  await page.getByRole("button", { name: "Jump to latest" }).waitFor({ state: "hidden" });
  await close();
});

test("an approval shows the exact command, Deny has focus, and a decision works", async () => {
  const run = await post("/api/runs", { repo: "my-app", action: "build", task: "Check what example.com serves again" });
  const approval = await waitFor(async () => (await approvals()).find((entry) => entry.runId === run.run.id), { what: "the approval" });
  const { page, close } = await open(`/approvals/${approval.id}`);
  const card = page.locator(`#approval-${approval.id}`);
  await card.waitFor();
  assert.equal((await card.locator("pre").textContent()).trim(), approval.exact);
  assert.match(await card.textContent(), /Reaches the internet/);
  assert.match(await card.textContent(), /Denied automatically in \d+ (min|h)/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Deny");
  await page.keyboard.press("Enter");
  await card.getByText("Denied", { exact: true }).waitFor();
  await waitFor(async () => (await api(`/api/approvals?status=denied`)).approvals.some((entry) => entry.id === approval.id), { what: "the denial" });
  await card.waitFor({ state: "detached", timeout: 6000 });
  await close();
});

test("Approve is a deliberate tap, and the title counts what needs you", async () => {
  const run = await post("/api/runs", { repo: "my-app", action: "build", task: "Check what example.com serves once more" });
  const approval = await waitFor(async () => (await approvals()).find((entry) => entry.runId === run.run.id), { what: "the approval" });
  const { page, close } = await open("/approvals");
  // Answering an approval lets its run carry on to its next question, so compare with the API each time.
  const waiting = async () => (await approvals()).length + (await runs()).filter((entry) => entry.status === "needs_input").length;
  assert.ok((await waiting()) >= 2);
  await waitFor(async () => (await page.title()) === `(${await waiting()}) segwi`, { what: "the title to match the count" });
  await page.locator(`#approval-${approval.id}`).getByRole("button", { name: "Approve" }).click();
  await page.locator(`#approval-${approval.id}`).getByText("Allowed", { exact: true }).waitFor();
  await waitFor(async () => (await api("/api/approvals?status=allowed")).approvals.some((entry) => entry.id === approval.id));
  await waitFor(async () => (await page.title()) === `(${await waiting()}) segwi`, { what: "the title after the decision" });
  await close();
});

test("stopping asks first, and Keep running is the focused choice", async () => {
  const target = await runWith("Replace the footer links");
  const { page, close } = await open(`/runs/${target.id}`);
  await page.getByRole("button", { name: "Stop…" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop this run?" });
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /The agent stops now; its branch and any open PR stay\./);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Keep running");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await api(`/api/runs/${target.id}`)).run.status, "running");
  await page.getByRole("button", { name: "Stop…" }).click();
  await dialog.getByRole("button", { name: "Stop run" }).click();
  await page.getByText("Stopped by you").first().waitFor();
  assert.equal((await api(`/api/runs/${target.id}`)).run.status, "stopped");
  await close();
});

test("a draft survives a reload, with the last repo and action", async () => {
  const { page, close } = await open("/new");
  await page.getByLabel("Repository").selectOption("docs-site");
  await page.getByRole("radio", { name: /Ask/ }).check({ force: true });
  await page.getByLabel("Task").fill("Half-written question");
  await page.reload();
  assert.equal(await page.getByLabel("Task").inputValue(), "Half-written question");
  assert.equal(await page.getByLabel("Repository").inputValue(), "docs-site");
  assert.ok(await page.getByRole("radio", { name: /Ask/ }).isChecked());
  assert.ok(await page.getByRole("option", { name: /scratch-pad.*uncommitted/ }).isDisabled());
  await close();
});

test("the Runs screen puts what needs you first and keeps the filter in the URL", async () => {
  const { page, close } = await open("/runs");
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
  const first = await page.locator("main a[href^='/runs/']").first().textContent();
  assert.match(first, /Needs your (reply|OK)/);
  await page.getByRole("link", { name: "Done", exact: true }).click();
  await page.waitForURL(/filter=done/);
  await waitFor(async () => (await page.getByRole("heading", { name: "Needs you" }).count()) === 0, { what: "the needs-you group to go" });
  await page.getByText("Done", { exact: true }).first().waitFor();
  await page.reload();
  assert.equal(await page.getByRole("link", { name: "Done", exact: true }).getAttribute("aria-current"), "true");
  await close();
});

test("deep links load directly, and an unknown page says so", async () => {
  const target = await runWith("Fix the flaky date test");
  const direct = await open(`/runs/${target.id}`);
  await direct.page.getByRole("heading", { name: "Run", exact: true }).waitFor();
  await direct.page.getByText("Fix the flaky date test").first().waitFor();
  await direct.page.getByRole("link", { name: "Pull request #42" }).first().waitFor();
  await direct.close();
  const approval = await waitFor(async () => (await approvals())[0], { what: "an approval" }).catch(() => null);
  if (approval) {
    const link = await open(`/approvals/${approval.id}`);
    await link.page.locator(`#approval-${approval.id}`).waitFor();
    await link.close();
  }
  const unknown = await open("/nowhere/at/all");
  await unknown.page.getByText("This page doesn't exist").first().waitFor();
  await unknown.page.getByRole("link", { name: "Go to Runs" }).click();
  await unknown.page.waitForURL(/\/runs$/);
  await unknown.close();
  const missing = await open("/runs/00000000-0000-4000-8000-000000000000");
  await missing.page.getByText("No such run").first().waitFor();
  await missing.close();
});

const SCREENS = () => [
  "/runs", "/approvals", "/new", "/audit", "/nowhere",
  `/runs/${runIds.running}`, `/runs/${runIds.completed}`, `/runs/${runIds.failed}`, `/runs/${runIds.timedOut}`,
];
const runIds = {};
test("every screen passes the axe scan, and every control is at least 44 by 44 on a phone", async () => {
  const all = await runs();
  runIds.running = all.find((run) => run.task.startsWith("Replace the footer")).id;
  runIds.completed = all.find((run) => run.task.startsWith("Fix the flaky")).id;
  runIds.failed = all.find((run) => run.status === "failed").id;
  runIds.timedOut = all.find((run) => run.status === "timed_out").id;
  const waitingRun = all.find((run) => run.status === "needs_input").id;
  const screens = [...SCREENS(), `/runs/${waitingRun}`];
  for (const screen of screens) {
    const { page, close } = await open(screen);
    await page.locator("h1").first().waitFor();
    await page.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const serious = result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    assert.deepEqual(serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), [], `axe on ${screen}`);
    const small = await page.evaluate(() => [...document.querySelectorAll("a, button, input, select, textarea")]
      .filter((element) => !element.closest(".sr-only") && !element.classList.contains("sr-only") && element.getClientRects().length)
      .map((element) => ({ name: (element.textContent || element.getAttribute("aria-label") || element.id || element.tagName).trim().slice(0, 40), box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 1 && box.height > 1 && (box.width < 44 || box.height < 44))
      .map(({ name, box }) => `${name} ${Math.round(box.width)}x${Math.round(box.height)}`));
    assert.deepEqual(small, [], `targets on ${screen}`);
    await close();
  }
  // The open stop sheet is part of the app too.
  const { page, close } = await open(`/runs/${waitingRun}`);
  await page.getByRole("button", { name: "Stop…" }).click();
  await page.getByRole("dialog").waitFor();
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  assert.deepEqual(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact)).map((violation) => violation.id), []);
  await close();
});

test("the Reconnecting banner shows when the server goes away and clears when it is back", async () => {
  const free = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  let second = await startHarness({ port: free });
  const { page, close } = await open("/runs", { base: second.url, collect: false });
  try {
    await page.getByText("No runs yet").waitFor();
    assert.equal(await page.getByText("Reconnecting…").count(), 0);
    await second.close();
    const banner = page.getByRole("status").filter({ hasText: "Reconnecting…" });
    await banner.waitFor({ timeout: 10_000 });
    second = await startHarness({ port: free });
    await banner.waitFor({ state: "hidden", timeout: 20_000 });
  } finally {
    await close();
    await second.close();
  }
});

test.after(() => {
  const real = problems.filter((message) => !/Failed to load resource.*(404|0)|the server responded with a status of 404/.test(message));
  assert.deepEqual(real, [], "no console errors or CSP violations");
});
