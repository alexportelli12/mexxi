---
name: playwright-tests
description: Write and maintain Playwright UI tests with resilient selectors, reusable helpers, and AAA structure. Use when creating or updating Playwright tests, configuring test id attributes, adding test utilities, or enforcing UI automation standards.
metadata:
  optional: "Repositories that keep Playwright UI tests."
  why: "Browser tests with brittle selectors break on every harmless change."
  group: ui
---

# Playwright Tests

## Overview

Create reliable, readable, and maintainable Playwright UI tests with stable
selectors, reusable flows, and flake-resistant assertions. Follow the active
repository's configured test-id attribute and selector conventions.
`test-design` decides whether a flow needs a browser test at all and which
break it catches; this skill covers writing it well.

## Core Principles

- **Arrange, Act, Assert**: separate setup, interactions, and verification.
- **Selectors use the repository convention**: add stable test-id attributes in
  templates only when the repository uses them; never add or mutate them in
  TypeScript.
- **Reuse repeated steps**: extract common flows into helpers or fixtures to avoid duplication.

## Locator Strategy

1. Use the repository's configured test-id attribute when one exists.
2. Prefer `getByTestId()` with stable values when that convention is available.
3. Use semantic locators when no test-id convention exists or when semantics are
   the more stable contract.
4. Avoid CSS/XPath unless there is no other option.

```ts
await page.getByRole("button", { name: "Submit order" }).click();
```

**Naming guidance:** use unique, descriptive, stable names (feature + element + intent). Avoid dynamic values, index-based ids, or styling references.

## Test Structure (AAA)

```ts
import { test, expect } from "@playwright/test";

test("user submits checkout", async ({ page }) => {
  // Arrange
  await page.goto("/checkout");
  await fillCheckoutForm(page);

  // Act
  await page.getByTestId("checkout-submit").click();

  // Assert
  await expect(page.getByTestId("checkout-success")).toBeVisible();
});
```

## Reuse and Abstractions

- Create reusable helpers for repeated steps (login, onboarding, form fills, navigation).
- Prefer small, explicit helper functions and test fixtures over monolithic page objects.
- Use `test.step()` to label complex flows and keep test intent clear.
- Keep helpers deterministic: no hidden waits or random timing.

Example helper:

```ts
export async function fillCheckoutForm(page: Page) {
  await page.getByTestId("checkout-name").fill("Alex");
  await page.getByTestId("checkout-email").fill("alex@example.com");
}
```

## Stability and Flake Resistance

- Use Playwright locators (auto-waiting) and web-first assertions (`expect(...).toBeVisible()`).
- Avoid `waitForTimeout`; wait on specific UI states instead.
- Keep selectors strict and unique; avoid ambiguous matches.
- Ensure tests are isolated: clean state, unique data, no shared mutable globals.
- Use `storageState` or fixtures for authenticated flows; reset state per test.
- Mock network only when necessary for determinism; otherwise test real integrations.

## Debugging and CI Hygiene

- Enable traces/screenshot/video on failure in CI for fast triage.
- Keep tests parallel-safe; avoid cross-test dependencies.
- Tag slow or flaky tests; keep retries limited and justified.
- Use `test.describe` to scope setup and reduce redundant navigation.
