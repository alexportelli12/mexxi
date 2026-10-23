import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DENY_MESSAGE } from "../lib/approver.mjs";

const entry = fileURLToPath(new URL("../server.mjs", import.meta.url));

test("until approvals arrive, the approver tool denies every call", async (t) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "approver", "--run", "r1"] }));
  t.after(() => client.close());
  const reply = await client.callTool({ name: "approve", arguments: { tool_name: "Bash", input: { command: "curl https://example.com" }, tool_use_id: "toolu_1" } });
  assert.deepEqual(JSON.parse(reply.content[0].text), { behavior: "deny", message: DENY_MESSAGE });
});
