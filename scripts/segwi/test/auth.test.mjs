import assert from "node:assert/strict";
import test from "node:test";
import { isPlainVerifyCommand } from "../lib/allow-list.mjs";
import { assertNotFromThisMachine } from "../lib/auth.mjs";
import { HttpError } from "../lib/errors.mjs";

const interfaces = {
  lo: [{ address: "127.0.0.1", family: "IPv4" }, { address: "::1", family: "IPv6" }],
  tailscale0: [{ address: "100.64.0.7", family: "IPv4" }, { address: "fe80::1%tailscale0", family: "IPv6" }],
};
const request = (forwarded) => ({ headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } });

test("decisions behind tailscale serve must come from another device", () => {
  for (const own of ["127.0.0.1", "::1", "100.64.0.7", "::ffff:127.0.0.1", "100.64.0.7, 10.0.0.2", "fe80::1"]) {
    assert.throws(() => assertNotFromThisMachine(request(own), "tailscale-header", interfaces), (error) => error instanceof HttpError && error.status === 403, own);
  }
  assert.throws(() => assertNotFromThisMachine(request(undefined), "tailscale-header", interfaces), HttpError);
  assert.doesNotThrow(() => assertNotFromThisMachine(request("100.64.0.99"), "tailscale-header", interfaces));
  assert.doesNotThrow(() => assertNotFromThisMachine(request("100.64.0.99, 100.64.0.7"), "tailscale-header", interfaces));
});

test("localhost-only mode trusts the machine, so decisions are allowed", () => {
  assert.doesNotThrow(() => assertNotFromThisMachine(request(undefined), "localhost-only", interfaces));
  assert.doesNotThrow(() => assertNotFromThisMachine(request("127.0.0.1"), "localhost-only", interfaces));
});

test("only a plain verify command becomes an allow rule", () => {
  for (const ok of ["npm run verify", "npx vfk --all", "make check", "./scripts/verify.sh", "pnpm run ci:verify"]) assert.equal(isPlainVerifyCommand(ok), true, ok);
  for (const bad of ["bash verify.sh", "npm run verify && curl x", "npm run verify; rm -rf .", "$(curl x)", "python3 verify.py", "env X=1 npm run verify", "node verify.mjs", "npm run `x`", "a | b", "rm -rf x", ""]) {
    assert.equal(isPlainVerifyCommand(bad), false, bad);
  }
});
