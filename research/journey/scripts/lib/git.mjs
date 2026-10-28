// Milestones and backpack sizes from Git history. Everything here reads
// commits, paths and counts; file contents are read to count lines and rules
// and are never returned.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function git(repo, args) {
  try {
    const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

const day = (iso) => iso.slice(0, 10);

// The first commit matching a git-log query, oldest first.
async function first(repo, args) {
  const line = (await git(repo, ["log", "--reverse", "--format=%aI %h", ...args])).split("\n").find(Boolean);
  if (!line) return null;
  const [date, commit] = line.split(" ");
  return { date: day(date), commit };
}

// Agent attribution trailers Claude Code, OpenCode and Codex write.
const AGENT_TRAILER = "co-authored-by: (claude|codex|opencode)|generated with \\[?(claude|opencode)";
export const INSTRUCTION_PATHS = /(?:^|\/)(?:AGENTS|CLAUDE)\.md$|^\.github\/copilot-instructions\.md$|^\.cursorrules$|^\.claude\/rules\/[^/]+\.md$/;
// Workflow prose loaded when a command or agent runs rather than always:
// slash commands and agent definitions, in mexxi and in project repositories.
export const WORKFLOW_PATHS = /^(?:commands|agent)\/[^/]+\.md$|(?:^|\/)\.(?:claude|opencode)\/(?:commands?|agents?)\/[^/]+\.md$/;
export const SKILL_PATH = /(?:^|\/)SKILL\.md$/;
const IGNORED = /(?:^|\/)(?:node_modules|\.git|dist|vendor)\//;
const LINT_PATH = /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[a-z]+)?)$/;
const STRICT_LINT_MESSAGE = /eslint (?:hardening|strict)|strict(?:er)? lint|tighten\w* (?:the )?(?:eslint|lint)|lint(?:ing)? harden/i;

// The commit that first added a "verify" script, confirmed by the diff.
async function firstVerifyScript(repo) {
  const candidates = (await git(repo, ["log", "--reverse", "--format=%aI %h", "-S\"verify\"", "--", "package.json"])).split("\n").filter(Boolean);
  for (const line of candidates) {
    const [date, commit] = line.split(" ");
    const diff = await git(repo, ["show", commit, "--format=", "--", "package.json"]);
    if (/^\+\s*"verify"\s*:/m.test(diff)) return { date: day(date), commit };
  }
  return null;
}

async function firstStrictLint(repo) {
  const lines = (await git(repo, ["log", "--reverse", "--format=%aI %h %s", "--", "eslint.config.*", ".eslintrc*", "**/eslint.config.*"])).split("\n").filter(Boolean);
  for (const line of lines) {
    const [date, commit, ...subject] = line.split(" ");
    if (STRICT_LINT_MESSAGE.test(subject.join(" "))) return { date: day(date), commit };
  }
  return null;
}

// Per-repository dates of each milestone that Git can show.
export async function repoMilestones(repo) {
  return {
    firstCommit: await first(repo, []),
    agentCommit: await first(repo, ["-i", "-E", `--grep=${AGENT_TRAILER}`]),
    instructions: await first(repo, ["--diff-filter=A", "--", "AGENTS.md", "CLAUDE.md", "**/AGENTS.md", "**/CLAUDE.md"]),
    skill: await first(repo, ["--diff-filter=A", "--", "**/SKILL.md"]),
    verifyScript: await firstVerifyScript(repo),
    strictLint: await firstStrictLint(repo),
    verifika: await first(repo, ["--diff-filter=A", "--", "verifika.config.json"]),
    mexxiConfig: await first(repo, ["--diff-filter=A", "--", ".mexxi.json"]),
  };
}

// mexxi's own milestones: files whose first appearance dates a tool.
export const MEXXI_TOOL_FILES = {
  worktreeCli: ["scripts/implementation-workspace.mjs"],
  ibni: ["scripts/ibni/ibni.mjs", "scripts/ibni/commands/prepare.mjs"],
  portBlocks: ["docs/decisions/0017-workspace-port-blocks.md"],
  runSlots: ["docs/decisions/0018-machine-wide-run-slots.md"],
  commandFixer: ["claude/mods/command-fixer/hooks/fix.ts", "claude/mods/command-fixer/hooks/fix.mjs"],
  loopBreaker: ["scripts/hooks/loop-breaker.mjs"],
  licence: ["LICENSE"],
  docsSite: ["site/index.html"],
};

export async function mexxiToolDates(repo) {
  const dates = {};
  for (const [id, paths] of Object.entries(MEXXI_TOOL_FILES)) dates[id] = await first(repo, ["--diff-filter=A", "--", ...paths]);
  return dates;
}

// --- Backpack -------------------------------------------------------------

// A line that tells the agent to do or not do something.
export const DIRECTIVE = /\b(?:always|never|must|do not|don't|avoid|prefer|only|make sure|ensure|should|instead of|before (?:you|any|the|making|changing|editing))\b/i;

// Instruction text, split into its directive lines. Code fences are skipped:
// they hold examples, not rules.
export function countRules(text) {
  let fenced = false;
  let lines = 0;
  let rules = 0;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.trim()) continue;
    lines += 1;
    if (DIRECTIVE.test(line) && !/^\s*#/.test(line)) rules += 1;
  }
  return { lines, rules };
}

// The description a host keeps in context for every skill, so the agent can
// decide when to load it: always-loaded text even when the skill is not used.
export function skillDescription(text) {
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  if (!front) return "";
  const match = front[1].match(/^description:\s*(?:[>|][-+]?\s*\n((?:[ \t]+.*\n?)+)|(.*))/m);
  if (!match) return "";
  return (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
}

// Concerns that started as prose and may have moved into a tool. prose finds
// the concern in instruction text; tool says what took it over, checked
// against the repository's files at the snapshot (see toolsAt).
export const CONCERNS = [
  { id: "run-checks-before-done", prose: /\b(?:run|ran)\b[^.\n]{0,40}\b(?:tests?|lint|checks?|verify|build)\b|before (?:saying|claiming|reporting)[^.\n]{0,30}\b(?:done|complete)/i, tool: "verify script" },
  { id: "formatting", prose: /\bprettier\b|\bformat(?:ting|ted)?\b[^.\n]{0,30}\b(?:code|files?|consistent)/i, tool: "format check in verify" },
  { id: "code-patterns", prose: /\bany\b[^.\n]{0,15}\btype|\bno console|import order|explicit (?:return )?types?|naming convention|max(?:imum)? (?:lines|length|params)|\bOnPush\b|standalone components?|signals? (?:over|instead)/i, tool: "lint rule" },
  { id: "complexity-coverage", prose: /\bcoverage\b|\bcomplexity\b|\bCRAP\b/i, tool: "coverage or CRAP gate" },
  { id: "isolated-workspace", prose: /\bworktree\b/i, tool: "ibni prepare" },
  { id: "ports", prose: /\bports?\b/i, tool: "ibni port blocks" },
  { id: "long-runs-and-waits", prose: /run_in_background|\bsleep\b|long[- ]running|\bpoll(?:ing)?\b/i, tool: "run slots and Monitor rule" },
  { id: "shell-quoting-and-exit-codes", prose: /\bglob\b|\bquote\b|pipefail|exit (?:code|status)/i, tool: "command fixer" },
];

async function treeAt(repo, date) {
  const commit = (await git(repo, ["rev-list", "-1", `--before=${date}T23:59:59`, "HEAD"])).trim();
  if (!commit) return null;
  const paths = (await git(repo, ["ls-tree", "-r", "--name-only", commit])).split("\n").filter((p) => p && !IGNORED.test(p));
  return { commit, paths };
}

async function show(repo, commit, file) {
  return git(repo, ["show", `${commit}:${file}`]);
}

// Which concerns a repository's own files enforce at a commit.
async function toolsAt(repo, tree, { mexxi }) {
  const enforced = new Set();
  const pkgText = tree.paths.includes("package.json") ? await show(repo, tree.commit, "package.json") : "";
  let scripts = {};
  try {
    scripts = JSON.parse(pkgText || "{}").scripts ?? {};
  } catch {
    scripts = {};
  }
  const verify = scripts.verify ?? "";
  const all = Object.values(scripts).join(" ");
  if (verify || tree.paths.includes("verifika.config.json")) enforced.add("run-checks-before-done");
  if (/format|prettier/.test(verify) || /prettier --check|format:check/.test(all)) enforced.add("formatting");
  if (/crap|coverage/i.test(all)) enforced.add("complexity-coverage");
  const lintConfigs = tree.paths.filter((p) => LINT_PATH.test(p));
  let lintErrors = 0;
  for (const file of lintConfigs) lintErrors += ((await show(repo, tree.commit, file)).match(/["']error["']|:\s*2\b/g) ?? []).length;
  if (lintErrors > 0) enforced.add("code-patterns");
  if (mexxi) {
    const has = (prefix) => tree.paths.some((p) => p.startsWith(prefix));
    if (has("scripts/implementation-workspace") || has("scripts/ibni/")) enforced.add("isolated-workspace");
    if (tree.paths.includes(MEXXI_TOOL_FILES.portBlocks[0])) enforced.add("ports");
    if (tree.paths.includes(MEXXI_TOOL_FILES.runSlots[0])) enforced.add("long-runs-and-waits");
    if (has("claude/mods/command-fixer/")) enforced.add("shell-quoting-and-exit-codes");
  }
  return { enforced, lintErrors };
}

// One backpack row for a repository at a date: instruction size and how many
// tracked concerns its tools enforce by then.
export async function backpackAt(repo, date, { mexxi = false } = {}) {
  const tree = await treeAt(repo, date);
  if (!tree) return null;
  let lines = 0;
  let rules = 0;
  const prose = new Set();
  for (const file of tree.paths.filter((p) => INSTRUCTION_PATHS.test(p))) {
    const text = await show(repo, tree.commit, file);
    const counted = countRules(text);
    lines += counted.lines;
    rules += counted.rules;
    for (const concern of CONCERNS) if (concern.prose.test(text)) prose.add(concern.id);
  }
  let workflowLines = 0;
  let workflowRules = 0;
  for (const file of tree.paths.filter((p) => WORKFLOW_PATHS.test(p))) {
    const counted = countRules(await show(repo, tree.commit, file));
    workflowLines += counted.lines;
    workflowRules += counted.rules;
  }
  const skills = tree.paths.filter((p) => SKILL_PATH.test(p) && !/(?:^|\/)(?:evals?|tests?|fixtures?)\//.test(p));
  let skillDescriptionWords = 0;
  let skillLines = 0;
  for (const file of skills) {
    const text = await show(repo, tree.commit, file);
    skillDescriptionWords += skillDescription(text).split(/\s+/).filter(Boolean).length;
    skillLines += text.split("\n").length;
  }
  const { enforced, lintErrors } = await toolsAt(repo, tree, { mexxi });
  return {
    commit: tree.commit.slice(0, 7),
    instructionLines: lines,
    instructions: rules,
    workflowLines,
    workflowRules,
    skills: skills.length,
    skillDescriptionWords,
    skillLines,
    lintErrorRules: lintErrors,
    concernsInProse: [...prose].sort(),
    movedToTools: [...enforced].sort(),
  };
}

export function monthEnds(from, to) {
  const dates = [];
  const cursor = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0));
  const end = Date.parse(to);
  while (cursor.getTime() <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(1);
    cursor.setUTCMonth(cursor.getUTCMonth() + 2);
    cursor.setUTCDate(0);
  }
  if (dates.at(-1) !== to) dates.push(to);
  return dates;
}
