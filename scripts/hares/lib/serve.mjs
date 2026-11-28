// Starts the hares server: refuses a non-loopback bind or an empty allow list
// (and audits the refusal), connects to herdr (read-only until a person acts),
// follows the sessions and the hook's records, then listens.
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.mjs";
import { createHookApprovals } from "./approvals.mjs";
import { assertAuthConfig, createAuthenticator } from "./auth.mjs";
import { assertLoopbackBind, assertPortOutsideWorkflow } from "./bind.mjs";
import { createHandler } from "./http.mjs";
import { closeExtensions, loadExtensions } from "./extensions.mjs";
import { createGithubBoard } from "./github-board.mjs";
import { createGithubWriter, runGh } from "./github-write.mjs";
import { slugForRepository } from "./github.mjs";
import { createHerdrAdapter } from "./herdr/adapter.mjs";
import { createIbniLink } from "./ibni-link.mjs";
import { defaultSocket } from "./herdr/client.mjs";
import { createLinkResolver } from "./links.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { createNotifier } from "./notify.mjs";
import { createPushService } from "./push.mjs";
import { ensurePrivateDir, stateDir as defaultStateDir } from "./paths.mjs";
import { createReadinessService } from "./readiness.mjs";
import { createRunView } from "./run-view.mjs";
import { createSessionStream } from "./session-stream.mjs";
import { createSessionService } from "./sessions.mjs";
import { openStore } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC = path.join(here, "..", "web", "dist", "web", "browser");
const version = JSON.parse(readFileSync(path.join(here, "..", "..", "..", "package.json"), "utf8")).version ?? "0.0.0";
const DAY_MS = 24 * 60 * 60 * 1000;
const LINK_REFRESH_MS = 60_000;
const WORKSPACE_KEY = "herdr.workspace";

/** Where ħares keeps the id of the herdr workspace it opens new tabs in (guard.mjs workspaceStore). */
function workspaceStoreFor(store) {
  const get = store.db.prepare("SELECT value FROM meta WHERE key = ?");
  const set = store.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  return { get: () => get.get(WORKSPACE_KEY)?.value ?? null, set: (id) => set.run(WORKSPACE_KEY, id) };
}

/**
 * Which session made which pull request, and which issue a session works on, from the links ħares
 * derives by evidence (links.mjs). Refreshed in the background, so readiness and the board can ask
 * synchronously. It is also readiness.mjs's store interface: sessionForPr, sessionFacts,
 * gateAcceptance and acceptGateChange, over store.mjs and the session service.
 *
 * sessionFacts carries ibni's snapshot of the workspace a session works in (the worktree its folder is in),
 * read through ibni-link.mjs on each refresh, for the sessions linked to a pull request: readiness's
 * reviewed-head and review-findings-closed checks read it. `ibni` is injected by tests.
 */
export function createLinkIndex({ sessions, store, approvals, settings, ibni = createIbniLink(), log = () => {} }) {
  const links = new Map();
  let snapshots = new Map();
  let latest = new Map();
  let timer = null;
  let running = null;

  async function refresh() {
    if (running) return running;
    running = (async () => {
      try {
        const list = await sessions.list();
        latest = new Map(list.map((session) => [session.id, session]));
        for (const session of list) {
          if (!session.repo || !/^[0-9a-f-]{36}$/i.test(session.id)) continue;
          try {
            links.set(session.id, (await sessions.get(session.id, { limit: 0 })).links);
          } catch (error) {
            log(`links for ${session.id}: ${error.message}`);
          }
        }
        snapshots = await snapshotsFor(list);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** ibni's snapshot per session linked to a pull request, from the ibni workspace whose worktree holds the session's folder. */
  async function snapshotsFor(list) {
    const found = new Map();
    const byRepo = new Map();
    for (const session of list) {
      if (!session.cwd || !links.get(session.id)?.pull) continue;
      byRepo.set(session.repo, [...(byRepo.get(session.repo) ?? []), session]);
    }
    for (const [repo, group] of byRepo) {
      const repository = settings.hares.repositories.find((candidate) => candidate.name === repo);
      if (!repository) continue;
      let workspaces;
      try {
        workspaces = await ibni.list(repository.path);
      } catch (error) {
        log(`ibni list in ${repo}: ${error.message}`);
        continue;
      }
      for (const session of group) {
        const workspace = workspaces.find((entry) => typeof entry?.worktreePath === "string" && typeof entry.sessionId === "string"
          && (session.cwd === entry.worktreePath || session.cwd.startsWith(entry.worktreePath + path.sep)));
        if (!workspace) continue;
        try {
          found.set(session.id, (await ibni.summary(repository.path, workspace.sessionId)).snapshot ?? null);
        } catch (error) {
          log(`ibni info for ${session.id}: ${error.message}`);
        }
      }
    }
    return found;
  }

  const sessionWhere = (test) => {
    for (const [id, linked] of links) {
      const session = latest.get(id);
      if (session && test(session, linked)) return id;
    }
    return null;
  };

  return {
    refresh,
    linksOf: (id) => links.get(id) ?? null,
    session: (id) => (id ? latest.get(id) ?? null : null),
    sessionForPr: (repo, number) => sessionWhere((session, linked) => session.repo === repo && linked?.pull?.number === number),
    sessionForIssue: (repo, number) => sessionWhere((session, linked) => session.repo === repo && linked?.issue?.number === number),
    sessionFacts(sessionId) {
      const session = latest.get(sessionId);
      if (!session) return null;
      const state = session.alive ? session.status : "closed";
      return { state, snapshot: snapshots.get(sessionId) ?? null, pendingPermissions: approvals.forSession(sessionId).length };
    },
    gateAcceptance: (repo, number, headSha) => store.prGateAcceptance(repo, number, headSha),
    acceptGateChange: (fields) => store.acceptPrGateChange(fields),
    start() {
      void refresh().catch(() => {});
      timer = setInterval(() => void refresh().catch(() => {}), LINK_REFRESH_MS);
      timer.unref();
      const off = [sessions.on("session.changed", ({ initial }) => { if (!initial) void refresh().catch(() => {}); })];
      return () => { clearInterval(timer); off.forEach((stop) => stop()); };
    },
  };
}

/**
 * @param {{ settings: object, dataDir: string, staticRoot?: string|null, stateDir?: string, mcpConfirmTtlMs?: number,
 *   pushOptions?: { allowEndpoint?: Function, agent?: object, send?: Function }, githubFetch?: typeof fetch,
 *   herdrSocket?: string, adapterOptions?: object, home?: string, pendingOptions?: object, ghExec?: Function,
 *   checkout?: Function, notifyPollMs?: number, now?: () => Date }} options
 *   herdrSocket, adapterOptions, home, pendingOptions, ghExec, checkout, notifyPollMs, now, stateDir, mcpConfirmTtlMs,
 *   pushOptions and githubFetch are injected by tests (a fake herdr, a temp HOME, a fake gh); the CLI uses the real ones.
 */
export async function startServer({
  settings, dataDir, staticRoot = DEFAULT_STATIC, stateDir = defaultStateDir(), mcpConfirmTtlMs, pushOptions = {}, githubFetch = globalThis.fetch,
  herdrSocket = defaultSocket(), adapterOptions = {}, home = os.homedir(), pendingOptions = {}, ghExec = runGh, checkout, notifyPollMs, now = () => new Date(),
}) {
  ensurePrivateDir(dataDir);
  const store = openStore(path.join(dataDir, "segwi.db"));
  const { bind, auth } = settings.hares;
  try {
    assertAuthConfig(auth.web);
    assertLoopbackBind(bind.host);
    assertPortOutsideWorkflow(bind.port, settings.workflowPorts);
  } catch (error) {
    audit(store, { actor: "system", origin: "system", action: "server.start", outcome: "rejected", detail: error.message });
    store.close();
    throw error;
  }
  const log = (message) => console.error(`hares: ${message}`);
  const adapter = createHerdrAdapter({ socket: herdrSocket, workspaceStore: workspaceStoreFor(store), log, ...adapterOptions });
  // herdr may be down: the server still starts, shows it, and reconnects with backoff.
  await adapter.connect().catch((error) => log(`herdr is not reachable yet: ${error.message}`));

  const repoOf = (name) => settings.hares.repositories.find((repository) => repository.name === name);
  const slugFor = async (repoOrRepository) => slugForRepository(typeof repoOrRepository === "string" ? repoOf(repoOrRepository) : repoOrRepository);
  const push = createPushService({ store, settings, stateDir, ...pushOptions });
  let sessions = null;
  let notifier = null;
  const approvals = createHookApprovals({
    store, adapter, settings, home,
    repoForSession: (sessionId) => linkIndex?.session(sessionId)?.repo ?? "",
    // The push for a permission goes out with the question's own "asks" event, so this one is only counted.
    notify: () => {},
  });
  let readiness = null;
  const board = createGithubBoard({
    settings, stateDir, fetch: githubFetch,
    readiness: { forPr: (target) => readiness.forPr(target) },
    linkedSession: ({ repo, number }) => linkIndex?.sessionForPr(repo, number) ?? null,
  });
  const links = createLinkResolver({
    slugFor: async (repo) => slugFor(repo),
    findPullsForBranch: async ({ repo, branch }) => {
      const pull = await board.prForBranch(repo, branch);
      return pull ? [{ ...pull, headRefName: branch }] : [];
    },
  });
  sessions = createSessionService({
    adapter, store, settings, approvals, links, home, pendingOptions, slugFor, ...(checkout ? { checkout } : {}), now, log,
  });
  const linkIndex = createLinkIndex({ sessions, store, approvals, settings, log });
  readiness = createReadinessService({ store: linkIndex, settings, stateDir, fetch: githubFetch });
  const writer = createGithubWriter({
    settings, exec: ghExec,
    audit: ({ action, target, actor, outcome }) => audit(store, { actor: actor ?? "unknown", origin: "web", action, target, outcome }),
  });
  notifier = createNotifier({ store, push, settings, sessions, board, now, ...(notifyPollMs ? { pollMs: notifyPollMs } : {}), log });
  const stream = createSessionStream({ sessions, now });
  const stopWatching = sessions.watch();
  await sessions.sync().catch((error) => log(`first session sync failed: ${error.message}`));
  const stopLinks = linkIndex.start();
  const stopNotify = notifier.start();
  // Activity keeps 90 days: purge once at start, then daily (the audit trigger refuses anything younger).
  const purge = () => {
    try {
      const removed = store.purgeAudit();
      if (removed) audit(store, { actor: "system", origin: "system", action: "audit.purged", outcome: "ok", detail: `${removed} rows older than 90 days` });
    } catch (error) {
      log(`audit purge failed: ${error.message}`);
    }
  };
  purge();
  const purgeTimer = setInterval(purge, DAY_MS);
  purgeTimer.unref();

  const runs = createRunView({ sessions, store, settings, ...(checkout ? { checkout } : {}) });
  const extensions = await loadExtensions(settings.hares.extensions ?? [], { dataDir, settings });
  const handler = createHandler({
    extensions, store, settings, authenticate: createAuthenticator(auth.web), sessions, approvals, readiness, board, writer, notifier, push, stream,
    herdr: adapter, linkIndex, staticRoot: staticRoot && readableDir(staticRoot) ? staticRoot : null, version, ...(checkout ? { checkout } : {}),
    mcp: createMcpHandler({ store, settings, runs, approvals: { list: (query) => approvals.list(query) }, readiness, github: board, stateDir, confirmTtlMs: mcpConfirmTtlMs }),
  });
  // A request still running when the server closes may find the store shut; it has nobody left to answer.
  const server = http.createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(bind.port, bind.host, resolve);
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const serverUrl = `http://127.0.0.1:${port}`;
  audit(store, { actor: "system", origin: "system", action: "server.start", outcome: "ok", detail: `listening on ${bind.host}:${port}` });
  let closed = false;
  return {
    port, url: serverUrl, store, sessions, approvals, push, notifier, adapter, linkIndex, board,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(purgeTimer);
      stopNotify();
      stopLinks();
      stopWatching();
      stream.close();
      adapter.close();
      await closeExtensions(extensions);
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
