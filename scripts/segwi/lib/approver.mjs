// The permission-prompt tool Claude Code calls for anything outside the allow
// list. Until approvals arrive it fails closed: every call is denied.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const DENY_MESSAGE = "Approvals arrive in a later version of segwi, so this call was not allowed.";

export async function runApprover() {
  const server = new McpServer({ name: "segwi", version: "0.1.0" });
  server.registerTool(
    "approve",
    {
      description: "Decide whether the agent may make a call that is outside its allow list.",
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: DENY_MESSAGE }) }] }),
  );
  await server.connect(new StdioServerTransport());
}
