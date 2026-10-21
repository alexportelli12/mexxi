#!/usr/bin/env node
// The `mods` check: Claude Code itself validates the marketplace and each mod
// in claude/mods/, and runs each mod's tests (`claude plugin test`). Only the
// claude CLI can do either, so the check needs it and fails, never skips,
// without it: a verify that silently drops a check is not the same gate.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function claude(args) {
  const result = spawnSync("claude", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error?.code === "ENOENT") {
    throw new Error("the mods check needs the claude CLI (Claude Code) on PATH to validate and test claude/mods/; install Claude Code, then run it again");
  }
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`claude ${args.join(" ")} failed:\n${output.trim()}`);
  return output;
}

try {
  const marketplaceFile = path.join(root, ".claude-plugin/marketplace.json");
  claude(["plugin", "validate", marketplaceFile]);
  const { plugins } = JSON.parse(await readFile(marketplaceFile, "utf8"));
  for (const { name, source } of plugins) {
    const folder = path.join(root, source);
    claude(["plugin", "validate", folder]);
    const tested = claude(["plugin", "test", folder]);
    // A mod with no tests would pass vacuously.
    if (!/\b[1-9]\d* pass\b/.test(tested) || /\b[1-9]\d* fail\b/.test(tested)) throw new Error(`mod ${name} ran no passing tests:\n${tested.trim()}`);
    process.stdout.write(`${name}: valid, ${tested.match(/\b\d+ pass\b/)[0]}\n`);
  }
} catch (error) {
  process.stderr.write(`Mods check failed: ${error.message}\n`);
  process.exitCode = 1;
}
