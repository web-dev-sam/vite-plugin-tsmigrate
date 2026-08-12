import { existsSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import sirv from "sirv";
import type { Plugin, ViteDevServer } from "vite";

/**
 * Options for {@link tsmigrate}.
 */
export interface TsMigrateOptions {
  /**
   * Message exposed by the `virtual:tsmigrate` module, shown in the tool UI,
   * and logged when the Vite config is resolved.
   *
   * @default "Hello, Vite 8!"
   */
  greeting?: string;

  /**
   * Log through Vite's logger: the greeting once the config is resolved, and
   * the tool URL once the dev server is listening.
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

/** Payload served by the tool server's `/api/diagnostics` endpoint. */
export interface Diagnostics {
  greeting: string;
  appUrl: string | null;
  root: string;
  /** Vue version resolved from the user's app, or `null` when not found. */
  vueVersion: string | null;
  /** `.vue` module ids currently in the dev server's module graph. */
  vueModules: string[];
  plugins: string[];
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

// Inspect the user's app through the dev server: resolved Vue version, the
// .vue modules Vite has processed so far, and the active plugin list.
function collectDiagnostics(server: ViteDevServer, greeting: string): Diagnostics {
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
    greeting,
    appUrl: server.resolvedUrls?.local[0] ?? null,
    root,
    vueVersion,
    vueModules,
    plugins: server.config.plugins.map((p) => p.name),
  };
}

/**
 * A minimal, idiomatic Vite 8 plugin — the "hello world" of devtool-style
 * Vite plugins (vite-plugin-inspect, vue-devtools, …).
 *
 * It registers a virtual module (`virtual:tsmigrate`) demonstrating the
 * `resolveId`/`load` pair with the NUL-prefixed resolved-id convention.
 * During dev it hosts its **own Vue application** — prebuilt into
 * `dist/client` and shipped with the package — on a separate port, which
 * diagnoses the user's app via the `/api/diagnostics` endpoint.
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

      // Locate the prebuilt tool UI: `client/` next to the built plugin
      // (dist/index.mjs + dist/client) or, when the plugin runs from source,
      // the repo's dist/client.
      const clientDir = ["client/", "../dist/client/"]
        .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
        .find((dir) => existsSync(join(dir, "index.html")));
      const serveClient = clientDir ? sirv(clientDir, { dev: true, single: true }) : null;

      // The plugin's own Vue app, unrelated to the user's app server — served
      // from a dedicated port like vite-plugin-inspect / devtools plugins.
      const tool = createHttpServer((req, res) => {
        if (req.url?.split("?")[0] === "/api/diagnostics") {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(collectDiagnostics(server, greeting)));
          return;
        }
        if (serveClient) {
          serveClient(req, res, () => {
            res.statusCode = 404;
            res.end("Not found");
          });
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><title>tsmigrate tool</title>" +
            "<p>Tool UI not built yet — run <code>vp run build</code> in the plugin repo.</p>" +
            '<p>The diagnostics API works regardless: <a href="/api/diagnostics">/api/diagnostics</a></p>',
        );
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
