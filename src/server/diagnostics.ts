import { createRequire } from "node:module";
import { basename, join, relative } from "node:path";
import type { ViteDevServer } from "vite";
import type { Diagnostics } from "../shared/types.ts";

/** Quick environment summary shown in the tool header. */
export function collectDiagnostics(server: ViteDevServer, ripgrep: boolean): Diagnostics {
  const root = server.config.root;
  const requireFromApp = createRequire(join(root, "package.json"));

  // Project display name: the app's package.json `name`, else the root dir basename.
  let projectName = basename(root);
  try {
    const pkg: unknown = requireFromApp("./package.json");
    if (pkg && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string" && pkg.name) {
      projectName = pkg.name;
    }
  } catch {
    // Keep the basename fallback.
  }

  let vueVersion: string | null = null;
  try {
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
    appUrl: server.resolvedUrls?.local[0] ?? null,
    root,
    projectName,
    vueVersion,
    vueModules,
    plugins: server.config.plugins.map((plugin) => plugin.name),
    ripgrep,
  };
}
