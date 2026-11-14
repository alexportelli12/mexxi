// The shared guard's rules. guard.mjs, the hook entry every host runs, says
// what they refuse and which gaps are accepted; OpenCode's plugin imports
// guardToolCall and refusalMessage, and the loop breaker guardConfig, from here.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, configPath, loadConfig, resolveConfig } from "../lib/config.mjs";
import { LEGACY_METADATA_FILE, METADATA_FILE } from "../ibni/lib/metadata.mjs";
import { simpleCommands, sleepLoops } from "./shell.mjs";

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
// destination the guard cannot name (git checkout -, --detach) is unknown,
// until a branch is created.
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
    head.unknown = false;
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

const unknownHead = () => ({ branches: new Set(), upstreams: new Set(), unknown: true });

// A directory Git cannot read a branch in (not a repository yet, or not there
// yet) has an unknown HEAD; a detached one has none to push.
function currentHead(cwd) {
  const current = git(cwd, ["branch", "--show-current"]);
  if (current === null) return unknownHead();
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  return {
    branches: new Set(current ? [current] : []),
    upstreams: new Set(upstream?.includes("/") ? [upstream.slice(upstream.indexOf("/") + 1)] : []),
    unknown: false,
  };
}

// Options of git worktree add and git clone that take a value.
const WORKTREE_VALUE_OPTIONS = new Set(["--reason"]);
const CLONE_VALUE_OPTIONS = new Set([
  "-o", "--origin", "-u", "--upload-pack", "--reference", "--reference-if-able", "--separate-git-dir", "--depth",
  "--shallow-since", "--shallow-exclude", "-c", "--config", "--template", "-j", "--jobs", "--filter", "--bundle-uri",
  "--server-option", "--ref-format",
]);

// Splits args into positionals and the values of the options named in
// `valued`; an option in `valued` may also be written --option=value.
function parseOptions(args, valued) {
  const positional = [];
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    const [option, inline] = arg.split(/=(.*)/s);
    if (valued.has(option)) values.set(option, inline ?? args[++index]);
    else if (!arg.startsWith("-")) positional.push(arg);
    else values.set(arg, true);
  }
  return { positional, values };
}

// The directories git worktree add, git clone and git symbolic-ref HEAD give
// a HEAD earlier in the line, so a push from there is checked like one after
// a switch. A clone's branch is the remote's default unless --branch names it.
function noteNewHead(subcommand, args, cwd, heads) {
  if (subcommand === "symbolic-ref") {
    const { positional } = parseOptions(args, new Set(["-m"]));
    if (positional[0] !== "HEAD" || positional.length < 2) return;
    const ref = positional[1];
    heads.set(cwd, ref.startsWith("refs/heads/") && !ref.includes("$")
      ? { branches: new Set([ref.slice("refs/heads/".length)]), upstreams: new Set(), unknown: false }
      : unknownHead());
    return;
  }
  if (subcommand === "clone") {
    const { positional, values } = parseOptions(args, new Set([...CLONE_VALUE_OPTIONS, "-b", "--branch"]));
    const [repository, directory] = positional;
    if (!repository) return;
    const target = directory ?? path.basename(repository.replace(/[/\\]+$/, "").replace(/(?:\/\.git|\.git)$/, "").replace(/^.*:/, ""));
    const branch = values.get("-b") ?? values.get("--branch");
    heads.set(path.resolve(cwd, target), typeof branch === "string" && !branch.includes("$")
      ? { branches: new Set([branch]), upstreams: new Set([branch]), unknown: false }
      : unknownHead());
    return;
  }
  if (subcommand !== "worktree" || args[0] !== "add") return;
  const { positional, values } = parseOptions(args.slice(1), new Set([...WORKTREE_VALUE_OPTIONS, "-b", "-B"]));
  const [worktree, commitish] = positional;
  if (!worktree) return;
  const head = { branches: new Set(), upstreams: new Set(), unknown: false };
  const created = values.get("-b") ?? values.get("-B");
  if (values.has("--detach") || values.has("-d")) head.unknown = true;
  // Without a commit-ish or -b, the worktree gets a branch named after its
  // directory, as if -b <basename> were given.
  else noteSwitch("checkout", created ? ["-b", created, ...(commitish ? [commitish] : [])] : [commitish ?? path.basename(worktree)], cwd, head);
  heads.set(path.resolve(cwd, worktree), head);
}

// Whether the part of a refspec that names the pushed branch is only known at
// run time. A parameter is still in the value as written ($B), so only the
// part holding it counts; a command substitution leaves no trace in the
// value, so the whole word does.
function expandedRef(part, expansion) {
  return expansion === "substitution" || (expansion === "parameter" && part.includes("$"));
}

// expansions: for each of args, the shell reader's expansion kind (see
// effectiveArgv), so a refspec built at run time can be told from a literal.
function checkPush(args, cwd, config, head = null, expansions = []) {
  const positional = [];
  let mirror = false;
  let everyBranch = false;
  let deleting = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1).map((value, at) => ({ value, expansion: expansions[index + 1 + at] ?? null })));
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
    else if (!arg.startsWith("-")) positional.push({ value: arg, expansion: expansions[index] ?? null });
  }
  if (mirror) return "git push --mirror overwrites every remote ref; mexxi never force-pushes";
  const [remoteArgument, ...refspecs] = positional.map(({ value }) => value);
  const remotes = (git(cwd, ["remote"]) ?? "").split("\n").filter(Boolean);
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = remoteArgument && remotes.includes(remoteArgument) ? remoteArgument
    : upstream?.split("/")[0] ?? (remotes.includes("origin") ? "origin" : remotes[0] ?? "origin");
  const branches = protectedBranches(cwd, remote, config);
  const { branches: heads, upstreams, unknown } = head ?? currentHead(cwd);
  const name = (ref) => ref.replace(/^refs\/heads\//, "");
  const targets = [];
  let headRelative = false;
  // A refspec built at run time ($(git branch --show-current), "$B") most
  // often names the branch HEAD is on, so it is pushed only from a branch the
  // guard knows is not protected.
  let expandedTarget = false;
  if (everyBranch) targets.push(...branches);
  for (const [at, refspec] of refspecs.entries()) {
    if (refspec.startsWith("+")) return `git push ${refspec} force-updates its target; mexxi never force-pushes`;
    const [source, destination] = refspec.includes(":") ? refspec.split(/:(.*)/s) : [refspec, undefined];
    const expansion = positional[at + 1].expansion;
    if (expandedRef(destination !== undefined && destination !== "" ? destination : source, expansion)) expandedTarget = true;
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
    return "git push of HEAD where the guard cannot name its branch (after git checkout -, @{-1} or --detach, a clone without --branch, or where Git cannot read one) could land on a protected branch; push an explicit branch (git push origin <branch>)";
  }
  const hit = targets.map((target) => [...branches].find((branch) => targetsBranch(target, branch))).find(Boolean);
  if (hit) {
    return `git push ${deleting ? "--delete " : ""}to ${hit} changes a protected branch (the default branch or guard.protectedBranches); deliver through a feature branch and a pull request`;
  }
  if (expandedTarget) {
    const onProtected = [...heads].map((current) => [...branches].find((branch) => targetsBranch(current, branch))).find(Boolean);
    // A detached HEAD counts as unknown: no branch vouches for the expansion.
    const where = onProtected ? `on ${onProtected}` : unknown || !heads.size ? "the guard cannot name the current branch" : null;
    if (where) {
      return `git push to a branch named by an expansion while ${where} could push to a protected branch; name the branch literally (git push origin <branch>)`;
    }
  }
  return null;
}

// Git environment variables that point a command at another repository or
// checkout than the directory it runs in.
const RELOCATING_ENV = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)\b/;

// relocatedBy: what earlier in the line (GIT_DIR=..., export GIT_WORK_TREE)
// may point git at another repository, or null.
function checkGit(argv, cwd, config, heads = new Map(), relocatedBy = null, expansions = []) {
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
  if (subcommand === "push") return checkPush(args, directory, config, heads.get(directory), expansions.slice(index + 1));
  if (["switch", "checkout", "branch"].includes(subcommand)) {
    if (!heads.has(directory)) heads.set(directory, currentHead(directory));
    noteSwitch(subcommand, args, directory, heads.get(directory));
  }
  noteNewHead(subcommand, args, directory, heads);
  let destructive = null;
  if (subcommand === "stash" && !["list", "show"].includes(args[0])) destructive = `git stash${args[0] ? ` ${args[0]}` : ""}`;
  if (subcommand === "reset" && args.includes("--hard")) destructive = "git reset --hard";
  if (subcommand === "clean" && !args.some((arg) => arg === "--dry-run" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("n")))) destructive = "git clean";
  // Overwriting working-tree files from the index or a commit discards their
  // changes as surely as reset --hard: restore (unless --staged alone),
  // checkout of paths, and a forced checkout or switch.
  const short = (letter) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
  if (subcommand === "restore" && (!(args.includes("--staged") || short("S")) || args.includes("--worktree") || short("W"))) destructive = "git restore";
  if (subcommand === "checkout" && args.some((arg) => arg === "--" || arg === "." || arg.startsWith("--pathspec-from-file"))) destructive = "git checkout of paths";
  if (["checkout", "switch"].includes(subcommand) && args.some((arg) => ["-f", "--force", "--discard-changes"].includes(arg))) destructive = `git ${subcommand} --force`;
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
  // In any argument: the endpoint may be the full .../graphql URL rather than the word graphql.
  if (words[0] === "api" && argv.some((arg) => /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(arg))) {
    return "gh api graphql mergePullRequest: merge decisions stay with the human";
  }
  return null;
}

// glab's options that take a value, wherever they sit before or between the
// subcommands (glab -R g/r mr merge, glab mr --repo g/r merge).
const GLAB_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);

// GitLab's equivalents: glab mr merge (alias accept), the REST merge and
// merge-train endpoints, and the GraphQL mutation that merges or sets
// auto-merge (mergeRequestAccept), in any argument.
function checkGlab(argv) {
  const words = [];
  for (let index = 1; index < argv.length && words.length < 2; index += 1) {
    if (GLAB_VALUE_OPTIONS.has(argv[index])) index += 1;
    else if (!argv[index].startsWith("-")) words.push(argv[index]);
  }
  if (words[0] === "mr" && ["merge", "accept"].includes(words[1])) return `glab mr ${words[1]}: merge decisions stay with the human`;
  if (words[0] === "api" && argv.some((arg) => /merge_requests\/[^/\s]+\/merge\b|merge_trains\/merge_requests\//.test(arg))) return "glab api .../merge: merge decisions stay with the human";
  if (words[0] === "api" && argv.some((arg) => /\bmergeRequestAccept\b/.test(arg))) {
    return "glab api graphql mergeRequestAccept: merge decisions stay with the human";
  }
  return null;
}

// Spellings that run the same thing: a package's name for its command
// (npx firebase-tools@13 is firebase) and npm's aliases for run.
const COMMAND_ALIASES = { "firebase-tools": "firebase", "@shopify/cli": "shopify" };
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

// Whether the command ends up a dry run: the last of --dry-run[=value] and
// --no-dry-run decides, and --dry-run false (npm reads the next word as a
// boolean's value) or --dry-run=false switches it off.
function dryRun(argv) {
  let dry = false;
  for (let index = 1; index < argv.length; index += 1) {
    const [option, value] = argv[index].split(/=(.*)/s);
    if (option === "--no-dry-run") dry = false;
    else if (option === "--dry-run") dry = (value ?? (argv[index + 1] === "false" ? "false" : "true")) !== "false";
  }
  return dry;
}

// npm publish --dry-run publishes nothing. Only commands known to honour
// --dry-run are let through with it: npm run deploy --dry-run still runs the
// script, and a CLI that ignored the option would deploy.
function publishDryRun(argv) {
  return matchesPrefix(argv, "npm publish") && dryRun(argv);
}

// The guard.deny prefixes, applied to every simple command rather than only
// the start of the line.
function checkDeny(argv, config) {
  for (const prefix of config.guard.deny) {
    if (denyForms(argv).some((form) => matchesPrefix(form, prefix) && !publishDryRun(form))) {
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

// Shopify CLI commands that change a live store: releasing an app version,
// publishing or deleting a theme, and pushing to the live theme.
function checkShopifyCli(args) {
  const [topic, command] = args[0]?.includes(":") ? args[0].split(":") : args;
  const live = (topic === "app" && ["deploy", "release"].includes(command))
    || (topic === "theme" && ["publish", "delete"].includes(command))
    || (topic === "theme" && command === "push" && args.some((arg) => ["--live", "-l", "--allow-live", "-a"].includes(arg)));
  return live ? `shopify ${topic} ${command} writes to a live store; production writes need a human` : null;
}

function checkShopify(argv) {
  if (commandName(argv[0]) === "shopify") return checkShopifyCli(argv.slice(1));
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

// Where a cd or pushd leaves the commands after it, or null for any other
// command.
function changedDirectory(argv, directory, home) {
  if (argv[0] !== "cd" && argv[0] !== "pushd") return null;
  const target = argv.slice(1).find((arg) => !arg.startsWith("-") || arg === "-");
  if (target === undefined) return home;
  if (target === "-") return directory;
  return path.resolve(directory, target.replace(/^~(?=\/|$)/, home));
}

// The reason a command line is refused for crossing a red line, or null. cwd
// is where the host runs it; a `cd` earlier in the same line moves later
// commands.
export function checkCommand(command, { cwd, config, home = os.homedir() }) {
  let directory = cwd;
  // Each directory's HEAD as switches earlier in the line leave it.
  const heads = new Map();
  for (const simple of simpleCommands(command)) {
    const { argv } = simple;
    if (simple.refused) return simple.refused;
    const moved = changedDirectory(argv, directory, home);
    if (moved !== null) {
      directory = moved;
      continue;
    }
    const relocatedBy = command.match(RELOCATING_ENV)?.[0] ?? null;
    const check = (words) => (words[0] === "git" ? checkGit(words, directory, config, heads, relocatedBy, simple.expansions) : null)
      ?? (words[0] === "gh" ? checkGh(words) : null)
      ?? (words[0] === "glab" ? checkGlab(words) : null)
      ?? checkDeny(words, config)
      ?? checkShopify(words);
    const reason = check(argv);
    if (reason) return reason;
    if (simple.nameExpanded) {
      // $v push -f: the name is only known at run time, so the command is
      // read as each command a rule guards.
      for (const name of guardedNames(config)) {
        const guarded = check([name, ...argv.slice(1)]);
        if (guarded) return `a command name built by an expansion could be ${name}, and then: ${guarded}; write the command name out`;
      }
    }
  }
  return null;
}

function guardedNames(config) {
  return new Set(["git", "gh", "glab", "curl", "wget", "shopify", ...config.guard.deny.map((prefix) => prefix.trim().split(/\s+/)[0])]);
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

// Help, not red lines (decision 0021). These refusals catch commands that
// would fail or mislead in a known way, and hand back the corrected command:
// the guard refuses rather than rewriting, because a rewritten call is one
// the host's permission review never saw. Like the red-line checks, they back
// up written rules (the overlay's "wait with Monitor, never sleep", ibni's
// verify, Read before Edit); they do not own them. Which ones apply depends
// on the host: Claude Code ("claude"), Codex ("codex") or OpenCode
// ("opencode"). An unknown host gets only the host-neutral ones.

const quote = (value) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);
const quoteAlways = (value) => `'${value.replace(/'/g, "'\\''")}'`;

const BRACE_LIST = /^([^{}]*)\{([^{}]*,[^{}]*)\}([^{}]*)$/;

// The patterns a glob stands for once the shell expands its braces, or null
// when the braces are anything but one simple comma list (nested, a {1..3}
// range).
function braceExpand(value) {
  if (!/[{}]/.test(value)) return [value];
  const match = BRACE_LIST.exec(value);
  return match ? match[2].split(",").map((entry) => `${match[1]}${entry}${match[3]}`) : null;
}

const GLOB_OPTION = /^(--(?:include|exclude)(?:-dir)?)=(.*)$/s;
const FIND_PATTERNS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename"]);

// The unquoted globs zsh would expand (and abort the line on when nothing
// matches) in one simple command, each { words, fixed }: the words as
// written, in order, and what replaces them.
function unquotedGlobs({ argv, globs }) {
  const found = [];
  for (let at = 1; at < argv.length; at += 1) {
    if (!globs[at]) continue;
    const option = argv[at].match(GLOB_OPTION);
    if (option) {
      const patterns = braceExpand(option[2]) ?? [option[2]];
      found.push({ words: [argv[at]], fixed: patterns.map((pattern) => `${option[1]}=${quoteAlways(pattern)}`).join(" ") });
    } else if (argv[0] === "find" && FIND_PATTERNS.has(argv[at - 1])) {
      const patterns = braceExpand(argv[at]) ?? [argv[at]];
      found.push(patterns.length === 1
        ? { words: [argv[at]], shown: `${argv[at - 1]} ${argv[at]}`, fixed: quoteAlways(patterns[0]) }
        // find has no brace syntax either: one test per entry, or-ed.
        : { words: [argv[at - 1], argv[at]], fixed: `\\( ${patterns.map((pattern) => `${argv[at - 1]} ${quoteAlways(pattern)}`).join(" -o ")} \\)` });
    }
  }
  return found;
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The line with each glob replaced, or null when a replacement cannot be
// placed for certain: its words must appear exactly once in the line as
// written, standing as words of their own.
function replaceGlobs(line, globsFound) {
  let fixed = line;
  for (const { words, fixed: replacement } of globsFound) {
    const pattern = new RegExp(`(?<=^|[\\s;&|(])${words.map(escapeRegex).join("[ \\t]+")}(?=$|[\\s;&|)<>])`, "g");
    const matches = fixed.match(pattern) ?? [];
    if (matches.length !== 1) return null;
    fixed = fixed.replace(pattern, () => replacement);
  }
  return fixed;
}

const CHECK_SCRIPT = /^(?:test|lint|verify|typecheck|check)(?:$|[:-])/;
const CHECK_COMMANDS = new Set(["vitest", "jest", "mocha", "pytest", "eslint", "tsc", "vfk", "verifika"]);

// Whether a command runs tests, lint or verify, whose exit status is the
// result.
function runsChecks(argv) {
  const name = commandName(argv[0] ?? "");
  if (CHECK_COMMANDS.has(name)) return true;
  if (name === "playwright") return argv.includes("test");
  if (name === "node") return argv.includes("--test");
  if (name === "go" || name === "cargo") return argv[firstWord(argv, 1)] === "test";
  if (/^python3?$/.test(name)) return argv[1] === "-m" && argv[2] === "pytest";
  if (!PACKAGE_MANAGERS.has(name)) return false;
  const at = firstWord(argv, 1);
  const word = WORD_ALIASES[argv[at]] ?? argv[at];
  if (word === undefined) return false;
  if (word === "test" || (name === "npm" && ["t", "tst"].includes(word))) return true;
  if (word === "run") return CHECK_SCRIPT.test(argv[firstWord(argv, at + 1)] ?? "");
  if (PACKAGE_RUNNERS.has(word)) return runsChecks(argv.slice(firstWord(argv, at + 1)));
  // pnpm, yarn and bun run a script or a package's command by its bare name.
  return name !== "npm" && (CHECK_SCRIPT.test(word) || runsChecks(argv.slice(at)));
}

const FILTERS = new Set(["tail", "head", "grep"]);

// Whether argv is a full verify run: npm run verify, verifika or vfk --all, or
// the session's own verifyCommand (with any arguments after it).
function fullVerify(argv, metadata) {
  const name = commandName(argv[0]);
  if (name === "npm") {
    const at = firstWord(argv, 1);
    if ((WORD_ALIASES[argv[at]] ?? argv[at]) === "run" && argv[firstWord(argv, at + 1)] === "verify") return true;
  }
  if ((name === "verifika" || name === "vfk") && argv.includes("--all")) return true;
  if (typeof metadata.verifyCommand !== "string") return false;
  const own = simpleCommands(metadata.verifyCommand);
  return own.length === 1 && own[0].argv.length > 0 && own[0].argv.every((word, at) => argv[at] === word);
}

// head and tail options that take a value, and the ones that follow a file.
const HEAD_TAIL_VALUES = new Set(["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid", "--max-unchanged-stats"]);
const FOLLOW = /^(?:-[A-Za-z]*[fF][A-Za-z]*|--follow(?:=.*)?|--retry)$/;

// What a plain file read shows: { files, offset, limit, fromEnd } when argv
// prints files as they are (cat, head, tail without following, sed -n), or
// null. Words the shell expands are skipped: they name no file for certain.
function fileRead({ argv, globs, expansions }) {
  const [name] = argv;
  const operand = (at) => !globs[at] && !expansions[at] && argv[at] !== "-";
  if (name === "cat") {
    const files = argv.slice(1).filter((arg, at) => !arg.startsWith("-") && operand(at + 1));
    return files.length ? { files } : null;
  }
  if (name === "head" || name === "tail") {
    const files = [];
    let lines = null;
    for (let at = 1; at < argv.length; at += 1) {
      const [option, inline] = argv[at].split(/=(.*)/s);
      if (FOLLOW.test(argv[at])) return null;
      if (HEAD_TAIL_VALUES.has(option)) {
        const value = inline ?? argv[++at];
        if (option === "-n" || option === "--lines") lines = value;
      } else if (/^-n.+/.test(argv[at])) lines = argv[at].slice(2);
      else if (/^-\d+$/.test(argv[at])) lines = argv[at].slice(1);
      else if (!argv[at].startsWith("-") && operand(at)) files.push(argv[at]);
    }
    if (!files.length) return null;
    const count = lines ?? "10";
    if (name === "head") return /^\d+$/.test(count) ? { files, offset: 1, limit: Number(count) } : { files };
    if (/^\+\d+$/.test(count)) return { files, offset: Number(count.slice(1)) };
    return /^\d+$/.test(count) ? { files, limit: Number(count), fromEnd: true } : { files };
  }
  if (name === "sed") {
    const options = argv.slice(1).filter((arg) => arg.startsWith("-"));
    if (!options.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg) || arg === "--quiet" || arg === "--silent")) return null;
    if (options.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place") || /^-[A-Za-z]*[ef]$/.test(arg) || arg === "--expression")) return null;
    const positional = argv.map((arg, at) => ({ arg, at })).slice(1).filter(({ arg }) => !arg.startsWith("-"));
    const [script, ...rest] = positional;
    const files = rest.filter(({ at }) => operand(at)).map(({ arg }) => arg);
    if (!script || !files.length) return null;
    const range = script.arg.match(/^(\d+)(?:,(\d+))?p$/);
    if (!range) return { files };
    const from = Number(range[1]);
    return { files, offset: from, limit: range[2] ? Number(range[2]) - from + 1 : 1 };
  }
  return null;
}

// Whether file sits inside directory, as written or as real paths (a file
// that does not exist yet has no real path to compare).
function inside(file, directory) {
  return [[file, directory], [canonical(file), canonical(directory)]].some(([one, other]) => {
    const relative = path.relative(path.resolve(other), path.resolve(one));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

// The host's own tool for reading a file, written as a call with the range
// the shell command showed.
function readToolCall(host, file, { offset, limit, fromEnd }) {
  const start = fromEnd ? "<near the end: the line count minus " + limit + ">" : offset;
  if (host === "opencode") {
    const args = [`filePath: ${file}`, ...(start !== undefined ? [`offset: ${start}`] : []), ...(limit !== undefined ? [`limit: ${limit}`] : [])];
    return `use the read tool with offset and limit: read(${args.join(", ")})`;
  }
  const args = [file, ...(start !== undefined ? [`offset: ${start}`] : []), ...(limit !== undefined ? [`limit: ${limit}`] : [])];
  return `use the Read tool with offset and limit: Read(${args.join(", ")})`;
}

const URL_IN_LINE = /https?:\/\/[^\s'"`;|&()<>]+/;
const LOG_IN_LINE = /[^\s'"`;|&()<>=]+\.(?:log|out)\b/;

// The wait a sleep loop does, as a command that ends when the wait does
// (polling a URL or a log the loop names, or both patterns when it names
// neither), and the Monitor command that would stream that log instead.
function waitPatterns(line, loop) {
  const url = line.match(URL_IN_LINE)?.[0];
  const grep = [...loop.condition, ...loop.body].find((argv) => argv[0] === "grep");
  const pattern = grep?.slice(1).find((arg) => !arg.startsWith("-"));
  const log = line.match(LOG_IN_LINE)?.[0];
  const forUrl = `until curl -sf ${url ? quote(url) : "<url>"} >/dev/null; do sleep 1; done`;
  const forLog = `until grep -q ${pattern ? quoteAlways(pattern) : "'<ready text>'"} ${log ? quote(log) : "<log>"}; do sleep 1; done`;
  const stream = `tail -F ${log ? quote(log) : "<log>"} | grep --line-buffered ${pattern ? quoteAlways(pattern) : "'<text>'"}`;
  if (url && !log) return { wait: `for the URL: ${forUrl}`, stream };
  if (log && !url) return { wait: `for the log: ${forLog}`, stream };
  return { wait: `for a URL: ${forUrl}; for a log line: ${forLog}`, stream };
}

// The reason a command line is refused to help, or null. host and tool are the
// host's name and the tool the call came through; background is whether
// Claude Code runs it with run_in_background.
export function helpReason(line, { cwd, host = null, tool = null, background = false, home = os.homedir() }) {
  const simples = simpleCommands(line);
  const owned = new Map();
  const ownerOf = (directory) => {
    if (!owned.has(directory)) owned.set(directory, ownedWorktree(directory));
    return owned.get(directory);
  };
  const inBackground = host === "claude" ? "with run_in_background: true and wait for its completion notification" : "and wait for it to finish";

  // A full verify run by hand, inside an ibni worktree: ibni verify runs the
  // same command with the workspace's ports and slot, and records the result.
  let directory = cwd;
  for (const { argv } of simples) {
    const moved = changedDirectory(argv, directory, home);
    if (moved !== null) {
      directory = moved;
      continue;
    }
    // The session's own verifyCommand may be any command, so ownership is
    // looked up for each directory the line runs in (once per directory).
    const metadata = argv.length ? ownerOf(directory) : null;
    if (metadata && fullVerify(argv, metadata)) {
      return `${argv.join(" ")} runs the full verify by hand inside an ibni worktree, without the workspace's ports, run slot or recorded result; run ibni verify --session ${metadata.sessionId ?? "<sessionId>"} ${inBackground} (targeted checks such as vfk --changed or one test file stay fine)`;
    }
  }

  // Text fixes that compose into one corrected line: quoted globs, and
  // pipefail for checks piped into a filter.
  const globsFound = simples.flatMap((simple) => unquotedGlobs(simple).map((glob) => ({ ...glob, nested: simple.nested })));
  const piped = /pipefail/.test(line) ? null : simples.find((simple) => FILTERS.has(simple.argv[0]) && simple.upstream.some(runsChecks));
  if (globsFound.length || piped) {
    const why = [];
    if (globsFound.length) {
      const braces = globsFound.some(({ words }) => /[{}]/.test(words.at(-1)));
      why.push(`unquoted ${globsFound.map(({ words, shown }) => shown ?? words.join(" ")).join(", ")} would be expanded by zsh before the command sees it, and zsh aborts the whole line when nothing matches; quote each pattern${braces ? ", one per brace entry (grep and find have no brace syntax)" : ""}`);
    }
    if (piped) {
      const checks = piped.upstream.find(runsChecks);
      why.push(`${checks.join(" ")} piped into ${piped.argv[0]} reports ${piped.argv[0]}'s exit status, so a failing run reads as a pass; keep the checks' status with pipefail`);
    }
    const fixedGlobs = globsFound.some(({ nested }) => nested) ? null : replaceGlobs(line, globsFound);
    if (fixedGlobs !== null && !piped?.nested) {
      return `${why.join("; ")}. Run instead: ${piped ? `set -o pipefail; ${fixedGlobs}` : fixedGlobs}`;
    }
    const fixes = [...globsFound.map(({ words, fixed }) => `${fixed} for ${words.join(" ")}`), ...(piped ? [`set -o pipefail; at the start of the script that runs the pipe`] : [])];
    return `${why.join("; ")}. Write ${fixes.join(", and ")}`;
  }

  // Claude Code's Bash in the foreground, waiting in a sleep loop: the call
  // blocks until the wait ends. Monitor runs such loops by design, and Codex
  // and OpenCode have no background tool to offer instead.
  if (host === "claude" && tool === "Bash" && !background) {
    const [loop] = sleepLoops(line);
    if (loop) {
      const { wait, stream } = waitPatterns(line, loop);
      return `a while or until loop that sleeps holds this Bash call in the foreground until the wait ends or the call times out; rerun this exact loop with run_in_background: true, and you get one completion notification when it exits (start a server it waits for in its own Bash call with run_in_background: true). The wait ${wait}, with run_in_background: true. Use the Monitor tool (command, description, timeout_ms) only for a stream of events, such as each matching log line: ${stream}; tail | grep -m1 can hang, so never use it for a one-shot wait`;
    }
  }

  // A plain read of a worktree file through the shell: what the shell shows
  // does not count as a read, so a later edit of the file is refused. Codex
  // has no read tool and reads through the shell.
  if ((host === "claude" && tool === "Bash") || host === "opencode") {
    directory = cwd;
    for (const simple of simples) {
      const moved = changedDirectory(simple.argv, directory, home);
      if (moved !== null) {
        directory = moved;
        continue;
      }
      if (simple.stdoutToFile || simple.nested) continue;
      let read = fileRead(simple);
      // cat file | head -n 20 reads the file as surely as head -n 20 file.
      const [producer] = simple.upstream;
      if (!read && producer?.[0] === "cat" && producer.length === 2 && ["head", "tail", "sed"].includes(simple.argv[0])) {
        const filtered = fileRead({ argv: [...simple.argv, producer[1]], globs: [], expansions: [] });
        read = filtered && { ...filtered, files: [producer[1]] };
      }
      // A file whose output feeds another command is being processed, not read.
      if (!read || (simple.pipesOn && simple.argv[0] === "cat")) continue;
      const worktree = ownerOf(directory)?.worktreePath;
      const file = worktree && read.files.map((name) => path.resolve(directory, name.replace(/^~(?=\/|$)/, home))).find((name) => inside(name, worktree));
      if (file) {
        const others = read.files.length > 1 ? " (and likewise for each other file)" : "";
        return `${simple.argv[0]} shows ${file} through the shell, which does not count as reading it, so a later edit of it is refused until it is read; ${readToolCall(host, file, read)}${others}`;
      }
    }
  }
  return null;
}

// The host a hook runs for, from its --host argument: "claude", "codex" or
// "opencode", or null for anything else.
export function hostFrom(argv) {
  const at = argv.findIndex((arg) => arg === "--host" || arg.startsWith("--host="));
  if (at === -1) return null;
  const value = argv[at].includes("=") ? argv[at].slice(argv[at].indexOf("=") + 1) : argv[at + 1];
  return ["claude", "codex", "opencode"].includes(value) ? value : null;
}

// The message each host hands the agent for a verdict. A red line is never to
// be routed around; a help refusal comes with the command to run instead.
export function refusalMessage({ reason, help }) {
  return help
    ? `mexxi guard refused this command to help, not over a red line: ${reason}. Run the corrected command instead.`
    : `mexxi guard blocked this command: ${reason}. Do not retry it in pieces, rephrase it or route around it; report what was blocked and why it was needed.`;
}

// Host-neutral entry: the tool call in Claude Code's PreToolUse shape, which
// Codex shares and OpenCode's plugin builds. Returns null, or { reason, help }:
// help is true for a refusal that only hands back a corrected command.
export async function guardToolCall(input, { config, home, host = null } = {}) {
  if (!SHELL_TOOLS.has(input?.tool_name)) return null;
  const command = commandLine(input.tool_input?.command);
  if (command === null) {
    return { reason: `could not read the command (expected a string or an array of strings, got ${JSON.stringify(input.tool_input?.command) ?? "nothing"}); refusing it`, help: false };
  }
  const cwd = input.cwd || process.cwd();
  const reason = checkCommand(command, { cwd, config: config ?? await guardConfig(), home });
  if (reason) return { reason, help: false };
  const help = helpReason(command, { cwd, host, tool: input.tool_name, background: input.tool_input?.run_in_background === true, home });
  return help ? { reason: help, help: true } : null;
}

// The shell command line a tool call runs. Codex has sent an argv array
// (["bash", "-lc", "<script>"]); it is quoted word by word so the reader sees
// exactly that argv. Anything else is unreadable: null.
function commandLine(command) {
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || !command.length || !command.every((word) => typeof word === "string")) return null;
  return command.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
}
