import net from "node:net";
import path from "node:path";
import { WorkspaceError } from "./errors.mjs";
import { run } from "./git.mjs";

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

const blockPorts = ({ first, size }) => Array.from({ length: size }, (_, offset) => first + offset);

// The block a retained workspace holds. Workspaces prepared before blocks
// recorded only their one port.
export function recordedBlock(metadata) {
  if (Number.isInteger(metadata?.ports?.first) && Number.isInteger(metadata.ports.size)) return metadata.ports;
  return Number.isInteger(metadata?.port) ? { first: metadata.port, size: 1 } : null;
}

// The first block of blockSize consecutive ports, aligned from first, that
// overlaps no recorded block and has nothing on this machine listening on it.
// Callers hold the machine-wide ports lock, so two prepares, in any
// repositories, cannot pick the same block.
export async function allocatePortBlock({ first, last, blockSize }, recordedBlocks) {
  const taken = new Set(recordedBlocks.flatMap(blockPorts));
  for (let start = first; start + blockSize - 1 <= last; start += blockSize) {
    const block = { first: start, size: blockSize };
    const ports = blockPorts(block);
    if (ports.some((port) => taken.has(port))) continue;
    if ((await Promise.all(ports.map(portIsFree))).every(Boolean)) return block;
  }
  throw new WorkspaceError(
    `no free block of ${blockSize} ports between ${first} and ${last}`,
    "Clean up retained workspaces with ibni cleanup, or widen workflow.ports in config.json.",
  );
}

// What setup, verify and any server the agent starts see: PORT is the block's
// first port, MEXXI_PORT_<n> each port by offset, and workflow.portVariables
// names the variables a repository already reads (such as a test server's
// port) and the offset each takes. A block of one, from before blocks, has
// only PORT and MEXXI_PORT_0; a mapped offset beyond it is left unset.
export function portEnvironment(block, variables = {}) {
  if (!block) return {};
  const env = { PORT: String(block.first) };
  for (const [offset, port] of blockPorts(block).entries()) env[`MEXXI_PORT_${offset}`] = String(port);
  for (const [name, offset] of Object.entries(variables)) {
    if (offset < block.size) env[name] = String(block.first + offset);
  }
  return env;
}

// The ports of a block something is listening on, so verify can stop with a
// clear message before a test server fails half-way with EADDRINUSE.
export async function busyPorts(block) {
  if (!block) return [];
  const ports = blockPorts(block);
  const free = await Promise.all(ports.map(portIsFree));
  return ports.filter((_, index) => !free[index]);
}

const mappedVariables = (metadata, config) => config.workflow.portVariables[
  metadata.controlWorktreePath ? path.basename(metadata.controlWorktreePath) : null
];

// A session's port variables: its block, with the variables
// workflow.portVariables maps for its repository, keyed by the folder name of
// the control checkout. Read from config at each run, so a mapping added later
// reaches retained workspaces too.
export function sessionPortEnvironment(metadata, config) {
  return portEnvironment(recordedBlock(metadata), mappedVariables(metadata, config));
}

// The environment setup and verify run with: base without any port variable
// it inherited, such as another workspace's portEnv exported in the agent's
// shell or the block of an ibni run this one is nested in, then the session's.
// A variable the session's block cannot hold is then unset, not inherited.
export function sessionRunEnvironment(metadata, config, base = process.env) {
  const owned = new Set(["PORT", ...Object.keys(mappedVariables(metadata, config) ?? {})]);
  const inherited = Object.fromEntries(Object.entries(base).filter(([name]) => !owned.has(name) && !/^MEXXI_PORT_\d+$/.test(name)));
  return { ...inherited, ...sessionPortEnvironment(metadata, config) };
}

// The listening sockets in `ss -ltnpH` output as { port, pid, command }, one
// per process; pid and command are null when ss may not see the owner (a
// process of another user).
export function parseSsListeners(text) {
  const holders = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const port = Number(fields[3].match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port)) continue;
    const users = [...line.matchAll(/\("([^"]*)",pid=(\d+)/g)];
    if (users.length === 0) holders.push({ port, pid: null, command: null });
    for (const [, command, pid] of users) holders.push({ port, pid: Number(pid), command });
  }
  return holders;
}

// `lsof -Fpc` output: a p<pid> line, then c<command> for that process.
export function parseLsofListeners(text, port) {
  const holders = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) holders.push({ port, pid: Number(line.slice(1)), command: null });
    else if (line.startsWith("c") && holders.length) holders.at(-1).command = line.slice(1);
  }
  return holders.filter((holder) => Number.isInteger(holder.pid));
}

const unique = (holders) => [...new Map(holders.map((holder) => [`${holder.port}:${holder.pid}`, holder])).values()];

// Who listens on each busy port, so a refusal can name what to stop: ss on
// Linux, lsof where ss is missing or cannot see the owner. holders is null,
// with a reason, when neither tool can say.
export async function portHolders(ports, { runCommand = run } = {}) {
  const found = [];
  const reasons = [];
  try {
    const { stdout } = await runCommand("ss", ["-ltnpH"], { timeout: 5_000 });
    found.push(...parseSsListeners(stdout).filter((holder) => ports.includes(holder.port) && holder.pid !== null));
  } catch (error) {
    reasons.push(`ss: ${error.message.split("\n")[0]}`);
  }
  for (const port of ports.filter((candidate) => !found.some((holder) => holder.port === candidate))) {
    try {
      // lsof exits 1 when it finds nothing.
      const { stdout } = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { timeout: 5_000, allowedExitCodes: [0, 1] });
      found.push(...parseLsofListeners(stdout, port));
    } catch (error) {
      reasons.push(`lsof: ${error.message.split("\n")[0]}`);
    }
  }
  if (found.length === 0) return { holders: null, reason: reasons.length ? reasons.join("; ") : "neither ss nor lsof could see the process (it may belong to another user)" };
  return { holders: unique(found), reason: null };
}

// "port 4551 is held by node (pid 1234)", for each busy port.
export function describeHolders(busy, holders) {
  return busy.map((port) => {
    const owners = (holders ?? []).filter((holder) => holder.port === port);
    if (owners.length === 0) return `port ${port} is held by a process ibni cannot name`;
    return `port ${port} is held by ${owners.map((owner) => `${owner.command ?? "an unnamed process"} (pid ${owner.pid})`).join(" and ")}`;
  }).join("; ");
}
