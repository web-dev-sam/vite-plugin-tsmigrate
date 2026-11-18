import { createServer as createHttpServer, type Server } from "node:http";
import type { ViteDevServer } from "vite";
import { AnalysisEngine } from "../analysis/engine.ts";
import type { AnalysisHost } from "../analysis/host.ts";
import { commandTypeChecker, type TypeChecker, withFallback } from "../analysis/typecheck.ts";
import { patchPrintUrls } from "../log.ts";
import type { ResolvedOptions } from "../options.ts";
import { type ApiHandler, createApiHandler } from "./routes.ts";
import {
  type ClientHandler,
  createClientHandler,
  FALLBACK_HTML,
  resolveClientDir,
} from "./static.ts";
import { createTs7Checker } from "./ts7.ts";
import { createAnalysisHost, createContentSearch, wireInvalidation } from "./vite-adapter.ts";

/** The live engine + request handlers for the current dev-server instance. */
interface ToolHandlers {
  engine: AnalysisEngine;
  handleApi: ApiHandler;
  serveClient: ClientHandler | null;
}

// The tool server is process-scoped: one http server, bound once, reused across
// every dev-server restart. Vite tears down and recreates the dev server (and
// its httpServer) on each restart — sometimes twice — so anchoring the tool to
// a single dev-server instance rebinds the port every edit and races the old
// socket, which is exactly what strands the tool-UI HMR proxy on a dead port.
// Instead we bind once and hot-swap the engine + handlers; the socket lives for
// the process (freed on exit, or explicitly via `stopToolServer` in tests).
let tool: { http: Server; port: number } | null = null;
let handlers: ToolHandlers | null = null;
let exitWired = false;
// The tool UI's TS 7.1 toggle outlives dev-server restarts (null = follow the
// `experimentalTs7` option).
let ts7Toggle: boolean | null = null;

/**
 * The plugin's own tool: a prebuilt Vue app plus a JSON API, served from a
 * dedicated port (like vite-plugin-inspect / devtools plugins) — unrelated
 * to the user's app server. Dev only; one server per process, reused across
 * restarts with the analysis engine hot-swapped in.
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

  const host = createAnalysisHost(server);
  const typeChecker = (ts7: boolean) => createTypeChecker(host, options, ts7);
  const engine = new AnalysisEngine(host, {
    typeChecker: typeChecker(ts7Toggle ?? options.experimentalTs7),
    blame: options.blame,
    blameAliases: options.blameAliases,
  });
  wireInvalidation(server, engine);
  // The TS 7.1 checker owns a Go process (plus the content mapper's Node
  // process): release it with the dev server, not just on the next restart.
  server.httpServer.once("close", () => engine.dispose());
  const search = await createContentSearch(server.config.root);
  const clientDir = resolveClientDir();
  const setTs7 = (enabled: boolean) => {
    ts7Toggle = enabled;
    engine.setTypeChecker(typeChecker(enabled));
  };

  // Retire the previous dev server's engine (its analysis, watchers and
  // type-check process) and serve from this one.
  handlers?.engine.dispose();
  handlers = {
    engine,
    handleApi: createApiHandler(server, engine, search, setTs7),
    serveClient: clientDir ? createClientHandler(clientDir) : null,
  };

  if (!tool) {
    const http = createHttpServer((req, res) => {
      const cur = handlers;
      if (!cur) {
        res.statusCode = 503;
        res.end();
        return;
      }
      void cur.handleApi(req, res).then((handled) => {
        if (handled) {
          return;
        }
        if (cur.serveClient) {
          cur.serveClient(req, res, () => {
            res.statusCode = 404;
            res.end("Not found");
          });
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(FALLBACK_HTML);
      });
    });
    tool = { http, port: await listenTool(http, options.toolPort) };
    wireExit();
  }

  if (options.logOnStart) {
    patchPrintUrls(server, `http://localhost:${tool.port}/`);
  }
}

/**
 * The project type-check pass: `typeCheckCommand` (vue-tsc by default), or —
 * with the experimental toggle on — the TypeScript 7.1 API checker, which
 * falls back to the command when it cannot run.
 */
function createTypeChecker(
  host: AnalysisHost,
  options: ResolvedOptions,
  ts7: boolean,
): TypeChecker | null {
  const command =
    options.typeCheckCommand === false ? null : commandTypeChecker(host, options.typeCheckCommand);
  if (!ts7) {
    return command;
  }
  return withFallback(createTs7Checker(host.root, options.ts7Tsconfig), command);
}

// Free the tool socket when the process ends (the tool lives for the process,
// like other devtool servers). Registered once; a killed process frees it too.
function wireExit(): void {
  if (exitWired) {
    return;
  }
  exitWired = true;
  process.once("exit", () => {
    tool?.http.close();
  });
}

/**
 * Stop the process-scoped tool server and dispose the current engine. Only
 * needed by tests, which create and discard many dev servers in one process;
 * in real use the tool lives until the process exits.
 */
export function stopToolServer(): void {
  handlers?.engine.dispose();
  handlers = null;
  ts7Toggle = null;
  tool?.http.close();
  tool?.http.closeAllConnections();
  tool = null;
}

// Bind the tool server to its preferred port. EADDRINUSE is usually the
// previous instance still releasing the port during a dev-server restart, so
// retry the SAME port for a short window — keeping the tool URL and the tool-UI
// HMR proxy target (:7357) stable across restarts — and only drift to an
// ephemeral port if it stays genuinely occupied. Resolves with the bound port.
// Exported for a focused reclaim test; not part of the package's public API.
export function listenTool(tool: Server, preferred: number): Promise<number> {
  const deadline = Date.now() + 2000;
  return new Promise<number>((resolve, reject) => {
    const onListening = () => {
      tool.off("listening", onListening);
      tool.off("error", onError);
      const addr = tool.address();
      resolve(typeof addr === "object" && addr ? addr.port : preferred);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        tool.off("listening", onListening);
        tool.off("error", onError);
        reject(err);
        return;
      }
      // Retry the preferred port until the window elapses, then give up on it.
      setTimeout(() => tool.listen(Date.now() < deadline ? preferred : 0, "127.0.0.1"), 150);
    };
    tool.on("listening", onListening);
    tool.on("error", onError);
    tool.listen(preferred, "127.0.0.1");
  });
}
