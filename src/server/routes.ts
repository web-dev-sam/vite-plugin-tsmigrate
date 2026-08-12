import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import type { AnalysisEngine } from "../analysis/engine.ts";
import type { ResolvedOptions } from "../options.ts";
import { collectDiagnostics } from "./diagnostics.ts";

/**
 * HTTP API of the tool server. This module only maps routes to analysis
 * calls and serializes `shared/types` — the transport seam: replacing
 * polling with birpc/WebSocket later touches this file (and the client
 * mirror in `tool/src/api/client.ts`) and nothing else.
 */
export function createApiHandler(
  server: ViteDevServer,
  engine: AnalysisEngine,
  options: ResolvedOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://tool.local");

    if (url.pathname === "/api/diagnostics") {
      sendJson(res, collectDiagnostics(server, options));
      return true;
    }

    if (url.pathname === "/api/graph") {
      // Cheap probe: unchanged since the client's version → tiny payload.
      const since = Number(url.searchParams.get("since"));
      if (Number.isInteger(since) && since === engine.version) {
        sendJson(res, { version: engine.version, unchanged: true });
        return true;
      }
      sendJson(res, await engine.getGraph());
      return true;
    }

    return false;
  };
}

function sendJson(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}
