// The socket client: one request per connection with a deadline, and herdr's
// error lines surfaced as typed errors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { herdrRequest } from "../lib/herdr/client.mjs";
import { startFakeHerdr } from "./fake-herdr.mjs";

test("gives up on a herdr that never answers instead of hanging", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hares-herdr-silent-"));
  const socket = path.join(dir, "herdr.sock");
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(herdrRequest("ping", {}, { socket, timeoutMs: 50 }), { code: "timeout" });
});

test("surfaces herdr's error code", async (t) => {
  const fake = await startFakeHerdr(t);
  fake.failNext("agent.list", "agent_not_found", "no such agent");
  await assert.rejects(herdrRequest("agent.list", {}, { socket: fake.socket }), { name: "HerdrError", code: "agent_not_found" });
});

test("opens a new connection for each request, as herdr closes one after answering", async (t) => {
  const fake = await startFakeHerdr(t);
  await herdrRequest("ping", {}, { socket: fake.socket });
  const { agents } = await herdrRequest("agent.list", {}, { socket: fake.socket });
  assert.deepEqual(agents, []);
  assert.deepEqual(fake.requests.map((entry) => entry.method), ["ping", "agent.list"]);
});
