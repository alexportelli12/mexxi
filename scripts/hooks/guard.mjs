#!/usr/bin/env node
// The shared guard: every host runs it before a shell command. Claude Code and
// Codex call this file as a PreToolUse command hook with the tool call as JSON
// on stdin; OpenCode's plugin (opencode/plugins/mexxi-guard.js) imports
// guardToolCall. A refused call exits 2 with the reason on stderr, which both
// hosts hand back to the agent as the tool's error.
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
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, configPath, loadConfig, resolveConfig } from "../lib/config.mjs";
import { LEGACY_METADATA_FILE, METADATA_FILE } from "../ibni/lib/metadata.mjs";
import { simpleCommands } from "./shell.mjs";

// Tools whose input.command is a shell command line, per host: Claude Code's
// Bash and Monitor (a monitor's script is a shell command too), Codex's Bash,
// and OpenCode's bash, which its plugin passes on under the same name.
export const SHELL_TOOLS = new Set(["Bash", "Monitor", "bash"]);

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function canonical(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function readMetadata(gitDirectory) {
  for (const name of [METADATA_FILE, LEGACY_METADATA_FILE]) {
    try {
      return JSON.parse(readFileSync(path.join(gitDirectory, name), "utf8"));
    } catch {
      // Missing or unreadable metadata is no ownership.
    }
  }
  return null;
}

// An ibni workspace in its expected state: a linked worktree whose metadata
// names it, on its own task branch, never the default branch. Which agent
// session holds it is ibni's business; the guard only needs to know the work
// in it belongs to a task, so cleaning it cannot destroy someone else's.
export function ownedWorktree(cwd) {
  const output = git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  if (!output) return null;
  const [top, gitDirectory, common] = output.split("\n");
  if (!top || canonical(gitDirectory) === canonical(path.resolve(cwd, common))) return null;
  const metadata = readMetadata(gitDirectory);
  if (metadata?.version !== 1 || !metadata.worktreePath || canonical(metadata.worktreePath) !== canonical(top)) return null;
  if (!metadata.branch || metadata.branch === metadata.defaultBranch) return null;
  if (git(cwd, ["branch", "--show-current"]) !== metadata.branch) return null;
  return metadata;
}

// The branches a push may not land on: the remote's default branch (main and
// master when Git cannot say) plus guard.protectedBranches.
function protectedBranches(cwd, remote, config) {
  const branches = new Set(config.guard.protectedBranches);
  const head = git(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (head?.startsWith(`${remote}/`)) branches.add(head.slice(remote.length + 1));
  else {
    branches.add("main");
    branches.add("master");
  }
  return branches;
}

const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

// Whether a push target names the branch. A wildcard refspec
// (refs/heads/*:refs/heads/*, refs/*) pushes every branch it matches,
// protected ones included.
function targetsBranch(target, branch) {
  if (!target.includes("*")) return target === branch;
  const pattern = target.split("*").map((part) => part.replace(/[.+?^$()|[\]{}\\]/g, "\\$&")).join(".*");
  const regex = new RegExp(`^${pattern}$`);
  return regex.test(branch) || regex.test(`refs/heads/${branch}`);
}

// Where HEAD may be after git switch, checkout or branch -m earlier in the same
// line, so a later push of HEAD is checked against the branch it would really
// push. A switch that may fail leaves the old branch possible too; a
// destination the guard cannot name (git checkout -, --detach) is unknown.
// `head` is { branches, upstreams, unknown }, filled from Git on first use.
function noteSwitch(subcommand, args, cwd, head) {
  const creates = { switch: ["-c", "-C", "--create", "--force-create", "--orphan"], checkout: ["-b", "-B", "--orphan"], branch: [] }[subcommand];
  if (!creates) return;
  const positional = [];
  let created = null;
  let detached = false;
  let renaming = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return; // git checkout <tree-ish> -- <paths> switches nothing
    const [option, inline] = arg.split(/=(.*)/s);
    if (creates.includes(option)) created = inline ?? args[++index];
    else if (arg === "--detach" || (subcommand === "switch" && arg === "-d")) detached = true;
    else if (subcommand === "branch" && ["-m", "-M", "--move"].includes(arg)) renaming = true;
    else if (!arg.startsWith("-") || arg === "-") positional.push(arg);
  }
  if (subcommand === "branch") {
    if (!renaming || !positional.length) return;
    const renamed = positional.at(-1);
    if (positional.length === 1) head.branches = new Set([renamed]);
    else head.branches.add(renamed);
    return;
  }
  const unnamed = (ref) => ref === "-" || ref.startsWith("@{-") || ref.includes("$");
  if (detached || (created ?? positional[0] ?? "").includes("$") || (!created && positional[0] && unnamed(positional[0]))) {
    head.unknown = true;
    return;
  }
  const remotes = (git(cwd, ["remote"]) ?? "").split("\n").filter(Boolean);
  const remoteBranch = (ref) => {
    const remote = remotes.find((name) => ref.startsWith(`${name}/`));
    return remote ? ref.slice(remote.length + 1) : null;
  };
  if (created) {
    // A new branch starts from HEAD or the start point, tracking it when the
    // start point is a remote branch.
    head.branches = new Set([created]);
    const tracked = positional[0] && remoteBranch(positional[0]);
    head.upstreams = new Set(tracked ? [tracked] : []);
    return;
  }
  const target = positional[0];
  if (!target) return;
  // git checkout --track origin/main creates main; git switch main may
  // create it from origin/main. Either way both names are possible.
  for (const branch of [target, remoteBranch(target)].filter(Boolean)) {
    head.branches.add(branch);
    const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`]);
    if (upstream?.includes("/")) head.upstreams.add(upstream.slice(upstream.indexOf("/") + 1));
  }
}

function currentHead(cwd) {
  const current = git(cwd, ["branch", "--show-current"]);
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  return {
    branches: new Set(current ? [current] : []),
    upstreams: new Set(upstream?.includes("/") ? [upstream.slice(upstream.indexOf("/") + 1)] : []),
    unknown: false,
  };
}

function checkPush(args, cwd, config, head = null) {
  const positional = [];
  let mirror = false;
  let everyBranch = false;
  let deleting = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (PUSH_VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--force" || arg.startsWith("--force-with-lease") || arg === "--force-if-includes") {
      return `git push ${arg} rewrites published history; mexxi never force-pushes`;
    }
    if (/^-[A-Za-z]+$/.test(arg) && arg.includes("f")) return "git push -f rewrites published history; mexxi never force-pushes";
    if (arg === "--mirror") mirror = true;
    else if (arg === "--all" || arg === "--branches") everyBranch = true;
    else if (arg === "--delete" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("d"))) deleting = true;
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  if (mirror) return "git push --mirror overwrites every remote ref; mexxi never force-pushes";
  const [remoteArgument, ...refspecs] = positional;
  const remotes = (git(cwd, ["remote"]) ?? "").split("\n").filter(Boolean);
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = remoteArgument && remotes.includes(remoteArgument) ? remoteArgument
    : upstream?.split("/")[0] ?? (remotes.includes("origin") ? "origin" : remotes[0] ?? "origin");
  const branches = protectedBranches(cwd, remote, config);
  const { branches: heads, upstreams, unknown } = head ?? currentHead(cwd);
  const name = (ref) => ref.replace(/^refs\/heads\//, "");
  const targets = [];
  let headRelative = false;
  if (everyBranch) targets.push(...branches);
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return `git push ${refspec} force-updates its target; mexxi never force-pushes`;
    const [source, destination] = refspec.includes(":") ? refspec.split(/:(.*)/s) : [refspec, undefined];
    if (destination !== undefined && destination !== "") targets.push(name(destination));
    else if (source === "HEAD" || source === "@") {
      headRelative = true;
      targets.push(...(heads.size ? heads : ["HEAD"]));
    } else if (source) targets.push(name(source));
  }
  if (!refspecs.length && !everyBranch) {
    headRelative = true;
    targets.push(...heads, ...upstreams);
  }
  if (headRelative && unknown) {
    return "git push of HEAD after a switch to a branch the guard cannot name (git checkout -, @{-1}, --detach) could land on a protected branch; push an explicit branch (git push origin <branch>)";
  }
  const hit = targets.map((target) => [...branches].find((branch) => targetsBranch(target, branch))).find(Boolean);
  if (hit) {
    return `git push ${deleting ? "--delete " : ""}to ${hit} changes a protected branch (the default branch or guard.protectedBranches); deliver through a feature branch and a pull request`;
  }
  return null;
}

// Git environment variables that point a command at another repository or
// checkout than the directory it runs in.
const RELOCATING_ENV = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)\b/;

// relocatedBy: what earlier in the line (GIT_DIR=..., export GIT_WORK_TREE)
// may point git at another repository, or null.
function checkGit(argv, cwd, config, heads = new Map(), relocatedBy = null) {
  let index = 1;
  let directory = cwd;
  while (index < argv.length && argv[index].startsWith("-")) {
    const [option, inline] = argv[index].split(/=(.*)/s);
    if (option === "-C") {
      directory = path.resolve(directory, argv[index + 1] ?? ".");
      index += 2;
      continue;
    }
    if (option === "--git-dir" || option === "--work-tree") relocatedBy ??= option;
    if (option === "-c" && /^core\.worktree=/i.test(argv[index + 1] ?? "")) relocatedBy ??= "-c core.worktree";
    if (["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(option) && inline === undefined) {
      index += 2;
    } else index += 1;
  }
  const [subcommand, ...args] = argv.slice(index);
  if (subcommand === "push") return checkPush(args, directory, config, heads.get(directory));
  if (["switch", "checkout", "branch"].includes(subcommand)) {
    if (!heads.has(directory)) heads.set(directory, currentHead(directory));
    noteSwitch(subcommand, args, directory, heads.get(directory));
  }
  let destructive = null;
  if (subcommand === "stash" && !["list", "show"].includes(args[0])) destructive = `git stash${args[0] ? ` ${args[0]}` : ""}`;
  if (subcommand === "reset" && args.includes("--hard")) destructive = "git reset --hard";
  if (subcommand === "clean" && !args.some((arg) => arg === "--dry-run" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("n")))) destructive = "git clean";
  if (destructive && relocatedBy) {
    // ownedWorktree vouches for the directory, not for the repository these
    // point git at.
    return `${destructive} with ${relocatedBy} works on another repository or checkout than the owned worktree, where it would destroy changes this task did not make; leave them in place and report instead`;
  }
  if (destructive && !ownedWorktree(directory)) {
    return `${destructive} outside an owned ibni worktree would destroy changes this task did not make (and the stash stack is shared by every worktree); leave them in place and report instead`;
  }
  return null;
}

// gh's options that take a value, wherever they sit before or between the
// subcommands (gh -R o/r pr merge, gh pr --repo o/r merge).
const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);

function checkGh(argv) {
  const words = [];
  for (let index = 1; index < argv.length && words.length < 2; index += 1) {
    if (GH_VALUE_OPTIONS.has(argv[index])) index += 1;
    else if (!argv[index].startsWith("-")) words.push(argv[index]);
  }
  if (words[0] === "pr" && words[1] === "merge") return "gh pr merge: merge decisions stay with the human";
  if (words[0] === "api" && argv.some((arg) => /\/pulls\/[^/\s]+\/merge\b/.test(arg))) return "gh api .../merge: merge decisions stay with the human";
  if (words[0] === "api" && argv.includes("graphql") && argv.some((arg) => /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(arg))) {
    return "gh api graphql mergePullRequest: merge decisions stay with the human";
  }
  return null;
}

// Spellings that run the same thing: a package's name for its command
// (npx firebase-tools@13 is firebase) and npm's aliases for run.
const COMMAND_ALIASES = { "firebase-tools": "firebase" };
const WORD_ALIASES = { "run-script": "run", rum: "run", urn: "run" };
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_RUNNERS = new Set(["exec", "x", "dlx"]);

function commandName(word) {
  const name = word.replace(/(?<=.)@[^@/]*$/, "");
  return COMMAND_ALIASES[name] ?? name;
}

// The index of the first word in args that is not an option, from `from`.
function firstWord(args, from = 0) {
  let index = from;
  while (index < args.length && args[index].startsWith("-")) index += 1;
  return index;
}

// The commands a simple command stands for, as a deny rule reads them: itself,
// and the command a package runner runs for it (npm exec, pnpm dlx, pnpx,
// yarn <bin>).
function denyForms(argv) {
  const forms = [argv];
  const name = commandName(argv[0]);
  if (name === "pnpx") forms.push(...denyForms(argv.slice(firstWord(argv, 1))));
  if (PACKAGE_MANAGERS.has(name)) {
    const at = firstWord(argv, 1);
    if (PACKAGE_RUNNERS.has(argv[at])) forms.push(...denyForms(argv.slice(firstWord(argv, at + 1))));
    else if (name === "yarn" && at < argv.length) forms.push(...denyForms(argv.slice(at)));
  }
  return forms.filter((form) => form.length);
}

// Whether argv runs a deny prefix: the prefix's words in order among the
// command's non-option words (an option's value may sit between them, as in
// firebase --project prod deploy), its last word also matching as word:* the
// way a Bash(<prefix>:*) rule does, and its options anywhere in the command.
function matchesPrefix(argv, prefix) {
  const parts = prefix.trim().split(/\s+/);
  const words = parts.filter((part) => !part.startsWith("-")).map((word, at) => (at ? WORD_ALIASES[word] ?? word : commandName(word)));
  const options = parts.filter((part) => part.startsWith("-"));
  if (commandName(argv[0]) !== words[0]) return false;
  let needed = 1;
  let optionValue = false;
  for (let index = 1; index < argv.length && needed < words.length; index += 1) {
    const arg = WORD_ALIASES[argv[index]] ?? argv[index];
    if (arg === "--") return false;
    if (arg.startsWith("-")) {
      optionValue = !arg.includes("=");
      continue;
    }
    const word = words[needed];
    if (arg === word || (needed === words.length - 1 && arg.startsWith(`${word}:`))) needed += 1;
    else if (!optionValue) return false;
    optionValue = false;
  }
  if (needed < words.length) return false;
  return options.every((option) => argv.some((arg) => arg === option || arg.startsWith(`${option}=`)
    || (/^-[A-Za-z]$/.test(option) && /^-[A-Za-z]+$/.test(arg) && arg.includes(option[1]))));
}

// The guard.deny prefixes, applied to every simple command rather than only
// the start of the line.
function checkDeny(argv, config) {
  for (const prefix of config.guard.deny) {
    if (denyForms(argv).some((form) => matchesPrefix(form, prefix))) {
      return `${prefix.trim().split(/\s+/).join(" ")} is on the guard.deny list (production deploys, publishing and merges need a human)`;
    }
  }
  return null;
}

const SHOPIFY_ADMIN = /(?:\.myshopify\.com\/admin\/api|\/admin\/api\/\d{4}-\d{2}\/)/i;
const CURL_DATA = new Set(["--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file"]);
// curl's short options that take a value, which ends a cluster (-sSd '{}',
// -sXPOST): d, F and T send a body, X names the method.
const CURL_SHORT_VALUES = "AbcCdDeEFHKmoPQrtTuUwxXyYz";
const WGET_BODIES = ["--post-data", "--post-file", "--body-data", "--body-file"];
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// GraphQL sends every operation as a POST; only a mutation writes. A body the
// guard cannot read (@file, stdin) counts as one.
function graphqlWrite(url, bodies) {
  if (!/graphql(\.json)?(\?|$)/i.test(url)) return true;
  return !bodies.length || bodies.some((body) => body.startsWith("@") || body === "-" || /\bmutation\b/.test(body));
}

function checkShopify(argv) {
  const [name, ...args] = argv;
  const url = args.find((arg) => SHOPIFY_ADMIN.test(arg));
  if (!url) return null;
  let method = null;
  const bodies = [];
  if (name === "curl") {
    let get = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (/^-[^-]/.test(arg)) {
        for (let at = 1; at < arg.length; at += 1) {
          if (arg[at] === "G") get = true;
          if (!CURL_SHORT_VALUES.includes(arg[at])) continue;
          const value = at + 1 < arg.length ? arg.slice(at + 1) : args[++index] ?? "";
          if (arg[at] === "X") method = value.toUpperCase();
          // An uploaded file is a body the guard cannot read.
          else if (arg[at] === "T") bodies.push("@");
          else if (arg[at] === "d" || arg[at] === "F") bodies.push(value);
          break;
        }
      } else if (arg === "--request") method = args[++index]?.toUpperCase();
      else if (arg.startsWith("--request=")) method = arg.slice(10).toUpperCase();
      else if (arg === "--get") get = true;
      else if (arg === "--upload-file" || arg.startsWith("--upload-file=")) {
        if (!arg.includes("=")) index += 1;
        bodies.push("@");
      } else if (CURL_DATA.has(arg)) bodies.push(args[++index] ?? "");
      else if ([...CURL_DATA].some((flag) => arg.startsWith(`${flag}=`))) bodies.push(arg.slice(arg.indexOf("=") + 1));
    }
    method ??= bodies.length && !get ? "POST" : "GET";
  } else if (name === "wget") {
    for (let index = 0; index < args.length; index += 1) {
      const [option, inline] = args[index].split(/=(.*)/s);
      if (option !== "--method" && !WGET_BODIES.includes(option)) continue;
      const value = inline ?? args[++index] ?? "";
      if (option === "--method") method = value.toUpperCase();
      else bodies.push(option.endsWith("-file") ? "@" : value);
    }
    method ??= bodies.length ? "POST" : "GET";
  } else if (["http", "https", "xh", "xhs"].includes(name)) {
    const explicit = args.find((arg) => /^[A-Z]+$/.test(arg));
    // Body items are key=value, key:=json and key@file; key==value is a query
    // parameter and Name:value a header, neither of which sends a body.
    const items = args.slice(args.indexOf(url) + 1).filter((arg) => /^[^-][^=:@]*(?::=|=(?!=)|@)/.test(arg));
    bodies.push(...items);
    method = explicit ?? (items.length ? "POST" : "GET");
  } else {
    return null;
  }
  if (!WRITE_METHODS.has(method)) return null;
  if (method === "POST" && !graphqlWrite(url, bodies)) return null;
  return `${name} ${method} to the Shopify Admin API writes to a live store; production writes need a human`;
}

function checkGlobs(command, config) {
  if (!config.guard.blockUnquotedGlobs) return null;
  const index = command.argv.findIndex((arg, at) => command.globs[at] && /^--(?:include|exclude)(?:-dir)?=/.test(arg));
  if (index === -1) return null;
  const [option, value] = command.argv[index].split(/=(.*)/s);
  return `unquoted ${command.argv[index]} is expanded by zsh before ${command.argv[0]} sees it (and aborts when nothing matches); quote it: ${option}='${value}'`;
}

// The reason a command line is refused, or null. cwd is where the host runs
// it; a `cd` earlier in the same line moves later commands.
export function checkCommand(command, { cwd, config, home = os.homedir() }) {
  let directory = cwd;
  // Each directory's HEAD as switches earlier in the line leave it.
  const heads = new Map();
  for (const simple of simpleCommands(command)) {
    const { argv } = simple;
    if (simple.refused) return simple.refused;
    if (argv[0] === "cd" || argv[0] === "pushd") {
      const target = argv.slice(1).find((arg) => !arg.startsWith("-") || arg === "-");
      if (target === undefined) directory = home;
      else if (target !== "-") directory = path.resolve(directory, target.replace(/^~(?=\/|$)/, home));
      continue;
    }
    const relocatedBy = command.match(RELOCATING_ENV)?.[0] ?? null;
    const reason = (argv[0] === "git" ? checkGit(argv, directory, config, heads, relocatedBy) : null)
      ?? (argv[0] === "gh" ? checkGh(argv) : null)
      ?? checkDeny(argv, config)
      ?? checkShopify(argv)
      ?? checkGlobs(simple, config);
    if (reason) return reason;
  }
  return null;
}

// An invalid config.json must not switch the guard off: it falls back to the
// schema's defaults, which ibni and the installer will refuse loudly anyway.
export async function guardConfig() {
  try {
    return (await loadConfig({ file: configPath() })).config;
  } catch (error) {
    if (error instanceof ConfigError) return resolveConfig({});
    throw error;
  }
}

// Host-neutral entry: the tool call in Claude Code's PreToolUse shape, which
// Codex shares and OpenCode's plugin builds.
export async function guardToolCall(input, { config, home } = {}) {
  const command = input?.tool_input?.command;
  if (!SHELL_TOOLS.has(input?.tool_name) || typeof command !== "string") return null;
  return checkCommand(command, { cwd: input.cwd || process.cwd(), config: config ?? await guardConfig(), home });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
}
