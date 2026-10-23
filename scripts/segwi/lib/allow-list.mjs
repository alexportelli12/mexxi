// The rendered Claude Code settings for a run. The allow list is derived from
// real /wettaq and /lesti sessions (see the plan's Spike results): everything a
// normal run does is allowed, so a person is only asked about the unusual.
// Shells, interpreters run directly, network clients, rm/cp/mv, kill, git push
// and gh api stay off it. It is not a boundary for code, though: npm run, the npx
// test tools and node --test run the repository's own code, which the agent can
// edit. The sandbox is what bounds that code.
import { denyRules } from "../../lib/claude-settings.mjs";

// Not grep or fetch with arguments: git grep -O and git fetch --upload-pack run a program of the caller's choosing.
const GIT = ["status", "diff", "log", "show", "add", "commit", "ls-files", "rev-parse", "check-ignore", "rm", "mv"];
const GIT_EXACT = ["git fetch", "git fetch origin"];
// --output makes git diff, log and show write a file anywhere, wherever it appears in the command.
const OUTPUT_DENY = ["Bash(git *--output*)", "Bash(gh *--output*)"];
const GH = ["pr create", "pr view", "pr edit", "pr checks", "pr diff", "run view", "run list"];
const NPM = ["ci", "run", "test", "audit", "view"];
const NPX = ["prettier", "vitest", "playwright", "tsc", "eslint", "ng", "oxlint"];

export const SANDBOX_DOMAINS = ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"];

const prefix = (command) => `Bash(${command}:*)`;
// Claude Code's `//path` form names an absolute path.
const absolute = (directory) => `/${directory}/**`;

const PLAIN_COMMAND = /^[A-Za-z0-9@._/:=+, -]+$/;
const UNSAFE_FIRST_WORDS = new Set([
  "sh", "bash", "zsh", "dash", "fish", "env", "sudo", "doas", "eval", "exec", "xargs", "python", "python3", "node", "deno", "bun",
  "perl", "ruby", "php", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "rm",
]);
export const VERIFY_NOT_ALLOWED = "This repository's verify command isn't on the allow list, so each verify run will ask you first.";

/** The repository names its verify command, so repository content must not widen what is allowed. */
export function isPlainVerifyCommand(command) {
  return PLAIN_COMMAND.test(command) && !UNSAFE_FIRST_WORDS.has(command.trim().split(/\s+/)[0]);
}

/**
 * @param {{ worktreeRoot: string, verifyCommand: string, tempDir: string }} input
 * @returns {string[]}
 */
export function allowRules({ worktreeRoot, verifyCommand, tempDir }) {
  const roots = [worktreeRoot, tempDir];
  return [
    ...["ibni", "vfk", "npx vfk", "npx verifika"].map(prefix),
    // The verify command exactly as the repository names it, never as a prefix that would also allow what follows it.
    ...(isPlainVerifyCommand(verifyCommand) ? [`Bash(${verifyCommand.trim()})`] : []),
    ...GIT.map((sub) => prefix(`git ${sub}`)),
    ...GIT_EXACT.map((command) => `Bash(${command})`),
    ...GH.map((sub) => prefix(`gh ${sub}`)),
    ...NPM.map((sub) => prefix(`npm ${sub}`)),
    "Bash(npm install)",
    // mexxi's command-fixer mod prefixes a piped verify with this, so the exact command (never a prefix) is allowed.
    "Bash(set -o pipefail)",
    ...NPX.map((tool) => prefix(`npx ${tool}`)),
    ...["node --test", "ocr delegate", "ffmpeg", "mkdir"].map(prefix),
    "mcp__playwright__*",
    ...["Read", "Edit", "Write"].flatMap((tool) => roots.map((root) => `${tool}(${absolute(root)})`)),
  ];
}

export function renderSettings({ worktreeRoot, verifyCommand, tempDir, denyPatterns }) {
  return {
    permissions: {
      allow: allowRules({ worktreeRoot, verifyCommand, tempDir }),
      deny: [...denyRules(denyPatterns), ...OUTPUT_DENY],
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      // Claude Code otherwise runs every sandboxed Bash command unasked, so the allow list would never be read.
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [worktreeRoot] },
      network: { allowedDomains: SANDBOX_DOMAINS },
    },
  };
}
