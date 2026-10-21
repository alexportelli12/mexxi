---
name: rendered-qa
description: Exercise a running UI hands-on and capture evidence — viewports, motion, hydration, scrolling, interaction, keyboard, touch targets, console — then report findings with a severity. Use for /wettaq's rendered pass, before-shots, the /ittestja command, or when a reviewer must close a named rendered-evidence gap. Do not use to design UI or to edit code.
---

# Rendered QA

Look at the real, running interface the way a careful tester would, and leave
evidence another person can check. Source code and CSS values cannot establish
what renders; screenshots, recordings, measurements and console output can.

This skill owns how to exercise a UI and capture evidence. `ui-designer` owns
design judgement; its `references/ui-review.md` owns the finding format. QA
never edits code.

## Scope The Pass

Be proportional. Cover the routes, states and flows the change or request
affects, plus their immediate neighbours, rather than auditing the whole app.
Pick the checks below that can plausibly fail for this change and say which
ones you skipped.

Write every artifact to the session's `evidenceDir` (from
`ibni prepare` or `info`). Outside a workspace, use a fresh
system temporary directory. Never write into a worktree or checkout. Name files
`<before|after>-<route-slug>-<viewport>.<ext>` so before and after pairs line up.

## Start The App

Use the repository's documented commands (agent docs, README, package scripts)
to install, seed and start the app; do not invent commands or configuration.
Install with the lockfile-respecting command (for example `npm ci`) and
confirm `git status` is unchanged afterwards; a rewritten lockfile dirties the
tree and blocks the lifecycle. Note the URL and port, wait until it serves, and
stop any server you started when finished. If the app cannot start, report that as the result instead of
guessing from source.

## Checks

**Viewports.** Desktop (about 1440×900), tablet (about 768×1024) and mobile
(about 390×844). Check that the hierarchy survives, nothing important
disappears, and nothing overflows horizontally: compare
`document.documentElement.scrollWidth` with `clientWidth` at each width.

**Motion.** Entrance and scroll-triggered animations cannot be judged from one
screenshot. Prefer a Playwright video (a context with `recordVideo`, or the
host's video option) or a trace. Otherwise sample frames: take screenshots
roughly every 100ms through the animation. Look for jank, content that never
arrives, elements stuck mid-transition, and motion that obscures content.

Through the Playwright MCP, open a separate context from
`page.context().browser()` with `recordVideo` pointed at a system temporary
directory, close the context, then call `video.saveAs()` with an absolute path
in `evidenceDir`. The MCP browser may run remotely, so `video.path()` is not
available, and raw recordings should not mix with publishable evidence.

**Hydration and layout shift.** For server-rendered apps, capture the page as
early as possible and again after it settles; compare them and watch a
recording for flashes of unstyled, wrong or missing content. Measure layout
shift with a `PerformanceObserver` for `layout-shift` entries during load and
interaction.

**Reduced motion.** Emulate `prefers-reduced-motion: reduce`, reload, and
confirm that non-essential motion stops or softens while all content still
appears. Content left at `opacity: 0` or off-screen is a defect.

**Scrolling.** Sticky elements stick and do not cover content they should not.
In-page anchors land with the target visible below any sticky header.
Back/forward navigation restores scroll position. Scrolling never reveals
horizontal overflow.

**Interaction.** Hover, click and focus each interactive element the change
touches, including loading, empty, error, success, selected and disabled
states where they apply. Then operate the flow with the keyboard only: logical
tab order, visible focus on every stop, Enter/Space activate, Escape closes
overlays, and focus returns sensibly afterwards.

**Touch targets.** At the mobile viewport, measure interactive elements with
`getBoundingClientRect`. Flag targets smaller than 24×24 CSS px (WCAG 2.5.8)
and note those under about 44×44 on primary actions.

**Console and network.** Collect console errors and warnings for the whole
pass, including hydration-mismatch messages, plus failed requests. Report
each one that is new or relevant to the change.

**Design references.** When the repository holds mockups, design references or
screenshots for the affected UI, compare the render against them side by side
and report material differences, not pixel noise.

## Motion For Pull Requests

When motion matters to the change, turn the recording into a GIF a pull request
can embed: about 5–8 seconds, about 800px wide, under 10MB. For example:

```bash
ffmpeg -y -t 8 -i after-home-motion.webm \
  -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  after-home-motion.gif
```

Lower the frame rate, width or duration if the file is too large. GitHub does
not embed video files from a repository, so keep the original only as a link.
If recording or `ffmpeg` is unavailable, fall back to a short sequence of
screenshots and say so in the report.

## Before-Shots

When asked to capture "before" evidence, take the same routes, states and
viewports you expect to check afterwards, from the unchanged code, using the
`before-` prefix. Keep it to the affected routes.

## Report

Each finding uses the `ui-review.md` format (Observation → Impact → Principle →
Smallest fix) plus:

- **Severity:** `critical` (a primary task is blocked, data is at risk, or the
  flow is inaccessible), `high` (a common task is seriously impaired at a
  common viewport), `medium` (a noticeable defect with a workaround), or `low`
  (polish).
- **Where:** route, section and viewport.
- **Reproduce:** the shortest steps.
- **Evidence:** the artifact path.

Also list what you tested that worked, which checks you skipped and why, and
any limit on the evidence (for example, video recording unavailable).

End with **Could become executable checks**: findings or checks that the app
repository could automate, such as failing on console errors, asserting no
horizontal overflow at mobile width, or loading under reduced motion. Suggest
them; do not add them.
