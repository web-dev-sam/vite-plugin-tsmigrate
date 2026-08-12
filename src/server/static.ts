import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
