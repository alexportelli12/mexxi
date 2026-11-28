// The harness for the web app's browser tests and the demo: a fake server with demo data for every
// screen (demo-server.mjs). Nothing here reaches the network or herdr.
import { startDemoServer } from "./demo-server.mjs";

/**
 * Why the browser tests can't run on this machine, or null. Only a browser that isn't
 * installed is a reason; any other launch failure is a real failure. With CI set nothing is
 * ever skipped, so a passing CI run proves the browser tests ran.
 * @param {{ env?: Record<string, string|undefined>, launchError: Error|null }} options
 */
export function browserSkipReason({ env = process.env, launchError }) {
  if (env.CI || !launchError || !/Executable doesn't exist/.test(launchError.message)) return null;
  return "Playwright's Chromium isn't installed. Run npx playwright install chromium in scripts/hares/web to run these tests.";
}

/**
 * @param {{ port?: number, scenario?: string }} [options]
 * @returns the running demo server: url, calls, setScenario(name) and close()
 */
export const startHarness = (options = {}) => startDemoServer(options);
