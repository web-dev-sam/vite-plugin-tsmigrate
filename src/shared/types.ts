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
  /** Maintainable source lines — excludes `<style>`/`<svg>` blocks (null until analyzed). */
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
 * yields the edge `A → B`. In the `full` graph, edges are symbol-resolved
 * definition edges: value/type imports point at the modules that *define* the
 * imported symbols (barrels are transparent), whole-module dependencies
 * (side-effect, namespace, dynamic import) at the module itself.
 */
export interface ComponentEdge {
  from: string;
  to: string;
  /**
   * True when this edge exists *only* via TypeScript type-only imports
   * (`import type` / `import { type X }`) — no value or side-effect
   * dependency. Omitted for value edges. Rendered dashed in the tool.
   */
  type?: boolean;
  /**
   * True when this edge exists *only* across lazy boundaries (`import(...)`,
   * `import.meta.glob`) — a declarative registry hop. Rendered with its own dash.
   * Omitted for edges with any synchronous occurrence. `full` graph only.
   */
  lazy?: boolean;
  /**
   * Origin symbol names crossing this edge (capped; absent for whole-module
   * edges). `full` graph only — the `vue` graph keeps its exact legacy shape.
   */
  symbols?: string[];
  /**
   * Re-export/barrel hops the resolution passed through (first hop today —
   * the import statement's direct target — so a narrowed edge stays greppable
   * in `from`'s source). `full` graph only.
   */
  via?: string[];
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
  /** Reachable `.vue` + `.ts` modules, with symbol-resolved definition edges. */
  full: Graph;
  /**
   * Generated auto-import manifests detected during the crawl (Nuxt /
   * `unplugin-vue-components` / `unplugin-auto-import`): components and
   * composables bound with no import statement. Their edges are invisible to
   * the graph, so depths and strict-red propagation under-report — the tool
   * shows a warning banner when non-empty. Absolute paths.
   */
  autoImportManifests: string[];
  /** Which checker produces `typeErrors` — drives the experimental TS 7.1 toggle. */
  typeChecker: TypeCheckerInfo;
}

/**
 * The project type-check pass behind `typeErrors`: `typeCheckCommand`
 * (vue-tsc by default) or the experimental TypeScript 7.1 API checker.
 */
export interface TypeCheckerInfo {
  /** The experimental TypeScript 7.1 checker is switched on. */
  ts7: boolean;
  /**
   * Why the TS 7.1 checker could not run (not installed, crashed); the pass
   * fell back to `typeCheckCommand`. Absent while TS 7.1 works or is off.
   */
  fallback?: string;
}

/** One type error of a file, 1-based like an editor's line:column. */
export interface TypeErrorMessage {
  line: number;
  column: number;
  /** The `TSxxxx` number. */
  code: number;
  /** Full message text; chained detail lines are indented below the head. */
  message: string;
}

/**
 * Payload of `GET /api/type-errors?id=<absolute module id>`. `errors` is
 * `null` while the type-check pass has no result (pending, failed or
 * disabled) — never an empty list standing in for "unknown".
 */
export interface TypeErrorsResult {
  id: string;
  errors: TypeErrorMessage[] | null;
}

/** Cheap answer to `GET /api/graph?since=<version>` when nothing changed. */
export interface GraphUnchanged {
  version: number;
  unchanged: true;
}

export type GraphResponse = ComponentGraph | GraphUnchanged;

/** Payload of `GET /api/diagnostics`. */
export interface Diagnostics {
  appUrl: string | null;
  root: string;
  /** Display name of the analyzed project (its package.json `name`, else the root dir basename). */
  projectName: string;
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
