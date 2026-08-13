import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
// Consume the plugin from source: instant feedback while editing the plugin.
import { tsmigrate } from "../src/index.ts";

// This playground is the Vuetify monorepo itself, vendored as a git submodule
// under ./vuetify (Vue 3 + TypeScript). Unlike the vben playground (an app),
// this is a component *library*: ~300 `.tsx` components plus composables,
// directives and blueprints under packages/vuetify/src. The entry
// (src/main.ts) imports Vuetify's own bundler entry, so the tsmigrate crawl
// fans out across the real library module graph. Imports resolve to source
// (not built dist) via the `@/` alias below, so no Vuetify build is needed.
const vuetifySrc = fileURLToPath(new URL("./vuetify/packages/vuetify/src", import.meta.url));

export default defineConfig({
  resolve: {
    // `@/` is Vuetify's own source alias (packages/vuetify/tsconfig.json).
    alias: [{ find: /^@\//, replacement: `${vuetifySrc}/` }],
    extensions: [".ts", ".tsx", ".vue", ".mts", ".js", ".jsx", ".json"],
  },
  // The library isn't meant to run in the browser here (it needs Vuetify's full
  // build pipeline — sass, Vite-injected globals); the point is the tsmigrate
  // tool analyzing it. Skip dependency discovery so the dev server starts
  // regardless of Vuetify's many bare imports.
  optimizeDeps: { noDiscovery: true },
  plugins: [
    tsmigrate({
      greeting: "Analyzing Vuetify (Vue 3 + TypeScript component library)",
      // Real type-checking drives node coloring: run Vuetify's own `vue-tsc`
      // over `packages/vuetify`. Its committed ambient `.d.ts` shim sass and
      // globals like `__VUETIFY_VERSION__`, so the pass is accurate (not
      // spurious). `--ignoreDeprecations` silences a TS7 config-only warning so
      // the run exits clean. Diagnostic paths (relative to this root) resolve
      // onto the crawl's node ids. Vuetify is fully typed, so a clean checkout
      // reports zero errors → all green; a real type error turns its node (and
      // its importers) red — see ../playground for a live red/green example.
      typeCheckCommand: [
        "./vuetify/node_modules/.bin/vue-tsc",
        "--noEmit",
        "--skipLibCheck",
        "--ignoreDeprecations",
        "6.0",
        "-p",
        "vuetify/packages/vuetify/tsconfig.json",
        "--pretty",
        "false",
      ],
    }),
  ],
});
