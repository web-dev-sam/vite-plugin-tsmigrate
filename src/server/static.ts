import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Locate the prebuilt tool UI. Candidates cover every runtime layout:
 * - packaged: dist/index.mjs + dist/client/
 * - from source: src/server/static.ts → ../../dist/client/
 */
export function resolveClientDir(): string | null {
  const candidates = ["client/", "../dist/client/", "../../dist/client/"];
  for (const candidate of candidates) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

export const FALLBACK_HTML =
  "<!doctype html><title>tsmigrate tool</title>" +
  "<p>Tool UI not built yet — run <code>vp run build</code> in the plugin repo.</p>" +
  '<p>The API works regardless: <a href="/api/graph">/api/graph</a>, ' +
  '<a href="/api/diagnostics">/api/diagnostics</a></p>';

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Serves a prebuilt tool-UI file for the request, calling `notFound` when nothing matches. */
export type ClientHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  notFound: () => void,
) => void;

/**
 * Minimal static handler for the prebuilt tool UI. Maps a request to a file
 * under `dir` (guarding against path traversal) and falls back to `index.html`
 * for unknown routes, since the tool is a single-page app. Dev-only over a
 * fixed, hashed asset set — a static-server dependency (byte ranges, ETag
 * revalidation, precompression) buys nothing here.
 */
export function createClientHandler(dir: string): ClientHandler {
  const root = resolve(dir);
  const index = join(root, "index.html");
  return (req, res, notFound) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      // Malformed percent-encoding (e.g. `/%ZZ`) — do not let the URIError
      // escape into the request handler as an unhandled rejection / hung socket.
      notFound();
      return;
    }
    const candidate = normalize(join(root, pathname));
    const inside = candidate === root || candidate.startsWith(root + sep);
    const file =
      inside && existsSync(candidate) && statSync(candidate).isFile() ? candidate : index;
    if (!existsSync(file)) {
      notFound();
      return;
    }
    res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-cache");
    createReadStream(file).pipe(res);
  };
}
