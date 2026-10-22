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
// "Under the hood" nests Principles and Decisions, which explain why mexxi
// works as it does; a newcomer needs the other sections first.
const SECTIONS = ["Start here", "Commands", "Agents", "Skills", "CLI reference", "Configuration", "Under the hood"];
const UNDER_THE_HOOD = ["Principles", "Decisions"];
// Hand-written pages are Start here pages unless listed here.
const HANDWRITTEN_SECTIONS = { "host-details": "Configuration", "migrating-from-coding-agent-config": "Configuration" };

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
const codeCell = (value) => `\`${String(value).replace(/\|/g, "\\|")}\``;

// A name from names.json as a dictionary entry: the word, how to say it, its
// part of speech and meaning, then its job in mexxi. The trailing {…} is a
// VitePress attribute that styles the paragraph; the plain .md copies drop it.
export function dictionaryEntry(entry, { id = false } = {}) {
  const head = [`**${entry.name}**`, entry.respelling ? `*${entry.respelling}*` : null, entry.partOfSpeech, `“${entry.meaning.join(", ")}”`].filter(Boolean).join(" · ");
  return `${head}  \n${entry.job} {${id ? `#${entry.name} ` : ""}.dictionary}\n`;
}

// The old name moves to a small note at the bottom of the page.
function oldNameNote(entry) {
  if (!entry?.replaces) return [];
  const old = entry.kind === "command" ? `/${entry.replaces}` : entry.replaces;
  return [`*Old name: \`${old}\`${entry.kind === "command" ? ", which still works for one release" : ""}.*`, ""];
}

// How the respellings work, from the transcriptions they come from.
export const RESPELLING_KEY = "The respellings come from the dictionary's phonetic transcriptions. Doubled letters are held, as in \"book-keeper\", and ’ is a glottal stop, the catch in \"uh-oh\".";

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
  for (const file of [...files.keys()].filter((name) => /^docs\/[^/]+\.md$/.test(name)).sort()) {
    const route = routeFor(file, aliasTargets);
    const { body } = parseFrontmatter(get(file));
    add({ route, title: titleOf(body, route), nav: titleOf(body, route), section: HANDWRITTEN_SECTIONS[route] ?? "Start here", markdown: rewriteLinks(body, context(file, route)) });
  }
  // The names page is a small dictionary: one entry per name, each with the
  // page where you meet it and the dictionary entry it comes from.
  const nameLink = (entry) => {
    const target = { command: `commands/${entry.name}`, skill: `skills/${entry.name}`, cli: "cli/index", repo: "index" }[entry.kind];
    const label = { command: `the /${entry.name} command`, skill: `the ${entry.name} skill`, cli: "the ibni CLI", repo: "the overview" }[entry.kind];
    return `[${label}](${pageLink("names", target)})`;
  };
  const sourceLinks = (entry) => entry.sources.map((source) => `[${source.dictionary}, *${source.entry}*](${source.url})`).join(", ");
  const nameEntries = names.flatMap((entry) => [
    dictionaryEntry(entry, { id: true }),
    `Read more: ${nameLink(entry)}. Source: ${sourceLinks(entry)}.${entry.note ? ` ${entry.note}` : ""}`,
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
      RESPELLING_KEY,
      "",
      ...nameEntries,
      "## Where the meanings come from",
      "",
      "Every part of speech, meaning and pronunciation above comes from [Ġabra](https://mlrs.research.um.edu.mt/resources/gabra/), the University of Malta's lexicon of Maltese, and each entry links to its source. The live Ġabra site now redirects to the University's home page, so the entries were checked on 22 October 2026 against [Ġabra's own data export of 1 August 2021](https://web.archive.org/web/20211209195107/https://mlrs.research.um.edu.mt/resources/gabra-api/data/gabra_data_2021-08-01.tar.gz), as archived. [Dizzjunarju.mt](https://dizzjunarju.mt/), the National Dictionary of Maltese, was checked first; its first entries do not yet include these words.",
      "",
      "Where the dictionary does not list the exact form a tool uses, the entry gives the headword's meaning and leaves the pronunciation out rather than guess it.",
      "",
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

  // Skills (the workflow-for-alex skill is the governance page under Principles).
  const skillFiles = [...files.keys()].filter((name) => /^skills\/[^/]+\/SKILL\.md$/.test(name)).sort();
  const skillRows = { core: [], optional: [] };
  for (const file of skillFiles) {
    const dir = file.split("/")[1];
    const { data, body } = parseFrontmatter(get(file));
    if (!data.description?.trim()) throw new DocsError(`${file} has no \`description\` in its frontmatter`);
    if (data.name !== dir) throw new DocsError(`${file}: frontmatter name "${data.name}" must match the folder "${dir}"`);
    const route = routeFor(file, aliasTargets);
    const references = [...files.keys()].filter((name) => name.startsWith(`skills/${dir}/references/`)).sort();
    // `metadata.optional` marks a skill the core workflow never needs, with
    // the reason someone would want it (Agent Skills allows a metadata map).
    const optional = typeof data.metadata === "object" ? data.metadata.optional?.trim() : undefined;
    const parts = [`# ${dir}`, ""];
    if (byName.has(dir)) parts.push(dictionaryEntry(byName.get(dir)));
    parts.push(sentence(data.description), "");
    if (optional) parts.push("::: info Optional skill", `A run uses this skill only in one situation. **When you need it:** ${optional}`, ":::", "");
    parts.push(rewriteLinks(stripTitle(body), context(file, route)).trim(), "");
    const children = references.map((reference) => {
      const referenceRoute = routeFor(reference, aliasTargets);
      const text = parseFrontmatter(get(reference)).body;
      const title = titleOf(text, posix.basename(reference, ".md"));
      add({ route: referenceRoute, title, nav: title, section: "Skills", parent: route, markdown: `${rewriteLinks(text, context(reference, referenceRoute)).trim()}\n` });
      return { route: referenceRoute, nav: title };
    });
    if (children.length) parts.push("## References", "", ...children.map((child) => `- [${child.nav}](${pageLink(route, child.route)})`), "");
    parts.push(...oldNameNote(byName.get(dir)));
    const nav = route === "principles/workflow" ? "Workflow governance" : optional ? `${dir} (optional)` : dir;
    add({ route, title: dir, nav, section: route === "principles/workflow" ? "Principles" : "Skills", markdown: parts.join("\n") });
    const link = `[${dir}](${pageLink("skills/index", route)})`;
    if (optional) skillRows.optional.push(`| ${link} | ${optional} | ${firstSentenceOf(data.description)} |`);
    else skillRows.core.push(`| ${link} | ${firstSentenceOf(data.description)} |`);
  }
  add({
    route: "skills/index",
    title: "Skills",
    nav: "All skills",
    section: "Skills",
    markdown: [
      "# Skills",
      "",
      "Agents load a skill by matching its name and description, so every skill carries both. The tables give the first sentence of each description.",
      "",
      "## Core skills",
      "",
      "The workflow relies on these, whatever your stack.",
      "",
      "| Skill | Summary |",
      "| --- | --- |",
      ...skillRows.core,
      "",
      "## Optional skills",
      "",
      "A run uses these only in the situation the second column names, such as one stack or one job.",
      "",
      "| Skill | For | Summary |",
      "| --- | --- | --- |",
      ...skillRows.optional,
      "",
    ].join("\n"),
  });

  // Commands: one page each; aliases are mentioned on the page they point at.
  const commandRows = [];
  for (const file of commandFiles.filter((name) => !isAlias(get(name))).sort()) {
    const name = posix.basename(file, ".md");
    const route = `commands/${name}`;
    const { data, body } = parseFrontmatter(get(file));
    if (!data.description) throw new DocsError(`${file} has no description`);
    // The page leads with the human summary; the agent's own instructions are
    // long, so they sit collapsed below it.
    if (!data.summary?.trim()) throw new DocsError(`${file} has no \`summary\`: add a short one to its frontmatter saying when to use it, what you get and what it needs from you`);
    const entry = byName.get(name);
    const parts = [`# /${name}`, ""];
    if (entry) parts.push(dictionaryEntry(entry));
    parts.push(data.summary.trim(), "");
    parts.push(
      "## Agent instructions",
      "",
      `The agent follows the instructions below, from [\`${file}\`](${REPO_URL}/blob/main/${file}). Its one-line description is: ${sentence(data.description)}`,
      "",
      "::: details Full agent instructions",
      "",
      rewriteLinks(stripTitle(body), context(file, route)).trim(),
      "",
      ":::",
      "",
      ...oldNameNote(entry),
    );
    // The outline would list the headings folded inside the details block,
    // which go nowhere while it is closed, so command pages have none.
    add({ route, title: `/${name}`, nav: `/${name}`, section: "Commands", frontmatter: { outline: false }, markdown: parts.join("\n") });
    commandRows.push(`| [/${name}](${pageLink("commands/index", route)}) | ${entry?.job ?? ""} | ${firstSentenceOf(data.summary)} |`);
  }
  add({ route: "commands/index", title: "Commands", nav: "All commands", section: "Commands", markdown: ["# Commands", "", "Each command is a Markdown file in `commands/`, shared by all three hosts. Codex runs them as `$mexxi-<name>` skills.", "", "| Command | Job | When to use it |", "| --- | --- | --- |", ...commandRows, ""].join("\n") });

  // Agents, with what each host adapter grants.
  const roles = { "ui-designer": "uiDesigner", "code-reviewer": "reviewer" };
  const agentRows = [];
  for (const file of [...files.keys()].filter((name) => /^agent\/[^/]+\.md$/.test(name)).sort()) {
    const name = posix.basename(file, ".md");
    const route = `agents/${name}`;
    const body = get(file);
    const grants = hostGrants(name, { claude, codex, opencode, schema, role: roles[name] ?? name });
    add({
      route,
      title: name,
      nav: name,
      section: "Agents",
      markdown: [
        `# ${name}`,
        "",
        claude[name]?.description ?? "",
        "",
        rewriteLinks(stripTitle(body), context(file, route)).trim(),
        "",
        "## What each host grants",
        "",
        "Adapters render these from `claude/agents.json`, `codex/agents.json`, `opencode/opencode.json` and the model defaults in `config.schema.json`.",
        "",
        "| Host | Tools or permissions | Sandbox | Default model |",
        "| --- | --- | --- | --- |",
        ...grants,
        "",
      ].join("\n"),
    });
    agentRows.push(`| [${name}](${pageLink("agents/index", route)}) | ${claude[name]?.description ?? ""} |`);
  }
  add({ route: "agents/index", title: "Agents", nav: "All agents", section: "Agents", markdown: ["# Agents", "", "| Agent | What it does |", "| --- | --- |", ...agentRows, ""].join("\n") });

  // CLI reference from the real --help output.
  const help = describeHelp(root);
  const ibni = byName.get("ibni");
  add({
    route: "cli/index",
    title: "CLI reference",
    nav: "ibni",
    section: "CLI reference",
    markdown: [
      "# CLI reference",
      "",
      ibni ? dictionaryEntry(ibni) : "",
      "Every subcommand prints JSON. The text below is each subcommand's own `--help`.",
      "",
      "```text",
      help.overview,
      "```",
      "",
      ...help.commands.flatMap(({ name, help: text }) => [`## ibni ${name}`, "", "```text", text, "```", ""]),
      ...oldNameNote(ibni),
    ].join("\n"),
  });

  // Configuration: keys from the schema, links from the installer.
  const { links } = await import(pathToFileURL(path.join(root, "scripts/install.mjs")).href);
  const installation = await links({ home: "~", checkout: root, generated: "<generated>", hosts: { opencode: true, claude: true, codex: true } });
  const groups = Object.entries(schema.properties).filter(([key]) => key !== "$schema");
  const configuration = ["# Configuration", "", "One file configures mexxi: `~/.config/mexxi/config.json`, or the file `MEXXI_CONFIG` names. Every key is optional; the table gives the default. [`config.example.json`](" + `${REPO_URL}/blob/main/config.example.json` + ") spells them all out.", ""];
  for (const [key, group] of groups) {
    configuration.push(`## ${key}`, "", group.description, "", "| Key | Type | Default | What it sets |", "| --- | --- | --- | --- |");
    for (const row of schemaRows({ properties: { [key]: group } })) {
      configuration.push(`| ${codeCell(row.name)} | ${row.type} | ${codeCell(JSON.stringify(row.default))} | ${row.description.replace(/\|/g, "\\|")} |`);
    }
    configuration.push("");
  }
  configuration.push("## What the installer links", "", "`node scripts/install.mjs` links these into each host's home. Destinations are under your home directory; `<checkout>` is `paths.checkout`.", "", "| Host | Destination | Source |", "| --- | --- | --- |", ...installerRows(installation, root, tracked), "");
  add({ route: "configuration/index", title: "Configuration", nav: "Configuration", section: "Configuration", markdown: configuration.join("\n") });

  // Children follow their parent, so listings read in order.
  const ordered = pages.filter((page) => !page.parent);
  for (const child of pages.filter((page) => page.parent)) ordered.splice(ordered.findIndex((page) => page.route === child.parent) + 1 + ordered.filter((page) => page.parent === child.parent).length, 0, child);
  return { pages: ordered, names, skillCount: skillFiles.length };
}

// Sidebar: sections in a fixed order, hand-written pages first.
export function buildSidebar(pages) {
  const link = (route) => (route === "index" ? "/" : `/${route}`);
  const order = ["index", "getting-started", "reviewing-a-pull-request", "how-a-run-works", "names", "glossary"];
  const itemsFor = (section) => {
    const inSection = pages.filter((page) => page.section === section && !page.parent);
    const sorted = section === "Start here" ? order.map((route) => inSection.find((page) => page.route === route)).filter(Boolean).concat(inSection.filter((page) => !order.includes(page.route))) : [...inSection].sort((a, b) => (a.route.endsWith("/index") ? -1 : b.route.endsWith("/index") ? 1 : a.nav.localeCompare(b.nav)));
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
