---
name: rendered-qa
description: Exercise a running UI hands-on and capture evidence — viewports, motion, hydration, scrolling, interaction, keyboard, touch targets, console — then report findings with a severity. Use for /wettaq's rendered pass, before-shots, the /ittestja command, or when a reviewer must close a named rendered-evidence gap. Do not use to design UI or to edit code.
metadata:
  why: "Code and stylesheets cannot show what a page actually looks like; a real browser and screenshots can."
  group: run
---

# Rendered QA

Exercise the running interface as a careful tester would, and leave evidence
another person can check, never conclusions drawn from source or CSS.
`ui-designer` owns design judgement and `references/ui-review.md` the finding
format. QA never edits code.

## Run In A Subagent, Report In Text

In a `/wettaq` run, this pass, before-shots included, runs in a subagent that
loads this skill and keeps the browser to itself. Screenshots stay on disk in
`evidenceDir`: the subagent reads them, and returns only text, findings and
evidence file paths, never images, so the run's own context stays small. The
orchestrator opens a screenshot only to choose what the pull request shows.

## Scope The Pass

Cover the routes, states and flows the change affects, plus their immediate
neighbours. Pick the checks below that can plausibly fail, and say which you
skipped. Write every artifact to `evidenceDir` (outside a workspace, a fresh
system temporary directory), never into a worktree or checkout, named
`<before|after>-<route-slug>-<viewport>.<ext>` so pairs line up.

## Start The App

Use the repository's documented commands to seed and start the app; never
invent them. In a workspace the dependencies are already installed; elsewhere
use the lockfile's install (such as `npm ci`), and confirm `git status` is
unchanged afterwards. In a workspace, export `portEnv` and serve on `port`
through the repository's own port setting, with a second server on another
port of the block. Wait until it serves, and stop every server you started when
finished. If the app cannot start, that is the result; never guess from source.

## Readiness Rules

1. Wait for a readiness signal (a selector, a response, `document.fonts.ready`),
   never a fixed sleep.
2. Confirm no dev-error overlay (Vite, Next.js, webpack, Angular) before judging
   a page; an overlay is itself a finding.
3. Take an accessibility snapshot before choosing selectors.
4. Dismiss overlays that intercept clicks instead of retrying or forcing.
5. Use 5-second action timeouts; a click that has not landed by then is
   blocked or mistargeted.

## The Sweep Helper

Never write the viewport pass by hand. From this skill's folder:

```bash
node scripts/sweep.mjs --url <url> --out <evidenceDir> --name <route-slug> --phase <before|after>
```

It screenshots each width in `workflow.viewports` and reports as JSON, per
viewport: horizontal overflow with the offending elements, interactive elements
under 44×44 CSS px, a dev-error overlay and console errors. At the first
viewport it also runs axe's ARIA and label rules (`axe`): a reference to a
missing id, a control with no accessible name, a field with no or two labels.
`--wait-for <selector>` supplies readiness; `--help` lists the rest. An
overflow, a `below-24` target or an axe violation is a defect; `below-44` is
advisory, and inline links in a sentence are exempt (WCAG 2.5.8). Sweep every
affected route and each state the change adds.

## Checks Beyond The Sweep

- **Viewports:** read the screenshots; the hierarchy survives at each width.
- **Motion:** judge animations from a recording, never one screenshot. Through
  the Playwright MCP, open a separate context from `page.context().browser()`
  with `recordVideo` pointed at a system temporary directory, close it, then
  `video.saveAs()` into `evidenceDir`. Otherwise sample frames about every
  100ms. Look for jank, content that never arrives or stays mid-transition.
- **Hydration and layout shift:** for server-rendered apps, compare the earliest
  capture with the settled one, and measure `layout-shift` entries with a
  `PerformanceObserver`.
- **Reduced motion:** emulate `prefers-reduced-motion: reduce` and reload;
  content left at `opacity: 0` or off-screen is a defect.
- **Scrolling:** sticky elements cover nothing, anchors land below sticky
  headers, back and forward restore position.
- **Interaction:** hover, click and focus each element the change touches, in
  every state it has; then the keyboard only: tab order, visible focus,
  Enter/Space, Escape, focus return.
- **Console and network:** warnings, hydration mismatches and failed requests
  that are new or relevant.
- **Design references:** compare against mockups the repository holds; report
  material differences, not pixel noise.

## Media For The Pull Request

When motion matters, make a GIF of about 5–8 seconds, about 800px wide, under
10MB:

```bash
ffmpeg -y -t 8 -i after-home-motion.webm \
  -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  after-home-motion.gif
```

Publish chosen screenshots or GIFs with `ibni publish-media --session
"<sessionId>" --files "<names in evidenceDir>"`, after checking each file for
secrets, tokens, personal data and internal hostnames: the branch may be
public, and cleanup does not erase history.

## Before-Shots

Take the routes, states and viewports you expect to check afterwards, from the
unchanged code, with the `before-` prefix.

## Report

Each finding uses the `ui-review.md` format (Observation → Impact → Principle →
Smallest fix) plus:

- **Severity:** `blocker` (a primary task is blocked, data is at risk, or the
  flow is inaccessible), `major` (a common task is seriously impaired at a
  common viewport, or an axe violation), `minor` (a noticeable defect with a
  workaround), or `nit` (polish).
- **Where:** route, section and viewport.
- **Reproduce:** the shortest steps.
- **Evidence:** the file path.

Also list what worked, what you skipped and why, and limits on the evidence.
End a pass that used the Playwright MCP with `browser_close`: an open
browser holds about a gigabyte.

End with **Could become executable checks**: one line each for checks the app
repository could automate, such as failing on console errors. Suggest them,
never add them; `/wettaq` lists them under **Left for later**.
