// Who may use the web app. Both modes require a loopback peer. A request that a
// proxy forwarded (tailscale serve sets identity headers) is never treated as
// local, and a Host that is not a loopback name is refused so a page on another
// site cannot reach the API through DNS rebinding.
import os from "node:os";
import { isLoopbackAddress } from "./bind.mjs";
import { HttpError } from "./errors.mjs";

const PROXY_HEADERS = ["tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "forwarded"];
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class AuthConfigError extends Error {}

export function assertAuthConfig(web) {
  if (web.mode === "tailscale-header" && web.allowed.length === 0) {
    throw new AuthConfigError("segwi auth.web.mode is tailscale-header but auth.web.allowed is empty, so nobody could sign in. List the identities allowed.");
  }
}

function hostName(host = "") {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/** Returns the identity, or throws an HttpError (401 or 403). */
export function createAuthenticator(web) {
  const allowed = new Set(web.allowed.map((entry) => entry.toLowerCase()));
  const header = web.header.toLowerCase();
  return function authenticate(req) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, "Only loopback connections are accepted.");
    if (web.mode === "localhost-only") {
      const proxied = PROXY_HEADERS.find((name) => req.headers[name] !== undefined);
      if (proxied) throw new HttpError(403, `A proxied request is not local (${proxied} is set); use tailscale-header mode.`);
      if (!LOOPBACK_NAMES.has(hostName(req.headers.host).toLowerCase())) throw new HttpError(403, "The Host header is not a loopback name.");
      return "local";
    }
    const identity = req.headers[header];
    if (typeof identity !== "string" || identity === "") throw new HttpError(401, `The ${web.header} header is missing.`);
    if (!allowed.has(identity.toLowerCase())) throw new HttpError(403, "That identity is not allowed.");
    return identity;
  };
}

/** Writes must come from the app's own origin, as JSON. */
export function assertSameOriginWrite(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const sameOrigin = origin !== undefined
    ? host !== undefined && (origin === `http://${host}` || origin === `https://${host}`)
    : req.headers["sec-fetch-site"] === "same-origin";
  if (!sameOrigin) throw new HttpError(403, "Writes must come from the app's own origin.");
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Send the body as application/json.");
  }
}

const normaliseAddress = (address) => address.trim().replace(/^::ffff:/i, "").replace(/%.*$/, "").toLowerCase();

/**
 * For decisions only (approving a call). Behind tailscale serve, a request from a
 * browser on this machine still carries the owner's identity, so the agent could
 * answer its own approval. The forwarded client address must be another device.
 * localhost-only mode trusts everyone on this machine and allows decisions.
 */
export function assertNotFromThisMachine(req, mode, interfaces = os.networkInterfaces()) {
  if (mode !== "tailscale-header") return;
  const refusal = new HttpError(403, "Approvals can't be answered from the machine the agent runs on. Use your phone or another device.");
  const forwarded = req.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0] : "";
  if (!first.trim()) throw refusal;
  const client = normaliseAddress(first);
  const own = Object.values(interfaces).flat().filter(Boolean).map((entry) => normaliseAddress(entry.address));
  if (own.includes(client)) throw refusal;
}
