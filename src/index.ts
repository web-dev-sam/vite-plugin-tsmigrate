import pc from "picocolors";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

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
   * Log through Vite's logger: the greeting once the config is resolved, and
   * the server URL once the dev or preview server is listening.
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

// `server.resolvedUrls` is only populated after the server starts listening,
// so an `httpServer` "listening" handler would race it. Patching `printUrls`
// is the ecosystem convention: the CLI (dev and preview) and programmatic
// servers call it once the URLs exist.
function patchPrintUrls(server: ViteDevServer | PreviewServer): void {
  const printUrls = server.printUrls.bind(server);
  server.printUrls = () => {
    printUrls();
    const url = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0];
    if (url) {
      // Match Vite's own URL block styling: green arrow, bold label, cyan URL
      // with a bold port (picocolors is Vite's own color lib).
      const colored = pc.cyan(
        url.replace(/:(\d+)\//, (_: string, port: string) => `:${pc.bold(port)}/`),
      );
      server.config.logger.info(`  ${pc.green("\u279C")}  ${pc.bold("tsmigrate")}: ${colored}`);
    }
  };
}

/**
 * A minimal, idiomatic Vite 8 plugin — the "hello world" of Vite plugins.
 *
 * It registers a virtual module (`virtual:tsmigrate`) that re-exports a
 * configurable greeting, demonstrating the `resolveId`/`load` pair with the
 * NUL-prefixed resolved-id convention, plus `configResolved`,
 * `configureServer`, and `configurePreviewServer` for logging.
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
        config.logger.info(`${pc.cyan("[vite-plugin-tsmigrate]")} ${greeting}`);
      }
    },

    configureServer(server) {
      if (logOnStart) {
        patchPrintUrls(server);
      }
    },

    configurePreviewServer(server) {
      if (logOnStart) {
        patchPrintUrls(server);
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
