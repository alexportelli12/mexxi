// An allowlist sanitizer for the body_html GitHub renders from markdown
// (Accept: application/vnd.github.html+json). GitHub's HTML is already
// sanitized, but hares serves it into its own origin, so it re-checks: only the
// tags, attributes and URL schemes below survive, and anything else is dropped
// (its text kept, except for tags whose content is code or markup, which go
// whole). No dependency: the input is machine-made HTML, so a small tokenizer
// is enough, and unknown input fails closed into escaped text.

/** Hosts an image may load from: GitHub's image proxy and its upload hosts. The server's CSP img-src lists the same ones. */
export const IMAGE_HOSTS = [
  "camo.githubusercontent.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "avatars.githubusercontent.com",
  "github.com", // /user-attachments/assets/...
];

const VOID = new Set(["br", "hr", "img", "input"]);
const KEEP = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "input", "blockquote", "pre", "code", "em", "strong", "b", "i",
  "del", "s", "ins", "a", "img", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "details", "summary", "div", "span", "sup", "sub", "kbd", "g-emoji",
]);
// Dropped together with everything inside them.
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "form", "textarea", "select", "title", "noscript", "template", "button", "head", "link", "meta", "base", "video", "audio", "canvas"]);
// Classes GitHub's markdown output uses (syntax highlighting, task lists, alerts). Kept with an md- prefix so they can't hit hares's own styles.
const CLASS_OK = /^(?:pl-[a-z0-9-]+|highlight(?:-[a-z0-9-]+)?|notranslate|task-list-item|contains-task-list|markdown-alert(?:-[a-z]+)?|emoji|user-mention|issue-link)$/;
const ALIGN = new Set(["left", "right", "center"]);
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const escapeText = (text) => text.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function decode(value) {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** A URL the page may link to or load: decoded, control characters and whitespace removed (so "java\tscript:" can't hide), scheme checked. */
function safeUrl(raw, { image }) {
  // eslint-disable-next-line no-control-regex
  const value = decode(raw).replace(/[\x00-\x20\x7f-\x9f]/g, "");
  if (!value) return null;
  if (!image && /^#[\w%.:-]*$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (image) return url.protocol === "https:" && IMAGE_HOSTS.includes(url.hostname) && (url.hostname !== "github.com" || url.pathname.startsWith("/user-attachments/")) ? url.href : null;
  if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") return url.href;
  return null;
}

/** Attributes from a tag's inside text, as a Map of lower-cased name to raw value. */
function parseAttributes(text) {
  const attributes = new Map();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function cleanClasses(value) {
  const kept = decode(value).split(/\s+/).filter((name) => CLASS_OK.test(name)).map((name) => "md-" + name);
  return kept.length ? kept.join(" ") : null;
}

/** The attribute text to emit for an allowed tag, or null when the tag must go (an image with no safe source). */
function attributesFor(tag, attributes) {
  const out = [];
  const add = (name, value) => out.push(name + '="' + escapeAttr(value) + '"');
  const classes = attributes.has("class") ? cleanClasses(attributes.get("class")) : null;
  if (tag === "a") {
    const href = attributes.has("href") ? safeUrl(attributes.get("href"), { image: false }) : null;
    if (!href) return null;
    add("href", href);
    if (!href.startsWith("#")) out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  } else if (tag === "img") {
    const src = attributes.has("src") ? safeUrl(attributes.get("src"), { image: true }) : null;
    if (!src) return null;
    add("src", src);
    add("alt", decode(attributes.get("alt") ?? "").slice(0, 300));
    for (const name of ["width", "height"]) if (/^\d{1,4}$/.test(attributes.get(name) ?? "")) add(name, attributes.get(name));
    out.push('loading="lazy"', 'decoding="async"', 'referrerpolicy="no-referrer"');
  } else if (tag === "input") {
    // Only GitHub's task-list checkbox; always inert.
    if ((attributes.get("type") ?? "").toLowerCase() !== "checkbox") return null;
    out.push('type="checkbox"', "disabled");
    if (attributes.has("checked")) out.push("checked");
  } else if (tag === "ol" && /^\d{1,6}$/.test(attributes.get("start") ?? "")) {
    add("start", attributes.get("start"));
  } else if ((tag === "td" || tag === "th") && ALIGN.has((attributes.get("align") ?? "").toLowerCase())) {
    add("align", attributes.get("align").toLowerCase());
  } else if (tag === "details" && attributes.has("open")) {
    out.push("open");
  }
  if (classes && tag !== "img" && tag !== "input") add("class", classes);
  return out.length ? " " + out.join(" ") : "";
}

/**
 * Sanitized HTML for hares to put in the page, from GitHub's body_html. Never throws; anything it can't make sense of
 * comes out as escaped text.
 * @param {unknown} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
  const input = typeof html === "string" ? html : "";
  const out = [];
  const open = []; // tags emitted and not yet closed
  let skipTag = null; // a DROP_WITH_CONTENT tag we're inside
  let skipDepth = 0;
  let index = 0;
  const closeTo = (tag) => {
    const at = open.lastIndexOf(tag);
    if (at < 0) return;
    while (open.length > at) out.push("</" + open.pop() + ">");
  };
  while (index < input.length) {
    const lt = input.indexOf("<", index);
    if (lt < 0) {
      if (!skipTag) out.push(escapeText(input.slice(index)));
      break;
    }
    if (lt > index && !skipTag) out.push(escapeText(input.slice(index, lt)));
    index = lt;
    if (input.startsWith("<!--", index)) {
      const end = input.indexOf("-->", index + 4);
      index = end < 0 ? input.length : end + 3;
      continue;
    }
    const tagMatch = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(input.slice(index, index + 20_000));
    if (!tagMatch) {
      // "<!doctype", "<?x", or a stray "<": not a tag we understand.
      const end = /^<[!?]/.test(input.slice(index, index + 2)) ? input.indexOf(">", index) : -1;
      if (end >= 0) index = end + 1;
      else {
        if (!skipTag) out.push("&lt;");
        index += 1;
      }
      continue;
    }
    index += tagMatch[0].length;
    const closing = tagMatch[1] === "/";
    const tag = tagMatch[2].toLowerCase();
    const selfClosed = tagMatch[3].trimEnd().endsWith("/");
    if (skipTag) {
      if (tag === skipTag && !closing && !selfClosed) skipDepth += 1;
      else if (tag === skipTag && closing) {
        skipDepth -= 1;
        if (skipDepth === 0) skipTag = null;
      }
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !selfClosed) {
        skipTag = tag;
        skipDepth = 1;
      }
      continue;
    }
    if (!KEEP.has(tag)) continue; // unknown or custom element: unwrapped, its text stays
    if (closing) {
      if (!VOID.has(tag)) closeTo(tag);
      continue;
    }
    const attributes = attributesFor(tag, parseAttributes(tagMatch[3]));
    if (attributes === null) continue; // an unsafe link is unwrapped to its text; an unsafe image or checkbox goes
    out.push("<" + tag + attributes + ">");
    if (!VOID.has(tag)) open.push(tag);
  }
  while (open.length) out.push("</" + open.pop() + ">");
  // GitHub's heading anchors are empty links once their icon is gone.
  return out.join("").replace(/<a href="#[^"]*"(?: class="[^"]*")?><\/a>/g, "");
}
