import { createServer as createHttpServer, type Server } from "node:http";
import type { ViteDevServer } from "vite";
import { AnalysisEngine } from "../analysis/engine.ts";
import { patchPrintUrls } from "../log.ts";
import type { ResolvedOptions } from "../options.ts";
import { createApiHandler } from "./routes.ts";
import { createClientHandler, FALLBACK_HTML, resolveClientDir } from "./static.ts";
import { createAnalysisHost, wireInvalidation } from "./vite-adapter.ts";

/**
 * The plugin's own tool: a prebuilt Vue app plus a JSON API, served from a
 * dedicated port (like vite-plugin-inspect / devtools plugins) — unrelated
 * to the user's app server. Dev only; lifecycle is tied to the dev server.
 */
export async function startToolServer(
  server: ViteDevServer,
  options: ResolvedOptions,
): Promise<void> {
  // No standalone http server in middleware mode — no place to anchor the
  // tool's lifecycle (and printUrls is meaningless there).
  if (!server.httpServer) {
    return;
  }

  const engine = new AnalysisEngine(createAnalysisHost(server), {
    typeCheckCommand: options.typeCheckCommand,
    blame: options.blame,
    blameAliases: options.blameAliases,
  });
  wireInvalidation(server, engine);
  const handleApi = createApiHandler(server, engine, options);

  const clientDir = resolveClientDir();
  const serveClient = clientDir ? createClientHandler(clientDir) : null;

  const tool = createHttpServer((req, res) => {
    void handleApi(req, res).then((handled) => {
      if (handled) {
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
      res.end(FALLBACK_HTML);
    });
  });

  const port = await listenTool(tool, options.toolPort);

  // Tie the tool's lifecycle to the dev server (also covers restarts).
  server.httpServer.once("close", () => {
    engine.dispose();
    tool.close();
  });

  if (options.logOnStart) {
    patchPrintUrls(server, `http://localhost:${port}/`);
  }
}

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
