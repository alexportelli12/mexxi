// Secret redaction shared with the retro script: both read
// secret-patterns.json, so a pattern added there protects every text that
// leaves this machine or lands in a report.
import { readFileSync } from "node:fs";

const SOURCE = JSON.parse(readFileSync(new URL("./secret-patterns.json", import.meta.url), "utf8"));

export const REDACTION = SOURCE.replacement;
export const SECRET_PATTERNS = SOURCE.patterns.map(({ name, pattern, flags }) => ({ name, regex: new RegExp(pattern, `g${flags}`) }));

// Replaces every match and counts them, so a caller can record that it redacted.
export function redact(text) {
  let count = 0;
  let result = text;
  for (const { regex } of SECRET_PATTERNS) {
    result = result.replace(regex, () => {
      count += 1;
      return REDACTION;
    });
  }
  return { text: result, count };
}
