#!/usr/bin/env node
// segwi's entry point: the subcommand table, help and dispatch. Each phase
// fills in more commands, and help marks the ones that don't work yet.
import path from "node:path";
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
    implemented: true,
    summary: "Rotate the bearer token MCP clients use.",
    why: "A leaked token should be cheap to replace, so rotating it takes one command.",
  },
  vapid: {
    implemented: true,
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

/** `--config <file>` and `--data-dir <dir>` are the operator's flags, never request input. */
function serveFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--config" && name !== "--data-dir") || !value) throw new Error(`serve accepts --config <file> and --data-dir <dir>, not "${[name, value].filter(Boolean).join(" ")}"`);
    flags[name === "--config" ? "config" : "dataDir"] = value;
  }
  return flags;
}

async function serve(args) {
  const { readSettings } = await import("./lib/settings.mjs");
  const { startServer } = await import("./lib/serve.mjs");
  const { dataDir } = await import("./lib/paths.mjs");
  let flags;
  try {
    flags = serveFlags(args);
  } catch (error) {
    process.stderr.write(`segwi: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let settings;
  try {
    settings = await readSettings(flags.config ? { file: path.resolve(flags.config) } : {});
  } catch (error) {
    process.stderr.write(`segwi: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (!settings.segwi.enabled) {
    process.stderr.write("segwi: segwi.enabled is false in config.json, so the server will not start.\n");
    process.exitCode = 2;
    return;
  }
  try {
    const { url, close } = await startServer({ settings, dataDir: flags.dataDir ? path.resolve(flags.dataDir) : dataDir() });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close().finally(() => process.exit(0)));
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
  if (first === "serve") return serve(args.slice(1));
  if (first === "approver") return (await import("./lib/approver.mjs")).runApprover(args.slice(1));
  if (first === "vapid") return (await import("./lib/vapid-cli.mjs")).runVapid(args.slice(1));
  if (first === "token") return (await import("./lib/token-cli.mjs")).runToken(args.slice(1));
  process.stderr.write(`segwi ${first}: not yet implemented\n`);
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
