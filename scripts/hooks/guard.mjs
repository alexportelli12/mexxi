#!/usr/bin/env node
// The shared guard: every host runs it before a shell command. Claude Code and
// Codex call this file as a PreToolUse command hook with the tool call as JSON
// on stdin and `--host claude` or `--host codex` on the command line;
// OpenCode's plugin (opencode/plugins/mexxi-guard.js) imports guardToolCall
// from guard-rules.mjs and passes host "opencode". A refused call exits 2
// with the reason on stderr, which both hosts hand back to the agent as the
// tool's error. A hook never rewrites the command (decision 0021): a changed
// call is one the host's permission review never saw.
//
// It refuses what AGENTS.md says an agent never does and a permission prefix
// rule cannot hold on its own, because `cd x && <command>` sidesteps a prefix:
//   - force pushes, pushes to the default branch or a guard.protectedBranches
//     entry (including a push of HEAD after a switch, worktree add, clone or
//     symbolic-ref HEAD earlier in the line, and a push of HEAD where Git
//     cannot read the branch), a push to a branch named by an expansion
//     (git push origin "$(git branch --show-current)", "$B") while HEAD is on
//     a protected branch or one the guard cannot name, and merging pull
//     requests;
//   - git stash, git reset --hard, git clean, git restore (of the working
//     tree), git checkout of paths and a forced checkout or switch outside an
//     owned ibni worktree, or pointed elsewhere from one (--git-dir,
//     --work-tree, GIT_DIR), where they would destroy work the agent did not
//     make;
//   - every guard.deny prefix (production deploys, publishing), wherever it
//     sits in the command line, matched on the command's words so options
//     (firebase --project p deploy), npm's run aliases, a package name
//     (npx firebase-tools) and package runners (npm exec, pnpm dlx, yarn
//     <bin>) do not hide it;
//   - writes to the Shopify Admin API, and Shopify CLI commands that change a
//     live store (app deploy and release, theme publish and delete, theme
//     push --live);
//   - any of these behind a wrapper (sudo, doas, env, npx, ...) or a command
//     name held in a variable or substitution ($v push -f, "$(command -v
//     git)" push -f), including a -c script such a name may run ($SHELL -c);
//   - a shell fed a script it cannot read: through a pipe (curl ... | sh), a
//     process substitution (bash < <(curl ...), source <(...)), or an
//     expansion (bash -c "$(...)", bash -c "$CMD", a $VAR the line sets, an
//     unquoted heredoc that expands). A variable the line leaves alone, used
//     as an argument (bash -c "cd $DIR && npm test"), is allowed.
// npm publish --dry-run is allowed: it publishes nothing.
//
// Once a line crosses no red line, it is refused to help, with the corrected
// command in the reason, when it would fail or mislead in a known way. These
// back up written rules too, and say so in their message:
//   - unquoted --include=/--exclude= globs and find -name/-path globs, which
//     zsh expands and aborts the line on when nothing matches (braces become
//     one option per entry);
//   - tests, lint or verify piped into tail, head or grep without pipefail,
//     which reports the filter's exit status instead of the checks';
//   - a full verify (npm run verify, verifika or vfk --all, the session's
//     verifyCommand) run by hand inside an ibni worktree instead of ibni verify;
//   - on Claude Code's Bash in the foreground only, a while or until loop that
//     sleeps (Monitor, a background call and the other hosts are left alone);
//   - on Claude Code's Bash and OpenCode only, cat, head, tail (not following)
//     or sed -n printing a file inside the ibni worktree to the agent, which
//     does not count as a read before an edit. Codex reads through the shell.
// A host the guard cannot name (no --host) gets only the host-neutral ones.
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
//   - a variable from the host's environment whose value holds shell syntax,
//     expanded into a bash -c script (bash -c "cd $DIR"): the line cannot
//     set it, so it is taken to be a value;
//   - a variable expanded into a guarded command's arguments (s=push; git $s
//     --force): only an expanded command name is read as every guarded one;
//   - a push to a branch named by an expansion from a feature branch (B=main;
//     git push origin "$B"): it is taken to name the feature branch. From a
//     protected branch it is refused even when the line sets it to a feature
//     branch; name the branch literally;
//   - git checkout <path> without -- or ., which reads like a branch switch;
//   - shopify theme push --theme <id of the live theme>, which the CLI
//     confirms interactively;
//   - a branch creation that fails before a push of HEAD (git switch -c x;
//     git push): creating is taken to succeed, so HEAD is read as x;
//   - for the help refusals: a sleep loop inside a -c script, a read of a file
//     named by a glob or a variable, and a pipe whose first stage is a
//     subshell ( npm test ) | tail.
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
let hostFrom;
let refusalMessage;
try {
  ({ guardToolCall, hostFrom, refusalMessage } = await import("./guard-rules.mjs"));
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
let verdict;
try {
  verdict = await guardToolCall(input, { host: hostFrom(process.argv.slice(2)) });
} catch (error) {
  // Nor does one that breaks while checking (an unreadable config.json, a
  // bug): an error must never wave the call through.
  process.stderr.write(`mexxi guard error; refusing: ${error.message}\n`);
  process.exit(2);
}
if (verdict) {
  process.stderr.write(`${refusalMessage(verdict)}\n`);
  process.exit(2);
}
