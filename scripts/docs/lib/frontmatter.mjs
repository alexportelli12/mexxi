// Reads the YAML subset this repository's Markdown uses: scalars, quoted
// strings, folded (>-) and literal (|) blocks, lists written inline ([a, b])
// or as "- item" lines, and one level of nested scalars. Anything fancier is
// not supported on purpose.
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
      // One level of "key: value" lines is a map, such as a skill's `metadata`.
      const entries = following.map((line) => line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/)).filter(Boolean);
      data[key] = items.length ? items : entries.length ? Object.fromEntries(entries.map(([, name, text]) => [name, unquote(text)])) : "";
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: text.slice(match[0].length) };
}
