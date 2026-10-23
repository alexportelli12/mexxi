// The rendered Claude Code settings for a run. The allow list is derived from
// real /wettaq and /lesti sessions (see the plan's Spike results): everything a
// normal run does is allowed, so a person is only asked about the unusual.
// Shells, interpreters run directly, network clients, rm/cp/mv, kill, git push
// and gh api stay off it. It is not a boundary for code, though: npm run, the npx
// test tools and node --test run the repository's own code, which the agent can
// edit. The sandbox is what bounds that code.
import path from "node:path";
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

// What an ask run may do: look, never change. No file tool writes, nothing that installs, builds,
// commits or opens a pull request, and no browser, which can submit forms on the web.
const ASK_IBNI = ["list", "info", "stats"];
const ASK_GIT = ["status", "diff", "log", "show", "ls-files", "rev-parse", "check-ignore"];
const ASK_GH = ["pr view", "pr checks", "pr diff", "run view", "run list"];

/**
 * @param {{ action: string, worktreeRoot: string, verifyCommand: string, tempDir: string, repoPath: string }} input
 * @returns {string[]}
 */
export function allowRules({ action, worktreeRoot, verifyCommand, tempDir, repoPath }) {
  const reads = [worktreeRoot, tempDir, repoPath].map((root) => `Read(${absolute(root)})`);
  if (action === "ask") {
    return [
      ...ASK_IBNI.map((sub) => prefix(`ibni ${sub}`)),
      ...ASK_GIT.map((sub) => prefix(`git ${sub}`)),
      ...ASK_GH.map((sub) => prefix(`gh ${sub}`)),
      ...reads,
    ];
  }
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
    ...reads,
    ...["Edit", "Write"].flatMap((tool) => [worktreeRoot, tempDir].map((root) => `${tool}(${absolute(root)})`)),
  ];
}

/**
 * Where a run may write. The control checkout (the clone you work in, `repoPath`) is never one of those
 * places: a file planted there runs later as you, outside any sandbox. A build or ready run starts in the
 * worktree root instead, because Claude Code always lets a run write where it starts. Its commits in a linked
 * worktree still need the checkout's git directory (objects, refs, worktree metadata, ibni's lock), so that is
 * writable, except the config, hooks and submodules, through which git would run code. `controlEntries` are the
 * checkout's top-level names, denied one by one, because denying the checkout itself would also deny its git
 * directory. `ibni prepare` alone runs outside the sandbox: it must fast-forward the checkout, and it runs
 * before the agent has written anything. Claude Code frees only a single plain command this way, never a
 * compound one. An ask run starts in the checkout and writes nothing there.
 */
function filesystemRules({ action, worktreeRoot, tempDir, repoPath, gitCommonDir, controlEntries = [] }) {
  if (action === "ask") return { allowWrite: [tempDir], denyWrite: [repoPath] };
  return {
    allowWrite: [worktreeRoot, tempDir, gitCommonDir],
    denyWrite: [
      ...["config", "hooks", "modules"].map((name) => path.join(gitCommonDir, name)),
      ...controlEntries.filter((name) => path.join(repoPath, name) !== gitCommonDir).map((name) => path.join(repoPath, name)),
    ],
  };
}

/**
 * The file tools may never write into the control checkout. Claude Code reads one Edit rule for all of them
 * (Write and NotebookEdit rules change nothing), and it turns a `/**` rule into a sandbox mount over the whole
 * checkout, which would also block the git directory a worktree's commits need. A `/*` glob is not mounted,
 * and still refuses every file tool anywhere in the checkout (the sandbox test checks both).
 */
const controlDenyRules = (repoPath) => [`Edit(/${repoPath}/*)`];

export function renderSettings({ action, worktreeRoot, verifyCommand, tempDir, repoPath, gitCommonDir = path.join(repoPath, ".git"), controlEntries = [], denyPatterns }) {
  return {
    permissions: {
      allow: allowRules({ action, worktreeRoot, verifyCommand, tempDir, repoPath }),
      deny: [...denyRules(denyPatterns), ...OUTPUT_DENY, ...controlDenyRules(repoPath)],
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      // Claude Code otherwise runs every sandboxed Bash command unasked, so the allow list would never be read.
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      ...(action === "ask" ? {} : { excludedCommands: ["ibni prepare *"] }),
      filesystem: filesystemRules({ action, worktreeRoot, tempDir, repoPath, gitCommonDir, controlEntries }),
      network: { allowedDomains: SANDBOX_DOMAINS },
    },
  };
}
