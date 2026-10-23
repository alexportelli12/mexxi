import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { askServer, DENY_MESSAGE } from "../lib/approver.mjs";

const entry = fileURLToPath(new URL("../server.mjs", import.meta.url));
const INPUT = { command: "curl https://example.com", description: "Fetch the page", nested: { keep: [1, "two", null] } };

/** A stand-in for segwi's internal route. `answer(request)` returns [status, body]. */
async function stubServer(t, answer) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = { method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(text) };
    seen.push(request);
    const [status, body] = answer(request);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const call = (url, extra = {}) => askServer({ url, secret: "s3cret", runId: "run-1", toolName: "Bash", input: INPUT, toolUseId: "toolu_1", ...extra });

test("an allow carries back the original input unchanged, and the request names the run with its secret", async (t) => {
  const { url, seen } = await stubServer(t, () => [200, { decision: "allow", message: "" }]);
  assert.deepEqual(await call(url), { behavior: "allow", updatedInput: INPUT });
  assert.equal(seen[0].url, "/internal/approvals");
  assert.equal(seen[0].authorization, "Bearer s3cret");
  assert.deepEqual(seen[0].body, { runId: "run-1", toolName: "Bash", input: INPUT, toolUseId: "toolu_1" });
});

test("a deny passes the server's message through", async (t) => {
  const { url } = await stubServer(t, () => [200, { decision: "deny", message: DENY_MESSAGE }]);
  assert.deepEqual(await call(url), { behavior: "deny", message: DENY_MESSAGE });
});

test("every failure is a denial: bad status, bad body, unreachable server, missing settings", async (t) => {
  const bad = await stubServer(t, () => [401, { error: "no" }]);
  const garbage = await stubServer(t, () => [200, "not an answer"]);
  const odd = await stubServer(t, () => [200, { decision: "maybe" }]);
  const closed = await stubServer(t, () => [200, {}]);
  for (const url of [bad.url, garbage.url, odd.url, "http://127.0.0.1:1"]) {
    const reply = await call(url);
    assert.equal(reply.behavior, "deny", url);
    assert.ok(reply.message);
  }
  assert.equal((await call(closed.url, { secret: "" })).behavior, "deny");
  assert.equal((await call("", {})).behavior, "deny");
  assert.equal(closed.seen.length, 0);
});

test("the approver tool works over stdio and denies when no server is configured", async (t) => {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "approver", "--run", "r1"], env: {} }));
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["approve"]);
  const reply = await client.callTool({ name: "approve", arguments: { tool_name: "Bash", input: { command: "curl https://example.com" }, tool_use_id: "toolu_1" } });
  assert.equal(JSON.parse(reply.content[0].text).behavior, "deny");
});
