// Everything that came from outside passes through here before it is stored or
// returned, so a secret never reaches the database, a response or a stream.
import { redact } from "../../lib/redact.mjs";

export function cleanText(text, max = Infinity) {
  const value = redact(String(text ?? "")).text;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Redacts each string leaf rather than the JSON text, so a replacement can
// never break the structure (a pattern may match across a quote).
export function cleanDeep(value, maxString = 20000) {
  if (typeof value === "string") return cleanText(value, maxString);
  if (Array.isArray(value)) return value.map((item) => cleanDeep(item, maxString));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key, 200), cleanDeep(item, maxString)]));
  }
  return value;
}
