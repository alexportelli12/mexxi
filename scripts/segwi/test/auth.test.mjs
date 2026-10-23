import assert from "node:assert/strict";
import test from "node:test";
import { isPlainVerifyCommand } from "../lib/allow-list.mjs";

test("only a plain verify command becomes an allow rule", () => {
  for (const ok of ["npm run verify", "npx vfk --all", "make check", "./scripts/verify.sh", "pnpm run ci:verify"]) assert.equal(isPlainVerifyCommand(ok), true, ok);
  for (const bad of ["bash verify.sh", "npm run verify && curl x", "npm run verify; rm -rf .", "$(curl x)", "python3 verify.py", "env X=1 npm run verify", "node verify.mjs", "npm run `x`", "a | b", "rm -rf x", ""]) {
    assert.equal(isPlainVerifyCommand(bad), false, bad);
  }
});
