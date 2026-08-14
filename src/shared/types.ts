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

/**
 * One node in an induced graph. File-level facts (`loc`, `blame`,
 * `typeErrors`, `status`) are identical wherever the file appears; the
 * topology fields (`height`, `strictRed`) are relative to the graph the node
 * belongs to — a `.vue` file's subtree differs between the component-only
 * `vue` graph and the `full` graph that also walks `.ts` modules.
 */
export interface ComponentNode {
  /** Absolute module id — stable key, referenced by edges. */
  id: string;
  /** Path relative to the project root. */
  file: string;
  /** Component/module name derived from the file name. */
  name: string;
  /** Top-level folder used for angular clustering (e.g. `layout`, `(root)`). */
  group: string;
  /** Component (`.vue`) vs plain module (`.ts`). */
  kind: "vue" | "ts";
  /** Total lines in the file (null until analyzed). */
  loc: number | null;
  /** Longest import path from this node down to a leaf, within its graph. */
  height: number;
  /** True when this file OR anything in its import subtree has type errors. */
  strictRed: boolean;
  /** Own type-error count (null until the type-check pass completes). */
  typeErrors: number | null;
  /** Blame breakdown (null until analyzed; see status.blame). */
  blame: BlameSummary | null;
  /** Per-analyzer progress — the UI renders progressively. */
  status: { loc: AnalyzerState; blame: AnalyzerState; typecheck: AnalyzerState };
  errors: Partial<Record<"loc" | "blame" | "typecheck", string>>;
}

/**
 * Importer → imported relation. In the `vue` graph, non-component modules
 * (barrels, composables) are collapsed: `A.vue → utils/index.ts → B.vue`
 * yields the edge `A → B`. In the `full` graph, edges are the raw module
 * imports with no collapsing.
 */
export interface ComponentEdge {
  from: string;
  to: string;
}

/** A self-consistent induced graph: heights/edges/maxHeight all relative to `nodes`. */
export interface Graph {
  nodes: ComponentNode[];
  edges: ComponentEdge[];
  /** Largest `height` among `nodes` — the number of concentric depth rings. */
  maxHeight: number;
}

export interface ComponentGraph {
  /** Monotonic server-side version; bumps on any fact or graph change. */
  version: number;
  /** True when no analyzer work is queued or running. */
  complete: boolean;
  root: string;
  /** `.vue` components only, with barrel-collapsed edges. */
  vue: Graph;
  /** Reachable `.vue` + `.ts` modules, with raw import edges. */
  full: Graph;
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
  /** `true` when the `rg` (ripgrep) binary is available — gates content search. */
  ripgrep: boolean;
}

/**
 * Payload of `GET /api/search?q=<regex>` — files whose contents match the
 * (multiline) ripgrep regex, as paths relative to the project root (matching
 * `ComponentNode.file`). `error` is set instead when the regex is invalid.
 */
export interface SearchResult {
  files: string[];
  error?: string;
}

/**
 * Payload of `GET /api/source?id=<absolute module id>` — the raw file contents
 * for the source-view modal, with the project-relative path and a language id
 * for the client-side highlighter. `error` is set when the file is missing or
 * resolves outside the project root.
 */
export interface SourceResult {
  file: string;
  content: string;
  error?: string;
}
