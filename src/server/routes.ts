import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import type { ViteDevServer } from "vite";
import type { AnalysisEngine } from "../analysis/engine.ts";
import type { TypeErrorsResult } from "../shared/types.ts";
import { collectDiagnostics } from "./diagnostics.ts";
import { type ContentSearch, readProjectFile } from "./vite-adapter.ts";

/** The tool server's API request handler: resolves `true` when it handled the request. */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * HTTP API of the tool server. This module only maps routes to analysis
 * calls and serializes `shared/types` — the transport seam: replacing
 * polling with birpc/WebSocket later touches this file (and the client
 * mirror in `tool/src/api/client.ts`) and nothing else.
 */
export function createApiHandler(
  server: ViteDevServer,
  engine: AnalysisEngine,
  search: ContentSearch,
  setTs7: (enabled: boolean) => void,
): ApiHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://tool.local");

    if (url.pathname === "/api/diagnostics") {
      sendJson(res, collectDiagnostics(server, search.available));
      return true;
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      try {
        sendJson(res, { files: await search.search(q) });
      } catch (error) {
        sendJson(res, { files: [], error: String(error instanceof Error ? error.message : error) });
      }
      return true;
    }

    if (url.pathname === "/api/source") {
      const id = url.searchParams.get("id") ?? "";
      const source = await readProjectFile(server.config.root, id);
      if (!source) {
        sendJson(res, { file: "", content: "", error: "file not found" });
        return true;
      }
      sendJson(res, source);
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

    if (url.pathname === "/api/type-errors") {
      // `id` is an absolute module id (`ComponentNode.id`); a root-relative
      // path (`ComponentNode.file`) works too.
      const raw = url.searchParams.get("id") ?? "";
      const id = isAbsolute(raw) ? raw : resolve(server.config.root, raw);
      const result: TypeErrorsResult = { id, errors: engine.typeErrorsOf(id) };
      sendJson(res, result);
      return true;
    }

    // The tool's experimental TypeScript 7.1 toggle; body `{ "enabled": boolean }`.
    // Turning it on lets TypeScript spawn the content mapper, so only the tool
    // itself may flip it: a JSON content type makes any cross-origin page's
    // request preflight, which this server never grants.
    if (url.pathname === "/api/ts7" && req.method === "POST") {
      if (req.headers["content-type"] !== "application/json") {
        res.statusCode = 415;
        res.end();
        return true;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end();
        return true;
      }
      const enabled =
        typeof parsed === "object" &&
        parsed !== null &&
        "enabled" in parsed &&
        parsed.enabled === true;
      setTs7(enabled);
      sendJson(res, { version: engine.version });
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
