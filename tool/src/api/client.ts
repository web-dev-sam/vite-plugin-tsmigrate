import type {
  Diagnostics,
  GraphResponse,
  SearchResult,
  SourceResult,
} from "../../../src/shared/types.ts";

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

/**
 * Content search: files whose contents match the multiline regex, relative to
 * the project root. Throws with ripgrep's message on an invalid regex.
 */
export async function fetchSearch(pattern: string): Promise<string[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(pattern)}`);
  if (!res.ok) {
    throw new Error(`search failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as SearchResult;
  if (data.error) {
    throw new Error(data.error);
  }
  return data.files;
}

/** Raw source of a node's file for the source-view modal. Throws when missing. */
export async function fetchSource(id: string): Promise<{ file: string; content: string }> {
  const res = await fetch(`/api/source?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`source failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as SourceResult;
  if (data.error) {
    throw new Error(data.error);
  }
  return { file: data.file, content: data.content };
}
