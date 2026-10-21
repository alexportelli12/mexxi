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
//     entry, and merging pull requests;
//   - git stash, git reset --hard and git clean outside an owned ibni worktree,
//     where they would destroy work the agent did not make;
//   - every guard.deny prefix (production deploys, publishing), wherever it
//     sits in the command line;
//   - writes to the Shopify Admin API;
//   - unquoted --include=* / --exclude=* globs, when guard.blockUnquotedGlobs
//     is on (zsh aborts on them unless no_nomatch reaches the agent's shell);
//   - a shell fed a script through a pipe it cannot read (curl ... | sh).
//
// Known gaps, accepted rather than chased (the guard backs up AGENTS.md and the
// host's permission rules; it is not a sandbox):
//   - git aliases defined on the command line (git -c alias.p=push p --force);
//   - abbreviated long options git accepts (git push --forc);
//   - deny prefixes reached through another runner (npm exec, pnpm dlx).
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

function checkPush(args, cwd, config) {
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
  const current = git(cwd, ["branch", "--show-current"]);
  const name = (ref) => ref.replace(/^refs\/heads\//, "");
  const targets = [];
  if (everyBranch) targets.push(...branches);
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) return `git push ${refspec} force-updates its target; mexxi never force-pushes`;
    const [source, destination] = refspec.includes(":") ? refspec.split(/:(.*)/s) : [refspec, undefined];
    if (destination !== undefined && destination !== "") targets.push(name(destination));
    else if (source === "HEAD" || source === "@") targets.push(current ?? "HEAD");
    else if (source) targets.push(name(source));
  }
  if (!refspecs.length && !everyBranch) {
    targets.push(...[current, upstream?.slice(upstream.indexOf("/") + 1)].filter(Boolean));
  }
  const hit = targets.map((target) => [...branches].find((branch) => targetsBranch(target, branch))).find(Boolean);
  if (hit) {
    return `git push ${deleting ? "--delete " : ""}to ${hit} changes a protected branch (the default branch or guard.protectedBranches); deliver through a feature branch and a pull request`;
  }
  return null;
}

function checkGit(argv, cwd, config) {
  let index = 1;
  let directory = cwd;
  while (index < argv.length && argv[index].startsWith("-")) {
    const option = argv[index];
    if (option === "-C") {
      directory = path.resolve(directory, argv[index + 1] ?? ".");
      index += 2;
    } else if (["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(option)) {
      index += 2;
    } else index += 1;
  }
  const [subcommand, ...args] = argv.slice(index);
  if (subcommand === "push") return checkPush(args, directory, config);
  let destructive = null;
  if (subcommand === "stash" && !["list", "show"].includes(args[0])) destructive = `git stash${args[0] ? ` ${args[0]}` : ""}`;
  if (subcommand === "reset" && args.includes("--hard")) destructive = "git reset --hard";
  if (subcommand === "clean" && !args.some((arg) => arg === "--dry-run" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("n")))) destructive = "git clean";
  if (destructive && !ownedWorktree(directory)) {
    return `${destructive} outside an owned ibni worktree would destroy changes this task did not make (and the stash stack is shared by every worktree); leave them in place and report instead`;
  }
  return null;
}

function checkGh(argv) {
  if (argv[1] === "pr" && argv[2] === "merge") return "gh pr merge: merge decisions stay with the human";
  if (argv[1] === "api" && argv.some((arg) => /\/pulls\/[^/\s]+\/merge\b/.test(arg))) return "gh api .../merge: merge decisions stay with the human";
  if (argv[1] === "api" && argv.includes("graphql") && argv.some((arg) => /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(arg))) {
    return "gh api graphql mergePullRequest: merge decisions stay with the human";
  }
  return null;
}

// Prefix rules as Claude Code's Bash(<prefix>:*) reads them, applied to every
// simple command rather than only the start of the line.
function checkDeny(argv, config) {
  const line = argv.join(" ");
  for (const prefix of config.guard.deny) {
    const normalised = prefix.trim().split(/\s+/).join(" ");
    if (line === normalised || line.startsWith(`${normalised} `) || line.startsWith(`${normalised}:`)) {
      return `${normalised} is on the guard.deny list (production deploys, publishing and merges need a human)`;
    }
  }
  return null;
}

const SHOPIFY_ADMIN = /(?:\.myshopify\.com\/admin\/api|\/admin\/api\/\d{4}-\d{2}\/)/i;
const CURL_DATA = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"]);
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
      if (arg === "-X" || arg === "--request") method = args[++index]?.toUpperCase();
      else if (/^-X[A-Za-z]+$/.test(arg)) method = arg.slice(2).toUpperCase();
      else if (arg.startsWith("--request=")) method = arg.slice(10).toUpperCase();
      else if (arg === "-G" || arg === "--get") get = true;
      else if (CURL_DATA.has(arg)) bodies.push(args[++index] ?? "");
      else if ([...CURL_DATA].some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))) bodies.push(arg.slice(arg.indexOf("=") + 1));
    }
    method ??= bodies.length && !get ? "POST" : "GET";
  } else if (name === "wget") {
    for (const arg of args) {
      if (arg.startsWith("--method=")) method = arg.slice(9).toUpperCase();
      for (const flag of ["--post-data=", "--post-file=", "--body-data=", "--body-file="]) {
        if (arg.startsWith(flag)) bodies.push(flag.includes("file") ? "@" : arg.slice(flag.length));
      }
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
  for (const simple of simpleCommands(command)) {
    const { argv } = simple;
    if (simple.refused) return simple.refused;
    if (argv[0] === "cd" || argv[0] === "pushd") {
      const target = argv.slice(1).find((arg) => !arg.startsWith("-") || arg === "-");
      if (target === undefined) directory = home;
      else if (target !== "-") directory = path.resolve(directory, target.replace(/^~(?=\/|$)/, home));
      continue;
    }
    const reason = (argv[0] === "git" ? checkGit(argv, directory, config) : null)
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
