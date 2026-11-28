// The web app in a real browser against the demo server (demo-server.mjs): every screen of the design,
// in dark and light, on a phone and on a desktop, plus the flows that must not go wrong. Needs the app
// built (npm --prefix scripts/hares/web run build) and Playwright's Chromium (npx playwright install
// chromium; HARES_CHROMIUM names another Chrome to use); without a browser every test is skipped with
// that reason, except under CI, where they must run. HARES_SHOTS=<folder> saves a screenshot of every
// screen at 390 and 1440 pixels. Everything it starts is stopped when the file ends.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { browserSkipReason, startHarness } from "./web-harness.mjs";

const webPackage = fileURLToPath(new URL("../web/package.json", import.meta.url));
const dist = fileURLToPath(new URL("../web/dist/web/browser/index.html", import.meta.url));
const requireFromWeb = createRequire(webPackage);
const { chromium } = requireFromWeb("playwright-core");
const { AxeBuilder } = requireFromWeb("@axe-core/playwright");

// verify always builds the app first (hares-e2e depends on hares-web), so a missing build means the file
// was run by hand too early: say so loudly rather than skip.
assert.ok(existsSync(dist), "Build the web app first: npm --prefix scripts/hares/web run build");

let browser = null;
let launchError = null;
try {
  browser = await chromium.launch(process.env.HARES_CHROMIUM ? { executablePath: process.env.HARES_CHROMIUM } : {});
} catch (error) {
  launchError = error;
}
const skip = browserSkipReason({ launchError });
if (launchError && !skip) throw launchError;
// Every test below goes through `e2e`, so without a browser the whole file reports as skipped, with the reason.
const e2e = skip ? (name, fn) => test(name, { skip }, fn) : test;
const demo = skip ? null : await startHarness();
if (!skip) {
  test.after(async () => {
    await browser.close();
    await demo.close();
  });
}
const shots = process.env.HARES_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const THATS_FAIR = ID(1);
const JEV = ID(2);
const VERIFIKA = ID(3);

async function scenario(name) {
  const response = await fetch(`${demo.url}/__demo/scenario`, { method: "POST", body: JSON.stringify({ name }) });
  assert.equal(response.status, 200);
  demo.calls.length = 0;
}

/** Opens a path in a fresh browser context. Console errors and page errors are collected, and fail the test that opened it. */
async function open(path_, { width = 390, height = 844, colorScheme = "dark", reducedMotion = "no-preference", expected = /^$/ } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion, serviceWorkers: "block" });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => { if (message.type() === "error" && !expected.test(message.text())) problems.push(message.text()); });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(`${demo.url}${path_}`);
  await page.locator("#main").waitFor();
  return { page, problems, close: async () => { await context.close(); assert.deepEqual(problems, [], `console errors on ${path_}`); } };
}

// Every screen of the design, with the scenario that shows it.
const SCREENS = [
  ["waiting", "/", "Now, waiting"],
  ["queue", "/", "Now, three questions"],
  ["clear", "/", "Now, nothing waiting"],
  ["offline", "/", "Now, offline"],
  ["waiting", `/s/${THATS_FAIR}`, "Session, with a question"],
  ["permission", `/s/${JEV}`, "Session, with a permission"],
  ["clear", `/s/${VERIFIKA}`, "Session, finished"],
  ["waiting", `/s/${THATS_FAIR}/terminal`, "Terminal"],
  ["waiting", "/start", "Start, prompt"],
  ["waiting", "/start?command=lesti", "Start, command"],
  ["waiting", "/start?issue=152&repo=thats-fair", "Start, issue"],
  ["waiting", "/start?pr=148&repo=thats-fair", "Start, pull request"],
  ["waiting", "/settings", "Settings"],
  ["waiting", "/settings/notifications", "Notifications"],
  ["waiting", "/activity", "Activity"],
  // The GitHub screens must be styled under the real CSP (style-src 'self'): component styles injected as <style>
  // elements are refused, and the page then renders as bare HTML.
  ["waiting", "/prs", "Pull requests"],
  ["waiting", "/prs/eduline-ai-shop/231", "Pull request"],
  ["waiting", "/prs/eduline-ai-shop/231?view=review", "Pull request, review"],
  ["waiting", "/issues", "Issues"],
  ["waiting", "/ci", "CI"],
];
const GITHUB_ROUTE = /^\/(?:prs|issues|ci)/;
/** Taps are ignored for half a second after the cards move, so a test waits as a person must. */
const settle = (page) => page.waitForTimeout(650);
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

for (const [name, route, title] of SCREENS) {
  for (const colorScheme of ["dark", "light"]) {
    for (const width of [390, 1440]) {
      e2e(`${title} at ${width} pixels in ${colorScheme} has no all-caps, no middle dot, no small target, one raised surface and no accessibility violation`, async () => {
        await scenario(name);
        const { page, close } = await open(route, { width, height: width > 800 ? 900 : 844, colorScheme });
        await page.waitForLoadState("networkidle");
        const styled = GITHUB_ROUTE.test(route) ? await page.evaluate(() => {
          const page_ = document.querySelector(".gh-page");
          const chip = [...document.querySelectorAll(".gh-chip, .gh-btn")].find((el) => el.getBoundingClientRect().height > 0);
          const row = document.querySelector("hares-prs-page .row");
          return {
            hasPage: !!page_,
            maxWidth: page_ && getComputedStyle(page_).maxWidth,
            chipHeight: chip && chip.getBoundingClientRect().height,
            rowBorder: row && getComputedStyle(row).borderBottomWidth,
            styleElements: document.querySelectorAll("style").length,
            styleAttributes: document.querySelectorAll("[style]").length,
          };
        }) : null;
        if (styled) {
          assert.equal(styled.hasPage, true, "the GitHub page rendered");
          assert.equal(styled.maxWidth, "1280px", "the page's own stylesheet applied");
          assert.ok(styled.chipHeight >= (width < 800 ? 43.5 : 36), `a chip or button is ${styled.chipHeight}px tall`);
          if (route === "/prs") assert.equal(styled.rowBorder, "1px", "the pull request list has its row dividers");
          assert.equal(styled.styleElements, 0, "no <style> element is injected, the CSP refuses them");
          assert.equal(styled.styleAttributes, 0, "no inline style attribute is set, the CSP refuses it");
        }
        const found = await page.evaluate(() => {
          const visible = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && !el.closest("[hidden], dialog:not([open])"); };
          const all = [...document.querySelectorAll("body *")].filter(visible);
          const small = [...document.querySelectorAll("a[href], button, input, textarea, select, [role=switch], [role=radio], [role=tab], [role=checkbox]")]
            .filter(visible).filter((el) => !el.matches(".sr-only, .sr-only *") && !el.closest(".sr-only"))
            .map((el) => ({ el, box: el.getBoundingClientRect() })).filter(({ box }) => Math.min(box.width, box.height) < (innerWidth < 800 ? 43.5 : 24))
            .map(({ el, box }) => `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
          return {
            caps: all.filter((el) => getComputedStyle(el).textTransform === "uppercase").map((el) => el.tagName),
            dots: document.body.innerText.includes("·"),
            small,
            raised: document.querySelectorAll("[data-raised]").length,
            fonts: [...new Set(all.map((el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "")))],
          };
        });
        assert.deepEqual(found.caps, [], "no element is set in capitals");
        assert.equal(found.dots, false, "no middle dot");
        assert.deepEqual(found.small, [], "every target is at least 44 pixels on a phone, and 24 with a mouse");
        assert.ok(found.raised <= 1, `${found.raised} raised surfaces`);
        // While atlas can't be seen the design shows the list at half strength on purpose: it may be out of date.
        const axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
        if (name === "offline") axe.exclude("hares-session-row");
        const violations = (await axe.analyze()).violations;
        assert.deepEqual(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), []);
        if (shots) await page.screenshot({ path: path.join(shots, `${slug(title)}-${width}-${colorScheme}.png`), fullPage: width < 800 });
        await close();
      });
    }
  }
}

e2e("the desktop header's links are each 44 pixels wide and tall, including CI with the red-main dot, and each has an accessible name", async () => {
  await scenario("waiting"); // main is red here, so the CI link carries its dot
  const { page, close } = await open("/", { width: 1440, height: 900 });
  await page.getByRole("link", { name: /^CI/ }).waitFor();
  const links = await page.evaluate(() => [...document.querySelectorAll("header a")].map((el) => {
    const box = el.getBoundingClientRect();
    return { name: (el.getAttribute("aria-label") || el.textContent || "").trim(), width: Math.round(box.width), height: Math.round(box.height) };
  }));
  assert.ok(links.some((link) => /^CI/.test(link.name) && /main is red/.test(link.name)), "the CI link shows it is red");
  assert.deepEqual(links.filter((link) => !link.name || link.width < 44 || link.height < 44), []);
  await close();
});

e2e("on a phone, a pull request's own Review and Merge bar is not covered by the bottom bar", async () => {
  await scenario("waiting");
  const { page, close } = await open("/prs/thats-fair/148");
  const review = page.getByRole("button", { name: "Review", exact: true }).last();
  await review.waitFor();
  const onTop = await review.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit && el.contains(hit));
  });
  assert.equal(onTop, true, "the Review button is the element a tap at its centre reaches");
  await close();
});

e2e("running text on the GitHub screens has no tabular figures, which put a space before commas and full stops", async () => {
  await scenario("waiting");
  const { page, close } = await open("/prs", { width: 1440, height: 900 });
  await page.locator(".gh-page").waitFor();
  const features = await page.locator(".gh-page").evaluate((el) => getComputedStyle(el).fontFeatureSettings);
  assert.doesNotMatch(features, /tnum/);
  await close();
});

e2e("an answer is sent with the status and sequence the person saw, for the question they picked, and the card goes away", async () => {
  await scenario("waiting");
  const { page, close } = await open("/");
  await page.getByRole("button", { name: "Send answer" }).waitFor();
  await settle(page);
  assert.equal(await page.getByRole("button", { name: "Send answer" }).isDisabled(), true, "nothing is sent before something is picked");
  await page.getByRole("radio", { name: /Keep ESLint/ }).click();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText("Answer sent. The session is working again.").waitFor();
  assert.equal(demo.calls.length, 1);
  assert.deepEqual(demo.calls[0].body, {
    questionId: "q-templates",
    expect: { terminalId: "term-1", sessionId: THATS_FAIR, status: "blocked", seq: 41 },
    answers: [{ kind: "option", n: 1 }],
  });
  await page.getByText("That’s Fair is asking").waitFor({ state: "detached" });
  await close();
});

e2e("with three questions waiting, previous and next move through them and each answer goes to its own question", async () => {
  await scenario("queue");
  const { page, close } = await open("/");
  await page.getByText("1 of 3").waitFor();
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByText("2 of 3").waitFor();
  await page.getByText("Which view should the gift list use by default?").waitFor();
  await page.waitForTimeout(600); // taps are ignored while the card is moving, so a finger can't land on the wrong one
  await page.getByRole("radio", { name: /Grid/ }).click();
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText("Answer sent.").waitFor();
  assert.equal(demo.calls[0].body.questionId, "q-gifts");
  assert.equal(demo.calls[0].body.expect.sessionId, ID(5));
  assert.deepEqual(demo.calls[0].body.answers, [{ kind: "option", n: 2 }]);
  await page.getByText("1 of 2").waitFor();
  await close();
});

e2e("a tap straight after the queue changes is ignored, so it can't answer the question that slid under the finger", async () => {
  await scenario("queue");
  const { page, close } = await open("/");
  await page.getByText("1 of 3").waitFor();
  await page.getByRole("radio", { name: /Keep ESLint/ }).click();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.querySelector("[aria-label='Next question']").click();
  });
  await page.getByText("2 of 3").waitFor();
  const pick = page.getByRole("radio", { name: /Grid/ });
  await pick.dispatchEvent("click", { detail: 1 });
  await page.waitForTimeout(150);
  assert.equal(await pick.getAttribute("aria-checked"), "false", "the first tap after a move is dropped");
  await page.waitForTimeout(600);
  await pick.click();
  await page.waitForFunction(() => [...document.querySelectorAll("[role=radio]")].some((el) => el.textContent.includes("Grid") && el.getAttribute("aria-checked") === "true"));
  await close();
});

e2e("when the session moved since the person looked, nothing is applied and the screen says so", async () => {
  await scenario("waiting");
  // The browser logs the refused request itself; that refusal is what this test provokes.
  const { page, close } = await open("/", { expected: /status of 409/ });
  await page.getByRole("radio", { name: /Keep ESLint/ }).waitFor();
  await settle(page);
  await page.getByRole("radio", { name: /Keep ESLint/ }).click();
  await fetch(`${demo.url}/__demo/stale`);
  await page.getByRole("button", { name: "Send answer" }).click();
  await page.getByText("The session changed since you looked; check it again").waitFor();
  await page.getByRole("button", { name: "Check again" }).waitFor();
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByRole("button", { name: "Send answer" }).waitFor();
  await close();
});

e2e("always allow shows the exact rule first and adds it only on the second step, with the confirmation", async () => {
  await scenario("permission");
  const { page, close } = await open(`/s/${JEV}`);
  await page.getByRole("button", { name: "Always allow in this repo" }).waitFor();
  await settle(page);
  await page.getByRole("button", { name: "Always allow in this repo" }).click();
  await page.getByText("Bash(pnpm add:*)").waitFor();
  assert.equal(demo.calls.length, 0, "the first tap only asks");
  await page.getByRole("button", { name: "Keep asking" }).click();
  await page.getByText("Bash(pnpm add:*)").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Always allow in this repo" }).click();
  await page.getByRole("button", { name: "Add the rule" }).click();
  await page.getByText("Decision sent.").waitFor();
  assert.equal(demo.calls[0].path, "/api/approvals/p-pnpm-add");
  assert.deepEqual(demo.calls[0].body, { decision: "always", expect: { terminalId: "term-2", sessionId: JEV, status: "blocked", seq: 42 }, rule: "Bash(pnpm add:*)", confirm: true });
  await close();
});

e2e("a permission in the queue on Now is opened to decide, never decided from the list", async () => {
  await scenario("permission");
  const { page, close } = await open("/");
  await page.getByText("needs your OK").waitFor();
  assert.equal(await page.getByRole("button", { name: /Run once|Always allow/ }).count(), 0);
  await page.locator("hares-permission-summary").getByRole("link", { name: "Review" }).click();
  await page.waitForURL(new RegExp(`/s/${JEV}\\?q=p-pnpm-add`));
  await page.getByRole("button", { name: "Run once" }).waitFor();
  await close();
});

e2e("the terminal sends one key from its keycap, and a lit Ctrl turns the next typed letter into a control key", async () => {
  await scenario("waiting");
  const { page, close } = await open(`/s/${THATS_FAIR}/terminal`);
  await page.getByText("Chat about this").waitFor();
  await page.getByRole("button", { name: "Escape" }).click();
  await page.waitForResponse((response) => response.url().includes("/screen"));
  assert.deepEqual(demo.calls[0].body.keys, ["escape"]);
  assert.equal(demo.calls[0].body.expect.seq, 41);
  await page.getByRole("button", { name: "Control, then the next key" }).click();
  await page.getByRole("textbox", { name: "Type into the terminal" }).fill("c");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForResponse((response) => response.url().includes("/screen"));
  assert.deepEqual(demo.calls[1].body.keys, ["ctrl-c"]);
  await close();
});

e2e("starting from a command sends the repo, the command and what it is for, and opens the new session", async () => {
  await scenario("waiting");
  const { page, close } = await open("/start");
  await page.getByRole("tab", { name: "mexxi" }).click();
  await page.getByRole("radio", { name: "eduline-ai-shop" }).click();
  await page.getByRole("radio", { name: /lesti/ }).click();
  await page.getByLabel("For").fill("#152");
  assert.match(await page.locator("code").last().innerText(), /claude "\/lesti #152"/);
  await page.getByRole("button", { name: "Start session" }).click();
  await page.waitForURL(/\/s\/00000000-0000-4000-8000-0000000001/);
  assert.deepEqual({ ...demo.calls[0].body, clientId: "x" }, { clientId: "x", repo: "eduline-ai-shop", kind: "command", command: "lesti", args: "#152" });
  await close();
});

e2e("starting from a pull request names the pull request and what to ask for", async () => {
  await scenario("waiting");
  const { page, close } = await open("/start?pr=148&repo=thats-fair");
  await page.getByRole("radio", { name: "Address the review comments" }).waitFor();
  await page.getByRole("button", { name: "Start session" }).click();
  await page.waitForURL(/\/s\//);
  assert.deepEqual({ ...demo.calls[0].body, clientId: "x" }, { clientId: "x", repo: "thats-fair", kind: "pr", pr: 148, ask: "review-comments" });
  await close();
});

e2e("old links open the new screens: a run link its session, an approval link its session with the prompt open", async () => {
  await scenario("permission");
  let opened = await open(`/runs/${THATS_FAIR}`);
  await opened.page.waitForURL(`**/s/${THATS_FAIR}`);
  await opened.close();
  opened = await open("/approvals/p-pnpm-add");
  await opened.page.waitForURL(new RegExp(`/s/${JEV}\\?q=p-pnpm-add`));
  await opened.close();
});

e2e("the theme follows the device until a choice is made, and the choice survives a reload", async () => {
  await scenario("waiting");
  const { page, close } = await open("/settings", { colorScheme: "light" });
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await background();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "dark");
  assert.notEqual(await background(), light);
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), "dark");
  await page.getByRole("radio", { name: "System" }).click();
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-theme"));
  assert.equal(await background(), light);
  await close();
});

e2e("with atlas unreachable the screen says so with the last-seen time and offers no question to answer", async () => {
  await scenario("offline");
  const { page, close } = await open("/");
  await page.getByText("Can’t reach atlas.").waitFor();
  await page.getByText("Can’t see atlas right now").waitFor();
  assert.match(await page.getByRole("img", { name: /atlas offline, last seen at \d\d:\d\d/ }).getAttribute("aria-label"), /last seen at/);
  assert.equal(await page.getByRole("button", { name: "Send answer" }).count(), 0);
  await close();
});

e2e("the lantern breathes while a session waits, and stands still under reduced motion", async () => {
  await scenario("waiting");
  for (const [reducedMotion, expected] of [["no-preference", "breathe"], ["reduce", "none"]]) {
    const { page, close } = await open("/", { reducedMotion });
    const animation = await page.locator(".lantern").first().evaluate((el) => getComputedStyle(el).animationName);
    assert.equal(animation, expected);
    await close();
  }
});

e2e("on a desktop J and K move between sessions, a number picks an option without sending it, and E interrupts", async () => {
  await scenario("waiting");
  const { page, close } = await open("/", { width: 1440, height: 900 });
  await page.getByRole("heading", { name: "Move lint to oxlint and oxfmt" }).waitFor();
  await page.keyboard.press("j");
  await page.getByRole("heading", { name: "Fix verify:ci lint errors" }).waitFor();
  await page.keyboard.press("k");
  await page.getByRole("heading", { name: "Move lint to oxlint and oxfmt" }).waitFor();
  await page.getByRole("radio", { name: /Drop template linting/ }).waitFor();
  await settle(page);
  await page.keyboard.press("2");
  await page.waitForFunction(() => [...document.querySelectorAll("[role=radio]")].some((el) => el.textContent.includes("Drop template") && el.getAttribute("aria-checked") === "true"));
  assert.equal(demo.calls.length, 0, "picking sends nothing");
  await page.keyboard.press("e");
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
  assert.equal(demo.calls[0].path, `/api/sessions/${THATS_FAIR}/esc`);
  await close();
});

e2e("notification choices are saved as they are made, and Settings links the machine health page, which loads", async () => {
  await scenario("waiting");
  const { page, close } = await open("/settings/notifications");
  await page.getByRole("switch", { name: "A PR is ready to merge" }).click();
  await page.waitForTimeout(200);
  assert.equal(demo.calls[0].method, "PUT");
  assert.equal(demo.calls[0].body.events.prReady, true);
  await page.goto(`${demo.url}/settings`);
  const href = await page.getByRole("link", { name: /Machine health/ }).getAttribute("href");
  assert.equal(href, "/ext/atlas-ops/");
  assert.equal((await fetch(demo.url + href)).status, 200);
  await close();
});

e2e("ending a session needs the second, confirming tap, and then leaves for Now", async () => {
  await scenario("waiting");
  const { page, close } = await open(`/s/${ID(4)}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "End session" }).click();
  assert.equal(demo.calls.length, 0, "the first tap only asks");
  await page.getByText("Closes its herdr pane.").waitFor();
  await page.getByRole("group", { name: "Confirm ending the session" }).getByRole("button", { name: "End session" }).click();
  await page.waitForURL(`${demo.url}/`);
  assert.equal(demo.calls[0].path, `/api/sessions/${ID(4)}/end`);
  assert.equal(demo.calls[0].body.confirm, true);
  await close();
});
