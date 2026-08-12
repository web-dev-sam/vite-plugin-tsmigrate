import type { Diagnostics, GraphResponse } from "../../../src/shared/types.ts";

/**
 * Client mirror of `src/server/routes.ts` — the transport seam. The graph
 * endpoint supports cheap `?since=` probes: the server answers with a tiny
 * `{ unchanged: true }` payload when nothing changed.
 */

export async function fetchDiagnostics(): Promise<Diagnostics> {
  const res = await fetch("/api/diagnostics");
  if (!res.ok) {
    throw new Error(`diagnostics failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Diagnostics;
  return data;
}

export async function fetchGraph(since?: number): Promise<GraphResponse> {
  const url = since === undefined ? "/api/graph" : `/api/graph?since=${since}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`graph failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as GraphResponse;
  return data;
}
