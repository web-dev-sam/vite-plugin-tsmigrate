import type { Plugin } from "vite";
import { PLUGIN_NAME } from "./constants.ts";
import { logGreeting } from "./log.ts";
import { resolveOptions, type TsMigrateOptions } from "./options.ts";
import { startToolServer } from "./server/index.ts";
import { loadVirtualModule, resolveVirtualId } from "./virtual.ts";

export { VIRTUAL_MODULE_ID } from "./constants.ts";
export type { TsMigrateOptions } from "./options.ts";
export type {
  BlameSummary,
  ComponentEdge,
  ComponentGraph,
  ComponentNode,
  Diagnostics,
  GraphResponse,
} from "./shared/types.ts";

/**
 * A minimal, idiomatic Vite 8 plugin — the "hello world" of devtool-style
 * Vite plugins. Ships a virtual module (`virtual:tsmigrate`) and, during
 * dev, hosts its own Vue app on a separate port that analyses the user's
 * app: component graph, LoC, and git blame per component.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { tsmigrate } from "vite-plugin-tsmigrate";
 *
 * export default defineConfig({
 *   plugins: [tsmigrate({ greeting: "Hello from my app!" })],
 * });
 * ```
 */
export function tsmigrate(userOptions: TsMigrateOptions = {}): Plugin {
  const options = resolveOptions(userOptions);
  return {
    name: PLUGIN_NAME,

    configResolved(config) {
      if (options.logOnStart) {
        logGreeting(config.logger, options);
      }
    },

    configureServer(server) {
      return startToolServer(server, options);
    },

    resolveId(id) {
      return resolveVirtualId(id);
    },

    load(id) {
      return loadVirtualModule(id, options);
    },
  };
}

export default tsmigrate;
