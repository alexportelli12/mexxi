// segwi listens on loopback only, in both auth modes: anything else would
// expose a launcher for coding agents beyond this machine. Remote access goes
// through `tailscale serve`, which proxies to loopback.
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class BindRefusedError extends Error {
  constructor(host) {
    super(`segwi only listens on loopback (127.0.0.1, ::1 or localhost), not ${host}. Reach it from other devices with tailscale serve.`);
    this.name = "BindRefusedError";
  }
}

export function assertLoopbackBind(host) {
  if (!LOOPBACK_HOSTS.has(host)) throw new BindRefusedError(host);
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export class PortCollisionError extends Error {
  constructor(port, { first, last }) {
    super(`segwi.bind.port ${port} is inside workflow.ports (${first}-${last}), which dev servers use and the run's browser is blocked from. Pick a port outside it.`);
    this.name = "PortCollisionError";
  }
}

export function assertPortOutsideWorkflow(port, range) {
  if (range && port >= range.first && port <= range.last) throw new PortCollisionError(port, range);
}
