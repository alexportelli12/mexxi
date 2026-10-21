// Reads the YAML subset this repository's Markdown uses: scalars, quoted
// strings, folded (>-) and literal (|) blocks, and lists written inline
// ([a, b]) or as "- item" lines. Anything fancier is not supported on purpose.
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

export function parseFrontmatter(source) {
  // A checkout with core.autocrlf (common on Windows) has CRLF line endings.
  const text = source.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { data: {}, body: text };
  const lines = match[1].split("\n");
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const pair = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    const following = [];
    while (index + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[index + 1])) following.push(lines[(index += 1)]);
    if (/^[>|][+-]?$/.test(value)) {
      const parts = following.map((line) => line.trim()).filter(Boolean);
      data[key] = parts.join(value.startsWith(">") ? " " : "\n");
    } else if (value === "") {
      const items = following.map((line) => line.match(/^\s*-\s+(.*)$/)?.[1]).filter(Boolean).map(unquote);
      data[key] = items.length ? items : "";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}
