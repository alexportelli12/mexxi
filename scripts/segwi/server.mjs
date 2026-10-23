#!/usr/bin/env node
// segwi's entry point: the subcommand table, help and dispatch. Each phase
// fills in more commands, and help marks the ones that don't work yet.
import { pathToFileURL } from "node:url";

/** @type {Record<string, { summary: string, why: string, implemented?: boolean }>} */
export const COMMANDS = {
  serve: {
    implemented: true,
    summary: "Run the web app and MCP server on loopback.",
    why: "A run stops whenever it needs a reply, so something has to stay up to start, follow and answer runs from your phone.",
  },
  approver: {
    implemented: true,
    summary: "Ask you to allow or deny a call the agent is not pre-approved to make.",
    why: "The agent should never run an unusual command unseen, so each one waits for your answer.",
  },
  token: {
    summary: "Rotate the bearer token MCP clients use.",
    why: "A leaked token should be cheap to replace, so rotating it takes one command.",
  },
  vapid: {
    summary: "Create the keys push notifications are signed with.",
    why: "Your phone can only trust a push that is signed, so segwi needs its own key pair.",
  },
  canary: {
    summary: "Run a small real task to check the coding agent still behaves as segwi expects.",
    why: "The agent's command line can change between versions, and a nightly check finds out before you do.",
  },
};

export function help() {
  const lines = ["Usage: segwi <command>", "", "Commands:"];
  for (const [name, { summary, why, implemented }] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(9)}${summary}${implemented ? "" : " (not yet implemented)"}`, `${" ".repeat(11)}Why: ${why}`);
  }
  return lines.join("\n");
}

async function serve() {
  const { readSettings } = await import("./lib/settings.mjs");
  const { startServer } = await import("./lib/serve.mjs");
  const { dataDir } = await import("./lib/paths.mjs");
  const settings = await readSettings();
  if (!settings.segwi.enabled) {
    process.stderr.write("segwi: segwi.enabled is false in config.json, so the server will not start.\n");
    process.exitCode = 2;
    return;
  }
  try {
    const { url } = await startServer({ settings, dataDir: dataDir() });
    process.stdout.write(`segwi listening on ${url}\n`);
  } catch (error) {
    process.stderr.write(`segwi: ${error.message}\n`);
    process.exitCode = 2;
  }
}

export async function main(args = process.argv.slice(2)) {
  const [first] = args;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (!Object.hasOwn(COMMANDS, first)) {
    process.stderr.write(`segwi: expected ${Object.keys(COMMANDS).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (first === "serve") return serve();
  if (first === "approver") return (await import("./lib/approver.mjs")).runApprover();
  process.stderr.write(`segwi ${first}: not yet implemented\n`);
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
