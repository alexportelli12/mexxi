// A loopback proxy that adds the sandbox proxy's credentials to each request. Inside Claude Code's sandbox every
// connection out goes through a proxy whose URL carries a username and password, which Chromium can't send: it
// answers every page with 407 Proxy Authentication Required. The run's browser launcher (bin/chromium.mjs) points
// the browser here instead. The relay reaches only what the sandbox proxy allows, with the credentials every
// command in the sandbox already holds, so it widens nothing.
import http from "node:http";
import net from "node:net";

/** The Proxy-Authorization header for a proxy URL's credentials, or null when it has none. */
export function proxyAuthorization(proxyUrl) {
  const url = new URL(proxyUrl);
  if (!url.username && !url.password) return null;
  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/** The proxy a sandboxed command is told to use, from its environment, or null. */
export function proxyFromEnv(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
}

/**
 * Starts the relay on 127.0.0.1 in front of `upstreamUrl`. It tunnels CONNECT (HTTPS) and forwards plain HTTP
 * requests, adding the upstream's credentials to both. Resolves to its port and a close function.
 */
export async function startProxyRelay(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  const upstreamHost = upstream.hostname.replace(/^\[|\]$/g, "");
  const upstreamPort = Number(upstream.port) || 80;
  const authorization = proxyAuthorization(upstreamUrl);
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };

  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, ...(authorization ? { "proxy-authorization": authorization } : {}) };
    const forward = http.request({ host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forward);
  });

  server.on("connect", (req, client, head) => {
    track(client);
    const tunnel = track(net.connect(upstreamPort, upstreamHost));
    const lines = [`CONNECT ${req.url} HTTP/1.1`, `Host: ${req.url}`, ...(authorization ? [`Proxy-Authorization: ${authorization}`] : [])];
    tunnel.once("connect", () => {
      tunnel.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) tunnel.write(head);
      // The upstream's own answer (200, or 403 for a host the sandbox refuses) reaches the browser unchanged.
      tunnel.pipe(client);
      client.pipe(tunnel);
    });
    const end = () => {
      tunnel.destroy();
      client.destroy();
    };
    tunnel.on("error", end);
    client.on("error", end);
  });
  server.on("connection", track);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      sockets.forEach((socket) => socket.destroy());
      server.close(() => resolve());
    }),
  };
}
