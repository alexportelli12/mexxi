import net from "node:net";
import { WorkspaceError } from "./errors.mjs";

// Only EADDRINUSE means another process holds the port; a host without IPv6
// reports a different error for "::" and still has the port free.
function bindable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => resolve(error.code !== "EADDRINUSE"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function portIsFree(port) {
  return await bindable(port, "127.0.0.1") && await bindable(port, "::");
}

// The first port in the configured range that no retained workspace has
// recorded and nothing on this machine is listening on. Callers hold the
// repository lock, so two prepares in one repository cannot pick the same port;
// simultaneous prepares in different repositories could, which is rare enough
// not to warrant a machine-wide lock.
export async function allocatePort({ first, last }, recordedPorts) {
  if (first > last) {
    throw new WorkspaceError("workflow.ports is empty", `first (${first}) is above last (${last}) in config.json.`);
  }
  const taken = new Set(recordedPorts);
  for (let port = first; port <= last; port += 1) {
    if (!taken.has(port) && await portIsFree(port)) return port;
  }
  throw new WorkspaceError(
    `no free port between ${first} and ${last}`,
    "Clean up retained workspaces with ibni cleanup, or widen workflow.ports in config.json.",
  );
}
