// The bearer token MCP clients present. Only its SHA-256 hash is stored, in the
// installer's state directory, so reading the disk never yields a usable token.
// verify() reads the file on each call, so a rotation takes effect on the next
// request without restarting the server.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = "segwi.json";
const PREFIX = "segwi_";

const hashOf = (token) => `sha256:${createHash("sha256").update(token).digest("hex")}`;
const fileIn = (stateDir) => path.join(stateDir, FILE);

function readState(stateDir) {
  try {
    const value = JSON.parse(readFileSync(fileIn(stateDir), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Creates a new token, stores only its hash (file mode 0600) and returns the token. Shown once. */
export function rotate(stateDir) {
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  mkdirSync(stateDir, { recursive: true });
  const file = fileIn(stateDir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...readState(stateDir), mcpTokenHash: hashOf(token), rotatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return token;
}

/** True when `presented` is the current token. Compares hashes in constant time; false when none was ever made. */
export function verify(stateDir, presented) {
  const stored = readState(stateDir).mcpTokenHash;
  if (typeof stored !== "string" || typeof presented !== "string" || presented === "") return false;
  const given = Buffer.from(hashOf(presented));
  const expected = Buffer.from(stored);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
