// The rendered Claude Code settings for a run. The allow list is derived from
// real /wettaq and /lesti sessions (see the plan's Spike results): everything a
// normal run does is allowed, so a person is only asked about the unusual.
// Interpreters, network clients, rm/cp/mv, kill, git push and gh api stay off it.
import { denyRules } from "../../lib/claude-settings.mjs";

const GIT = ["status", "diff", "log", "show", "add", "commit", "grep", "ls-files", "rev-parse", "fetch", "check-ignore", "rm", "mv"];
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
    ...["ibni", ...(isPlainVerifyCommand(verifyCommand) ? [verifyCommand] : []), "vfk", "npx vfk", "npx verifika"].map(prefix),
    ...GIT.map((sub) => prefix(`git ${sub}`)),
    ...GH.map((sub) => prefix(`gh ${sub}`)),
    ...NPM.map((sub) => prefix(`npm ${sub}`)),
    "Bash(npm install)",
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
      deny: denyRules(denyPatterns),
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [worktreeRoot] },
      network: { allowedDomains: SANDBOX_DOMAINS },
    },
  };
}
