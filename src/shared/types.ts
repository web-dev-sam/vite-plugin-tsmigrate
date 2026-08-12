/**
 * Wire contract between the plugin (server side) and the tool UI (client).
 * The single source of truth — the tool app imports these types directly.
 * Everything here must stay environment-neutral (no node/vite imports).
 */

export type AnalyzerState = "pending" | "ready" | "error";

export interface BlameSummary {
  /** Lines currently attributed to each author (`git blame`). */
  authorLines: Record<string, number>;
}

export interface ComponentNode {
  /** Absolute module id — stable key, referenced by edges. */
  id: string;
  /** Path relative to the project root. */
  file: string;
  /** Component name derived from the file name. */
  name: string;
  /** Total lines in the file (null until analyzed). */
  loc: number | null;
  /** Blame breakdown (null until analyzed; see status.blame). */
  blame: BlameSummary | null;
  /** Per-analyzer progress — the UI renders progressively. */
  status: { loc: AnalyzerState; blame: AnalyzerState };
  errors: Partial<Record<"loc" | "blame", string>>;
}

/**
 * Importer → imported relation between components. Non-component modules
 * (barrels, composables) are collapsed: `A.vue → utils/index.ts → B.vue`
 * yields the edge `A → B`.
 */
export interface ComponentEdge {
  from: string;
  to: string;
}

export interface ComponentGraph {
  /** Monotonic server-side version; bumps on any fact or graph change. */
  version: number;
  /** True when no analyzer work is queued or running. */
  complete: boolean;
  root: string;
  nodes: ComponentNode[];
  edges: ComponentEdge[];
}

/** Cheap answer to `GET /api/graph?since=<version>` when nothing changed. */
export interface GraphUnchanged {
  version: number;
  unchanged: true;
}

export type GraphResponse = ComponentGraph | GraphUnchanged;

/** Payload of `GET /api/diagnostics`. */
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
