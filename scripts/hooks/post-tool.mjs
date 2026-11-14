#!/usr/bin/env node
// The one post-tool hook entry Claude Code and Codex run, after shell
// commands and edits. It dispatches to two helpers, each in its own module:
//   - the loop breaker (loop-breaker.mjs), which stops the same failing
//     command on its third try: exit 2 with the reason on stderr;
//   - the test-design nudge (test-design-nudge.mjs), which tells the agent to
//     load test-design the first time a session edits a test file: exit 0
//     with hookSpecificOutput.additionalContext on stdout, which Claude Code's
//     and Codex's PostToolUse both accept.
// The loop breaker only speaks after a shell command and the nudge only after
// an edit, so one call never needs both. OpenCode's plugin calls the same two
// helpers itself.
//
// Both only help: a broken state file or any other error is reported on
// stderr and never fails the tool call.
import { guardConfig } from "./guard-rules.mjs";
import { recordToolResult } from "./loop-breaker.mjs";
import { firstTestEdit } from "./test-design-nudge.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch (error) {
  process.stderr.write(`mexxi post-tool hook skipped: ${error.message}\n`);
  process.exit(0);
}

try {
  const config = await guardConfig();
  const message = await recordToolResult(input, { limit: config.guard.repeatedFailureLimit });
  if (message) {
    process.stderr.write(`mexxi loop breaker: ${message}\n`);
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`mexxi loop breaker skipped: ${error.message}\n`);
}

try {
  const nudge = await firstTestEdit(input);
  if (nudge) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: nudge } })}\n`);
  }
} catch (error) {
  process.stderr.write(`mexxi test-design nudge skipped: ${error.message}\n`);
}
