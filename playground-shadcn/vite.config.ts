import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
// Consume the plugin from source: instant feedback while editing the plugin.
import { tsmigrate } from "../src/index.ts";

// This playground is the shadcn-vue monorepo, vendored as a git submodule under
// ./shadcn-vue (Vue 3 + TypeScript). The analysed codebase is its component
// registry (`apps/v4/registry/new-york-v4`): ~66 UI components plus blocks,
// charts and shared libs, authored as `.vue` + `.ts`. The entry (src/main.ts)
// imports every UI barrel, so the tsmigrate crawl fans out across the real
// component graph. `@/` is shadcn-vue's own source alias (-> apps/v4), so
// imports resolve to source; third-party deps (reka-ui, ...) stay external.
const appRoot = fileURLToPath(new URL("./shadcn-vue/apps/v4", import.meta.url));

export default defineConfig({
  resolve: {
    // `@` and `~` are the Nuxt srcDir aliases used across the registry.
    alias: [
      { find: /^@\//, replacement: `${appRoot}/` },
      { find: /^~\//, replacement: `${appRoot}/` },
    ],
    extensions: [".ts", ".tsx", ".vue", ".mts", ".js", ".jsx", ".json"],
  },
  // The registry isn't meant to run here (it needs shadcn-vue's Nuxt pipeline);
  // the point is the tsmigrate tool analyzing it. Skip dependency discovery so
  // the dev server starts regardless of the many external imports.
  optimizeDeps: { noDiscovery: true },
  plugins: [
    tsmigrate({
      // Dev harness (scripts/dev.mjs) pins the tool server's port so the tool
      // UI's proxy always targets this exact backend; falls back to the default.
      toolPort: Number(process.env.TSMIGRATE_PORT) || undefined,
      // shadcn-vue's registry is a Nuxt app whose type-check relies on Nuxt's
      // generated tsconfig + auto-imports; a standalone vue-tsc needs that
      // pipeline, so the type pass is left off here — the crawl still maps the
      // real component graph + LoC. (See ../playground and ../playground-vuetify
      // for playgrounds that run a real vue-tsc pass.)
      typeCheckCommand: false,
    }),
  ],
});
