import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceConfig } from "../lib/config.mjs";
import { WorkspaceError } from "../lib/errors.mjs";
import { run } from "../lib/git.mjs";
import { evidenceDirectoryFor } from "../lib/metadata.mjs";
import { sessionWorkspace } from "../lib/session.mjs";

const MODES = new Set(["discovery", "confirmation"]);
const REVIEWER_BODY = fileURLToPath(new URL("../../../agent/code-reviewer.md", import.meta.url));
const REVIEW_TIMEOUT_MS = 20 * 60_000;

// Claude Code's way to a reviewer from another model family: the shared
// code-reviewer instructions run through `codex exec` in a read-only sandbox,
// with the model named by models.claude.crossFamilyReviewer. Anything that
// stops this (no model configured, Codex not installed) returns
// delegated: false with the reason, and the caller uses the same-model
// code-reviewer subagent and states the reason in the pull request's Evidence.
export async function crossReview({ cwd = process.cwd(), sessionId, mode, background, target }) {
  if (!MODES.has(mode)) throw new WorkspaceError("cross-review requires --mode discovery or confirmation");
  if (!background || !target) throw new WorkspaceError("cross-review requires --background <file> and --target <review target>");
  const { entry: { worktreePath } } = await sessionWorkspace(cwd, sessionId);
  const config = await workspaceConfig();
  const model = config.models.claude.crossFamilyReviewer;
  const fallback = (reason) => ({ operation: "cross-review", sessionId, delegated: false, reason });
  if (!model) return fallback("models.claude.crossFamilyReviewer is not set, so the reviewer shares the implementer's model");
  try {
    await run("codex", ["--version"]);
  } catch {
    return fallback("codex is not installed, so the reviewer shares the implementer's model");
  }
  const outputFile = path.join(evidenceDirectoryFor(worktreePath), `cross-review-${mode}.md`);
  const prompt = [
    (await readFile(REVIEWER_BODY, "utf8")).trimEnd(),
    "",
    "# This invocation",
    "",
    "You run through `codex exec` in a read-only sandbox as the independent, cross-family reviewer. Do not edit files.",
    "Your final message is the result described above.",
    "",
    `- Mode: ${mode}`,
    `- Worktree: ${worktreePath}`,
    `- Review target: ${target}`,
    `- Review tool: ${config.review.tool}`,
    `- Background file (read it first): ${path.resolve(background)}`,
    "",
  ].join("\n");
  await run("codex", [
    "exec", "--sandbox", "read-only", "--ephemeral", "--color", "never",
    "-C", worktreePath, "-m", model, "-o", outputFile, "-",
  ], { cwd: worktreePath, input: prompt, timeout: REVIEW_TIMEOUT_MS });
  return { operation: "cross-review", sessionId, delegated: true, model, outputFile, review: await readFile(outputFile, "utf8") };
}
