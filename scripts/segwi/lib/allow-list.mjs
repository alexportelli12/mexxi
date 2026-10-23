// The rendered Claude Code settings for a run. The allow list is derived from
// real /wettaq and /lesti sessions (see the plan's Spike results): everything a
// normal run does is allowed, so a person is only asked about the unusual.
// Shells, interpreters run directly, network clients, rm/cp/mv, kill, git push
// and gh api stay off it. It is not a boundary for code, though: npm run, the npx
// test tools and node --test run the repository's own code, which the agent can
// edit. The sandbox is what bounds that code.
import { statSync } from "node:fs";
import path from "node:path";
import { sanitizePrefix } from "../../ibni/lib/config.mjs";
import { denyRules } from "../../lib/claude-settings.mjs";

// Not grep or fetch with arguments: git grep -O and git fetch --upload-pack run a program of the caller's choosing.
const GIT = ["status", "diff", "log", "show", "add", "commit", "ls-files", "rev-parse", "check-ignore", "rm", "mv"];
const GIT_EXACT = ["git fetch", "git fetch origin"];
// --output makes git diff, log and show write a file anywhere, wherever it appears in the command.
const OUTPUT_DENY = ["Bash(git *--output*)", "Bash(gh *--output*)"];
const GH = ["pr create", "pr view", "pr edit", "pr checks", "pr diff", "run view", "run list"];
const NPM = ["ci", "run", "test", "audit", "view"];
const NPX = ["prettier", "vitest", "playwright", "tsc", "eslint", "ng", "oxlint"];

// The run's browser (Playwright MCP) runs outside the sandbox, so only tools that look at or drive a page are
// allowed. Running code (browser_evaluate), uploading or dropping local files, writing files (pdf, traces, video), changing
// routes, cookies or storage, and calling page tools ask a person; browser_run_code_unsafe runs code in the
// Playwright server itself and is refused outright.
const BROWSER_TOOLS = [
  "navigate", "navigate_back", "navigate_forward", "reload", "snapshot", "take_screenshot", "click", "type", "press_key",
  "press_sequentially", "fill_form", "select_option", "check", "uncheck", "hover", "drag", "handle_dialog", "wait_for",
  "resize", "tabs", "close", "console_messages", "network_requests", "emulate_media", "find", "keydown", "keyup",
  "mouse_click_xy", "mouse_down", "mouse_up", "mouse_move_xy", "mouse_drag_xy", "mouse_wheel",
  "verify_element_visible", "verify_list_visible", "verify_text_visible", "verify_value",
].map((tool) => `mcp__playwright__browser_${tool}`);
const BROWSER_DENY = ["mcp__playwright__browser_run_code_unsafe"];

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
    ...BROWSER_TOOLS,
    ...reads,
    ...["Edit", "Write"].flatMap((tool) => [worktreeRoot, tempDir].map((root) => `${tool}(${absolute(root)})`)),
  ];
}

/**
 * The branch prefixes a build or ready run may write, each as ibni prepare spells it in a branch name:
 * workflow.branchPrefix and then segwi.branchPrefixes, without repeats. ibni prepare refuses any other.
 */
export function writablePrefixes(branchPrefix, branchPrefixes = []) {
  return [...new Set([branchPrefix, ...branchPrefixes].map((prefix) => `${sanitizePrefix(prefix.replace(/\/+$/, ""))}/`))];
}

/** The folder a prefix's branches live in under the git directory's refs/heads. */
export const branchFolder = (gitCommonDir, prefix) => path.join(gitCommonDir, "refs", "heads", prefix.replace(/\/+$/, ""));

/**
 * The parts of the control checkout's git directory a run's commits and fetches in its linked worktree write:
 * objects, its own branches (under `prefixes` only), remote and tag refs, reflogs and worktree metadata. Not HEAD,
 * the index, packed-refs, info, config, hooks or the default branch: rewriting those would bring planted code into
 * your checkout the next time you, or ibni prepare, update it. The adapter creates any that don't exist yet.
 */
export function gitWritePaths(gitCommonDir, prefixes) {
  return [
    path.join(gitCommonDir, "objects"), ...prefixes.map((prefix) => branchFolder(gitCommonDir, prefix)),
    ...[path.join("refs", "remotes"), path.join("refs", "tags"), path.join("logs", "refs"), "worktrees"].map((part) => path.join(gitCommonDir, part)),
  ];
}

/**
 * Where a run may write. The control checkout (the clone you work in, `repoPath`) is never one of those
 * places: a file planted there runs later as you, outside any sandbox. A build or ready run starts in the
 * worktree root instead, because Claude Code always lets a run write where it starts, and may write only the
 * git data its worktree needs (gitWritePaths). `controlEntries` are the checkout's top-level names, denied
 * one by one alongside git's config, hooks and submodules, because denying the checkout itself would also
 * deny the git directory. ibni runs outside the sandbox (see renderSettings). An ask run starts in the
 * checkout and writes nothing there.
 */
function filesystemRules({ action, worktreeRoot, tempDir, repoPath, gitCommonDir, prefixes, controlEntries = [], existingGit = [], denyRead = [] }) {
  if (action === "ask") return { allowWrite: [tempDir], denyWrite: [repoPath], denyRead };
  return {
    allowWrite: [worktreeRoot, tempDir, ...gitWritePaths(gitCommonDir, prefixes)],
    denyWrite: [
      ...["config", "hooks", "modules"].map((name) => path.join(gitCommonDir, name)),
      // Other sessions' worktree metadata and branches, as they stand when the run starts, are not this run's to change.
      ...existingGit,
      ...controlEntries.filter((name) => path.join(repoPath, name) !== gitCommonDir).map((name) => path.join(repoPath, name)),
    ],
    denyRead,
  };
}

/**
 * The file tools may never write into the control checkout. Claude Code reads one Edit rule for all of them
 * (Write and NotebookEdit rules change nothing), and it turns a `/**` rule into a sandbox mount over the whole
 * checkout, which would also block the git directory a worktree's commits need. A `/*` glob is not mounted,
 * and still refuses every file tool anywhere in the checkout (the sandbox test checks both).
 */
const controlDenyRules = (checkouts) => [...new Set(checkouts)].map((checkout) => `Edit(/${checkout}/*)`);

/** The Read tool runs outside the sandbox, so denyRead alone doesn't stop it; each secret path is denied to it too. */
const secretReadRules = (paths) => paths.flatMap((file) => [`Read(/${file})`, `Read(/${file}/**)`]);

const isFolder = (file) => {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The file tools run outside the sandbox too, and in auto mode a model, not a person, judges a write outside the
 * worktree. So the paths whose contents later run as you, or steer the agent, are denied to them in every mode,
 * whether or not they exist yet. A folder gets only the `/*` form, as the control checkout does: a rule without a
 * glob becomes a read-only sandbox mount, and over the mexxi clone that would cover its git directory too, so a run
 * in it could no longer commit. A secret is a folder or a file by what is on disk; the others are named as one.
 */
function protectedWriteRules({ secrets, files, folders }) {
  const fileRules = [...secrets.filter((file) => !isFolder(file)), ...files].map((file) => `Edit(/${file})`);
  return [...new Set([...fileRules, ...[...secrets.filter(isFolder), ...folders].map((folder) => `Edit(/${folder}/*)`)])];
}

// What a run never does unasked, in any mode, though in sandboxed mode it would run inside the sandbox, which can
// reach GitHub: push, or change a repository through gh. ibni publish is the run's own way to push.
const ASK_RULES = ["git push", "gh api", "gh repo", "gh release", "gh pr merge"].map(prefix);

/**
 * ibni verify and ibni setup run the commands the repository names, which `ibni:*` would otherwise allow whatever
 * they are. One that isn't plain asks, as it would if the agent ran it directly (VERIFY_NOT_ALLOWED). Read from the
 * checkout, so in a /lesti run where the default branch names no verify, the command a branch adds is not checked
 * here; like any npm run script the agent edits, it is bounded by the sandbox, not by this list.
 */
export function askRules({ verifyCommand, setupCommand }) {
  return [
    ...ASK_RULES,
    ...(isPlainVerifyCommand(verifyCommand) ? [] : [prefix("ibni verify")]),
    ...(setupCommand && !isPlainVerifyCommand(setupCommand) ? [prefix("ibni setup")] : []),
  ];
}

/**
 * `denyRead` are the secrets nothing in the sandbox needs: keys and credentials in the home directory, and
 * segwi's own state and data (its tokens, push key, run secrets and pending approvals). Only existing paths.
 */
export function renderSettings({ action, worktreeRoot, verifyCommand, setupCommand = null, tempDir, repoPath, gitCommonDir = path.join(repoPath, ".git"), branchPrefix = "agent/",
  branchPrefixes = [], permissions = "strict", controlEntries = [], existingGit = [], denyRead = [], protectedFiles = [], protectedFolders = [],
  controlCheckouts = [], denyPatterns }) {
  const prefixes = writablePrefixes(branchPrefix, branchPrefixes);
  return {
    permissions: {
      allow: allowRules({ action, worktreeRoot, verifyCommand, tempDir, repoPath }),
      deny: [...denyRules(denyPatterns), ...OUTPUT_DENY, ...BROWSER_DENY, ...controlDenyRules([repoPath, ...controlCheckouts]), ...secretReadRules(denyRead),
        ...protectedWriteRules({ secrets: denyRead, files: protectedFiles, folders: protectedFolders })],
      ask: askRules({ verifyCommand, setupCommand }),
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      // Only in sandboxed mode does a command inside the sandbox run unasked. Otherwise the allow list is read
      // first, and what it doesn't cover goes to a person (strict) or auto mode's classifier (auto).
      autoAllowBashIfSandboxed: permissions === "sandboxed",
      allowUnsandboxedCommands: false,
      // ibni prepare must fast-forward the checkout, so it alone runs outside, and only as a single plain command,
      // never a compound one. It runs in the checkout, whose git config the run can't change. Every other ibni
      // command stays inside: the run can point its own worktree at a git config of its choosing.
      ...(action === "ask" ? {} : { excludedCommands: ["ibni prepare *"] }),
      filesystem: filesystemRules({ action, worktreeRoot, tempDir, repoPath, gitCommonDir, prefixes, controlEntries, existingGit, denyRead }),
      network: { allowedDomains: SANDBOX_DOMAINS },
    },
  };
}
