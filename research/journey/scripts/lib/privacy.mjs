// What may be published: repository names the owner listed, anonymous labels
// for every other repository, and nothing that looks like a path, host,
// address or secret. scanForLeaks is the last gate before files are written.
import { redact } from "../../../../scripts/lib/redact.mjs";

// Repositories the owner named for publication, plus public ones.
export const PUBLIC_REPOS = new Set(["mexxi", "verifika", "eduline-ai-shop", "constitution-explained", "coding-agent-config", "mexxi-demo"]);

// Which repository a session worked in, from its working directory. known is
// the list of repository directory names on this machine; a second checkout
// named <repo>-<suffix> (mexxi-upgrade) belongs to <repo>. No private
// repository name may appear in this code, so there is no alias table.
export function repoFromCwd(cwd, home, known) {
  if (!cwd) return "unknown";
  const rel = cwd.startsWith(home) ? cwd.slice(home.length).replace(/^\//, "") : null;
  if (cwd.startsWith("/tmp/") || cwd === "/tmp") return "scratch";
  if (rel === null) return "unknown";
  if (rel === "") return "home";
  if (/^\.(?:config\/opencode|claude|codex)(?:\/|$)/.test(rel)) return "global-config";
  const worktree = rel.match(/^\.local\/share\/(?:mexxi|opencode|coding-agent)\/(?:implementation-)?worktrees\/([^/]+)/);
  const workspace = rel.match(/^workspace\/([^/]+)/);
  const name = worktree ? worktree[1].replace(/-[0-9a-f]{10}$/, "") : workspace?.[1];
  if (!name) return "unknown";
  if (known.includes(name)) return name;
  const prefix = known.filter((repo) => name.startsWith(`${repo}-`)).sort((a, b) => b.length - a.length)[0];
  return prefix ?? "unknown";
}

// Labels for publication: listed names stay, others become "private repo A",
// "private repo B" and so on, lettered by first commit date so the letters
// stay the same from run to run.
export function publicLabels(repos) {
  const labels = new Map();
  let next = 0;
  const ordered = [...repos].sort((a, b) => (a.firstCommit ?? "9999").localeCompare(b.firstCommit ?? "9999") || a.name.localeCompare(b.name));
  for (const { name } of ordered) {
    if (PUBLIC_REPOS.has(name)) labels.set(name, name);
    else labels.set(name, `private repo ${String.fromCharCode(65 + next++)}`);
  }
  for (const label of ["global-config", "home", "unknown", "scratch"]) labels.set(label, label);
  return labels;
}

const LEAKS = [
  { name: "home path", regex: /\/home\/[\w.-]+|~\/(?:workspace|\.local|\.claude|\.config)/ },
  { name: "temp path", regex: /\/tmp\/[\w.-]+/ },
  { name: "email", regex: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { name: "IPv4 address", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: "cloud host", regex: /\b[\w-]+\.(?:cloudfunctions\.net|run\.app|web\.app|firebaseapp\.com|supabase\.co)\b/ },
];

// Every problem in a text that is about to be published. privateNames are
// repository names that must not appear.
export function scanForLeaks(text, privateNames = []) {
  const problems = [];
  if (redact(text).count) problems.push("secret pattern");
  for (const { name, regex } of LEAKS) if (regex.test(text)) problems.push(name);
  for (const repo of privateNames) {
    if (new RegExp(`(?<![\\w-])${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text)) problems.push(`private repository name ${repo}`);
  }
  return problems;
}
