import { readFile } from "node:fs/promises";
import { WorkspaceError } from "../lib/errors.mjs";
import { cleanOutput, configuredGithubRepository, run } from "../lib/git.mjs";
import { sessionWorkspace } from "../lib/session.mjs";

export const QA_LABEL = "qa-check";
const MAX_TITLE = 200;

// One check per line; a leading list marker is dropped. Blank lines are ignored.
export function parseChecks(text) {
  const titles = text.split("\n").map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  for (const title of titles) {
    if (title.length > MAX_TITLE) {
      throw new WorkspaceError(`a check is longer than ${MAX_TITLE} characters`, `Write each as a one-line issue title: ${title.slice(0, 60)}...`);
    }
  }
  return titles;
}

const normal = (title) => title.toLowerCase().replace(/\s+/g, " ");

// Files each rendered-QA suggestion ("could become executable checks") as an
// issue labelled qa-check in the session's repository, so they turn into tests
// over time. Titles already open or closed under the label are skipped, which
// makes a repeat delivery safe. Every gh call names the repository with --repo,
// taken from the session remote's configured URL, so gh never guesses it from
// another remote (a fork's upstream, say).
export async function fileQaChecks({ cwd = process.cwd(), sessionId, from }) {
  if (!from) throw new WorkspaceError("file-qa-checks requires --from <file>");
  const { entry: { metadata, worktreePath } } = await sessionWorkspace(cwd, sessionId);
  const text = await readFile(from, "utf8").catch((error) => {
    throw new WorkspaceError(`could not read ${from}`, error.message);
  });
  const checks = parseChecks(text);
  if (checks.length === 0) return { operation: "file-qa-checks", sessionId, created: [], skipped: [] };
  const github = await configuredGithubRepository(worktreePath, metadata.remote);
  if (!github) {
    throw new WorkspaceError(
      `file-qa-checks needs remote ${metadata.remote} to be a GitHub repository to file issues in`,
      "List the suggested checks in the pull request instead.",
    );
  }
  const repository = `${github.owner}/${github.repo}`;
  const gh = (args) => run("gh", [...args, "--repo", repository], { cwd: worktreePath, timeout: 60_000 });
  const labels = JSON.parse(cleanOutput(await gh(["label", "list", "--limit", "200", "--json", "name"])));
  if (!labels.some((label) => label.name === QA_LABEL)) {
    await gh(["label", "create", QA_LABEL, "--color", "0E8A16", "--description", "A check rendered QA suggested, to become an executable test"]);
  }
  const existing = JSON.parse(cleanOutput(await gh(["issue", "list", "--label", QA_LABEL, "--state", "all", "--limit", "500", "--json", "title"])));
  const seen = new Set(existing.map((issue) => normal(issue.title)));

  const created = [];
  const skipped = [];
  const origin = metadata.prUrl ? `the pull request ${metadata.prUrl}` : `branch ${metadata.branch}`;
  for (const title of checks) {
    if (seen.has(normal(title))) {
      skipped.push(title);
      continue;
    }
    seen.add(normal(title));
    const url = cleanOutput(await gh([
      "issue", "create", "--title", title, "--label", QA_LABEL,
      "--body", `Suggested by rendered QA of ${origin}. Make it an executable check in this repository's tests, or close this issue with the reason it should not be one.`,
    ]));
    created.push({ title, url });
  }
  return { operation: "file-qa-checks", sessionId, created, skipped };
}
