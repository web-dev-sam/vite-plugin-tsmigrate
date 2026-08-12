import { createRequire } from "node:module";
import { join, relative } from "node:path";
import type { ViteDevServer } from "vite";
import type { ResolvedOptions } from "../options.ts";
import type { Diagnostics } from "../shared/types.ts";

/** Quick environment summary shown in the tool header. */
export function collectDiagnostics(server: ViteDevServer, options: ResolvedOptions): Diagnostics {
  const root = server.config.root;

  let vueVersion: string | null = null;
  try {
    const requireFromApp = createRequire(join(root, "package.json"));
    const pkg: unknown = requireFromApp("vue/package.json");
    if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") {
      vueVersion = pkg.version;
    }
  } catch {
    vueVersion = null;
  }

  const vueModules = [...server.environments.client.moduleGraph.idToModuleMap.keys()]
    .filter((id) => id.endsWith(".vue"))
    .map((id) => relative(root, id))
    .sort();

  return {
    greeting: options.greeting,
    appUrl: server.resolvedUrls?.local[0] ?? null,
    root,
    vueVersion,
    vueModules,
    plugins: server.config.plugins.map((plugin) => plugin.name),
  };
}
