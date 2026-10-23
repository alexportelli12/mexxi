#!/usr/bin/env node
// Dev only: the real segwi server on a port you choose, backed by the fake host and
// seeded with a run in every state, a pending approval and audit rows, so every
// screen can be looked at and photographed. Everything lives in a temporary folder
// that is removed on Ctrl+C.
//
//   node scripts/segwi/test/demo-server.mjs [--port 4290]
//
// Build the web app first: npm --prefix scripts/segwi/web run build
import { startHarness } from "./web-harness.mjs";

const flag = process.argv.indexOf("--port");
const port = flag === -1 ? 4290 : Number(process.argv[flag + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write("usage: demo-server.mjs [--port <number>]\n");
  process.exit(2);
}

const harness = await startHarness({ port, seed: true });
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void harness.close().finally(() => process.exit(0));
  });
}
process.stdout.write(`segwi demo on ${harness.url}\nrepositories: ${harness.repos.map((repo) => repo.name).join(", ")}\nPress Ctrl+C to stop; the temporary data is removed.\n`);
