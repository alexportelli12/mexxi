// A plain-words risk label for a call that needs a person's answer. The label
// is a hint for reading the exact command, never a reason to skip reading it.
import path from "node:path";

export const RISK_LABELS = {
  network: "Reaches the internet",
  "git-remote": "Talks to GitHub or another Git remote",
  "write-in-worktree": "Changes a file in this run's worktree",
  read: "Reads files",
  other: "Something else: read the command",
};

const NETWORK = /\b(?:curl|wget|nc|ssh|scp|rsync|ftp)\b|https?:\/\//;
const GIT_REMOTE = /\bgit\s+(?:push|pull|fetch|clone|remote)\b|(?:^|[\s;&|(])gh\s/;
const READ_ONLY_START = /^(?:ls|cat|head|tail|grep|rg|wc|pwd|stat|file|tree|du|df)\b/;
const NOT_READ_ONLY = /[>;&`]|\$\(|\|\s*(?:tee|sh|bash)\b/;
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

const filePath = (input) => String(input?.file_path ?? input?.notebook_path ?? input?.path ?? "");

function isUnder(file, root) {
  if (!file || !root || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** @returns {"network"|"git-remote"|"write-in-worktree"|"read"|"other"} */
export function classifyRisk({ tool, input = {}, worktreeRoot }) {
  if (tool === "WebFetch" || tool === "WebSearch") return "network";
  if (tool === "Bash") {
    const command = String(input.command ?? "");
    if (NETWORK.test(command)) return "network";
    if (GIT_REMOTE.test(command)) return "git-remote";
    if (READ_ONLY_START.test(command.trim()) && !NOT_READ_ONLY.test(command)) return "read";
    return "other";
  }
  if (WRITE_TOOLS.has(tool)) return isUnder(filePath(input), worktreeRoot) ? "write-in-worktree" : "other";
  if (READ_TOOLS.has(tool)) return "read";
  return "other";
}
