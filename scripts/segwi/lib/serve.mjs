// Starts the segwi server: refuses a non-loopback bind or an empty allow list
// (and audits the refusal), recovers runs a previous process left active, then
// listens.
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.mjs";
import { createApprovalService } from "./approvals.mjs";
import { assertAuthConfig, createAuthenticator } from "./auth.mjs";
import { assertLoopbackBind, assertPortOutsideWorkflow } from "./bind.mjs";
import { createHandler } from "./http.mjs";
import { createIbniLink } from "./ibni-link.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { createPushService } from "./push.mjs";
import { ensurePrivateDir, stateDir as defaultStateDir } from "./paths.mjs";
import { createRunService } from "./runs.mjs";
import { createBroker } from "./sse.mjs";
import { openStore } from "./store.mjs";
import { createRunner } from "../runners/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC = path.join(here, "..", "web", "dist", "web", "browser");
const version = JSON.parse(readFileSync(path.join(here, "..", "..", "..", "package.json"), "utf8")).version ?? "0.0.0";

/**
 * @param {{ settings: object, dataDir: string, runner?: object, ibni?: object, staticRoot?: string|null, approvalTimeoutMs?: number, settleMs?: number, stateDir?: string, mcpConfirmTtlMs?: number, pushOptions?: { allowEndpoint?: Function, agent?: object, send?: Function } }} options
 *   `runner`, `ibni`, `approvalTimeoutMs`, `settleMs`, `stateDir`, `mcpConfirmTtlMs` and `pushOptions` are injected by tests; the CLI uses the configured runner and the real ibni.
 */
export async function startServer({ settings, dataDir, runner, ibni = createIbniLink(), staticRoot = DEFAULT_STATIC, approvalTimeoutMs, settleMs, stateDir = defaultStateDir(), mcpConfirmTtlMs, pushOptions = {} }) {
  ensurePrivateDir(dataDir);
  const store = openStore(path.join(dataDir, "segwi.db"));
  const { bind, auth, runner: runnerId } = settings.segwi;
  try {
    assertAuthConfig(auth.web);
    assertLoopbackBind(bind.host);
    assertPortOutsideWorkflow(bind.port, settings.workflowPorts);
  } catch (error) {
    audit(store, { actor: "system", origin: "system", action: "server.start", outcome: "rejected", detail: error.message });
    store.close();
    throw error;
  }
  const theRunner = runner ?? createRunner(runnerId, { dataDir, stateDir });
  const broker = createBroker({ store });
  let serverUrl = "";
  const runs = createRunService({ store, settings, runner: theRunner, ibni, broker, serverUrl: () => serverUrl, settleMs });
  const approvals = createApprovalService({ store, settings, runs, broker, timeoutMs: approvalTimeoutMs });
  const push = createPushService({ store, settings, stateDir, ...pushOptions });
  runs.onStatus((status, run) => push.notify(status, run));
  runs.recover();
  const handler = createHandler({
    store, settings, authenticate: createAuthenticator(auth.web), runs, approvals, broker, push,
    staticRoot: staticRoot && readableDir(staticRoot) ? staticRoot : null, version, stateDir,
    mcp: createMcpHandler({ store, settings, runs, approvals, stateDir, confirmTtlMs: mcpConfirmTtlMs }),
  });
  // A request still running when the server closes may find the store shut; it has nobody left to answer.
  const server = http.createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(bind.port, bind.host, resolve);
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  serverUrl = `http://127.0.0.1:${port}`;
  audit(store, { actor: "system", origin: "system", action: "server.start", outcome: "ok", detail: `listening on ${bind.host}:${port}` });
  let closed = false;
  return {
    port, url: serverUrl, store, runs, approvals, push,
    async close() {
      if (closed) return;
      closed = true;
      await runs.shutdown();
      approvals.shutdown();
      broker.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

function readableDir(dir) {
  try {
    readFileSync(path.join(dir, "index.html"));
    return true;
  } catch {
    return false;
  }
}
