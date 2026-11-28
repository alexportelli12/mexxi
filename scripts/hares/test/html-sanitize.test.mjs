// The allowlist sanitizer for GitHub's body_html. Each test names the injection or loss it guards.
import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHtml } from "../lib/html-sanitize.mjs";

test("script, style, iframe and svg are dropped with their content, not left as visible text", () => {
  const html = sanitizeHtml('<p>a</p><script>alert(1)</script><style>p{display:none}</style><iframe src="https://x"><p>inner</p></iframe><svg><title>t</title><path d="M0"/></svg><p>b</p>');
  assert.equal(html, "<p>a</p><p>b</p>");
});

test("event handler attributes and style attributes never survive on any tag", () => {
  const html = sanitizeHtml('<p onclick="x()" style="position:fixed" id="a">hi</p><a href="https://github.com/x" onmouseover="y()">l</a>');
  assert.equal(html, '<p>hi</p><a href="https://github.com/x" target="_blank" rel="noopener noreferrer nofollow">l</a>');
});

test("a javascript: link is unwrapped to its text however the scheme is disguised", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "jav&#x61;script:alert(1)", "java&#9;script:alert(1)", " javascript:1", "data:text/html,x", "vbscript:x"]) {
    assert.equal(sanitizeHtml('<a href="' + href + '">click</a>'), "click", href);
  }
});

test("https, http, mailto and in-page links keep their target and open in a new tab without a referrer or opener", () => {
  assert.match(sanitizeHtml('<a href="mailto:a@b.co">m</a>'), /^<a href="mailto:a@b.co" target="_blank"/);
  assert.match(sanitizeHtml('<a href="http://example.com/x?a=1&amp;b=2">h</a>'), /href="http:\/\/example\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.equal(sanitizeHtml('<a href="#user-content-notes">n</a>'), '<a href="#user-content-notes">n</a>');
});

test("an image loads only from GitHub's image hosts over https, so a pull request can't make the page call another server", () => {
  const ok = sanitizeHtml('<img src="https://camo.githubusercontent.com/abc" alt="shot" width="300">');
  assert.match(ok, /^<img src="https:\/\/camo\.githubusercontent\.com\/abc" alt="shot" width="300"/);
  assert.match(sanitizeHtml('<img src="https://github.com/user-attachments/assets/1">'), /^<img src="https:\/\/github\.com\/user-attachments/);
  for (const src of ["https://evil.example/p.png", "http://camo.githubusercontent.com/abc", "https://github.com/someone/repo/raw/x.png", "data:image/svg+xml,<svg/>", "javascript:1"]) {
    assert.equal(sanitizeHtml('<img src="' + src + '">'), "", src);
  }
});

test("a task-list checkbox stays but is always disabled, and any other input is dropped", () => {
  assert.equal(sanitizeHtml('<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked onclick="x()"> done</li>'), '<li class="md-task-list-item"><input type="checkbox" disabled checked> done</li>');
  assert.equal(sanitizeHtml('<input type="text" value="x"><form action="https://evil"><input name="p"></form>'), "");
});

test("markdown structure survives: headings, lists, tables with alignment, code, quotes and details", () => {
  const html = '<h2>T</h2><ul><li>a</li></ul><ol start="3"><li>b</li></ol><blockquote><p>q</p></blockquote><pre class="notranslate"><code>x &lt; y</code></pre><table><thead><tr><th align="right">h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table><details open><summary>s</summary>body</details>';
  assert.equal(sanitizeHtml(html), '<h2>T</h2><ul><li>a</li></ul><ol start="3"><li>b</li></ol><blockquote><p>q</p></blockquote><pre class="md-notranslate"><code>x &lt; y</code></pre><table><thead><tr><th align="right">h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table><details open><summary>s</summary>body</details>');
});

test("classes outside GitHub's own markdown ones are removed, and kept ones are prefixed so they can't match hares's styles", () => {
  assert.equal(sanitizeHtml('<span class="pl-k modal fixed-top">x</span>'), '<span class="md-pl-k">x</span>');
  assert.equal(sanitizeHtml('<span class="modal">x</span>'), "<span>x</span>");
});

test("GitHub's heading anchors, whose icon is an svg, don't leave an empty link behind", () => {
  assert.equal(sanitizeHtml('<h2><a class="anchor" aria-hidden="true" href="#title"><svg class="octicon"><path d="M"/></svg></a>Title</h2>'), "<h2>Title</h2>");
});

test("unbalanced and stray markup is closed or escaped, never passed through as live tags", () => {
  assert.equal(sanitizeHtml("<p><b>unclosed"), "<p><b>unclosed</b></p>");
  assert.equal(sanitizeHtml("</div></p>text"), "text");
  assert.equal(sanitizeHtml("1 < 2 and <3"), "1 &lt; 2 and &lt;3");
  assert.equal(sanitizeHtml("<!-- hidden <script>x</script> -->shown"), "shown");
  assert.equal(sanitizeHtml('<p title="a>b"><script>x</script>ok</p>'), "<p>ok</p>");
});

test("an unknown or custom element is unwrapped so its text is still readable", () => {
  assert.equal(sanitizeHtml("<markdown-accessiblity-table><table><tr><td>x</td></tr></table></markdown-accessiblity-table>"), "<table><tr><td>x</td></tr></table>");
});

test("input that isn't a string comes out empty rather than throwing", () => {
  assert.equal(sanitizeHtml(undefined), "");
  assert.equal(sanitizeHtml(null), "");
  assert.equal(sanitizeHtml(42), "");
});
