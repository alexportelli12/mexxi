// The browser a run's own tests launch through CHROME_BIN (Karma, and Playwright where a repository passes it on).
// Inside Claude Code's sandbox the full Chromium can't start: its own sandbox needs user namespaces, which the
// sandbox refuses, and even with --no-sandbox it aborts when a seccomp filter blocks the Unix socket it opens to
// keep one browser per profile. chrome-headless-shell opens no such socket, so it starts with --no-sandbox. The
// runner looks for one here, outside the sandbox, and hands it to bin/chromium.mjs.
import { accessSync, constants, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The launcher a run's CHROME_BIN names. It lives in the mexxi clone, which a run can't write. */
export const BROWSER_LAUNCHER = fileURLToPath(new URL("../bin/chromium.mjs", import.meta.url));
/** Where the runner tells the launcher which browser to start. */
export const HEADLESS_SHELL_ENV = "MEXXI_HEADLESS_SHELL";

const executable = (file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const list = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The newest chrome-headless-shell Playwright installed (`npx playwright install chromium` brings one), else a
 * `chromium-headless-shell` on PATH (Debian's package), else null.
 */
export function findHeadlessShell({ home, env = process.env } = {}) {
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, ".cache", "ms-playwright");
  const installs = list(browsers)
    .map((name) => ({ name, revision: Number(/^chromium_headless_shell-(\d+)$/.exec(name)?.[1]) }))
    .filter(({ revision }) => Number.isInteger(revision))
    .sort((a, b) => b.revision - a.revision);
  for (const { name } of installs) {
    const dir = path.join(browsers, name);
    const found = list(dir)
      .filter((platform) => platform.startsWith("chrome-headless-shell-"))
      .map((platform) => path.join(dir, platform, "chrome-headless-shell"))
      .find(executable);
    if (found) return found;
  }
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .map((dir) => path.join(dir, "chromium-headless-shell")).find(executable) ?? null;
}
