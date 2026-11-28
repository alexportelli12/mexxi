/** The page title is the h1, so the body's headings start at h2: the shallowest one becomes h2 and the rest keep their distance. */
function shiftHeadings(html: string): string {
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  if (levels.length === 0) return html;
  const offset = 2 - Math.min(...levels);
  return html.replace(/<(\/?)h([1-6])\b/gi, (_m, slash: string, level: string) => `<${slash}h${Math.min(6, Number(level) + offset)}`);
}

/**
 * Prepares a pull request body or comment for [innerHTML]. The server already sanitised it; Angular
 * still sanitises what we bind, and it drops form controls, so this keeps the one thing it would
 * lose: whether a task-list box is ticked. Nothing here makes HTML trusted.
 */
export function prepareHtml(html: string): string {
  return shiftHeadings(html)
    .replace(/<input\b[^>]*\btype="checkbox"[^>]*>/gi, (tag) =>
      /\bchecked\b/i.test(tag)
        ? '<span class="gh-task gh-task-on" role="img" aria-label="Done"></span>'
        : '<span class="gh-task" role="img" aria-label="Not done"></span>')
    // A wide table scrolls inside its own box instead of stretching the page.
    .replace(/<table\b/gi, '<div class="gh-table"><table')
    .replace(/<\/table>/gi, '</table></div>')
    .replace(/<a\b([^>]*)>/gi, (tag, attrs: string) =>
      /\bhref="https?:/i.test(attrs) && !/\btarget=/i.test(attrs) ? `<a${attrs} target="_blank" rel="noopener noreferrer">` : tag);
}
