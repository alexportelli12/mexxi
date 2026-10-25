// The node:http router: /api is JSON only and audited; everything else is the
// built web app (or a one-line 503 until it is built). Bodies are never logged.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROXY_HEADERS, RUN_BROWSER_MARK, assertSameOriginWrite } from "./auth.mjs";
import { isLoopbackAddress } from "./bind.mjs";
import { audit } from "./audit.mjs";
import { canaryHealth } from "./canary-state.mjs";
import { HttpError } from "./errors.mjs";
import { parse, schemas as schemasFor } from "./validate.mjs";

const BODY_LIMIT = 64 * 1024;
// The approver forwards a whole tool input (a Write can carry a file), so its route allows more.
const INTERNAL_BODY_LIMIT = 1024 * 1024;
// No inline script or style: the web build turns Angular's critical-CSS inlining off instead of loosening this.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const NOT_BUILT = "Build the web app: npm --prefix scripts/segwi/web run build\n";
// segwi's colours and type, for extension pages (decision 0020).
const TOKENS = fileURLToPath(new URL("../../../site/tokens.css", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
  ".mjs": "text/javascript; charset=utf-8", ".jpg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

export async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request body is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The body is not valid JSON.");
  }
}

function cacheHeaders(file) {
  const name = path.basename(file);
  if (name === "sw.js") return { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" };
  return { "Cache-Control": name === "index.html" || name.endsWith(".webmanifest") ? "no-cache" : "public, max-age=3600" };
}

async function serveStatic(res, root, pathname) {
  if (!root) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(NOT_BUILT);
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request.\n");
    return;
  }
  const requested = path.normalize(path.join(root, decoded));
  let file = requested.startsWith(`${root}${path.sep}`) ? requested : path.join(root, "index.html");
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    file = path.join(root, "index.html"); // single-page app fallback
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", ...cacheHeaders(file) });
    res.end(body);
  } catch {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(NOT_BUILT);
  }
}

/**
 * @param {{ store: object, settings: object, authenticate: Function, runs: object, approvals: object, broker: object, push: object, staticRoot: string|null, version: string, mcp?: Function|null, stateDir?: string|null }} deps
 */
export function createHandler({ store, settings, authenticate, runs, approvals, broker, push, staticRoot, version, mcp = null, stateDir = null, extensions = [] }) {
  const parsers = schemasFor(settings);
  const routes = [
    ["GET", "/api/health", "none", async () => ({ ...(await runs.health(version)), canary: canaryHealth(stateDir) })],
    ["GET", "/api/repos", "none", async () => ({ repos: await runs.repos() })],
    ["GET", "/api/runs", "listRuns", async ({ query }) => ({ runs: runs.list({ status: query.status, repo: query.repo, limit: query.limit }) })],
    ["POST", "/api/runs", "createRun", async ({ body }) => {
      const { run, created } = await runs.create(body);
      return { status: created ? 201 : 200, body: { run } };
    }],
    ["GET", "/api/runs/:id", "none", async ({ params }) => ({ run: runs.get(params.id) })],
    ["GET", "/api/runs/:id/events", "events", async ({ params, query }) => ({ events: runs.events(params.id, query.since) })],
    ["POST", "/api/runs/:id/input", "input", async ({ params, body }) => ({ run: runs.send(params.id, body.text) })],
    ["POST", "/api/runs/:id/stop", "stop", async ({ params }) => ({ run: runs.stop(params.id) })],
    ["GET", "/api/approvals", "listApprovals", async ({ query }) => ({ approvals: approvals.list({ status: query.status }) })],
    // Nothing here tells a phone from this machine: a forwarded address is easy to forge. A run's browser
    // is refused (RUN_BROWSER_MARK) and MCP clients never get here, but a command a run runs is a process of
    // yours, as in a session you start by hand, and could reach this port as you can (decision 0016).
    ["POST", "/api/approvals/:id", "decideApproval", async ({ params, body, identity }) => ({ approval: approvals.decide(params.id, body.decision, identity) })],
    ["GET", "/api/push/key", "none", async () => {
      const publicKey = push.publicKey();
      if (!publicKey) throw new HttpError(404, push.setupProblem() ?? "Push isn't set up.");
      return { publicKey };
    }],
    ["POST", "/api/push/subscriptions", "pushSubscription", async ({ body, identity }) => {
      const id = push.subscribe(body, identity);
      // Only the push service's host is recorded; the endpoint itself identifies the device.
      return { status: 201, body: { id }, detail: new URL(body.endpoint).host };
    }],
    ["DELETE", "/api/push/subscriptions/:id", "none", async ({ params }) => {
      push.unsubscribe(params.id);
      return { status: 204 };
    }],
    ["GET", "/api/audit", "audit", async ({ query }) => ({ audit: store.listAudit(query.limit ?? 50) })],
    ["GET", "/api/extensions", "none", async () => ({ extensions: extensions.map(({ name, title }) => ({ name, title, url: `/ext/${name}/` })) })],
  ].map(([method, template, schema, handler]) => ({
    method, template, schema, handler,
    regex: new RegExp(`^${template.replace(/:(\w+)/g, "(?<$1>[0-9a-f-]{1,64})")}$`),
  }));

  async function handleApi(req, res, url) {
    let identity = "anonymous";
    let template = `${req.method} ${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`;
    let target = "";
    try {
      identity = authenticate(req);
      if (url.pathname === "/api/stream" && req.method === "GET") {
        template = "GET /api/stream";
        audit(store, { actor: identity, origin: "web", action: template, outcome: "ok" });
        broker.handle(req, res);
        return;
      }
      const matches = routes.map((candidate) => ({ candidate, match: candidate.regex.exec(url.pathname) })).filter((entry) => entry.match);
      if (!matches.length) throw new HttpError(404, "No such route.");
      const route = matches.find((entry) => entry.candidate.method === req.method);
      if (!route) throw new HttpError(405, "That method is not allowed here.");
      template = `${req.method} ${route.candidate.template}`;
      target = route.match.groups?.id ?? "";
      let body = {};
      if (req.method === "POST" || req.method === "DELETE") assertSameOriginWrite(req, { json: req.method === "POST" });
      if (req.method === "POST") body = parse(parsers[route.candidate.schema], await readBody(req));
      const query = req.method === "GET" ? parse(parsers[route.candidate.schema], Object.fromEntries(url.searchParams)) : {};
      const result = await route.candidate.handler({ params: route.match.groups ?? {}, query, body, req, identity });
      const status = result.status ?? 200;
      audit(store, { actor: identity, origin: "web", action: template, target, outcome: "ok", detail: result.detail ?? "" });
      if (status === 204) res.writeHead(204, { "Cache-Control": "no-store" }).end();
      else sendJson(res, status, result.body ?? result);
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error(`segwi: ${template}: ${error.stack ?? error}`);
      const status = known ? error.status : 500;
      // Only the reason is audited, never the request body.
      audit(store, { actor: identity, origin: "web", action: template, target, outcome: known ? error.outcome : "error", detail: known ? `${status} ${error.message}` : "500 internal error" });
      if (!res.headersSent) sendJson(res, status, { error: known ? error.message : "Something went wrong on the server." });
      else res.end();
    }
  }

  // The approver process's door: loopback and the run's own secret only. It is a separate
  // prefix with its own check, so neither the web identity nor an MCP client can use it.
  async function handleInternal(req, res, url) {
    const template = `${req.method} ${url.pathname}`;
    const fail = (error) => {
      const known = error instanceof HttpError;
      if (!known) console.error(`segwi: ${template}: ${error.stack ?? error}`);
      audit(store, { actor: "approver", origin: "system", action: template, outcome: known ? error.outcome : "error", detail: known ? `${error.status} ${error.message}` : "500 internal error" });
      if (!res.headersSent) sendJson(res, known ? error.status : 500, { error: known ? error.message : "Something went wrong on the server." });
    };
    try {
      if (url.pathname !== "/internal/approvals" || req.method !== "POST") throw new HttpError(404, "No such route.");
      if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, "Only loopback connections are accepted.");
      // The approver talks to the server directly; a proxied request (tailscale serve) is never one of its calls.
      if (PROXY_HEADERS.some((name) => req.headers[name] !== undefined)) throw new HttpError(403, "Proxied requests cannot reach the approval tool's route.");
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!bearer) throw new HttpError(401, "A run secret is required.");
      const body = parse(parsers.internalApproval, await readBody(req, INTERNAL_BODY_LIMIT));
      const controller = new AbortController();
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      const answer = await approvals.request({ runId: body.runId, toolName: body.toolName, input: body.input, toolUseId: body.toolUseId, bearer, signal: controller.signal });
      sendJson(res, 200, answer);
    } catch (error) {
      fail(error);
    }
  }

  // An extension's API answers like segwi's own: the same identity, the same
  // same-origin rule for writes, and an audit line naming the extension's route.
  // A GET is refused when another site's page sent it, too: the identity
  // comes with every request tailscale serve forwards, so an <img> on any
  // page you open could otherwise call a route that changes something.
  async function handleExtensionApi(req, res, extension, routePath, identity) {
    const template = `${req.method} /ext/${extension.name}/api${routePath}`.slice(0, 200);
    try {
      if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])) throw new HttpError(403, "Another site's page can't call an extension.");
      const handler = extension.routes.get(`${req.method} ${routePath}`);
      if (!handler) throw new HttpError(extension.routes.has(`${req.method === "GET" ? "POST" : "GET"} ${routePath}`) ? 405 : 404, "No such route.");
      let body = {};
      if (req.method === "POST") {
        assertSameOriginWrite(req, { json: true });
        body = await readBody(req);
      }
      const result = await handler({ query: Object.fromEntries(new URL(req.url ?? "/", "http://localhost").searchParams), body, identity });
      audit(store, { actor: identity, origin: "web", action: template, outcome: "ok" });
      sendJson(res, 200, result ?? {});
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error(`segwi: ${template}: ${error.stack ?? error}`);
      audit(store, { actor: identity, origin: "web", action: template, outcome: known ? error.outcome : "error", detail: known ? `${error.status} ${error.message}` : "500 internal error" });
      if (!res.headersSent) sendJson(res, known ? error.status : 500, { error: known ? error.message : "Something went wrong in the extension." });
      else res.end();
    }
  }

  async function serveExtensionFile(res, root, relative) {
    let decoded;
    try {
      decoded = decodeURIComponent(relative || "index.html");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const file = path.normalize(path.join(root, decoded));
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const target = (await stat(file)).isDirectory() ? path.join(file, "index.html") : file;
      const body = await readFile(target);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found.\n");
    }
  }

  // Sign-in comes first, so nobody without it learns which extensions exist.
  async function handleExtension(req, res, url) {
    let identity;
    try {
      identity = authenticate(req);
    } catch (error) {
      return res.writeHead(error.status ?? 403, { "Content-Type": "text/plain; charset=utf-8" }).end(`${error.message}\n`);
    }
    const [, name, ...rest] = url.pathname.split("/").slice(1);
    if (url.pathname === "/ext/tokens.css" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": TYPES[".css"], "Cache-Control": "no-cache" });
      return res.end(await readFile(TOKENS));
    }
    const extension = extensions.find((candidate) => candidate.name === name);
    if (!extension) return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No such extension.\n");
    if (rest[0] === "api") return handleExtensionApi(req, res, extension, `/${rest.slice(1).join("/")}`, identity);
    if (rest.length === 0) return res.writeHead(308, { Location: `/ext/${name}/` }).end();
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    return serveExtensionFile(res, extension.root, rest.join("/"));
  }

  return async function handler(req, res) {
    securityHeaders(res);
    // A run's own browser must never use the app, the API or MCP, or it could approve its own calls.
    if (String(req.headers["user-agent"] ?? "").includes(RUN_BROWSER_MARK)) {
      audit(store, { actor: "anonymous", origin: "web", action: `${req.method} ${new URL(req.url ?? "/", "http://localhost").pathname.slice(0, 100)}`, outcome: "rejected", detail: "403 a run's own browser" });
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("A run's own browser can't use segwi.\n");
      return undefined;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (url.pathname === "/mcp") return mcp ? mcp(req, res) : res.writeHead(404).end();
    if (url.pathname === "/internal" || url.pathname.startsWith("/internal/")) return handleInternal(req, res, url);
    if (url.pathname.startsWith("/ext/")) return handleExtension(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return undefined;
    }
    try {
      authenticate(req); // the app shell is behind the same identity check as the API
    } catch (error) {
      res.writeHead(error.status ?? 403, { "Content-Type": "text/plain; charset=utf-8" }).end(`${error.message}\n`);
      return undefined;
    }
    try {
      return await serveStatic(res, staticRoot, url.pathname);
    } catch {
      res.writeHead(400).end();
      return undefined;
    }
  };
}
