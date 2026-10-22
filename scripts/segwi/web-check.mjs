#!/usr/bin/env node
// The segwi-web check: install the web app's dependencies when its lockfile
// changed, build it for production, check that the initial bundle stays within
// 200 kB gzip (angular.json holds only a coarse raw-size backstop, because
// Angular budgets count raw bytes), then run its unit tests. The install is skipped otherwise,
// so a warm run stays well inside the verify time budget.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDirectory = fileURLToPath(new URL("./web/", import.meta.url));

export function lockHash(directory = webDirectory) {
  return createHash("sha256").update(readFileSync(path.join(directory, "package-lock.json"))).digest("hex");
}

/** True when node_modules is missing or was installed from a different lockfile. */
export function needsInstall(directory = webDirectory) {
  const stamp = path.join(directory, "node_modules/.segwi-lock-hash");
  return !existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== lockHash(directory);
}

export const GZIP_LIMIT_BYTES = 200 * 1024;

/** Gzip size of the scripts and stylesheets a built index.html loads directly, never its lazy chunks. */
export function initialGzipBytes(browserDirectory) {
  const html = readFileSync(path.join(browserDirectory, "index.html"), "utf8");
  const references = new Set([
    ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g)].map((match) => match[1]),
  ]);
  let total = 0;
  for (const reference of references) {
    total += gzipSync(readFileSync(path.join(browserDirectory, reference)), { level: 9 }).length;
  }
  return total;
}

function run(args) {
  const { status } = spawnSync("npm", args, {
    cwd: webDirectory,
    stdio: "inherit",
    env: { ...process.env, NG_CLI_ANALYTICS: "false" },
  });
  if (status !== 0) process.exit(status ?? 1);
}

function main() {
  if (needsInstall()) {
    run(["ci"]);
    writeFileSync(path.join(webDirectory, "node_modules/.segwi-lock-hash"), `${lockHash()}\n`);
  }
  run(["run", "build"]);
  const bytes = initialGzipBytes(path.join(webDirectory, "dist/web/browser"));
  if (bytes > GZIP_LIMIT_BYTES) {
    process.stderr.write(`Initial bundle is ${(bytes / 1024).toFixed(1)} kB gzip, over the ${GZIP_LIMIT_BYTES / 1024} kB limit.\n`);
    process.exit(1);
  }
  process.stdout.write(`Initial bundle: ${(bytes / 1024).toFixed(1)} kB gzip (limit ${GZIP_LIMIT_BYTES / 1024} kB).\n`);
  run(["test", "--", "--no-watch"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
