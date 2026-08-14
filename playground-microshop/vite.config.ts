import { defineConfig, type Plugin } from "vite";
// Consume the plugin from source: instant feedback while editing the plugin.
import { tsmigrate } from "../src/index.ts";

// This playground is twoBirds/MicroComponents, vendored as a git submodule under
// ./microcomponents. The analysed codebase is its `demo/shop` — a small, real
// web-component "Micro Shop" authored as plain `.ts` custom elements (no Vue, no
// `.vue` files, like ../playground-vuetify). The entry (src/main.ts) pulls in the
// shop's own barrel (`demo/shop/bundle-entry.ts`), which side-effect-imports every
// shop component, so the tsmigrate crawl fans out across the real module graph:
// shop-header/-catalog/-sidebar → product-card → cart-container and its panels,
// plus the shared `helpers.ts`. `.js` import specifiers resolve to their sibling
// `.ts` sources (Vite's `.js`→`.ts` resolution).

// `@twobirds/microcomponents` is the library the shop is built on — a
// *dependency*, not part of the analysed codebase. Its source lives in the same
// submodule (`microcomponents/src`), so aliasing the bare specifier to that
// source would resolve it under the playground root and the tsmigrate crawl
// would pull the library's own modules in as graph nodes. Mark it external
// instead: the crawl drops any specifier that doesn't resolve to a file under
// this root, so the graph stays scoped to the shop (its bare import becomes a
// dangling edge, exactly like a real `node_modules` dependency would).
function externalizeMicrocomponents(): Plugin {
  const isLibrary = /^@twobirds\/microcomponents(\/.*)?$/;
  return {
    name: "microshop:externalize-microcomponents",
    enforce: "pre",
    resolveId(id) {
      return isLibrary.test(id) ? { id, external: true } : null;
    },
  };
}

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"],
  },
  // The shop is normally assembled by the library's own build (tsc + a CDN
  // bundle); it isn't meant to run straight from source here. The point is the
  // tsmigrate tool analyzing it, so skip dependency discovery and let the dev
  // server start regardless of the library's bare imports.
  optimizeDeps: { noDiscovery: true },
  plugins: [
    externalizeMicrocomponents(),
    tsmigrate({
      // Dev harness (scripts/dev.mjs) pins the tool server's port so the tool
      // UI's proxy always targets this exact backend; falls back to the default.
      toolPort: Number(process.env.TSMIGRATE_PORT) || undefined,
      // Type-check is left off: the shop's real type pass runs under the
      // library's own tsconfig/build pipeline (which needs the submodule's
      // node_modules), and the shop isn't a standalone tsconfig project here.
      // The crawl still maps the real component graph + LoC. (See ../playground
      // and ../playground-vuetify for playgrounds that run a real vue-tsc pass.)
      typeCheckCommand: false,
      // Shallow submodule checkout — no commit history for git blame.
      blame: false,
    }),
  ],
});
