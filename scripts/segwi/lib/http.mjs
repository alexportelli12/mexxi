// The node:http router: /api is JSON only and audited; everything else is the
// built web app (or a one-line 503 until it is built). Bodies are never logged.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertSameOriginWrite } from "./auth.mjs";
import { audit } from "./audit.mjs";
import { HttpError } from "./errors.mjs";
import { parse, schemas as schemasFor } from "./validate.mjs";

const BODY_LIMIT = 64 * 1024;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "The request body is too large.");
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

async function serveStatic(res, root, pathname) {
  if (!root) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("The segwi web app is not built yet.\n");
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
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    res.end(body);
  } catch {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("The segwi web app is not built yet.\n");
  }
}

/**
 * @param {{ store: object, settings: object, authenticate: Function, runs: object, broker: object, staticRoot: string|null, version: string }} deps
 */
export function createHandler({ store, settings, authenticate, runs, broker, staticRoot, version }) {
  const parsers = schemasFor(settings);
  const routes = [
    ["GET", "/api/health", "none", async () => runs.health(version)],
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
    ["GET", "/api/audit", "audit", async ({ query }) => ({ audit: store.listAudit(query.limit ?? 50) })],
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
      if (req.method === "POST") {
        assertSameOriginWrite(req);
        body = parse(parsers[route.candidate.schema], await readBody(req));
      }
      const query = req.method === "GET" ? parse(parsers[route.candidate.schema], Object.fromEntries(url.searchParams)) : {};
      const result = await route.candidate.handler({ params: route.match.groups ?? {}, query, body });
      const status = result.status ?? 200;
      audit(store, { actor: identity, origin: "web", action: template, target, outcome: "ok" });
      sendJson(res, status, result.body ?? result);
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

  return async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
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
