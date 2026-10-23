#!/usr/bin/env node
// The audit check: known vulnerabilities in what ships. It audits the server's
// dependencies at the repository root and the web app's, and fails on a high or
// critical finding. It needs the network and fails loudly when the registry is out of reach.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directories = [new URL("../../", import.meta.url), new URL("./web/", import.meta.url)];
let failed = false;
for (const directory of directories) {
  const cwd = fileURLToPath(directory);
  process.stdout.write(`npm audit in ${cwd}\n`);
  const { status } = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high"], { cwd, stdio: "inherit" });
  if (status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
