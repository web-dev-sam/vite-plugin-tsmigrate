import type { Plugin } from "vite";
import { PLUGIN_NAME } from "./constants.ts";
import { resolveOptions, type TsMigrateOptions } from "./options.ts";
import { startToolServer } from "./server/index.ts";

export type { TsMigrateOptions } from "./options.ts";
export type {
  BlameSummary,
  ComponentEdge,
  ComponentGraph,
  ComponentNode,
  Diagnostics,
  Graph,
  GraphResponse,
} from "./shared/types.ts";

/**
 * A minimal, idiomatic Vite 8 plugin. During dev it hosts its own Vue app on
 * a separate port that analyses the user's app: component graph, LoC, and git
 * blame per component.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { tsmigrate } from "vite-plugin-tsmigrate";
 *
 * export default defineConfig({
 *   plugins: [tsmigrate()],
 * });
 * ```
 */
export function tsmigrate(userOptions: TsMigrateOptions = {}): Plugin {
  const options = resolveOptions(userOptions);
  return {
    name: PLUGIN_NAME,

    configureServer(server) {
      return startToolServer(server, options);
    },
  };
}

export default tsmigrate;
