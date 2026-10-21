#!/usr/bin/env node
// ibni's entry point: argument parsing and dispatch. Each subcommand lives in
// commands/, and the Git, locking, metadata and config helpers they share in lib/.
import { pathToFileURL } from "node:url";
import { cleanupWorkspaces } from "./commands/cleanup.mjs";
import { workspaceInfo } from "./commands/info.mjs";
import { listWorkspaces } from "./commands/list.mjs";
import { markPullRequest } from "./commands/mark-pr.mjs";
import { prepareWorkspace } from "./commands/prepare.mjs";
import { publishMedia } from "./commands/publish-media.mjs";
import { publishWorkspace } from "./commands/publish.mjs";
import { recordEvidence } from "./commands/record-evidence.mjs";
import { synchronizeWorkspace } from "./commands/sync.mjs";
import { WorkspaceError } from "./lib/errors.mjs";

export {
  cleanupWorkspaces,
  listWorkspaces,
  markPullRequest,
  prepareWorkspace,
  publishMedia,
  publishWorkspace,
  recordEvidence,
  synchronizeWorkspace,
  workspaceInfo,
};

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
    const { operation, options } = parseOptions(args);
    let result;
    if (operation === "prepare") {
      result = await prepareWorkspace({ slug: options.slug, prefix: options.prefix });
    } else if (operation === "sync") {
      result = await synchronizeWorkspace({ sessionId: options.session });
    } else if (operation === "publish") {
      result = await publishWorkspace({ sessionId: options.session });
    } else if (operation === "record-evidence") {
      result = await recordEvidence({ sessionId: options.session });
    } else if (operation === "mark-pr") {
      result = await markPullRequest({ sessionId: options.session, url: options.url });
    } else if (operation === "info") {
      result = await workspaceInfo({ sessionId: options.session });
    } else if (operation === "list") {
      result = await listWorkspaces({});
    } else if (operation === "publish-media") {
      result = await publishMedia({
        sessionId: options.session,
        files: options.files ? options.files.split(",").map((file) => file.trim()).filter(Boolean) : [],
      });
    } else if (operation === "cleanup") {
      result = await cleanupWorkspaces({ dryRun: options["dry-run"] !== "false" });
    } else {
      throw new WorkspaceError(
        "expected prepare, sync, record-evidence, publish, publish-media, mark-pr, info, list, or cleanup",
        "Usage: ibni prepare --slug <name> [--prefix <prefix>]",
      );
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
