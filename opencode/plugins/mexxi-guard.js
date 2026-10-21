// OpenCode's side of the shared guard and loop breaker. OpenCode has no
// command hooks, so this plugin calls the same modules Claude Code and Codex
// run as hook scripts. The rendered opencode.json loads it by its path in the
// mexxi clone, so the relative imports below resolve there.
//
// A refused call throws, which OpenCode reports to the agent as the tool's
// error. A third identical failure appends the loop breaker's message to the
// tool's output.
import path from "node:path";
import { guardConfig, guardToolCall } from "../../scripts/hooks/guard.mjs";
import { recordToolResult } from "../../scripts/hooks/loop-breaker.mjs";

// The plugin API's shape (@opencode-ai/plugin's Plugin type), written plainly
// so nothing has to be installed for OpenCode to load it.
async function server({ directory }) {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      const reason = await guardToolCall({
        tool_name: "bash",
        tool_input: { command: output.args?.command },
        cwd: path.resolve(directory, output.args?.workdir ?? "."),
        session_id: input.sessionID,
      });
      if (reason) {
        throw new Error(`mexxi guard blocked this command: ${reason}. Do not retry it in pieces, rephrase it or route around it; report what was blocked and why it was needed.`);
      }
    },
    "tool.execute.after": async (input, output) => {
      const base = { session_id: input.sessionID, tool_name: input.tool, tool_input: input.args ?? {} };
      let event;
      if (input.tool === "bash") {
        const exit = output.metadata?.exit;
        if (!Number.isInteger(exit)) return;
        event = exit === 0
          ? { ...base, hook_event_name: "PostToolUse", tool_response: { exit_code: 0 } }
          : { ...base, hook_event_name: "PostToolUseFailure", error: `Exit code ${exit}` };
      } else {
        event = { ...base, hook_event_name: "PostToolUse" };
      }
      try {
        const { guard } = await guardConfig();
        const message = await recordToolResult(event, { limit: guard.repeatedFailureLimit });
        if (message) output.output = `${output.output ?? ""}\n\nmexxi loop breaker: ${message}`;
      } catch {
        // Counting is advisory and must never fail the tool call.
      }
    },
  };
}

export default { id: "mexxi.guard", server };
