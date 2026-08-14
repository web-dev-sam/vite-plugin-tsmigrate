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
  /** Cyclomatic complexity — decision points in the file's script (null until analyzed). */
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
 * yields the edge `A → B`. In the `full` graph, edges are the raw module
 * imports with no collapsing.
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
  /** Cyclomatic complexity (decision points) — amplifies this file's flaw cost. */
  cc: number;
  /** Direct imports (efferent coupling, Ce). */
  fanOut: number;
  /** Direct importers (afferent coupling, Ca). */
  fanIn: number;
  /** Volatility-weighted instability `Ceʷ / (Ceʷ + Ca)` ∈ [0,1] — a change-likelihood proxy where stable imports count for less. */
  instability: number;
  /** Blast radius — fraction of the codebase's LoC that transitively imports this file. */
  blastRadius: number;
  /** True when this file sits in an import cycle (a non-trivial SCC). */
  inCycle: boolean;
  /** This file's modelled change-cost, in LoC-equivalent units. */
  cost: number;
}

/** The three overhead drivers (excess coupling / change blast / type errors). */
export type MaintainabilityDriver = "comprehension" | "blast" | "types";

/**
 * Per-node contribution to each driver, normalised to [0,1] by the top
 * contributor in that driver. Keyed by node id (absolute module id); a file
 * absent from the map contributes zero to every driver. Powers the graph's
 * driver-highlight rings.
 */
export type MaintainabilityContributions = Record<
  string,
  { comprehension: number; blast: number; types: number }
>;

/**
 * Per-node change-cost breakdown for the alt-hover detail view: the
 * LoC-equivalent overhead each driver adds to THIS file, plus the raw
 * structural ingredients (weighted fan-out, instability, blast radius) and the
 * complexity multiplier. Present only for files that carry overhead or
 * complexity; a file absent from the map sits at its own floor. Keyed by node id.
 */
export interface MaintainabilityBreakdown {
  /** Excess-coupling overhead this file adds, in LoC-equivalent units. */
  comprehension: number;
  /** Change-blast overhead, in LoC-equivalent units. */
  blast: number;
  /** Type-error overhead, in LoC-equivalent units. */
  types: number;
  /** Volatility-weighted fan-out (Ceʷ) — only volatile imports count toward it. */
  weightedFanout: number;
  /** Instability `Ceʷ/(Ceʷ+Ca)` ∈ [0,1]. */
  instability: number;
  /** Fraction of the codebase's LoC that transitively depends on this file. */
  blastRadius: number;
  /** Flaw-cost multiplier from complexity (1 = no amplification). */
  cxWeight: number;
}
/**
 * Whole-graph maintainability score: the modelled cost of a safe change,
 * normalised against the "read every file once" floor (higher = cheaper to
 * maintain). Computed over the `full` module graph. The full model — every
 * term and its rationale — lives in `docs/maintainability-score.md`.
 */
export interface Maintainability {
  /** 0..100, higher = more maintainable (`floorLoc / costLoc`). */
  score: number;
  /** Σ LoC — the theoretical floor: every file read once, no excess coupling, fully typed. */
  floorLoc: number;
  /** Modelled total change-cost in LoC-equivalent units (`>= floorLoc`). */
  costLoc: number;
  /**
   * How the overhead above the floor splits, as fractions summing to 1:
   * `comprehension` (excess volatility-weighted fan-out), `blast` (volatility × blast radius), and
   * `types` (the direct cost of red, error-carrying files).
   */
  drivers: { comprehension: number; blast: number; types: number };
  /**
   * Fraction of the total flaw-cost that exists *because* flaws sit in
   * complex (branch-dense) files — i.e. how much complexity amplifies the
   * overhead. 0 when the codebase is flaw-free or uniformly simple.
   */
  complexityAmplification: number;
  /** Fraction of LoC trapped in import cycles (SCCs with more than one member). */
  cycleLoc: number;
  /** Nodes / edges the score was computed over (the `full` graph). */
  nodes: number;
  edges: number;
  /** LoC-weighted typed fraction, or `null` when the type-check pass is off. */
  typeHealth: number | null;
  /** Biggest score-draggers first (highest overhead above their own floor), capped — where to look to raise the score. */
  hotspots: MaintainabilityHotspot[];
  /** Per-node normalised contribution to each driver, for the driver-highlight rings. */
  contributions: MaintainabilityContributions;
  /** Per-node change-cost breakdown for the alt-hover detail view (files at their floor omitted). */
  breakdown: Record<string, MaintainabilityBreakdown>;
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
  /** Modelled maintainability of the `full` module graph. */
  maintainability: Maintainability;
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
