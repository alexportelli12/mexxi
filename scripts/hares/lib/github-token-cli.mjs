// `hares github-token set|remove [--state-dir <dir>]`: stores or removes the token readiness reads GitHub with.
// `set` reads the token from stdin, so it never lands in shell history or a process list.
import path from "node:path";
import { removeGithubToken, saveGithubToken } from "./github.mjs";
import { stateDir as defaultStateDir } from "./paths.mjs";

const USAGE = "usage: hares github-token set|remove [--state-dir <dir>]   (set reads the token from stdin)";

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {string[]} args the arguments after `github-token`
 * @param {{ stdin?: AsyncIterable<Buffer|string>, stderr?: { write(text: string): void } }} [io]
 */
export async function runGithubToken(args, { stdin = process.stdin, stderr = process.stderr } = {}) {
  try {
    const [command, flag, value, ...rest] = args;
    if (!["set", "remove"].includes(command) || rest.length || (flag !== undefined && (flag !== "--state-dir" || !value))) throw new Error(USAGE);
    const dir = value ? path.resolve(value) : defaultStateDir();
    if (command === "remove") {
      removeGithubToken(dir);
      stderr.write("hares: removed the GitHub token. Readiness now reports every run as not ready, with the reason.\n");
      return;
    }
    if (stdin.isTTY) stderr.write("Paste the fine-grained token, then press Enter and Ctrl-D:\n");
    saveGithubToken(dir, await readAll(stdin));
    stderr.write("hares: stored the GitHub token, readable only by you. hares reads it on each check, so no restart is needed.\n");
  } catch (error) {
    stderr.write(`hares: ${error.message}\n`);
    process.exitCode = 2;
  }
}
