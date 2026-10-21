// Copied into docs-site/.vitepress/ by build.mjs, next to site-data.json (the
// generated sidebar). Search is VitePress's built-in local index: no service.
import { defineConfig } from "vitepress";
import siteData from "./site-data.json";

const base = process.env.DOCS_BASE ?? "/mexxi/docs/";

export default defineConfig({
  lang: "en-GB",
  title: "mexxi",
  description: "Docs for mexxi: a workflow that takes a coding agent's task to a pull request you can review in a minute.",
  base,
  outDir: process.env.DOCS_OUT_DIR,
  appearance: "force-dark", // the landing page is dark only
  // public/ holds the plain .md copies; they ship as files, not as pages.
  srcExclude: ["public/**"],
  cleanUrls: false,
  ignoreDeadLinks: false, // a broken internal link fails the build; the `docs` check relies on it
  head: [["link", { rel: "icon", href: `${base}favicon.svg`, type: "image/svg+xml" }]],
  markdown: {
    config(md) {
      // Sources are plain Markdown. Raw HTML would let text such as <name>
      // become a Vue element, so escape it instead.
      md.set({ html: false });
      const fence = md.renderer.rules.fence;
      md.renderer.rules.fence = (tokens, index, ...rest) => {
        const token = tokens[index];
        if (token.info.trim() !== "mermaid") return fence(tokens, index, ...rest);
        return `<pre v-pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
      };
    },
  },
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Start here", link: "/" },
      { text: "Commands", link: "/commands/" },
      { text: "Skills", link: "/skills/" },
      { text: "CLI", link: "/cli/" },
      { text: "Landing page", link: "https://alexportelli12.github.io/mexxi/" },
    ],
    sidebar: siteData.sidebar,
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/alexportelli12/mexxi" }],
    outline: [2, 3],
  },
});
