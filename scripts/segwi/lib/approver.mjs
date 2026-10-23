// The permission-prompt tool Claude Code calls for anything outside the allow
// list (`mcp__segwi__approve`). It forwards the call to the local segwi server
// and waits for a person's answer. It fails closed: any problem is a denial, and
// an allow carries back the original input exactly as received, so the answer
// covers that one call and nothing wider.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const DENY_MESSAGE = "A person denied this in segwi.";
const UNREACHABLE_MESSAGE = "segwi could not be asked, so it denied this.";

const deny = (message) => ({ behavior: "deny", message });

// node:http rather than fetch: an answer can take an hour, and fetch gives up on headers after five minutes.
function post(url, { secret, body, signal }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(url, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: `Bearer ${secret}` },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(payload);
  });
}

/**
 * Asks the server and maps its answer to the prompt-tool reply. Never throws.
 * @param {{ url: string, secret: string, runId: string, toolName: string, input: Record<string, unknown>, toolUseId?: string, signal?: AbortSignal }} call
 */
export async function askServer({ url, secret, runId, toolName, input, toolUseId = "", signal }) {
  if (!url || !secret || !runId) return deny(UNREACHABLE_MESSAGE);
  try {
    const { status, text } = await post(new URL("/internal/approvals", url), { secret, signal, body: { runId, toolName, input, toolUseId: toolUseId || "unknown" } });
    if (status !== 200) return deny(UNREACHABLE_MESSAGE);
    const answer = JSON.parse(text);
    if (answer?.decision === "allow") return { behavior: "allow", updatedInput: input };
    return deny(typeof answer?.message === "string" && answer.message ? answer.message : DENY_MESSAGE);
  } catch {
    return deny(UNREACHABLE_MESSAGE);
  }
}

/** `args` are the arguments after `approver`: `--run <id>`. The URL and secret come from the environment segwi renders. */
export async function runApprover(args = [], env = process.env) {
  const runId = args[args.indexOf("--run") + 1] ?? "";
  const server = new McpServer({ name: "segwi", version: "0.1.0" });
  server.registerTool(
    "approve",
    {
      description: "Decide whether the agent may make a call that is outside its allow list.",
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
    },
    async ({ tool_name: toolName, input, tool_use_id: toolUseId }, extra) => {
      const reply = await askServer({ url: env.SEGWI_URL ?? "", secret: env.SEGWI_RUN_SECRET ?? "", runId, toolName, input, toolUseId, signal: extra?.signal });
      return { content: [{ type: "text", text: JSON.stringify(reply) }] };
    },
  );
  await server.connect(new StdioServerTransport());
}
