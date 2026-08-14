import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Alias, defineConfig } from "vite";
// Consume the plugin from source: instant feedback while editing the plugin.
import { tsmigrate } from "../src/index.ts";

// The playground is a complex, real-world app: vue-vben-admin's `web-antd`
// admin, vendored as a git submodule under ./vben (Vue 3 + TypeScript, ~700
// `.vue` + ~700 `.ts` across the app shell and its @vben/@vben-core packages).
// The entry (src/main.ts) imports web-antd's own entry, so the tsmigrate crawl
// fans out across the real component/module graph. Imports resolve to source
// (not built dist) via the aliases below, so no monorepo build is needed.
const vbenRoot = fileURLToPath(new URL("./vben", import.meta.url));
const webAntdSrc = join(vbenRoot, "apps/web-antd/src");

// Map every @vben/* and @vben-core/* workspace package to its `src` directory
// so the crawl follows cross-package imports into real files (`@vben/x` →
// <pkg>/src, `@vben/x/sub` → <pkg>/src/sub). Generated from the submodule's
// package manifests so it survives vben upgrades.
function packageAliases(): Alias[] {
  const aliases: Alias[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "package.json") {
        continue;
      }
      let name: unknown;
      try {
        name = JSON.parse(readFileSync(full, "utf8")).name;
      } catch {
        continue;
      }
      if (typeof name !== "string" || !name.startsWith("@vben")) {
        continue;
      }
      const src = join(dirname(full), "src");
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      aliases.push({ find: new RegExp(`^${escaped}(/|$)`), replacement: `${src}$1` });
    }
  };
  for (const top of ["packages", "apps"]) {
    walk(join(vbenRoot, top));
  }
  return aliases;
}

export default defineConfig({
  resolve: {
    // `#/*` is web-antd's own source alias; the rest map the workspace packages.
    alias: [{ find: /^#\//, replacement: `${webAntdSrc}/` }, ...packageAliases()],
    extensions: [".ts", ".tsx", ".vue", ".mts", ".js", ".jsx", ".json"],
  },
  // The app isn't meant to run in the browser here (it needs vben's full build
  // pipeline); the point is the tsmigrate tool analyzing it. Skip dependency
  // discovery so the dev server starts regardless of vben's many bare imports.
  optimizeDeps: { noDiscovery: true },
  plugins: [
    tsmigrate({
      // Dev harness (scripts/dev.mjs) pins the tool server's port so the tool
      // UI's proxy always targets this exact backend; falls back to the default.
      toolPort: Number(process.env.TSMIGRATE_PORT) || undefined,
      greeting: "Analyzing vue-vben-admin (Vue 3 + TypeScript)",
      // Real per-file type errors drive node coloring: run vben's own vue-tsc
      // over the web-antd app from this root, so diagnostic paths resolve to
      // the crawl's node ids. A clean vben checkout reports zero errors (fully
      // typed → all green); introduce a type error to see a node turn red.
      typeCheckCommand: [
        "./vben/node_modules/.bin/vue-tsc",
        "-p",
        "vben/apps/web-antd/tsconfig.json",
        "--noEmit",
        "--pretty",
        "false",
      ],
    }),
  ],
});
