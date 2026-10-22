#!/usr/bin/env node
// segwi's entry point. Only the subcommand table and help exist so far; each
// later phase fills in one command, so help never claims more than works.
import { pathToFileURL } from "node:url";

/** @type {Record<string, { summary: string, why: string }>} */
export const COMMANDS = {
  serve: {
    summary: "Run the web app and MCP server on loopback.",
    why: "A run stops whenever it needs a reply, so something has to stay up to start, follow and answer runs from your phone.",
  },
  approver: {
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
  const lines = ["Usage: segwi <command>", "", "Commands (none is implemented yet):"];
  for (const [name, { summary, why }] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(9)}${summary}`, `${" ".repeat(11)}Why: ${why}`);
  }
  return lines.join("\n");
}

export function main(args = process.argv.slice(2)) {
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
  process.stderr.write(`segwi ${first}: not yet implemented\n`);
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
