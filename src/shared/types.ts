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
  /** Cyclomatic complexity — decision points in the script plus template branch directives (null until analyzed). */
  cc: number | null;
  /** Longest import path from this node down to a leaf, within its graph. */
  height: number;
  /** True when this file OR anything in its import subtree has type errors. */
  strictRed: boolean;
  /** Own type-error count (null until the type-check pass completes). */
  typeErrors: number | null;
  /** Blame breakdown (null until analyzed; see status.blame). */
  blame: BlameSummary | null;
  /** Per-analyzer progress — the UI renders progressively. */
  status: { loc: AnalyzerState; cc: AnalyzerState; blame: AnalyzerState; typecheck: AnalyzerState };
  errors: Partial<Record<"loc" | "cc" | "blame" | "typecheck", string>>;
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
   * `import.meta.glob`) — a declarative registry hop, not comprehension load.
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

/**
 * One maintainability hotspot — a file whose modelled change-cost dominates
 * the score. Surfaced so the number is actionable: these are where to look.
 */
export interface MaintainabilityHotspot {
  id: string;
  file: string;
  loc: number;
  /** Cyclomatic complexity (script decision points + template branches) — drives this file's mass cost. */
  cc: number;
  /** Direct value imports (efferent coupling, Ce) — type-only edges excluded. */
  fanOut: number;
  /** Direct value importers (afferent coupling, Ca) — type-only edges excluded. */
  fanIn: number;
  /** Volatility ∈ [0,1] — measured deleted-lines rate, floored by shrunk structural instability. */
  volatility: number;
  /** Blast radius — fraction of the codebase's LoC that transitively imports this file. */
  blastRadius: number;
  /** True when this file sits in a structural import cycle (a non-trivial SCC over value edges). */
  inCycle: boolean;
  /** This file's modelled change-cost, in LoC-equivalent units. */
  cost: number;
}

/**
 * The overhead drivers (excess coupling / change blast / complexity mass).
 * Types are a cost discount inside each driver, not a driver of their own.
 */
export type MaintainabilityDriver = "comprehension" | "blast" | "mass";

/**
 * Per-node contribution to each driver, normalised to [0,1] by the top
 * contributor in that driver. Keyed by node id (absolute module id); a file
 * absent from the map contributes zero to every driver. Powers the graph's
 * driver-highlight rings.
 */
export type MaintainabilityContributions = Record<
  string,
  { comprehension: number; blast: number; mass: number }
>;

/**
 * Per-node change-cost breakdown for the alt-hover detail view: the
 * LoC-equivalent overhead each driver adds to THIS file (typed discounts
 * applied — a typed file's flaws already cost only D×), plus the raw
 * structural ingredients (weighted fan-out, volatility, blast radius).
 * Present only for files that carry overhead; a file absent from the map
 * sits at its own floor. Keyed by node id.
 */
export interface MaintainabilityBreakdown {
  /** Excess-coupling overhead this file adds, in LoC-equivalent units (typed discount applied). */
  comprehension: number;
  /** Change-blast overhead, in LoC-equivalent units (dependents' typedness discount applied). */
  blast: number;
  /** Complexity-mass overhead (decision points × size escalator), in LoC-equivalent units (typed discount applied). */
  mass: number;
  /** Volatility-weighted fan-out (Ceʷ) — only volatile imports count toward it. */
  weightedFanout: number;
  /** Volatility ∈ [0,1] (measured deleted-lines rate, floored by shrunk structural instability). */
  volatility: number;
  /** Fraction of the codebase's LoC that transitively depends on this file. */
  blastRadius: number;
}
/**
 * Whole-graph maintainability: the overhead of a safe change — typed code
 * discounts its flaws, the compiler carrying re-verification — mapped onto a
 * criterion-referenced scale (a typical production Vue app scores 30;
 * halving the overhead ratio is worth +25 points). Computed over the `full`
 * module graph. The full model — every term and its rationale — lives in
 * `docs/maintainability-score.md`.
 */
export interface Maintainability {
  /** `min(100, 30 − 25·log₂(Ω/Ω_typ))`. Capped at 100 (zero overhead), open below zero — negatives are genuine disasters. */
  score: number;
  /** The overhead ratio Ω = (costLoc − floorLoc)/floorLoc the mapping ran on (typed discounts included). */
  omega: number;
  /** Model/anchor calibration epoch — recorded so old screenshots stay interpretable across model versions. */
  calibrationEpoch: string;
  /** Σ LoC — the theoretical floor: every file read once, no excess coupling. */
  floorLoc: number;
  /** Modelled total change-cost in LoC-equivalent units (`>= floorLoc`). */
  costLoc: number;
  /**
   * How the structural overhead above the floor splits, as fractions summing
   * to 1: `comprehension` (excess volatility-weighted fan-out), `blast`
   * (volatility × blast radius), and `mass` (decision points escalated by
   * file size).
   */
  drivers: { comprehension: number; blast: number; mass: number };
  /** Fraction of LoC trapped in import cycles (SCCs with more than one member). */
  cycleLoc: number;
  /** Nodes / edges the score was computed over (the `full` graph). */
  nodes: number;
  edges: number;
  /** LoC-weighted typed fraction, or `null` when the type-check pass is off. */
  typeHealth: number | null;
  /**
   * LoC-weighted fraction of the graph with usable git history behind its
   * volatility, or `null` when the churn pass is off or still pending. Low
   * coverage means volatility is mostly the structural prior — the score is
   * valid but blind to real churn (shallow clones, fresh repos).
   */
  churnCoverage: number | null;
  /**
   * Edge-price volatility per node id ∈ [0,1] (zero-volatility nodes
   * omitted) — the exact number the score charges an importer per import of
   * that node, and therefore the visual weight of every drawn edge (by
   * target).
   */
  volatility: Record<string, number>;
  /** Biggest score-draggers first (highest overhead above their own floor), capped — where to look to raise the score. */
  hotspots: MaintainabilityHotspot[];
  /** Per-node normalised contribution to each driver, for the driver-highlight rings. */
  contributions: MaintainabilityContributions;
  /** Per-node change-cost breakdown for the alt-hover detail view (files at their floor omitted). */
  breakdown: Record<string, MaintainabilityBreakdown>;
  /**
   * Members of the largest import cycles (structural SCCs, biggest LoC
   * first, capped) — the actionable list behind `cycleLoc`/`inCycle`. Cycles
   * held together only by `import type` edges do not appear: they are legal
   * TS and carry no runtime hazard.
   */
  cycles: string[][];
}

/**
 * Crawl scope: what the graph actually covers, so a JS-graph score is never
 * read as a codebase-wide verdict. `unreached` lists project source files
 * (crawlable kinds only) that no entry reaches — dead code, archives, or
 * crawler blind spots. Diagnostic only: unreached files enter neither floor
 * nor cost.
 */
export interface CoverageSummary {
  /** Files in the `full` module graph. */
  graphFiles: number;
  /** Σ maintainable LoC of graph files. */
  graphLoc: number;
  /** All crawlable source files under the root (graph + unreached). */
  sourceFiles: number;
  /** Σ maintainable LoC of all crawlable source files. */
  sourceLoc: number;
  /** Project-relative paths + LoC of files the crawl never reached — largest LoC first, list capped (`sourceFiles − graphFiles` is the true count). */
  unreached: Array<{ file: string; loc: number }>;
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
  /** Modelled maintainability of the `full` module graph. */
  maintainability: Maintainability;
  /** How much of the project's source the graph covers. */
  coverage: CoverageSummary;
  /**
   * Generated auto-import manifests detected during the crawl (Nuxt /
   * `unplugin-vue-components` / `unplugin-auto-import`): components and
   * composables bound with no import statement. Their edges are invisible to
   * the graph, so coupling and blast radius are UNDER-reported — the tool
   * shows a warning banner when non-empty. Absolute paths.
   */
  autoImportManifests: string[];
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
