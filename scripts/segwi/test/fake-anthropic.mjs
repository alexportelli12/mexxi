// A scripted stand-in for the Anthropic Messages API, so a test can drive the
// real Claude Code binary without a model or a network. Each main-loop request
// (one that offers the Bash tool) is answered with the script's next turn,
// chosen by how many assistant turns the conversation already holds, so a retry
// gets the same answer. Every other call (titles, token counts, side queries)
// gets a harmless minimal answer. Every request body is recorded, so a test can
// read the tool results Claude Code sent back.
import http from "node:http";

/**
 * A turn is `{ tool: "Bash", input: { command } }` (any tool name and input) or `{ text }`, or a function
 * that returns one when the turn is asked for, for values known only once the run has started.
 * The conversation ends with the first text turn; past the end of the script the model says "Done.".
 * @param {Array<Turn | (() => Turn)>} script
 * @typedef {{ tool: string, input: object } | { text: string }} Turn
 */
export async function startFakeAnthropic(script) {
  const requests = [];
  let responses = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      requests.push({ method: req.method, url: req.url, body: json });
      const pathname = new URL(req.url, "http://x").pathname;
      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") return sendJson(res, { input_tokens: 1 });
      if (req.method !== "POST" || pathname !== "/v1/messages") return sendJson(res, {});
      const mainLoop = Array.isArray(json?.tools) && json.tools.some((tool) => tool.name === "Bash");
      // Claude Code may merge consecutive assistant turns, so the turn is counted by the tool calls made so far.
      const turnIndex = (json?.messages ?? []).filter((entry) => entry.role === "assistant" && Array.isArray(entry.content))
        .flatMap((entry) => entry.content).filter((block) => block.type === "tool_use").length;
      const scripted = script[turnIndex] ?? { text: "Done." };
      const turn = mainLoop ? (typeof scripted === "function" ? scripted() : scripted) : { text: "ok" };
      const blocks = "tool" in turn
        ? [{ type: "tool_use", id: `toolu_fake_${turnIndex}`, name: turn.tool, input: turn.input }]
        : [{ type: "text", text: turn.text }];
      responses += 1;
      const stopReason = "tool" in turn ? "tool_use" : "end_turn";
      const id = `msg_fake_${responses}`;
      if (json?.stream) sendStream(res, id, json.model, blocks, stopReason);
      else sendJson(res, message(id, json?.model, blocks, stopReason));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** The tool_result blocks Claude Code sent back, keyed by tool_use id, last one wins. */
    toolResults() {
      const results = {};
      for (const { body } of requests) {
        for (const entry of body?.messages ?? []) {
          if (!Array.isArray(entry.content)) continue;
          for (const block of entry.content) {
            if (block.type === "tool_result") results[block.tool_use_id] = { isError: block.is_error === true, text: resultText(block.content) };
          }
        }
      }
      return results;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** The id the fake gives the tool call in script turn `index`. */
export const toolUseId = (index) => `toolu_fake_${index}`;

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
  return "";
}

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function message(id, model, content, stopReason) {
  return { id, type: "message", role: "assistant", model: model ?? "fake", content, stop_reason: stopReason, stop_sequence: null, usage };
}

function sendJson(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendStream(res, id, model, blocks, stopReason) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", { message: message(id, model, [], null) });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      event("content_block_start", { index, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      event("content_block_start", { index, content_block: { ...block, input: {} } });
      event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    event("content_block_stop", { index });
  });
  event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
  event("message_stop", {});
  res.end();
}
