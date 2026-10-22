import { nextTick, onMounted, watch } from "vue";
import { useRoute } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./custom.css";

// Mermaid is loaded only on pages that contain a diagram. It is the one extra
// dependency of the docs build; the diagram stays plain text in the Markdown.
async function renderDiagrams() {
  const nodes = [...document.querySelectorAll("pre.mermaid:not([data-processed])")];
  if (!nodes.length) return;
  // Labels are sized from the font in use, so wait for fonts or they are clipped.
  await document.fonts?.ready;
  const { default: mermaid } = await import("mermaid");
  // Diagram colours come from the shared tokens, so they follow the page.
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: { primaryColor: token("--surface-raised"), primaryBorderColor: token("--accent"), primaryTextColor: token("--text"), lineColor: token("--muted"), fontFamily: "Inter, system-ui, sans-serif" },
  });
  await mermaid.run({ nodes });
}

export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute();
    onMounted(renderDiagrams);
    watch(() => route.path, () => nextTick(renderDiagrams));
  },
};
