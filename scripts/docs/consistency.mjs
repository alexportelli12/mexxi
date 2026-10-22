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
  // The README reads as an argument: the problem, how mexxi solves it, then
  // getting started (where the prompts belong), then where to read more.
  const readmeSections = (files.get("README.md") ?? "").split(/^(?=## )/m).slice(1);
  const order = [/^## The problem\n/, /^## How mexxi solves/, /^## Getting started/, /^## Learn more/];
  const found = order.map((heading) => readmeSections.findIndex((section) => heading.test(section)));
  if (found[0] !== 0 || found.some((index, at) => index === -1 || (at && index <= found[at - 1]))) {
    problems.push("README.md: sections must run The problem, How mexxi solves..., Getting started, Learn more, with the problem first");
  }
  const gettingStarted = flat(readmeSections[found[2]] ?? "");
  for (const [key, prompt] of Object.entries(prompts)) {
    if (!gettingStarted.includes(prompt.text)) problems.push(`README.md: the "${key}" prompt belongs in Getting started`);
  }
  // The full dictionary lives on one page, the generated names page, and the
  // README and the landing page link to it.
  const readme = files.get("README.md") ?? "";
  if (!/\]\(https:\/\/alexportelli12\.github\.io\/mexxi\/docs\/names\.html\)/.test(readme)) problems.push("README.md: link to the names page (docs/names.html), which holds the dictionary");
  if (!/href="docs\/names\.html"/.test(landing)) problems.push("site/index.html: link to the names page (docs/names.html), which holds the dictionary");
  // The landing page's dictionary section is static HTML, so each entry, marked
  // data-name="<name>", must say what names.json says, word for word.
  for (const entry of names) {
    const block = landing.match(new RegExp(`<li[^>]*data-name="${entry.name}"[^>]*>([\\s\\S]*?)</li>`))?.[1];
    if (!block) {
      problems.push(`site/index.html: the names section needs an entry with data-name="${entry.name}"`);
      continue;
    }
    const text = visibleText(block);
    // Every part of speech is a short word such as "verb", so it is matched in
    // its own span rather than anywhere in the entry.
    const partOfSpeech = visibleText(block.match(/<span class="entry__pos">([\s\S]*?)<\/span>/)?.[1] ?? "").trim();
    if (partOfSpeech !== entry.partOfSpeech) problems.push(`site/index.html: the ${entry.name} entry must show its partOfSpeech from names.json: "${entry.partOfSpeech}"`);
    for (const [field, value] of [["meaning", entry.meaning.join(", ")], ["job", entry.job]]) {
      if (!text.includes(value)) problems.push(`site/index.html: the ${entry.name} entry must show its ${field} from names.json: "${value}"`);
    }
  }
  // The hero or footer says what mexxi means.
  const mexxi = names.find((entry) => entry.name === "mexxi");
  // Tags read as spaces, so the word may be followed by " :".
  if (mexxi && !landingText.replace(/mexxi :/g, "mexxi:").includes(`mexxi: Maltese for “${mexxi.meaning.join(", ")}”`)) problems.push(`site/index.html: give mexxi's meaning as "mexxi: Maltese for “${mexxi.meaning.join(", ")}”" from names.json`);
  return problems;
}
