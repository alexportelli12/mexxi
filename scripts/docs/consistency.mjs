// Facts the README, the landing page and the docs repeat must match the files
// that own them. The landing page is static HTML with no build step, so a check
// (rather than injection) keeps its copy buttons from drifting.
const decodeAttribute = (text) => text.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const visibleText = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#?\w+;/g, "").replace(/\s+/g, " ");

export function checkConsistency(files) {
  const problems = [];
  const prompts = JSON.parse(files.get("prompts.json"));
  const names = JSON.parse(files.get("names.json"));
  const landing = files.get("site/index.html");
  const copyValues = [...landing.matchAll(/data-copy="([^"]*)"/g)].map((match) => decodeAttribute(match[1]));
  const landingText = visibleText(landing);
  const flat = (text) => text.replace(/\s+/g, " ");
  for (const [key, prompt] of Object.entries(prompts)) {
    if (!copyValues.includes(prompt.text)) problems.push(`site/index.html: the "${key}" copy button must carry the prompt in prompts.json`);
    if (!landingText.includes(prompt.text)) problems.push(`site/index.html: the "${key}" prompt text must be shown as in prompts.json`);
    for (const page of ["README.md", "docs/getting-started.md"]) {
      if (!flat(files.get(page) ?? "").includes(prompt.text)) problems.push(`${page}: must contain the "${key}" prompt from prompts.json`);
    }
  }
  // The README reads as an argument: the problems, how mexxi solves them, then
  // getting started (where the prompts belong), then where to read more.
  const readmeSections = (files.get("README.md") ?? "").split(/^(?=## )/m).slice(1);
  const order = [/^## The problems/, /^## How mexxi solves/, /^## Getting started/, /^## Learn more/];
  const found = order.map((heading) => readmeSections.findIndex((section) => heading.test(section)));
  if (found[0] !== 0 || found.some((index, at) => index === -1 || (at && index <= found[at - 1]))) {
    problems.push("README.md: sections must run The problems, How mexxi solves..., Getting started, Learn more, with the problems first");
  }
  const gettingStarted = flat(readmeSections[found[2]] ?? "");
  for (const [key, prompt] of Object.entries(prompts)) {
    if (!gettingStarted.includes(prompt.text)) problems.push(`README.md: the "${key}" prompt belongs in Getting started`);
  }
  // The full names table lives on one page, the generated names page. The
  // README and the landing page link to it, and pair every command and the CLI
  // with its job at least once, as in "/wettaq (build it)", so a reader learns
  // what a Maltese name does where they meet it.
  const readme = flat(files.get("README.md") ?? "");
  const readmeText = readme.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "");
  const pages = [
    { file: "README.md", text: readmeText, linksNames: /\]\(https:\/\/alexportelli12\.github\.io\/mexxi\/docs\/names\.html\)/.test(readme) },
    { file: "site/index.html", text: landingText, linksNames: /href="docs\/names\.html"/.test(landing) },
  ];
  for (const page of pages) {
    if (!page.linksNames) problems.push(`${page.file}: link to the names page (docs/names.html), which holds the full names table`);
    for (const entry of names.filter((item) => item.kind === "command" || item.kind === "cli")) {
      const shown = entry.kind === "command" ? `/${entry.name}` : entry.name;
      if (!page.text.includes(`${shown} (${entry.job})`)) problems.push(`${page.file}: pair ${shown} with its job at least once, as "${shown} (${entry.job})" from names.json`);
    }
  }
  return problems;
}
