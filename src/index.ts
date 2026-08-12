import type { Plugin } from "vite";

/**
 * Options for {@link tsmigrate}.
 */
export interface TsMigrateOptions {
  /**
   * Message exposed by the `virtual:tsmigrate` module and logged when the Vite
   * config is resolved.
   *
   * @default "Hello, Vite 8!"
   */
  greeting?: string;

  /**
   * Log the greeting through Vite's logger once the config is resolved.
   *
   * @default true
   */
  logOnStart?: boolean;
}

/** Import specifier consumers use to load the generated module. */
export const VIRTUAL_MODULE_ID = "virtual:tsmigrate";

// Resolved ids of virtual modules are prefixed with NUL so that other plugins
// (and Vite internals) leave them untouched.
// https://vite.dev/guide/api-plugin#virtual-modules-convention
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/**
 * A minimal, idiomatic Vite 8 plugin — the "hello world" of Vite plugins.
 *
 * It registers a virtual module (`virtual:tsmigrate`) that re-exports a
 * configurable greeting, demonstrating the `resolveId`/`load` pair and the
 * NUL-prefixed resolved-id convention shared across the Vite ecosystem.
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
 *
 * @example
 * ```ts
 * // anywhere in your app
 * import { greeting } from "virtual:tsmigrate";
 * console.log(greeting);
 * ```
 */
export function tsmigrate(options: TsMigrateOptions = {}): Plugin {
  const { greeting = "Hello, Vite 8!", logOnStart = true } = options;

  return {
    name: "vite-plugin-tsmigrate",

    configResolved(config) {
      if (logOnStart) {
        config.logger.info(`[vite-plugin-tsmigrate] ${greeting}`);
      }
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        return `export const greeting = ${JSON.stringify(greeting)};\n`;
      }
    },
  };
}

export default tsmigrate;
