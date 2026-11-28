#!/usr/bin/env node
// hares's entry point: the subcommand table, help and dispatch. Each phase
// fills in more commands, and help marks the ones that don't work yet.
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @type {Record<string, { summary: string, why: string, implemented?: boolean }>} */
export const COMMANDS = {
  serve: {
    implemented: true,
    summary: "Run the web app and MCP server on loopback.",
    why: "A session stops whenever it needs an answer, so something has to stay up to follow, answer and start sessions from your phone.",
  },
  token: {
    implemented: true,
    summary: "Rotate the bearer token MCP clients use.",
    why: "A leaked token should be cheap to replace, so rotating it takes one command.",
  },
  vapid: {
    implemented: true,
    summary: "Create the keys push notifications are signed with.",
    why: "Your phone can only trust a push that is signed, so hares needs its own key pair.",
  },
  "github-token": {
    implemented: true,
    summary: "Store or remove the read-only GitHub token that readiness reads pull requests with.",
    why: "Whether a pull request is ready depends on CI and its state on GitHub, which hares can only read with a token you choose.",
  },
  doctor: {
    implemented: true,
    summary: "Check, read-only, that herdr, the question hook and Claude Code are what hares expects.",
    why: "herdr's protocol, the hook in Claude Code's settings and Claude Code's screens can each change under hares, and this says which one did.",
  },
};

export function help() {
  const lines = ["Usage: hares <command>", "", "Commands:"];
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length)) + 2;
  for (const [name, { summary, why, implemented }] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}${summary}${implemented ? "" : " (not yet implemented)"}`, `${" ".repeat(width + 2)}Why: ${why}`);
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
    process.stderr.write(`hares: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  let settings;
  try {
    settings = await readSettings(flags.config ? { file: path.resolve(flags.config) } : {});
  } catch (error) {
    process.stderr.write(`hares: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (!settings.hares.enabled) {
    process.stderr.write("hares: hares.enabled is false in config.json, so the server will not start.\n");
    process.exitCode = 2;
    return;
  }
  try {
    const { url, close } = await startServer({ settings, dataDir: flags.dataDir ? path.resolve(flags.dataDir) : dataDir() });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close().finally(() => process.exit(0)));
    process.stdout.write(`hares listening on ${url}\n`);
  } catch (error) {
    process.stderr.write(`hares: ${error.message}\n`);
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
    process.stderr.write(`hares: expected ${Object.keys(COMMANDS).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (first === "serve") return serve(args.slice(1));
  if (first === "vapid") return (await import("./lib/vapid-cli.mjs")).runVapid(args.slice(1));
  if (first === "github-token") return (await import("./lib/github-token-cli.mjs")).runGithubToken(args.slice(1));
  if (first === "token") return (await import("./lib/token-cli.mjs")).runToken(args.slice(1));
  if (first === "doctor") return void (await (await import("./lib/doctor.mjs")).runDoctorCommand(args.slice(1)));
  process.stderr.write(`hares ${first}: not yet implemented\n`);
  process.exitCode = 2;
  return undefined;
}

// The installer links this file as `hares`, and node runs a symlinked script from its real path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
