// The runner registry. Config names a runner id; nothing else picks an executable.
import { createClaudeCodeAdapter } from "./claude-code.mjs";

const FACTORIES = { "claude-code": createClaudeCodeAdapter };

export function createRunner(id, options) {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`Unknown runner ${id}. Known: ${Object.keys(FACTORIES).join(", ")}.`);
  return factory(options);
}
