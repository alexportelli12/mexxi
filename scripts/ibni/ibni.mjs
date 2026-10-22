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
import { workspaceStats } from "./commands/stats.mjs";
import { triageSession } from "./commands/triage.mjs";
import { synchronizeWorkspace } from "./commands/sync.mjs";
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
  synchronizeWorkspace,
  triageSession,
  workspaceInfo,
  workspaceStats,
};

const SESSION_LOOKUP = "The session's workspace is found from its metadata, so this runs from any directory, including the session's evidenceDir.";

// The registry is the CLI: dispatch, help and the help test all read it, so a
// subcommand cannot exist without a usage line. Lifecycle steps (`timed`) are
// recorded with start, end and outcome in the session's metadata for `stats`.
export const COMMANDS = {
  prepare: {
    usage: "ibni prepare --slug <name> [--prefix <prefix>]",
    summary: "Create an isolated worktree and branch for a new task.",
    details: [
      "Run from the repository's clean primary checkout on its default branch. Fast-forwards it,",
      "sweeps retained workspaces whose pull requests are proven merged, then creates a locked",
      "worktree, its evidenceDir and a free PORT (from workflow.ports in config.json).",
      "verifyCommand is the repository's verify command: verify in its committed .mexxi.json,",
      "or npm run verify when that names none.",
      "If .mexxi.json names a ciCheck (the CI run of its full verify command) and that",
      "check succeeded on exactly the base commit, baseline.reused is true and baseline cites the",
      "run, so the local baseline verify can be skipped; otherwise baseline says why it runs.",
      "Prints sessionId, worktreePath, branch, evidenceDir, port, verifyCommand, baseline, provisionedEnv and cleanup.",
    ],
    options: {
      slug: "Short task name for the branch and worktree folder.",
      prefix: "Branch prefix; defaults to workflow.branchPrefix in config.json.",
    },
    timed: true,
    run: (options) => prepareWorkspace({ slug: options.slug, prefix: options.prefix }),
  },
  sync: {
    usage: "ibni sync --session <id>",
    summary: "Integrate the latest default branch into the session's branch.",
    details: ["Rebases unpublished work, merges into published work, and aborts cleanly on conflict.", SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    run: (options) => synchronizeWorkspace({ sessionId: options.session }),
  },
  "record-evidence": {
    usage: "ibni record-evidence --session <id>",
    summary: "Record that the committed tree passed the gates.",
    details: ["Required before publish; any later commit needs it again.", SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt." },
    timed: true,
    run: (options) => recordEvidence({ sessionId: options.session }),
  },
  publish: {
    usage: "ibni publish --session <id>",
    summary: "Sync, then push the evidenced branch without force.",
    details: [
      "Returns published: false with a nextAction when evidence is missing or stale.",
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
    details: [
      `Allowed file types: ${[...MEDIA_EXTENSIONS].join(", ")}.`,
      "Files must be inside the session's evidenceDir; returns embeddable GitHub URLs.",
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
    details: ["Cleanup only removes a workspace once its recorded pull request is merged.", SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt.", url: "The pull request's URL." },
    timed: true,
    run: (options) => markPullRequest({ sessionId: options.session, url: options.url }),
  },
  "file-qa-checks": {
    usage: "ibni file-qa-checks --session <id> --from <file>",
    summary: "File rendered QA's suggested checks as qa-check issues, skipping duplicates.",
    details: [
      "The file lists one check per line (a leading list marker is dropped); each is an issue title.",
      "Creates the qa-check label if the repository lacks it, then an issue per check whose title",
      "(case-insensitive) is not already open or closed under that label. Safe to repeat.",
      "Prints created (title, url) and skipped titles. Needs an authenticated gh.",
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
    details: [
      "Finds the workspace that recorded this pull request, then proves the PR is open, its head",
      "branch is the workspace's branch, and its head commit equals the recorded publication, the",
      "remote branch and the clean local HEAD. Only then does it print a new sessionId.",
      "Ownership moves rather than being shared: the previous session id stops working at once.",
      "Any failed check changes nothing.",
    ],
    options: { pr: "The pull request's URL, exactly as recorded by mark-pr." },
    timed: true,
    run: (options) => adoptWorkspace({ prUrl: options.pr }),
  },
  info: {
    usage: "ibni info --session <id>",
    summary: "Print one session's workspace: paths, branch, port, verify command, PR and state, plus the review tool config.json sets.",
    details: [SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt." },
    run: (options) => workspaceInfo({ sessionId: options.session }),
  },
  list: {
    usage: "ibni list",
    summary: "List the retained workspaces of the current repository.",
    details: [],
    options: {},
    run: () => listWorkspaces({}),
  },
  record: {
    usage: "ibni record --session <id> (--verify <pass|fail> | --review <count> [--accepted <count> --reviewer <same|cross>] | --qa <count> | --before-shots <taken|skipped>)",
    summary: "Record a verify run, the finding count of a review or QA pass, or the before-shots decision.",
    details: ["One result per call; stats reports them and compares the gates with Jev's triage.", SESSION_LOOKUP],
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
    details: [
      "Sends one batched request to OpenRouter (jev.endpoint, jev.model) with the request text, the",
      "task contract, the changed paths and diff stats against baseSha; never file contents, diffs,",
      "logs, env files or command output. Secrets are redacted first, and the request stays below",
      "jev.maxPayloadBytes by shortening the path list, then the request, then the contract.",
      "Runs only when jev.enabled is true, the push remote's GitHub repository is listed in",
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
    summary: "Print the session's step timings, verify attempts, finding counts and Jev triage as JSON.",
    details: [SESSION_LOOKUP],
    options: { session: "The sessionId from prepare or adopt." },
    run: (options) => workspaceStats({ sessionId: options.session }),
  },
  cleanup: {
    usage: "ibni cleanup [--dry-run false]",
    summary: "Remove workspaces whose pull requests are merged and consumed.",
    details: ["A dry run by default; protects open, dirty, unrecorded and unproven workspaces."],
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
  } catch (error) {
    process.stderr.write(`Implementation workspace error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
