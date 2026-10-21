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
  // Every name is explained on the README's and the landing page's name lists.
  for (const entry of names) {
    const shown = entry.kind === "command" ? `/${entry.name}` : entry.name;
    if (![shown, entry.meaning, entry.does].every((part) => landingText.includes(part))) {
      problems.push(`site/index.html: the names list must give ${shown}, "${entry.meaning}" and what it does, as in names.json`);
    }
    const readme = flat(files.get("README.md") ?? "");
    if (!readme.includes(shown) || !readme.includes(entry.meaning)) problems.push(`README.md: the names section must give ${shown} and "${entry.meaning}", as in names.json`);
  }
  return problems;
}
