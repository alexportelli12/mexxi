#!/usr/bin/env node
// ibni's entry point: argument parsing, help and dispatch. Each subcommand lives
// in commands/, and the Git, locking, metadata and config helpers they share in lib/.
import { pathToFileURL } from "node:url";
import { adoptWorkspace } from "./commands/adopt.mjs";
import { cleanupWorkspaces } from "./commands/cleanup.mjs";
import { crossReview } from "./commands/cross-review.mjs";
import { fileQaChecks } from "./commands/file-qa-checks.mjs";
import { workspaceInfo } from "./commands/info.mjs";
import { listWorkspaces } from "./commands/list.mjs";
import { markPullRequest } from "./commands/mark-pr.mjs";
import { prepareWorkspace } from "./commands/prepare.mjs";
import { publishMedia } from "./commands/publish-media.mjs";
import { publishWorkspace } from "./commands/publish.mjs";
import { recordGate } from "./commands/record.mjs";
import { recordEvidence } from "./commands/record-evidence.mjs";
import { setupWorkspace } from "./commands/setup.mjs";
import { workspaceStats } from "./commands/stats.mjs";
import { triageSession } from "./commands/triage.mjs";
import { synchronizeWorkspace } from "./commands/sync.mjs";
import { verifyWorkspace } from "./commands/verify.mjs";
import { WorkspaceError } from "./lib/errors.mjs";
import { MEDIA_EXTENSIONS } from "./lib/media.mjs";
import { recordStep } from "./lib/timings.mjs";

export {
  adoptWorkspace,
  cleanupWorkspaces,
  crossReview,
  fileQaChecks,
  listWorkspaces,
  markPullRequest,
  prepareWorkspace,
  publishMedia,
  publishWorkspace,
  recordEvidence,
  recordGate,
  setupWorkspace,
  synchronizeWorkspace,
  triageSession,
  verifyWorkspace,
  workspaceInfo,
  workspaceStats,
};

const SESSION_LOOKUP = "The session's workspace is found from its metadata, so this runs from any directory, including the session's evidenceDir.";

// The registry is the CLI: dispatch, help and the help test all read it, so a
// subcommand cannot exist without a usage line or a `why`, the problem it
// solves, which its help and the docs both show. Lifecycle steps (`timed`) are
// recorded with start, end and outcome in the session's metadata for `stats`.
// A command with `failed` exits 1 when its JSON reports a failure, so a
// background run's exit status alone says whether it passed.
export const COMMANDS = {
  prepare: {
    usage: "ibni prepare --slug <name> [--prefix <prefix>]",
    summary: "Create an isolated worktree and branch for a new task.",
    why: "An agent working in your checkout trips over your own work and over other tasks, so each task starts in its own worktree.",
    details: [
      "Run from the repository's clean primary checkout on its default branch. Fast-forwards it,",
      "sweeps retained workspaces whose pull requests are proven merged, then creates a locked",
      "worktree, its evidenceDir and a free block of ports (workflow.ports in config.json), chosen under",
      "a machine-wide lock so no two workspaces in any repository share one. port is the block's first;",
      "portEnv is what setup and verify get: PORT, MEXXI_PORT_0..<blockSize-1>, and the variables",
      "workflow.portVariables maps for this repository.",
      "verifyCommand is the repository's verify command: verify in its committed .mexxi.json,",
      "or npm run verify when that names none.",
      "Then installs dependencies in the new worktree, without holding the repository lock: setup in",
      ".mexxi.json, or the root lockfile's own install (package-lock.json: npm ci --prefer-offline",
      "--no-audit --no-fund; pnpm-lock.yaml: pnpm install --frozen-lockfile --prefer-offline). With",
      "neither, or more than one lockfile, setup.ran is false and setup.reason says why. The log goes",
      "to evidenceDir/setup.log. A failed setup rolls the new workspace back and prints the log's end.",
      "If .mexxi.json names a ciCheck (the CI run of its full verify command) and that",
      "check succeeded on exactly the base commit, baseline.reused is true and baseline cites the",
      "run, so the local baseline verify can be skipped; otherwise baseline says why it runs.",
      "forge is github or gitlab, from the push remote's host, forge.hosts in config.json or",
      "\"forge\" in .mexxi.json; null when none is known, and forgeReason then says why.",
      "Prints sessionId, worktreePath, branch, baseSha, forge, evidenceDir, port, ports, portEnv, verifyCommand, baseline, setup, provisionedEnv and cleanup.",
    ],
    options: {
      slug: "Short task name for the branch and worktree folder.",
      prefix: "Branch prefix; defaults to workflow.branchPrefix in config.json.",
    },
    timed: true,
    run: (options) => prepareWorkspace({ slug: options.slug, prefix: options.prefix }),
  },
  setup: {
    usage: "ibni setup --session <id>",
    summary: "Install the session's dependencies in its worktree.",
    why: "Each worktree needs its own dependencies, installed exactly as the repository pins them, before its checks can run.",
    details: [
      "When adopt reports dependencies.current false, or after a commit changes a lockfile. Resolves",
      "the command as prepare does: setup in the default branch's .mexxi.json, else the lockfile at HEAD. Never",
      "reinstalls on its own. The lock is not held during the install, which gets the workspace's",
      "portEnv. Writes evidenceDir/setup.log",
      "and prints setup (ran, command, source, passed, exitCode, durationMs, logPath, and logTail",
      "when it failed). Exits 1 when the install fails.",
      SESSION_LOOKUP,
    ],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    failed: (result) => result.setup.ran && !result.setup.passed,
    run: (options) => setupWorkspace({ sessionId: options.session }),
  },
  verify: {
    usage: "ibni verify --session <id>",
    summary: "Run the repository's verify command on the committed tree and record the result.",
    why: "A push should carry only code that passed the repository's checks, so ibni runs them itself rather than taking the agent's word.",
    details: [
      "Runs the session's verifyCommand from the worktree root and refuses on a dirty tree, so the",
      "result belongs to one committed tree. Before the first commit the tree is baseSha's, so this is",
      "the baseline run; when prepare reported baseline.reused, that CI run is recorded instead",
      "(reused) and nothing runs. The command gets the workspace's portEnv, and ibni refuses to start it",
      "while any port of the block is bound, so a test server never fails half-way on a taken port.",
      "The output goes to evidenceDir/verify-<tree>.log, never to stdout,",
      "and the lock is held only to check and record, so it is safe to run in the background.",
      "When the default branch has no verify command at all (no verify in .mexxi.json, no verify",
      "script in package.json), the one this branch's .mexxi.json names runs instead, and",
      "commandSource is branch; a branch never replaces a gate the default branch already has.",
      "Records verification (treeSha, headSha, passed, exitCode, durationMs, logPath, ranAt) and a",
      "verify entry for stats. A commit or edit while it runs leaves the result unrecorded.",
      "Prints one line of JSON at the end, with logTail when it failed; exits 1 unless it passed and was recorded.",
      SESSION_LOOKUP,
    ],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    failed: (result) => !result.passed || !result.recorded,
    run: (options) => verifyWorkspace({ sessionId: options.session }),
  },
  sync: {
    usage: "ibni sync --session <id>",
    summary: "Integrate the latest default branch into the session's branch.",
    why: "The default branch moves on while a task runs, so the task's branch has to catch up without losing work; on a conflict it stops and changes nothing.",
    details: ["Rebases unpublished work, merges into published work, and aborts cleanly on conflict.", SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    run: (options) => synchronizeWorkspace({ sessionId: options.session }),
  },
  "record-evidence": {
    usage: "ibni record-evidence --session <id>",
    summary: "Record that the committed tree passed the gates.",
    why: "A push should carry only code that passed the checks, so this records exactly which code that was.",
    details: [
      "Required before publish; any later commit needs it again. Refuses (recorded: false,",
      "requiresVerify: true, with a nextAction) unless ibni verify passed on exactly this tree.",
      SESSION_LOOKUP,
    ],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    run: (options) => recordEvidence({ sessionId: options.session }),
  },
  publish: {
    usage: "ibni publish --session <id>",
    summary: "Sync, then push the evidenced branch without force.",
    why: "Pushing is where an agent can do the most damage, so it happens one safe way: never forced, and only the recorded code.",
    details: [
      "Returns published: false with a nextAction when evidence is missing or stale, or when",
      "ibni verify has not passed on the tree it would push (requiresVerify: true).",
      "A push failing with an HTTP 5xx from the Git host is retried once.",
      SESSION_LOOKUP,
    ],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    run: (options) => publishWorkspace({ sessionId: options.session }),
  },
  "publish-media": {
    usage: "ibni publish-media --session <id> [--files <a.png,b.gif>]",
    summary: "Publish screenshots and recordings from evidenceDir to the pr-media branch.",
    why: "Screenshots belong in the pull request, not in the code, so they go to a separate pr-media branch in the same repository.",
    details: [
      `Allowed file types: ${[...MEDIA_EXTENSIONS].join(", ")}.`,
      "Files must be inside the session's evidenceDir; returns embeddable GitHub or GitLab URLs.",
      SESSION_LOOKUP,
    ],
    options: {
      session: "The sessionId from prepare or adopt.",
      files: "Comma-separated paths relative to evidenceDir; defaults to every media file in it.",
    },
    timed: true,
    run: (options) => publishMedia({
      sessionId: options.session,
      files: options.files ? options.files.split(",").map((file) => file.trim()).filter(Boolean) : [],
    }),
  },
  "mark-pr": {
    usage: "ibni mark-pr --session <id> --url <pull-request-url>",
    summary: "Record the pull request for a published session.",
    why: "Cleanup must never remove a worktree whose pull request is still open, so this records which pull request a worktree belongs to.",
    details: ["Cleanup only removes a workspace once its recorded pull request is merged.", SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt.", url: "The pull request's URL." },
    timed: true,
    run: (options) => markPullRequest({ sessionId: options.session, url: options.url }),
  },
  "file-qa-checks": {
    usage: "ibni file-qa-checks --session <id> --from <file>",
    summary: "File rendered QA's suggested checks as qa-check issues, skipping duplicates.",
    why: "A browser check that keeps finding the same kind of problem should become an automated test, not be repeated by hand.",
    details: [
      "The file lists one check per line (a leading list marker is dropped); each is an issue title.",
      "Creates the qa-check label if the repository lacks it, then an issue per check whose title",
      "(case-insensitive) is not already open or closed under that label. Safe to repeat.",
      "Prints created (title, url) and skipped titles. Needs an authenticated gh (GitHub) or glab (GitLab).",
      SESSION_LOOKUP,
    ],
    options: {
      session: "The sessionId from prepare or adopt.",
      from: "File of checks, one per line.",
    },
    timed: true,
    run: (options) => fileQaChecks({ sessionId: options.session, from: options.from }),
  },
  "cross-review": {
    usage: "ibni cross-review --session <id> --mode <discovery|confirmation> --background <file> --target <text>",
    summary: "Run the code-reviewer through codex exec in a read-only sandbox (Claude Code only).",
    why: "A reviewer from the builder's own model family shares its blind spots.",
    details: [
      "For Claude Code, whose implementer and reviewer would otherwise share a model family. Runs the",
      "shared code-reviewer instructions with models.claude.crossFamilyReviewer as the Codex model,",
      "writes the reviewer's final message to evidenceDir/cross-review-<mode>.md and prints it as review.",
      "Prints delegated: false with a reason when no model is configured or codex is not installed;",
      "then use the code-reviewer subagent and state the reason in the pull request's Evidence.",
      SESSION_LOOKUP,
    ],
    options: {
      session: "The sessionId from prepare or adopt.",
      mode: "discovery or confirmation, as for code-reviewer.",
      background: "The background file the reviewer reads first (requirements, and for confirmation the ledger and fixes).",
      target: "The review target, such as workspace changes against HEAD or a branch range.",
    },
    timed: true,
    run: (options) => crossReview({ sessionId: options.session, mode: options.mode, background: options.background, target: options.target }),
  },
  adopt: {
    usage: "ibni adopt --pr <pull-request-url>",
    summary: "Take over the retained workspace of an open pull request from a new session.",
    why: "When you continue a pull request from a new session, /wettaq runs this to pick up its worktree, and only when the worktree provably belongs to that pull request.",
    details: [
      "Finds the workspace that recorded this pull request, then proves the PR is open, its head",
      "branch is the workspace's branch, and its head commit equals the recorded publication, the",
      "remote branch and the clean local HEAD. Only then does it print a new sessionId.",
      "Ownership moves rather than being shared: the previous session id stops working at once.",
      "Any failed check changes nothing.",
      "Also reports dependencies (whether the worktree's lockfiles match the last recorded setup;",
      "current null when it predates ibni setup) and verified (whether ibni verify passed on HEAD's",
      "tree), each with a nextAction when not. It never reinstalls or verifies on its own.",
    ],
    options: { pr: "The pull request's URL, exactly as recorded by mark-pr." },
    timed: true,
    run: (options) => adoptWorkspace({ prUrl: options.pr }),
  },
  info: {
    usage: "ibni info --session <id>",
    summary: "Print one session's workspace: paths, branch, port block, verify command, PR, state and forge, plus the review tool config.json sets.",
    why: "A later step, or you, needs a session's paths, port and pull request without guessing them.",
    details: [
      "ports is the workspace's block (first, size, last) and portEnv the variables setup and verify get;",
      "export them when starting a server by hand.",
      SESSION_LOOKUP,
    ],
    options: { session: "The sessionId from prepare or adopt." },
    run: (options) => workspaceInfo({ sessionId: options.session }),
  },
  list: {
    usage: "ibni list",
    summary: "List the retained workspaces of the current repository.",
    why: "Worktrees are kept for follow-up changes, so you need to see which ones exist and why.",
    details: [],
    options: {},
    run: () => listWorkspaces({}),
  },
  record: {
    usage: "ibni record --session <id> (--verify <pass|fail> | --review <count> [--accepted <count> --reviewer <same|cross>] | --qa <count> | --before-shots <taken|skipped>)",
    summary: "Record a verify run, the finding count of a review or QA pass, or the before-shots decision.",
    why: "The agent records each verify run, browser check and review as it finishes, so ibni stats and /irrifletti can show how runs went.",
    details: [
      "One result per call; stats reports them and compares the gates with Jev's triage.",
      "ibni verify records its own runs; --verify is for a host that runs the verify command another",
      "way, and never satisfies the record-evidence or publish gate.",
      SESSION_LOOKUP,
    ],
    options: {
      session: "The sessionId from prepare or adopt.",
      verify: "Outcome of a full run of the repository's verify command: pass or fail.",
      review: "Number of findings an independent review pass returned.",
      accepted: "With --review: how many of those findings you accepted (fixed).",
      reviewer: "With --review: same if the reviewer shares your model family, cross if it does not (cross-review delegated).",
      qa: "Number of findings a rendered QA pass returned.",
      "before-shots": "Whether before-shots of existing UI were taken or skipped.",
    },
    run: (options) => recordGate({
      sessionId: options.session,
      verify: options.verify,
      review: options.review,
      qa: options.qa,
      beforeShots: options["before-shots"],
      accepted: options.accepted,
      reviewer: options.reviewer,
    }),
  },
  triage: {
    usage: "ibni triage --session <id> --request-file <file> --contract-file <file>",
    summary: "Ask Jev which gates the change needs, and record the answers (shadow: nothing changes).",
    why: "Experimental: it tests whether an outside decision model would choose a task's checks better than the agent, without letting it change anything.",
    details: [
      "Sends one batched request to OpenRouter (jev.endpoint, jev.model) with the request text, the",
      "task contract, the changed paths and diff stats against baseSha; never file contents, diffs,",
      "logs, env files or command output. Secrets are redacted first, and the request stays below",
      "jev.maxPayloadBytes by shortening the path list, then the request, then the contract.",
      "Runs only when jev.enabled is true, the push remote's github.com repository is listed in",
      "jev.repositories and owned by one of jev.owners, and OPENROUTER_API_KEY is set.",
      "Always exits 0 once the session is found: a skip, timeout, 429 (retried once), HTTP error or",
      "malformed answer prints outcome skipped or failed with a reason, and the run carries on.",
      "Prints the outcome only; the answers go to session metadata, where stats reports them",
      "beside the agent's own gate choices.",
      SESSION_LOOKUP,
    ],
    options: {
      session: "The sessionId from prepare or adopt.",
      "request-file": "File holding the user's request text.",
      "contract-file": "File holding the active task contract.",
    },
    run: (options) => triageSession({ sessionId: options.session, requestFile: options["request-file"], contractFile: options["contract-file"] }),
  },
  stats: {
    usage: "ibni stats --session <id>",
    summary: "Print the session's step timings, setup, verify attempts, finding counts and Jev triage as JSON.",
    why: "You need to see where a run spent its time and how often its checks failed.",
    details: [SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt." },
    run: (options) => workspaceStats({ sessionId: options.session }),
  },
  cleanup: {
    usage: "ibni cleanup [--dry-run false]",
    summary: "Remove workspaces whose pull requests have merged into the default branch.",
    why: "Kept worktrees take disk space once their pull requests have merged.",
    details: ["A dry run by default. Keeps a workspace whose pull request is still open, whose worktree has uncommitted changes, that has no recorded pull request, or whose merge it cannot confirm."],
    options: { "dry-run": "false to remove; anything else only reports." },
    run: (options) => cleanupWorkspaces({ dryRun: options["dry-run"] !== "false" }),
  },
};

const HELP_FLAGS = new Set(["--help", "-h"]);

export function toolHelp() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    "Usage: ibni <command> [options]",
    "",
    "Isolated worktrees per task, through to a published pull request. Output is JSON.",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
    "",
    "Run ibni <command> --help for its options.",
  ].join("\n");
}

export function commandHelp(name) {
  const command = COMMANDS[name];
  const options = Object.entries(command.options);
  const width = Math.max(0, ...options.map(([option]) => option.length + 2));
  return [
    `Usage: ${command.usage}`,
    "",
    command.summary,
    ...(command.why ? ["", `Why: ${command.why}`] : []),
    ...(command.details.length ? ["", ...command.details] : []),
    ...(options.length ? ["", "Options:", ...options.map(([option, text]) => `  ${`--${option}`.padEnd(width)}  ${text}`)] : []),
  ].join("\n");
}

function parseOptions(args) {
  const [operation, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new WorkspaceError(`invalid argument ${key ?? ""}`.trim());
    }
    options[key.slice(2)] = value;
  }
  return { operation, options };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const [first, second] = args;
    if (HELP_FLAGS.has(first) || (first === "help" && !second)) {
      process.stdout.write(`${toolHelp()}\n`);
      return;
    }
    if (first === "help" && Object.hasOwn(COMMANDS, second)) {
      process.stdout.write(`${commandHelp(second)}\n`);
      return;
    }
    if (!Object.hasOwn(COMMANDS, first)) {
      throw new WorkspaceError(
        `expected ${Object.keys(COMMANDS).join(", ")}`,
        "Usage: ibni prepare --slug <name> [--prefix <prefix>]\nRun ibni --help for every command.",
      );
    }
    if (args.some((arg) => HELP_FLAGS.has(arg))) {
      process.stdout.write(`${commandHelp(first)}\n`);
      return;
    }
    const { operation, options } = parseOptions(args);
    const command = COMMANDS[operation];
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await command.run(options);
    } catch (error) {
      if (command.timed) await recordStep({ cwd: process.cwd(), sessionId: options.session, step: operation, startedAt, error });
      throw error;
    }
    if (command.timed) {
      await recordStep({ cwd: process.cwd(), sessionId: result.sessionId ?? options.session, step: operation, startedAt, result });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (command.failed?.(result)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Implementation workspace error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
