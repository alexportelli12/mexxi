#!/usr/bin/env node
// One-release alias: the CLI is now ibni (scripts/ibni/). This module keeps
// `node scripts/implementation-workspace.mjs`, and the Windows wrapper the
// installer writes for implementation-workspace.cmd, working until it goes.
import { pathToFileURL } from "node:url";
import { main } from "./ibni/ibni.mjs";

export * from "./ibni/ibni.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
