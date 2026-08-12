import { createServer as createHttpServer, type Server } from "node:http";
import pc from "picocolors";
import type { Plugin, ViteDevServer } from "vite";

/**
 * Options for {@link tsmigrate}.
 */
export interface TsMigrateOptions {
  /**
   * Message exposed by the `virtual:tsmigrate` module, shown on the tool page,
   * and logged when the Vite config is resolved.
   *
   * @default "Hello, Vite 8!"
   */
  greeting?: string;

  /**
   * Log through Vite's logger: the greeting once the config is resolved, and
   * the tool server URL once the dev server is listening.
   *
   * @default true
   */
  logOnStart?: boolean;

  /**
   * Port for the plugin's own tool server (dev only). When the port is taken,
   * an ephemeral port is used instead. Pass `0` to always use an ephemeral
   * port.
   *
   * @default 7357
   */
  toolPort?: number;
}

/** Import specifier consumers use to load the generated module. */
export const VIRTUAL_MODULE_ID = "virtual:tsmigrate";

// Resolved ids of virtual modules are prefixed with NUL so that other plugins
// (and Vite internals) leave them untouched.
// https://vite.dev/guide/api-plugin#virtual-modules-convention
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

// Bind the tool server, falling back to an ephemeral port when the preferred
// one is taken. Resolves with the actually bound port.
function listenTool(tool: Server, port: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  tool.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") {
      reject(err);
      return;
    }
    tool.once("error", reject);
    tool.listen(0, "127.0.0.1", () => {
      const addr = tool.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
  tool.listen(port, "127.0.0.1", () => {
    const addr = tool.address();
    resolve(typeof addr === "object" && addr ? addr.port : port);
  });
  return promise;
}

/**
 * A minimal, idiomatic Vite 8 plugin — the "hello world" of Vite plugins.
 *
 * It registers a virtual module (`virtual:tsmigrate`) that re-exports a
 * configurable greeting, demonstrating the `resolveId`/`load` pair with the
 * NUL-prefixed resolved-id convention. During dev it also hosts its own tool
 * page on a separate port (like vite-plugin-inspect or devtools plugins) and
 * appends that URL to Vite's startup block.
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
  const { greeting = "Hello, Vite 8!", logOnStart = true, toolPort = 7357 } = options;

  return {
    name: "vite-plugin-tsmigrate",

    configResolved(config) {
      if (logOnStart) {
        config.logger.info(`${pc.cyan("[vite-plugin-tsmigrate]")} ${greeting}`);
      }
    },

    async configureServer(server: ViteDevServer) {
      // No standalone http server in middleware mode — no place to anchor the
      // tool's lifecycle (and printUrls is meaningless there).
      if (!server.httpServer) {
        return;
      }

      const escaped = greeting
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");

      // The plugin's own tool, unrelated to the user's app server — served
      // from a dedicated port like vite-plugin-inspect / devtools plugins.
      const tool = createHttpServer((_req, res) => {
        const appUrl = server.resolvedUrls?.local[0];
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>tsmigrate tool</title>
<style>main{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto}</style>
</head>
<body><main>
<h1>vite-plugin-tsmigrate</h1>
<p>${escaped}</p>
<p>App server: ${appUrl ? `<a href="${appUrl}">${appUrl}</a>` : "(not listening yet)"}</p>
</main></body>
</html>
`);
      });

      const port = await listenTool(tool, toolPort);
      const toolUrl = `http://localhost:${port}/`;

      // Tie the tool's lifecycle to the dev server (also covers restarts).
      server.httpServer.once("close", () => {
        tool.close();
      });

      if (logOnStart) {
        // `server.resolvedUrls` is only populated after `listen()` resolves,
        // so an `httpServer` "listening" handler would race it. Patching
        // `printUrls` is the ecosystem convention: the CLI and programmatic
        // servers call it once the URLs exist. Styling matches Vite's own URL
        // block (picocolors is Vite's own color lib).
        const printUrls = server.printUrls.bind(server);
        server.printUrls = () => {
          printUrls();
          const colored = pc.cyan(
            toolUrl.replace(/:(\d+)\//, (_: string, p: string) => `:${pc.bold(p)}/`),
          );
          server.config.logger.info(`  ${pc.green("\u279C")}  ${pc.bold("tsmigrate")}: ${colored}`);
        };
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
