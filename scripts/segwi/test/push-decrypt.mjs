// Opens a web push body the way a browser does (RFC 8291, aes128gcm), so a test can
// read what a push service would carry. The subscriber's key pair and auth secret
// are the ones the test generated when it subscribed.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

/** A browser's side of a subscription: the keys to hand the server and the secrets to decrypt with. */
export function makeSubscriber() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  return { ecdh, authSecret, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(authSecret) } };
}

/** @returns {string} the plaintext of one aes128gcm record */
export function decryptPush(body, { ecdh, authSecret }) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const secret = ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(0x02); // the padding delimiter closes a final record
  return padded.subarray(0, end === -1 ? padded.length : end).toString("utf8");
}
