import type { HighlighterCore } from "shiki/core";

/**
 * Lazy shiki highlighter for the source-view modal. Uses shiki's fine-grained
 * core with an explicit theme/lang set (via dynamic imports) so the build only
 * bundles the grammars the tool renders — importing the `shiki` meta-bundle
 * instead would code-split every language it ships. Created once, on first use;
 * the oniguruma wasm engine loads with it. `github-dark` matches the palette.
 */

const THEME = "github-dark";

// File extension → shiki language id, paired with the grammar's dynamic import.
// The set is the file types the crawl can surface; unknown types render as
// plaintext (`text`, always available without a grammar).
const LANGS = {
  vue: () => import("@shikijs/langs/vue"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  markdown: () => import("@shikijs/langs/markdown"),
} as const;

const BY_EXT: Record<string, keyof typeof LANGS> = {
  vue: "vue",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  md: "markdown",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/oniguruma"),
      ]);
      return createHighlighterCore({
        themes: [import("@shikijs/themes/github-dark")],
        langs: Object.values(LANGS).map((load) => load()),
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
    })();
  }
  return highlighterPromise;
}

/**
 * Highlight `code` to a `<pre class="shiki">…</pre>` string. `file` picks the
 * grammar by extension; unknown types render as plaintext.
 */
export async function highlightSource(code: string, file: string): Promise<string> {
  const ext = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
  const lang = BY_EXT[ext] ?? "text";
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, { lang, theme: THEME });
}
