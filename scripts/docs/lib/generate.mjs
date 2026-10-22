// Turns the allowlisted files into Markdown pages. Nothing here copies facts
// by hand: names, prompts, config keys, CLI help, agent grants and skill
// summaries all come from the files that own them.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontmatter } from "./frontmatter.mjs";
import { REPO_URL, trackedPaths } from "./source.mjs";

const posix = path.posix;

// A page is { route, title, nav, section, markdown }. Routes have no extension;
// "index" is the Start here page.
// "Under the hood" nests Principles, Decisions and History, which explain why
// mexxi works as it does and where it came from; a newcomer needs the other
// sections first.
const SECTIONS = ["Start here", "Commands", "Agents", "Skills", "CLI reference", "Configuration", "Under the hood"];
const UNDER_THE_HOOD = ["Principles", "Decisions", "History"];
// Hand-written pages are Start here pages unless listed here.
// The session statistics behind the problems are evidence, not a first read,
// and only people moving an old install need the migration guide.
const HANDWRITTEN_SECTIONS = { "host-details": "Configuration", "migrating-from-coding-agent-config": "History", "where-the-problems-come-from": "Principles" };
// Hand-written opening of the generated configuration page, not a page itself.
const CONFIGURATION_GUIDE = "docs/configuration-guide.md";

// What each skill is for; every skill names one in `metadata.group`.
const SKILL_GROUPS = {
  run: { title: "The run itself", text: "What a `/wettaq` run loads along the way: mapping the repository, checking the UI in a browser, the independent review and the pull request." },
  ui: { title: "UI work", text: "Design judgement and tests for interfaces, loaded when a change has a UI. Some are for one stack only." },
  setup: { title: "Setup", text: "Installing, repairing and upgrading mexxi itself." },
  mexxi: { title: "Working on mexxi", text: "For changing mexxi: its docs, its rules and its skills." },
};

// The CLI page groups ibni's subcommands by who runs them. A subcommand in no
// group, or a group naming one that does not exist, fails the build.
const CLI_GROUPS = [
  {
    title: "The agent's lifecycle",
    text: "The agent runs these during a `/wettaq` run, in this order. `record` runs whenever a gate finishes, and `publish-media` only when the run has screenshots. `publish` brings in the latest default branch itself; the agent runs `sync` first when it picks up an existing pull request for a follow-up.",
    diagram: [
      "sequenceDiagram",
      "  participant A as Agent",
      "  participant I as ibni",
      "  participant G as Git and the forge",
      "  A->>I: prepare",
      "  I->>G: new worktree and branch from the default branch",
      "  opt follow-up on an existing pull request",
      "    A->>I: sync",
      "    I->>G: bring in the latest default branch",
      "  end",
      "  A->>I: record (each verify, browser check and review)",
      "  A->>I: record-evidence",
      "  Note over I: remembers the exact code that passed",
      "  A->>I: publish",
      "  I->>G: bring in the default branch, push, never by force",
      "  opt the run has screenshots",
      "    A->>I: publish-media",
      "    I->>G: screenshots to the pr-media branch",
      "  end",
      "  A->>G: open the pull request",
      "  A->>I: mark-pr",
    ].join("\n"),
    names: ["prepare", "sync", "record", "record-evidence", "publish", "publish-media", "mark-pr"],
  },
  {
    title: "Commands you might run",
    text: "You might run these yourself now and then, to see what a run left behind or to continue a pull request from a new session.",
    names: ["list", "info", "cleanup", "stats", "adopt"],
  },
  {
    title: "Experimental or host-specific",
    text: "These run only in some setups: an experiment that is off by default, a step only Claude Code uses, and one that needs the browser check's suggestions.",
    names: ["triage", "cross-review", "file-qa-checks"],
  },
];

export class DocsError extends Error {}

const isAlias = (text) => /^Old name for \//.test(parseFrontmatter(text).data.description ?? "");

// Where a tracked source file is published, or null when it has no page.
function routeFor(file, aliasTargets) {
  let match;
  if (file === "README.md") return "index";
  if (file === "AGENTS.md") return "principles/agents";
  if (file === "names.json") return "names";
  if (file === "config.schema.json") return "configuration/index";
  if (file === "skills/workflow-for-alex/SKILL.md") return "principles/workflow";
  if ((match = file.match(/^commands\/([^/]+)\.md$/))) return `commands/${aliasTargets.get(match[1]) ?? match[1]}`;
  if ((match = file.match(/^agent\/([^/]+)\.md$/))) return `agents/${match[1]}`;
  if ((match = file.match(/^skills\/([^/]+)\/SKILL\.md$/))) return `skills/${match[1]}`;
  if ((match = file.match(/^skills\/([^/]+)\/references\/([^/]+)\.md$/))) return `skills/${match[1]}/${match[2]}`;
  if ((match = file.match(/^docs\/decisions\/([^/]+)\.md$/))) return `decisions/${match[1]}`;
  if ((match = file.match(/^docs\/([^/]+)\.md$/))) return match[1];
  return null;
}

// Relative link from one page to another, in the form both VitePress and the
// plain .md copies understand.
export function pageLink(from, to) {
  return `${posix.relative(posix.dirname(from), to)}.md`;
}

// Source files link to each other by repository path. Published pages link to
// pages; anything else tracked links to GitHub; a link to an untracked path
// fails the build.
function rewriteLinks(markdown, { file, route, tracked, aliasTargets }) {
  const trackedSet = new Set(tracked);
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (whole, bang, text, target, title) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return whole;
        const [pathPart, anchor] = target.split("#");
        const resolved = posix.normalize(posix.join(posix.dirname(file), pathPart)).replace(/\/$/, "");
        const page = bang ? null : routeFor(resolved, aliasTargets);
        if (page) return `[${text}](${pageLink(route, page)}${anchor ? `#${anchor}` : ""}${title})`;
        if (bang) return text;
        if (trackedSet.has(resolved)) return `[${text}](${REPO_URL}/blob/main/${resolved}${anchor ? `#${anchor}` : ""})`;
        if (tracked.some((name) => name.startsWith(`${resolved}/`))) return `[${text}](${REPO_URL}/tree/main/${resolved})`;
        // Hand-written pages sit at the site root, so a link that stays inside
        // docs/ is a site link (often to a generated page); VitePress's
        // dead-link check validates it.
        if (file.startsWith("docs/") && resolved.startsWith("docs/")) return whole;
        // A typo or a deleted file would otherwise vanish into plain text.
        throw new DocsError(`${file}: link to ${target} points at ${resolved}, which git does not track`);
      });
    })
    .join("\n");
}

export const firstSentenceOf = (text) => text.replace(/\s+/g, " ").match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
const sentence = (text) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const stripTitle = (body) => body.replace(/^\s*# .*\n+/, "");
const titleOf = (body, fallback) => body.match(/^# (.+)$/m)?.[1].trim() ?? fallback;
// Every reference entry says first, in one plain sentence, what problem it
// solves; a missing one fails the build, as a missing description does.
function requireWhy(where, value, field) {
  if (typeof value !== "string" || !value.trim()) throw new DocsError(`${where} has no ${field}: add one plain sentence saying what problem it solves`);
  return sentence(value);
}
// The why opens the entry as its lead sentence, unlabelled: the sentence
// names the problem itself, so a label would only repeat itself on every page.
const whyLine = (why) => `${why} {.why}`;

// The agent's own instructions are long, so the page leads with the human
// summary and folds them below it.
function foldedInstructions({ file, body, kind, description, links }) {
  const intro = { command: "The agent follows the instructions below", skill: "The agent loads the instructions below when a task needs this skill", agent: "This agent follows the instructions below" }[kind];
  return [
    `## ${kind === "skill" ? "Skill" : "Agent"} instructions`,
    "",
    `${intro}, from [\`${file}\`](${REPO_URL}/blob/main/${file}).${description ? ` Its one-line description is: ${sentence(description)}` : ""}`,
    "",
    `::: details Full ${kind === "skill" ? "skill" : "agent"} instructions`,
    "",
    rewriteLinks(stripTitle(body), links).trim(),
    "",
    ":::",
    "",
  ];
}

const codeCell = (value) => `\`${String(value).replace(/\|/g, "\\|")}\``;

// A name from names.json as a dictionary entry: the word, its part of speech
// and meaning, then its job in mexxi. The trailing {…} is a
// VitePress attribute that styles the paragraph; the plain .md copies drop it.
export function dictionaryEntry(entry, { id = false } = {}) {
  const head = [`**${entry.name}**`, entry.partOfSpeech, `“${entry.meaning.join(", ")}”`].join(" · ");
  return `${head}  \n${entry.job} {${id ? `#${entry.name} ` : ""}.dictionary}\n`;
}

// The old name moves to a small note at the bottom of the page.
function oldNameNote(entry) {
  if (!entry?.replaces) return [];
  const old = entry.kind === "command" ? `/${entry.replaces}` : entry.replaces;
  return [`*Old name: \`${old}\`${entry.kind === "command" ? ", which still works for one release" : ""}.*`, ""];
}

function describeHelp(root) {
  // MEXXI_CONFIG points at the shipped example so no machine-local value can
  // reach the help text.
  const env = { ...process.env, MEXXI_CONFIG: path.join(root, "config.example.json") };
  const run = (args) => execFileSync(process.execPath, [path.join(root, "scripts/ibni/ibni.mjs"), ...args], { cwd: root, env, encoding: "utf8" }).trimEnd();
  const overview = run(["--help"]);
  const listing = overview.split("\nCommands:\n")[1]?.split("\n\n")[0] ?? "";
  const commands = listing.split("\n").map((line) => line.match(/^ {2}(\S+)\s{2,}/)?.[1]).filter(Boolean);
  if (!commands.length) throw new DocsError("could not read the subcommand list from `ibni --help`");
  return { overview, commands: commands.map((name) => ({ name, help: run([name, "--help"]) })) };
}

function schemaRows(schema, prefix = "") {
  const rows = [];
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (key === "$schema") continue;
    const name = `${prefix}${key}`;
    if (property.type === "object" && property.properties) rows.push(...schemaRows(property, `${name}.`));
    else rows.push({ name, type: [].concat(property.type ?? "any").join(" or "), default: property.default, description: property.description });
  }
  return rows;
}

function hostGrants(name, { claude, codex, opencode, schema, role }) {
  const rows = [];
  const claudeTools = claude[name]?.tools;
  const permission = opencode.agent?.[name]?.permission;
  const summary = permission
    ? Object.entries(permission).map(([key, value]) => `${key}: ${typeof value === "string" ? value : "allow-list"}`).join(", ")
    : "inherits OpenCode's defaults";
  const model = (host) => {
    const value = schema.properties.models.properties[host].properties[role]?.default;
    return value ? codeCell(value) : "the host's own model";
  };
  rows.push(`| Claude Code | ${claudeTools ? `tools: ${codeCell(claudeTools)}` : "the session's tools"} | the session's | ${model("claude")} |`);
  rows.push(`| Codex | the session's tools | ${codex[name]?.sandbox_mode ? codeCell(codex[name].sandbox_mode) : "the session's"} | ${model("codex")} |`);
  rows.push(`| OpenCode | ${summary.replace(/\|/g, "\\|")} | the session's | ${model("opencode")} |`);
  return rows;
}

// Collapses runs of per-skill or per-command links into one row so the table
// stays readable.
function installerRows(entries, checkout, tracked) {
  const skillDirs = new Set(tracked.filter((name) => /^skills\/[^/]+\/SKILL\.md$/.test(name)).map((name) => name.split("/")[1]));
  const kept = entries.filter(([, source]) => {
    const own = source.match(/\/skills\/([^/]+)$/)?.[1];
    return !own || own === "verifika" || skillDirs.has(own);
  });
  const generalise = (value) => /\/verifika$/.test(value) ? value : value.replace(/\/skills\/([^/]+)$/, "/skills/<name>").replace(/\/agents\/[^/]+\.(md|toml)$/, "/agents/<agent>.$1").replace(/\/codex\/skills\/[^/]+$/, "/codex/skills/<command>").replace(/\/\.agents\/skills\/(?!<)[^/]+$/, "/.agents/skills/<name>");
  const groups = new Map();
  for (const [destination, source, host] of kept) {
    const key = `${host}\0${generalise(destination)}\0${generalise(source)}`;
    groups.set(key, [...(groups.get(key) ?? []), [destination, source]]);
  }
  const shorten = (value) => value.replace(checkout, "<checkout>").replace(/^.*\/generated\//, "<generated>/");
  const hostOrder = ["opencode", "claude", "codex", "shared"];
  const ordered = [...groups].sort(([a], [b]) => hostOrder.indexOf(a.split("\0")[0]) - hostOrder.indexOf(b.split("\0")[0]));
  return ordered.map(([key, members]) => {
    const [host, destination, source] = key.split("\0");
    const count = members.length > 1 ? ` (${members.length} links)` : "";
    return `| ${host} | ${codeCell(shorten(destination))}${count} | ${codeCell(shorten(source))} |`;
  });
}

export async function generatePages({ root, files }) {
  const tracked = trackedPaths(root);
  const get = (name) => files.get(name);
  const json = (name) => JSON.parse(get(name));
  const names = json("names.json");
  const schema = json("config.schema.json");
  const claude = json("claude/agents.json");
  const codex = json("codex/agents.json");
  const opencode = json("opencode/opencode.json");
  const byName = new Map(names.map((entry) => [entry.name, entry]));

  const commandFiles = [...files.keys()].filter((name) => /^commands\/[^/]+\.md$/.test(name));
  const aliasTargets = new Map();
  for (const file of commandFiles.filter((name) => isAlias(get(name)))) {
    const target = get(file).match(/`commands\/([^`/]+)\.md`/)?.[1];
    if (!target) throw new DocsError(`${file} is an alias but names no command file`);
    aliasTargets.set(posix.basename(file, ".md"), target);
  }

  const pages = [];
  const add = (page) => pages.push(page);
  const context = (file, route) => ({ file, route, tracked, aliasTargets });
  const fromSource = (file, route) => rewriteLinks(get(file), context(file, route));

  // Start here: the README as it is.
  add({ route: "index", title: titleOf(get("README.md"), "mexxi"), nav: "Overview", section: "Start here", markdown: fromSource("README.md", "index") });

  // The hand-written pages and the names page.
  for (const file of [...files.keys()].filter((name) => /^docs\/[^/]+\.md$/.test(name) && name !== CONFIGURATION_GUIDE).sort()) {
    const route = routeFor(file, aliasTargets);
    const { body } = parseFrontmatter(get(file));
    add({ route, title: titleOf(body, route), nav: titleOf(body, route), section: HANDWRITTEN_SECTIONS[route] ?? "Start here", markdown: rewriteLinks(body, context(file, route)) });
  }
  // The names page is a small dictionary: one entry per name, each with the
  // page where you meet it.
  const nameLink = (entry) => {
    const target = { command: `commands/${entry.name}`, skill: `skills/${entry.name}`, cli: "cli/index", repo: "index" }[entry.kind];
    const label = { command: `the /${entry.name} command`, skill: `the ${entry.name} skill`, cli: "the ibni CLI", repo: "the overview" }[entry.kind];
    return `[${label}](${pageLink("names", target)})`;
  };
  const nameEntries = names.flatMap((entry) => [
    dictionaryEntry(entry, { id: true }),
    `Read more: ${nameLink(entry)}.`,
    "",
  ]);
  // Only the old command names still work, as aliases; the others are history.
  const renamed = (kind) => names.filter((entry) => entry.replaces && (kind === "command") === (entry.kind === "command"));
  const oldCommands = renamed("command").map((entry) => `\`/${entry.name}\` was \`/${entry.replaces}\``);
  const oldOthers = renamed("other").map((entry) => `\`${entry.name}\` was \`${entry.replaces}\``);
  add({
    route: "names",
    title: "The names",
    nav: "The names",
    section: "Start here",
    markdown: [
      "# The names",
      "",
      "mexxi's tools are named in Maltese, the author's native language, as [Verifika](https://github.com/alexportelli12/verifika) is. Each name is an everyday Maltese word for what the tool does, so once you know the word, you know the job. Only the names are Maltese: the docs, skills, subcommands and flags are in English.",
      "",
      "## The dictionary",
      "",
      "Each meaning is the sense the word has in mexxi; most of these words have others too.",
      "",
      ...nameEntries,
      "## Old names",
      "",
      `Some tools had English names before. The old command names still work for one release: ${oldCommands.join("; ")}. The repository and the CLI were renamed too: ${oldOthers.join("; ")}.`,
      "",
    ].join("\n"),
  });

  // Principles.
  add({ route: "principles/agents", title: titleOf(get("AGENTS.md"), "Principles"), nav: "Engineering principles", section: "Principles", markdown: fromSource("AGENTS.md", "principles/agents") });

  // Decisions: one page per record in docs/decisions/, plus an index. A record
  // is named NNNN-slug.md, titled "# NNNN. Title", and states its status and
  // date, so the index can list them without anyone maintaining it.
  const decisionRows = [];
  for (const file of [...files.keys()].filter((name) => /^docs\/decisions\/[^/]+\.md$/.test(name)).sort()) {
    const number = posix.basename(file).match(/^(\d{4})-[a-z0-9-]+\.md$/)?.[1];
    if (!number) throw new DocsError(`${file}: name decision records NNNN-short-slug.md`);
    const { data, body } = parseFrontmatter(get(file));
    const heading = body.match(/^# (\d{4})\. (.+)$/m);
    if (!heading || heading[1] !== number) throw new DocsError(`${file}: the title must read "# ${number}. <decision>"`);
    if (!data.status?.trim()) throw new DocsError(`${file}: state the decision's \`status\` in its frontmatter`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date ?? "")) throw new DocsError(`${file}: \`date\` must be a YYYY-MM-DD date`);
    const route = routeFor(file, aliasTargets);
    const title = heading[2].trim();
    const status = `**Status:** ${data.status.trim()} · **Date:** ${data.date}`;
    const markdown = rewriteLinks(body, context(file, route)).replace(/^(# .+\n)/m, `$1\n${status}\n`);
    add({ route, title: `${number}. ${title}`, nav: `${number} ${title}`, section: "Decisions", markdown });
    decisionRows.push(`| [${number}. ${title}](${pageLink("decisions/index", route)}) | ${data.status.trim()} | ${data.date} |`);
  }
  if (decisionRows.length) {
    add({
      route: "decisions/index",
      title: "Decisions",
      nav: "All decisions",
      section: "Decisions",
      markdown: ["# Decisions", "", "Each record explains one architectural decision: the context, what was decided, its consequences and the alternatives turned down. Records are not edited to follow the code; a changed decision gets a new record that supersedes the old one.", "", "| Decision | Status | Date |", "| --- | --- | --- |", ...decisionRows, ""].join("\n"),
    });
  }

  // Skills, grouped by what they are for. Each carries, in its `metadata` map
  // (Agent Skills allows one), `why`: the problem it solves, and `group`.
  const skillFiles = [...files.keys()].filter((name) => /^skills\/[^/]+\/SKILL\.md$/.test(name)).sort();
  const skillRows = Object.fromEntries(Object.keys(SKILL_GROUPS).map((group) => [group, []]));
  for (const file of skillFiles) {
    const dir = file.split("/")[1];
    const { data, body } = parseFrontmatter(get(file));
    if (!data.description?.trim()) throw new DocsError(`${file} has no \`description\` in its frontmatter`);
    if (data.name !== dir) throw new DocsError(`${file}: frontmatter name "${data.name}" must match the folder "${dir}"`);
    const metadata = typeof data.metadata === "object" ? data.metadata : {};
    const why = requireWhy(file, metadata.why, "`metadata.why`");
    if (!SKILL_GROUPS[metadata.group]) throw new DocsError(`${file}: set \`metadata.group\` to one of ${Object.keys(SKILL_GROUPS).join(", ")}, the purpose it serves`);
    const route = routeFor(file, aliasTargets);
    const references = [...files.keys()].filter((name) => name.startsWith(`skills/${dir}/references/`)).sort();
    // `metadata.optional` marks a skill the core workflow never needs, with
    // the reason someone would want it.
    const optional = metadata.optional?.trim();
    const parts = [`# ${dir}`, ""];
    if (byName.has(dir)) parts.push(dictionaryEntry(byName.get(dir)));
    parts.push(whyLine(why), "", sentence(data.description), "");
    if (optional) parts.push("::: info Optional skill", `A run uses this skill only in one situation. **When you need it:** ${optional}`, ":::", "");
    const children = references.map((reference) => {
      const referenceRoute = routeFor(reference, aliasTargets);
      const text = parseFrontmatter(get(reference)).body;
      const title = titleOf(text, posix.basename(reference, ".md"));
      add({ route: referenceRoute, title, nav: title, section: "Skills", parent: route, markdown: `${rewriteLinks(text, context(reference, referenceRoute)).trim()}\n` });
      return { route: referenceRoute, nav: title };
    });
    if (children.length) parts.push("**References**, loaded only when a task needs them:", "", ...children.map((child) => `- [${child.nav}](${pageLink(route, child.route)})`), "");
    parts.push(...foldedInstructions({ file, body, kind: "skill", links: context(file, route) }), ...oldNameNote(byName.get(dir)));
    // A skill adapted from another project credits it at the bottom.
    if (metadata.credit) {
      if (!/^https:\/\//.test(metadata.upstream ?? "")) throw new DocsError(`${file}: a skill with \`metadata.credit\` needs \`metadata.upstream\`, the original's URL`);
      parts.push(`*${metadata.credit} [The original](${metadata.upstream}) · [its licence](${REPO_URL}/blob/main/skills/${dir}/LICENSE.txt).*`, "");
    }
    const nav = route === "principles/workflow" ? "Workflow governance" : optional ? `${dir} (optional)` : dir;
    add({ route, title: dir, nav, section: route === "principles/workflow" ? "Principles" : "Skills", frontmatter: { outline: false }, markdown: parts.join("\n") });
    const link = `[${dir}](${pageLink("skills/index", route)})${optional ? ` (optional: ${optional.replace(/\.$/, "")})` : ""}`;
    skillRows[metadata.group].push(`| ${link} | ${why} | ${firstSentenceOf(data.description)} |`);
  }
  add({
    route: "skills/index",
    title: "Skills",
    nav: "All skills",
    section: "Skills",
    markdown: [
      "# Skills",
      "",
      "A coding agent cannot hold every piece of specialist know-how in its standing instructions; they would grow too long to follow. A skill is know-how it loads only when a task needs it, by matching the skill's name and description. A run that changes no UI never loads the UI skills.",
      "",
      ...Object.entries(SKILL_GROUPS).flatMap(([group, { title, text }]) => [`## ${title}`, "", text, "", "| Skill | Why | What it does |", "| --- | --- | --- |", ...skillRows[group], ""]),
    ].join("\n"),
  });

  // Commands: one page each, in the order names.json lists them, which is how
  // often people use them; aliases are mentioned on the page they point at.
  const commandOrder = names.filter((entry) => entry.kind === "command").map((entry) => entry.name);
  const commandRows = [];
  const rank = (file) => commandOrder.indexOf(posix.basename(file, ".md"));
  for (const file of commandFiles.filter((name) => !isAlias(get(name))).sort((a, b) => rank(a) - rank(b))) {
    const name = posix.basename(file, ".md");
    const route = `commands/${name}`;
    const { data, body } = parseFrontmatter(get(file));
    if (!data.description) throw new DocsError(`${file} has no description`);
    const why = requireWhy(file, data.why, "`why`");
    // The page leads with the human summary; the agent's own instructions are
    // long, so they sit collapsed below it.
    if (!data.summary?.trim()) throw new DocsError(`${file} has no \`summary\`: add a short one to its frontmatter saying when to use it, what you get and what it needs from you`);
    const entry = byName.get(name);
    const parts = [`# /${name}`, ""];
    if (entry) parts.push(dictionaryEntry(entry));
    parts.push(whyLine(why), "", data.summary.trim(), "", ...foldedInstructions({ file, body, kind: "command", description: data.description, links: context(file, route) }), ...oldNameNote(entry));
    // The outline would list the headings folded inside the details block,
    // which go nowhere while it is closed, so these pages have none.
    add({ route, title: `/${name}`, nav: `/${name}`, section: "Commands", order: rank(file), frontmatter: { outline: false }, markdown: parts.join("\n") });
    commandRows.push(`| [/${name}](${pageLink("commands/index", route)}) | ${why} | ${firstSentenceOf(data.summary)} |`);
  }
  add({
    route: "commands/index",
    title: "Commands",
    nav: "All commands",
    section: "Commands",
    markdown: [
      "# Commands",
      "",
      "A command is a workflow you start by typing its name in your coding agent's chat, such as `/wettaq show the last sync time on the settings page`. Each is one Markdown file in `commands/`, shared by all three hosts; Codex runs them as `$mexxi-<name>` skills.",
      "",
      "They are listed by how often you will use them: `/wettaq` for every change, then the ones you use once per repository or now and then.",
      "",
      "| Command | Why | When to use it |",
      "| --- | --- | --- |",
      ...commandRows,
      "",
    ].join("\n"),
  });

  // Agents: what each is, why it is a separate agent, when it runs and what it
  // cannot do (docs/agents.json, since the shared agent files take no
  // frontmatter), then what each host grants and the folded instructions.
  const about = json("docs/agents.json");
  for (const name of Object.keys(about)) {
    if (!files.has(`agent/${name}.md`)) throw new DocsError(`docs/agents.json describes ${name}, which has no agent/${name}.md`);
  }
  const roles = { "ui-designer": "uiDesigner", "code-reviewer": "reviewer" };
  const agentRows = [];
  for (const file of [...files.keys()].filter((name) => /^agent\/[^/]+\.md$/.test(name)).sort()) {
    const name = posix.basename(file, ".md");
    const route = `agents/${name}`;
    const facts = about[name] ?? {};
    const why = requireWhy("docs/agents.json", facts.why, `\`${name}.why\``);
    for (const key of ["runs", "cannot"]) {
      if (!facts[key]?.trim()) throw new DocsError(`docs/agents.json: give ${name} a \`${key}\` sentence`);
    }
    const grants = hostGrants(name, { claude, codex, opencode, schema, role: roles[name] ?? name });
    add({
      route,
      title: name,
      nav: name,
      section: "Agents",
      frontmatter: { outline: false },
      markdown: [
        `# ${name}`,
        "",
        whyLine(why),
        "",
        sentence(claude[name]?.description ?? ""),
        "",
        `**When it runs:** ${facts.runs.trim()}`,
        "",
        `**What it cannot do:** ${facts.cannot.trim()}`,
        "",
        "## What each host grants",
        "",
        "Adapters render these from `claude/agents.json`, `codex/agents.json`, `opencode/opencode.json` and the model defaults in `config.schema.json`.",
        "",
        "| Host | Tools or permissions | Sandbox | Default model |",
        "| --- | --- | --- | --- |",
        ...grants,
        "",
        ...foldedInstructions({ file, body: get(file), kind: "agent", links: context(file, route) }),
      ].join("\n"),
    });
    agentRows.push(`| [${name}](${pageLink("agents/index", route)}) | ${why} | ${facts.runs.trim()} |`);
  }
  add({
    route: "agents/index",
    title: "Agents",
    nav: "All agents",
    section: "Agents",
    markdown: [
      "# Agents",
      "",
      "Here an agent is a specialist role that the main coding agent hands part of a task to. A separate agent can have fewer powers than the main one, or another model, and that is the point: the reviewer cannot edit code, so it can only judge.",
      "",
      "| Agent | Why | When it runs |",
      "| --- | --- | --- |",
      ...agentRows,
      "",
    ].join("\n"),
  });

  // CLI reference from the real --help output, grouped by who runs each
  // subcommand. Each subcommand's help carries a "Why:" line, shown first.
  const help = describeHelp(root);
  const ibni = byName.get("ibni");
  const helpByName = new Map(help.commands.map((command) => [command.name, command]));
  const grouped = CLI_GROUPS.flatMap((group) => group.names);
  for (const name of helpByName.keys()) {
    if (!grouped.includes(name)) throw new DocsError(`ibni ${name} is in no group: add it to CLI_GROUPS in scripts/docs/lib/generate.mjs`);
  }
  for (const name of grouped) {
    if (!helpByName.has(name)) throw new DocsError(`CLI_GROUPS names ibni ${name}, which \`ibni --help\` does not list`);
  }
  const subcommand = (name) => {
    const text = helpByName.get(name).help;
    const why = requireWhy(`ibni ${name} --help`, text.match(/^Why: (.+)$/m)?.[1], "\"Why:\" line");
    return [`### ibni ${name}`, "", whyLine(why), "", "```text", text.replace(/\n\nWhy: .+$/m, ""), "```", ""];
  };
  add({
    route: "cli/index",
    title: "CLI reference",
    nav: "ibni",
    section: "CLI reference",
    markdown: [
      "# CLI reference",
      "",
      ibni ? dictionaryEntry(ibni) : "",
      `**You rarely run \`ibni\` yourself.** The coding agent runs it at each step of a task, as [\`/wettaq\`](${pageLink("cli/index", "commands/wettaq")}) instructs. You might use a few of its subcommands now and then; they are listed below.`,
      "",
      `**Why it exists.** The steps that matter most, such as giving a task its own worktree and pushing its branch, should not depend on an agent saying it did them right. So \`ibni\` does them in code. It gives each task its own worktree and port, and the agent records with it the exact code its checks passed on. \`ibni\` then refuses to push any other code, or to push by force. [Decision 0004](${pageLink("cli/index", "decisions/0004-isolated-worktree-per-task")}) and [decision 0006](${pageLink("cli/index", "decisions/0006-rules-stay-rules-guard-backs-up")}) explain why.`,
      "",
      `Every subcommand prints JSON, so the agent can read the result. A few terms recur: a *session* is one agent conversation, a *workspace* is a kept worktree with its record, and a *gate* is a check a run must pass, such as verify. The [glossary](${pageLink("cli/index", "glossary")}) has the rest.`,
      "",
      ...CLI_GROUPS.flatMap((group) => [`## ${group.title}`, "", group.text, "", ...(group.diagram ? ["```mermaid", group.diagram, "```", ""] : []), ...group.names.flatMap(subcommand)]),
      "## Every subcommand",
      "",
      "The tool's own overview, from `ibni --help`:",
      "",
      "```text",
      help.overview,
      "```",
      "",
      ...oldNameNote(ibni),
    ].join("\n"),
  });

  // Configuration: the hand-written guide (why two files, common changes),
  // then every key from the schemas, then what the installer links.
  const { links } = await import(pathToFileURL(path.join(root, "scripts/install.mjs")).href);
  const installation = await links({ home: "~", checkout: root, generated: "<generated>", hosts: { opencode: true, claude: true, codex: true } });
  const groups = Object.entries(schema.properties).filter(([key]) => key !== "$schema");
  const guide = parseFrontmatter(get(CONFIGURATION_GUIDE)).body;
  const keyRows = (properties) => schemaRows({ properties }).map((row) => `| ${codeCell(row.name)} | ${row.type} | ${codeCell(JSON.stringify(row.default))} | ${row.description.replace(/\|/g, "\\|")} |`);
  const keyTable = ["| Key | Type | Default | What it sets |", "| --- | --- | --- | --- |"];
  const configuration = [
    rewriteLinks(guide, context(CONFIGURATION_GUIDE, "configuration/index")).trim(),
    "",
    "## Settings in config.json",
    "",
    `Every key is optional; the tables give the defaults. [\`config.example.json\`](${REPO_URL}/blob/main/config.example.json) spells them all out. To use another file, name it in \`MEXXI_CONFIG\`.`,
    "",
  ];
  for (const [key, group] of groups) {
    const why = requireWhy(`config.schema.json: ${key}`, group.why, "`why`");
    configuration.push(`### ${key}`, "", ...(group.scope ? [`::: info ${group.scope}`, ":::", ""] : []), whyLine(why), "", group.description, "", ...keyTable, ...keyRows({ [key]: group }), "");
  }
  const repositorySchema = json("mexxi.schema.json");
  configuration.push("## Settings in .mexxi.json", "", repositorySchema.why, "", repositorySchema.description, "", ...keyTable, ...keyRows(repositorySchema.properties), "");
  configuration.push(
    "## What the installer links",
    "",
    `The installer links one set of files into each host's home, so a change to the workflow reaches every agent. It records what it links and touches nothing else; [decision 0003](${pageLink("configuration/index", "decisions/0003-installer-owns-what-it-records")}) explains why. Destinations are under your home directory. \`<checkout>\` is \`paths.checkout\`, and \`<generated>\` is \`~/.local/share/mexxi/generated\`, where the installer renders each host's files from your \`config.json\`. \`implementation-workspace\` is \`ibni\`'s old name, kept for one release.`,
    "",
    "| Host | Destination | Source |",
    "| --- | --- | --- |",
    ...installerRows(installation, root, tracked),
    "",
  );
  add({ route: "configuration/index", title: "Configuration", nav: "Configuration", section: "Configuration", markdown: configuration.join("\n") });

  // Children follow their parent, so listings read in order.
  const ordered = pages.filter((page) => !page.parent);
  for (const child of pages.filter((page) => page.parent)) ordered.splice(ordered.findIndex((page) => page.route === child.parent) + 1 + ordered.filter((page) => page.parent === child.parent).length, 0, child);
  return { pages: ordered, names, skillCount: skillFiles.length };
}

// Sidebar: sections in a fixed order, hand-written pages first.
export function buildSidebar(pages) {
  const link = (route) => (route === "index" ? "/" : `/${route}`);
  // Why first: the overview and the ideas, then what a pull request looks like,
  // then how to set up and what happens in a run.
  const order = ["index", "ideas", "reviewing-a-pull-request", "getting-started", "how-a-run-works", "names", "glossary"];
  const itemsFor = (section) => {
    const inSection = pages.filter((page) => page.section === section && !page.parent);
    const sorted = section === "Start here" ? order.map((route) => inSection.find((page) => page.route === route)).filter(Boolean).concat(inSection.filter((page) => !order.includes(page.route))) : [...inSection].sort((a, b) => (a.route.endsWith("/index") ? -1 : b.route.endsWith("/index") ? 1 : (a.order ?? 0) - (b.order ?? 0) || a.nav.localeCompare(b.nav)));
    return sorted.map((page) => {
      const children = pages.filter((child) => child.parent === page.route);
      return { text: page.nav, link: link(page.route), ...(children.length ? { collapsed: true, items: children.map((child) => ({ text: child.nav, link: link(child.route) })) } : {}) };
    });
  };
  return SECTIONS.map((section) =>
    section === "Under the hood"
      ? { text: section, collapsed: false, items: UNDER_THE_HOOD.map((group) => ({ text: group, collapsed: true, items: itemsFor(group) })) }
      : { text: section, items: itemsFor(section) },
  );
}
