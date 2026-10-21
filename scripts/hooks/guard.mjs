#!/usr/bin/env node
// The shared guard: every host runs it before a shell command. Claude Code and
// Codex call this file as a PreToolUse command hook with the tool call as JSON
// on stdin; OpenCode's plugin (opencode/plugins/mexxi-guard.js) imports
// guardToolCall from guard-rules.mjs. A refused call exits 2 with the reason
// on stderr, which both hosts hand back to the agent as the tool's error.
//
// It refuses what AGENTS.md says an agent never does and a permission prefix
// rule cannot hold on its own, because `cd x && <command>` sidesteps a prefix:
//   - force pushes, pushes to the default branch or a guard.protectedBranches
//     entry (including a push of HEAD after a switch earlier in the line),
//     and merging pull requests;
//   - git stash, git reset --hard and git clean outside an owned ibni worktree,
//     or pointed elsewhere from one (--git-dir, --work-tree, GIT_DIR), where
//     they would destroy work the agent did not make;
//   - every guard.deny prefix (production deploys, publishing), wherever it
//     sits in the command line, matched on the command's words so options
//     (firebase --project p deploy), npm's run aliases, a package name
//     (npx firebase-tools) and package runners (npm exec, pnpm dlx, yarn
//     <bin>) do not hide it;
//   - writes to the Shopify Admin API;
//   - unquoted --include=* / --exclude=* globs, when guard.blockUnquotedGlobs
//     is on (zsh aborts on them unless no_nomatch reaches the agent's shell);
//   - a shell fed a script it cannot read: through a pipe (curl ... | sh), a
//     process substitution (bash < <(curl ...), source <(...)), or an
//     expansion (bash -c "$(...)", an unquoted heredoc that expands).
//
// Known gaps, accepted rather than chased (the guard backs up AGENTS.md and the
// host's permission rules; it is not a sandbox):
//   - git aliases defined on the command line (git -c alias.p=push p --force);
//   - abbreviated long options git accepts (git push --forc);
//   - a package script run by another package manager (yarn deploy, pnpm
//     run deploy) when guard.deny lists only npm run deploy;
//   - a GraphQL merge mutation read from a file (gh api graphql -F query=@file);
//   - a script written to a file and then run (bash s.sh): its content is not read;
//   - eval of an expansion (eval "$(...)"): refusing it would break common
//     setup such as eval "$(fnm env)";
//   - output process substitution into a shell (tee >(bash));
//   - zsh's repeat keyword (zsh -c 'repeat 2 git stash');
//   - a branch creation that fails before a push of HEAD (git switch -c x;
//     git push): creating is taken to succeed, so HEAD is read as x.
// `npm run deploy:staging` is refused on purpose: it matches the
// `npm run deploy` prefix's `deploy:*` scripts, and which of them reach
// production is the repository's business, not the guard's.
//
// This file is only the entry; the rules live in guard-rules.mjs. Everything
// that can fail, loading the rules included, sits inside a try that exits 2:
// a hook that crashes with exit 1 is non-blocking in Claude Code, so a
// half-finished checkout or a bad edit would otherwise wave every call through.
// Hence no static imports beyond Node's own.

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let guardToolCall;
try {
  ({ guardToolCall } = await import("./guard-rules.mjs"));
} catch (error) {
  process.stderr.write(`mexxi guard could not load; refusing: ${error.message}\n`);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch (error) {
  // A hook that cannot read its input fails closed rather than waving the
  // call through.
  process.stderr.write(`mexxi guard: could not read the tool call (${error.message}); refusing it\n`);
  process.exit(2);
}
let reason;
try {
  reason = await guardToolCall(input);
} catch (error) {
  // Nor does one that breaks while checking (an unreadable config.json, a
  // bug): an error must never wave the call through.
  process.stderr.write(`mexxi guard error; refusing: ${error.message}\n`);
  process.exit(2);
}
if (reason) {
  process.stderr.write(`mexxi guard blocked this command: ${reason}. Do not retry it in pieces, rephrase it or route around it; report what was blocked and why it was needed.\n`);
  process.exit(2);
}
