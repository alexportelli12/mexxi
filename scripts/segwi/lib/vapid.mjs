// The VAPID key pair push messages are signed with. It lives in the installer's
// state directory (private to the user) and never in config or the repository.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";

export const VAPID_SUBJECT = "mailto:segwi@localhost";

export const vapidFile = (stateDir) => path.join(stateDir, "segwi-vapid.json");

/** The stored keys, or null when `segwi vapid init` has not run (or the file is damaged). */
export function readVapid(stateDir) {
  try {
    const { publicKey, privateKey, subject } = JSON.parse(readFileSync(vapidFile(stateDir), "utf8"));
    return typeof publicKey === "string" && typeof privateKey === "string" ? { publicKey, privateKey, subject: subject ?? VAPID_SUBJECT } : null;
  } catch {
    return null;
  }
}

/** Writes a new key pair, mode 0600. Replacing existing keys breaks every subscription, so it needs `force`. */
export function initVapid(stateDir, { force = false } = {}) {
  const file = vapidFile(stateDir);
  if (existsSync(file) && !force) {
    throw new Error("VAPID keys already exist. Replacing them breaks every existing push subscription, so segwi keeps them; pass --force to replace them.");
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  writeFileSync(file, `${JSON.stringify({ publicKey, privateKey, subject: VAPID_SUBJECT }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return publicKey;
}
