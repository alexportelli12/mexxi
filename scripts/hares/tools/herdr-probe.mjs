#!/usr/bin/env node
// A read-only look at herdr, for proving the adapter against a live server:
//   node scripts/hares/tools/herdr-probe.mjs [--socket <path>] [--pane <pane_id>] [--lines <n>]
// Prints ping and every agent herdr lists; with --pane, also pane.read
// (detection and visible), agent.explain and what screen.mjs makes of the screen.
// It uses herdrRequest, which refuses anything but a read, so it cannot type
// into, start or close a pane.
import { parseArgs } from "node:util";
import { defaultSocket, HERDR_PROTOCOL, herdrRequest } from "../lib/herdr/client.mjs";
import { parseScreen } from "../lib/herdr/screen.mjs";

const { values } = parseArgs({
  options: { socket: { type: "string" }, pane: { type: "string" }, lines: { type: "string" }, help: { type: "boolean", short: "h" } },
});
if (values.help) {
  process.stdout.write("Usage: herdr-probe [--socket <path>] [--pane <pane_id>] [--lines <n>]\n");
  process.exit(0);
}
const socket = values.socket ?? defaultSocket();
const ask = (method, params = {}) => herdrRequest(method, params, { socket });
const print = (title, value) => process.stdout.write(`== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\n`);

try {
  const pong = await ask("ping");
  print("ping", { version: pong.version, protocol: pong.protocol, pinned: pong.protocol === HERDR_PROTOCOL });
  const { agents } = await ask("agent.list");
  print("agent.list", agents.map((agent) => ({
    pane_id: agent.pane_id, terminal_id: agent.terminal_id, agent: agent.agent ?? null, agent_status: agent.agent_status,
    state_change_seq: agent.state_change_seq ?? null, session: agent.agent_session?.value ?? null, name: agent.name ?? null,
  })));
  if (values.pane) {
    const lines = values.lines ? Number(values.lines) : undefined;
    for (const source of ["detection", "visible"]) {
      const { read } = await ask("pane.read", { pane_id: values.pane, source, ...(lines ? { lines } : {}) });
      print(`pane.read ${source} (revision ${read.revision}${read.truncated ? ", truncated" : ""})`, read.text);
      if (source === "visible") {
        const { raw, ...form } = parseScreen(read.text);
        print("screen.mjs", form);
      }
    }
    const { explain } = await ask("agent.explain", { target: values.pane });
    print("agent.explain", explain?.matched_rule ? { matched_rule: explain.matched_rule, state: explain.state, visible_blocker: explain.visible_blocker } : explain);
  }
} catch (error) {
  process.stderr.write(`herdr-probe: ${error.code ?? "error"}: ${error.message}\n`);
  process.exit(1);
}
