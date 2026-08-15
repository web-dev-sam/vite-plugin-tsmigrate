import * as d3 from "d3";
import type {
  ComponentNode,
  Graph,
  MaintainabilityBreakdown,
  MaintainabilityContributions,
  MaintainabilityDriver,
} from "../../../src/shared/types.ts";
import { type Adjacency, buildAdjacency, type FocusDir, isolateSet } from "./select.ts";

/**
 * Framework-agnostic d3 renderer for the radial typing-progress graph — a
 * faithful port of the prototype in `vis/graph.html`. Vue owns the chrome
 * (panel, tooltip element, control state); this module owns the SVG scene and
 * every graph interaction, and hands view-local readouts back through a
 * callback so the panel can render them.
 *
 * Interactions ported verbatim from the prototype: deterministic angular
 * seeding by folder wedge per depth ring, a settling force simulation with
 * fit-to-bounds, ring circles + depth labels, drag, zoom/pan, hover
 * neighbour-highlight with tooltip, click-to-isolate an import subtree, a
 * clickable depth-row isolate, strict/naive recolour, and the
 * only-red / show-rings / show-blame / search view filters.
 */

// GitHub-dark tokens (mirrors the prototype stylesheet).
const GREEN = "#3fb950";
const RED = "#f85149";
// Neutral fill for files still being type-checked — never red-on-unknown.
const NEUTRAL = "#8b949e";
// Driver-highlight ring colours (mirror the panel's coloured dots). Mass is
// the amber complexity accent, matching the panel's mass readout.
const DRIVER_COLOR: Record<MaintainabilityDriver, string> = {
  comprehension: "#58a6ff",
  blast: "#a371f7",
  mass: "#d29922",
};
// Driver-highlight ring geometry (user units): how far the ring extends past the
// node edge, its stroke thickness, and the min contribution worth drawing.
const HALO_OFFSET = 6;
const HALO_STROKE = 2;
const HALO_EPS = 0.03;

const TAU = 2 * Math.PI;
const RING = 150;
/** Pre-tick count that settles the layout before the first paint. */
const PRETICKS = 340;

/**
 * Compute the zoom transform that fits the bounding box of `pts` into a
 * `vw`×`vh` viewport (with `pad` user-units of margin).
 *
 * With no points there is no box to fit: `Math.min`/`Math.max` over empty
 * arrays return `+Infinity`/`-Infinity`, the derived centre is `NaN`, and the
 * scale collapses to `0` — which serialises to the invalid
 * `translate(NaN,NaN) scale(0)` and makes the browser reject the `<g>`
 * transform. Fall back to the identity transform in that case.
 */
export function fitTransform(
  pts: ReadonlyArray<{ x?: number; y?: number }>,
  vw: number,
  vh: number,
  pad = 50,
): d3.ZoomTransform {
  if (!pts.length) return d3.zoomIdentity;
  const xs = pts.map((p) => p.x!);
  const ys = pts.map((p) => p.y!);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const k = Math.min(vw / (w + 2 * pad), vh / (h + 2 * pad));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return d3.zoomIdentity
    .translate(vw / 2, vh / 2)
    .scale(k)
    .translate(-cx, -cy);
}

export type Mode = "strict" | "naive";

/** The persistent view controls Vue mirrors into the scene. */
export interface Controls {
  mode: Mode;
  onlyRed: boolean;
  /** Show only typed (green) components — the inverse of `onlyRed`. */
  onlyGreen: boolean;
  showRings: boolean;
  showBlame: boolean;
  search: string;
  /**
   * File paths (relative to root) whose contents match the content-search
   * regex, or `null` when no content search is active. When set, a node shows
   * only if its `file` is in the set — ANDed with `search`.
   */
  contentMatches: Set<string> | null;
  blameGreen: boolean;
  blameRed: boolean;
  /**
   * Render every import edge among the shown nodes. Off by default: with
   * thousands of edges the default view draws links only for the selected
   * node's subtree. Turning this on opts back into the full edge overlay.
   */
  showLinks: boolean;
  /**
   * Highlight every shown import edge in the hover-blue, as if hovering all
   * nodes at once. Implies drawing the full edge overlay (like `showLinks`),
   * but paints the edges with the emphasis colour instead of the muted grey.
   */
  highlightLinks: boolean;
  /**
   * Draw each shown node's filename as a text label above the node. Off by
   * default: with thousands of nodes the labels overlap into noise, so this is
   * an opt-in overlay (independent of the depth-number labels).
   */
  showLabels: boolean;
}

/** One row of the per-depth progress table (highest depth first). */
export interface DepthRow {
  height: number;
  /** Percent of this depth's LoC that is typed. */
  pct: number;
  green: number;
  total: number;
  /** Every file at this depth is typed. */
  done: boolean;
  /** This depth is the active isolate. */
  active: boolean;
}

/** One row of the blame-by-author rollup. */
export interface BlameRow {
  author: string;
  loc: number;
  pct: number;
}

/** View-local readouts recomputed over the shown set on every refresh. */
export interface Readouts {
  /** LoC-weighted typing progress of the shown set. */
  locPct: number;
  greenFiles: number;
  greenLoc: number;
  redFiles: number;
  redLoc: number;
  files: number;
  edges: number;
  leaves: number;
  roots: number;
  depths: DepthRow[];
  blame: {
    /** Whether any shown file carries blame data at all (independent of the green/red toggles). */
    available: boolean;
    /** Which source toggle is active: `green`, `red`, `all`, or `none`. */
    set: string;
    files: number;
    sumLoc: number;
    rows: BlameRow[];
  };
}

/** One contributor row inside a change-cost driver (an import or a dependent). */
export interface DetailContributor {
  name: string;
  /** Trailing muted annotation, e.g. `×0.42` or `128 LOC`. */
  tail: string;
  /**
   * Provenance line (native tooltip): the dependent's shortest import path to
   * this file plus the symbols crossing the final hop, or an import edge's
   * crossing symbols — the greppable "why" behind the row.
   */
  why?: string;
}

/** One change-cost driver in the detail panel's breakdown. */
export interface DetailDriver {
  key: "comprehension" | "blast" | "mass" | "types" | "cycle";
  label: string;
  /** Swatch colour (mirrors the panel's coloured dots). */
  color: string;
  /** Share of this file's structural overhead, in percent (null for the type-debt and cycle rows). */
  share: number | null;
  /** Muted descriptive tail. */
  meta: string;
  /** Mechanical next step ("imports 12 volatile modules — invert or split"). */
  action?: string;
  /** Volatility ∈ [0,1] for the `blast` driver — surfaced separately so the panel can colour-code it. */
  volatility?: number;
  /** Weighted contributor rows (imports for coupling, dependents for blast). */
  items: DetailContributor[];
}

/**
 * One shipped import cycle, preprocessed by the app shell for display and
 * isolation: members, a basename chain label, and the cut hint — the cycle
 * edge crossing the fewest symbols is the cheapest to sever.
 */
export interface CycleInfo {
  members: string[];
  /** Display chain, e.g. `store.ts ↔ actions.ts`. */
  label: string;
  /** Cheapest edge to sever, or null when no symbol data narrows the choice. */
  cut: { from: string; to: string; label: string } | null;
}

/**
 * Structured detail of the hovered or selected node, rendered by the sidebar's
 * bottom panel. Replaces the old alt-hover tooltip: the tooltip now carries only
 * the filename/LOC/links summary, everything else lives here.
 */
export interface NodeDetail {
  id: string;
  name: string;
  /** Path relative to the project root. */
  file: string;
  /** Directory portion of `file` (trailing slash), `""` at the root. */
  fileDir: string;
  /** Basename of `file`. */
  fileBase: string;
  /** Actual file ending (e.g. `tsx`), falling back to the coarse kind. */
  ext: string;
  status: "typed" | "red" | "analyzing";
  /** Extra own-status line (pending / N errors / self typed · subtree red), or null. */
  ownStatus: string | null;
  height: number;
  loc: number;
  cc: number;
  errors: number;
  /** Files that import this one ("X consume it"). */
  fanIn: number;
  /** Files this one imports ("consumes Y deps"). */
  fanOut: number;
  blame: { author: string; loc: number }[];
  /**
   * Change-cost breakdown: `null` until the score arrives; `atFloor` when the
   * file adds no overhead; otherwise the per-driver rows.
   */
  breakdown: { atFloor: boolean; drivers: DetailDriver[] } | null;
  /** Whether this reflects a live hover or the current selection. */
  source: "hover" | "select";
}

export interface InitOptions {
  svg: SVGSVGElement;
  /** Fixed tooltip element the renderer fills and positions on hover. */
  tooltip: HTMLElement;
  /** Fires whenever the shown set or colour mode changes. */
  onReadouts: (readouts: Readouts) => void;
  /** Fires on a node double-click — opens the source-view modal. */
  onOpenSource: (node: { id: string; file: string }) => void;
  /** Fires with the hovered/selected node's structured detail (null clears the panel). */
  onNodeDetail: (detail: NodeDetail | null) => void;
}

export interface GraphController {
  /** Rebuild the whole scene for a graph (vue ↔ full swap or fresh data). */
  setGraph(graph: Graph): void;
  /**
   * Provide the FULL module graph + shipped cycles regardless of the shown
   * view: the score runs on it, so breakdown contributor lists, ×vol tails and
   * dependent paths must come from it too (in the `vue` view the current
   * view's adjacency cannot add up to the server's numbers).
   */
  setFullGraph(full: Graph | null, cycles: CycleInfo[] | null): void;
  /** Reapply the persistent view controls without a relayout. */
  setControls(controls: Controls): void;
  /** Toggle a depth-row isolate (clears it when already active). */
  toggleDepth(height: number): void;
  /** Isolate a node's supertree (its dependents) — the panel's hotspot-row click. */
  focusDependents(id: string): void;
  /** Isolate an explicit id set (the panel's cycle-row click). */
  focusSet(ids: string[]): void;
  /** Highlight a driver's per-node contribution as coloured rings (null clears). */
  setDriverHighlight(
    driver: MaintainabilityDriver | null,
    contributions: MaintainabilityContributions | null,
  ): void;
  /** Update the per-node change-cost breakdown + volatility map for the detail panel and edge weights. */
  setBreakdown(
    breakdown: Record<string, MaintainabilityBreakdown> | null,
    volatility: Record<string, number> | null,
  ): void;
  /** Tear down the simulation, listeners and DOM. */
  destroy(): void;
}

/** Internal simulation node — the wire node adapted to the prototype's model. */
interface RNode extends d3.SimulationNodeDatum {
  id: string;
  /** Path relative to the project root (used for display). */
  file: string;
  name: string;
  group: string;
  kind: "vue" | "ts";
  /** Lines of code (prototype `size`). */
  size: number;
  /** Cyclomatic complexity — script decision points + template branches. */
  cc: number;
  /** Own type-error count (prototype `errors`). */
  errors: number;
  strictRed: boolean;
  /** Type-check still pending for this file — render neutral, never red. */
  analyzing: boolean;
  height: number;
  blame: Record<string, number>;
  /** Deterministic seed position (folder wedge on the depth ring). */
  _sx: number;
  _sy: number;
}

interface RLink extends d3.SimulationLinkDatum<RNode> {
  source: string | RNode;
  target: string | RNode;
  /** Type-only import edge — rendered dashed, zero structural weight. */
  type: boolean;
  /** Lazy-only edge (dynamic import / glob) — distinct dash, zero comprehension weight. */
  lazy: boolean;
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const baseOf = (f: string): string => f.slice(f.lastIndexOf("/") + 1);

/** Adapt a wire node into the internal simulation node. */
function toRNode(n: ComponentNode): RNode {
  return {
    id: n.id,
    file: n.file,
    name: n.name,
    group: n.group,
    kind: n.kind,
    size: n.loc ?? 1,
    cc: n.cc ?? 0,
    errors: n.typeErrors ?? 0,
    strictRed: n.strictRed,
    analyzing: n.typeErrors === null && n.status.typecheck !== "ready",
    height: n.height,
    blame: n.blame?.authorLines ?? {},
    _sx: 0,
    _sy: 0,
  };
}

export function initGraph(opts: InitOptions): GraphController {
  const { tooltip, onReadouts, onOpenSource, onNodeDetail } = opts;
  const svg = d3.select(opts.svg);
  const root = svg.append("g");
  const ringG = root.append("g");
  const linkG = root.append("g");
  const haloG = root.append("g");
  const fileLabelG = root.append("g");
  const nodeG = root.append("g");
  const labelG = root.append("g");

  const width = () => opts.svg.clientWidth || window.innerWidth;
  const height = () => opts.svg.clientHeight || window.innerHeight;

  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.03, 8])
    .on("zoom", (e) => root.attr("transform", e.transform.toString()));
  svg.call(zoom);

  // Persistent controls (defaults mirror the prototype's initial panel state).
  let controls: Controls = {
    mode: "strict",
    onlyRed: false,
    onlyGreen: false,
    showRings: true,
    showBlame: false,
    search: "",
    contentMatches: null,
    blameGreen: true,
    blameRed: false,
    showLinks: false,
    highlightLinks: false,
    showLabels: false,
  };

  // Current scene, rebuilt whenever the graph (vue vs vue+ts) changes.
  let current: { nodes: RNode[]; links: RLink[]; maxHeight: number } | null = null;
  let sim: d3.Simulation<RNode, RLink> | null = null;
  let nodeSel: d3.Selection<SVGCircleElement, RNode, SVGGElement, unknown> | null = null;
  let linkSel: d3.Selection<SVGLineElement, RLink, SVGGElement, unknown> | null = null;
  let labelSel: d3.Selection<SVGTextElement, RNode, SVGGElement, unknown> | null = null;
  let fileLabelSel: d3.Selection<SVGTextElement, RNode, SVGGElement, unknown> | null = null;
  // Adjacency for hover (undirected), the import subtree ("down"/out) and the
  // supertree ("up"/inn). Rebuilt per graph; see ./select.ts for the contract.
  let ga: Adjacency = buildAdjacency([], []);
  let nodeR: (n: RNode) => number = () => 6;
  // Driver-highlight rings: the selected driver and the per-node contribution
  // map that sets each ring's colour + opacity (null = no highlight).
  let haloSel: d3.Selection<SVGCircleElement, RNode, SVGGElement, unknown> | null = null;
  let driver: MaintainabilityDriver | null = null;
  let contrib: MaintainabilityContributions | null = null;
  // Per-node change-cost breakdown for the detail panel (null until the score
  // arrives), an id→node map for contributor lookups, and the current hover
  // target that drives the tooltip + detail panel.
  let breakdown: Record<string, MaintainabilityBreakdown> | null = null;
  let byId = new Map<string, RNode>();
  let hovered: RNode | null = null;

  // Server-shipped churn-blended volatility per node id — the exact number
  // the score charges per import, and therefore the visual weight of every
  // drawn edge (by target). Null until the score arrives.
  let volatility: Record<string, number> | null = null;
  // FULL module-graph context (set independently of the shown view): the score
  // runs on it, so the breakdown's contributor lists, ×vol tails and dependent
  // paths read these — never the current view's adjacency.
  let fullAdj: Adjacency = buildAdjacency([], []);
  let fullNodes = new Map<string, { name: string; loc: number }>();
  let fullEdgeInfo = new Map<
    string,
    { symbols?: string[]; via?: string[]; type?: boolean; lazy?: boolean }
  >();
  // Shipped import cycles, keyed per member for the detail panel's cycle row.
  let cycleOf = new Map<string, CycleInfo>();

  // Click-to-isolate: ids reachable from the focused node. `dir` picks the walk
  // — "down" = its import subtree (what it uses), "up" = its supertree (what
  // uses it, i.e. what changes if it changes). null = no focus.
  let focus: { root: string; dir: FocusDir; set: Set<string> } | null = null;
  // Depth-row isolate: show only this depth (null = no depth filter).
  let depthFocus: number | null = null;
  // The on-screen subset — recomputed each refresh, reused by the blame rollup.
  let shownNodes: RNode[] = [];

  const isGreen = (n: RNode): boolean =>
    controls.mode === "naive" ? n.errors === 0 : !n.strictRed;
  const color = (n: RNode): string => (n.analyzing ? NEUTRAL : isGreen(n) ? GREEN : RED);

  // only-red / only-green + node focus (ignores the depth filter); isHidden adds the depth filter.
  const hideBase = (d: RNode): boolean =>
    (controls.onlyRed && isGreen(d)) ||
    (controls.onlyGreen && !isGreen(d)) ||
    (focus !== null && !focus.set.has(d.id));
  const isHidden = (d: RNode): boolean =>
    hideBase(d) || (depthFocus !== null && d.height !== depthFocus);

  const linkId = (end: string | RNode): string => (typeof end === "string" ? end : end.id);

  // Which link lines are worth drawing right now (see the body for the rules).
  function visibleLinks(): RLink[] {
    if (!current) return [];
    // Default (no focus, links off): draw nothing. With a focus, restrict to
    // the focused set's internal edges; with "show links" or "highlight links"
    // on, every currently-shown edge.
    if (!controls.showLinks && !controls.highlightLinks && focus === null) return [];
    const inFocus = focus?.set ?? null;
    return current.links.filter((l) => {
      const s = l.source as RNode;
      const t = l.target as RNode;
      if (isHidden(s) || isHidden(t)) return false;
      return inFocus === null || (inFocus.has(s.id) && inFocus.has(t.id));
    });
  }

  // The visual weight of an edge is the exact number the score charges for it:
  // the target's churn-blended volatility. Type-only and lazy edges charge
  // no comprehension (§2), so they pin to the floor — the dashes explain
  // why. Opacity is the primary channel ("a stable import is nearly free"
  // renders as nearly invisible), width a secondary pop for heavy edges.
  const linkWeight = (l: RLink): number =>
    l.type || l.lazy ? 0 : (volatility?.[linkId(l.target)] ?? 0);
  const linkOpacity = (l: RLink): number => 0.1 + 0.65 * linkWeight(l);

  // Bind link <line> elements to the visible subset and position them. Called
  // whenever focus/filters change — the default (no focus) renders nothing, so
  // the thousands of edges never hit the DOM until a node is selected.
  // Base opacity/width are per-element attributes (NOT `.link` CSS): class
  // rules override SVG presentation attributes, so `.hl`/`.dim` win naturally;
  // `.hl` scales per edge through the `--hlo` custom property (higher floor so
  // trace mode stays usable).
  function renderLinks(): void {
    linkSel = linkG
      .selectAll<SVGLineElement, RLink>("line")
      .data(visibleLinks(), (l) => `${linkId(l.source)}\n${linkId(l.target)}`)
      .join("line")
      .attr("class", (l) => linkClass(l))
      .attr("stroke-opacity", (l) => linkOpacity(l).toFixed(3))
      .attr("stroke-width", (l) => (0.6 + 1.2 * linkWeight(l)).toFixed(2))
      .style("--hlo", (l) => Math.max(0.35, linkOpacity(l)).toFixed(3));
    // Position each edge; x/y attrs land on the same selection.
    linkSel
      .attr("x1", (d) => (d.source as RNode).x!)
      .attr("y1", (d) => (d.source as RNode).y!)
      .attr("x2", (d) => (d.target as RNode).x!)
      .attr("y2", (d) => (d.target as RNode).y!);
  }

  // Base class for the link overlay: hover-blue when "highlight links" is on,
  // otherwise the muted default; type-only edges add `.type` (dashed), lazy
  // edges `.lazy` (a distinct dash). Hover then toggles `.hl`/`.dim` on top.
  function linkClass(l: RLink): string {
    return `${controls.highlightLinks ? "link hl" : "link"}${l.type ? " type" : ""}${
      l.lazy ? " lazy" : ""
    }`;
  }

  // The tooltip is now a terse summary: filename, LOC, and the import links in
  // the "X consume it · consumes Y deps" form. Everything else (status, path,
  // depth, blame, change-cost breakdown) lives in the sidebar detail panel.
  function tooltipHtml(d: RNode): string {
    const slash = d.file.lastIndexOf("/");
    const fileBase = slash < 0 ? d.file : d.file.slice(slash + 1);
    const fanIn = ga.inn.get(d.id)?.size ?? 0;
    const fanOut = ga.out.get(d.id)?.size ?? 0;
    return (
      `<span class="tip-name">${esc(fileBase)}</span>` +
      `<br><span class="tip-p">${d.size} LOC</span>` +
      `<br><span class="tip-p">${fanIn} consume it · consumes ${fanOut} deps</span>`
    );
  }

  // Structured change-cost breakdown for the detail panel: which files drive
  // THIS file's change-cost, and by how much. Authoritative overhead per driver
  // comes from the server breakdown; the contributor lists (imports weighted by
  // volatility, transitive dependents by LoC, per-dependent import paths) come
  // from the FULL module graph — the graph the score ran on — whatever view is
  // shown. Returns null until the score arrives.
  function buildBreakdown(d: RNode): NodeDetail["breakdown"] {
    if (!breakdown) return null;
    const bd = breakdown[d.id];
    const cycle = cycleOf.get(d.id) ?? null;
    if (!bd && !cycle && d.errors === 0) return { atFloor: true, drivers: [] };
    const nameOf = (id: string) => fullNodes.get(id)?.name ?? byId.get(id)?.name ?? id;
    // Greppable provenance of one full-graph edge: the crossing symbols (and
    // the barrel hop the resolution passed through), or the whole-module kind.
    const whyOf = (from: string, to: string): string | undefined => {
      const e = fullEdgeInfo.get(`${from}\n${to}`);
      if (!e) return undefined;
      if (e.symbols?.length) {
        const via = e.via?.length ? ` (via ${e.via.map(nameOf).join(", ")})` : "";
        return `imports ${e.symbols.join(", ")}${via}`;
      }
      return e.type ? "type-only import" : e.lazy ? "lazy (dynamic import)" : "whole-module import";
    };
    const drivers: DetailDriver[] = [];
    const overhead = bd ? bd.comprehension + bd.blast + bd.mass : 0;
    const share = (x: number) => (overhead > 0 ? Math.round((x / overhead) * 100) : 0);
    if (bd && bd.comprehension > 0) {
      const imports = [...(fullAdj.out.get(d.id) ?? [])]
        .map((id) => ({ id, n: nameOf(id), w: volatility?.[id] ?? 0 }))
        .sort((a, b) => b.w - a.w);
      const volatile = imports.filter((r) => r.w >= 0.5).length;
      drivers.push({
        key: "comprehension",
        label: "excess coupling",
        color: DRIVER_COLOR.comprehension,
        share: share(bd.comprehension),
        meta: `${imports.length} imports, weighted ${bd.weightedFanout}`,
        action: `imports ${volatile} volatile ${volatile === 1 ? "module" : "modules"} — invert or split`,
        items: imports.map((r) => ({
          name: r.n,
          tail: `×${r.w.toFixed(2)}`,
          why: whyOf(d.id, r.id),
        })),
      });
    }
    if (bd && bd.blast > 0) {
      // One BFS over the full-graph importers gives every dependent AND its
      // shortest import path back to this file: `toward` maps each dependent
      // to its next hop toward the target.
      const toward = new Map<string, string>();
      const queue = [d.id];
      const seen = new Set([d.id]);
      while (queue.length) {
        const v = queue.shift()!;
        for (const u of fullAdj.inn.get(v) ?? []) {
          if (!seen.has(u)) {
            seen.add(u);
            toward.set(u, v);
            queue.push(u);
          }
        }
      }
      seen.delete(d.id);
      const rows = [...seen]
        .map((id) => ({ id, n: nameOf(id), loc: fullNodes.get(id)?.loc ?? 0 }))
        .sort((a, b) => b.loc - a.loc);
      const depLoc = rows.reduce((s, r) => s + r.loc, 0);
      // "Why does `main` need attention if this changes?" — the shortest path
      // plus the symbols crossing the final hop into this file.
      const pathWhy = (id: string): string => {
        const path: string[] = [id];
        let cur = id;
        while (cur !== d.id) {
          cur = toward.get(cur)!;
          path.push(cur);
        }
        const hop = path[path.length - 2]!;
        const symbols = fullEdgeInfo.get(`${hop}\n${d.id}`)?.symbols;
        const names = path.map(nameOf).join(" → ");
        return symbols?.length ? `${names} — imports ${symbols.join(", ")}` : names;
      };
      drivers.push({
        key: "blast",
        label: "change blast",
        color: DRIVER_COLOR.blast,
        share: share(bd.blast),
        meta:
          `${rows.length} files (${depLoc} LOC, ${Math.round(bd.blastRadius * 100)}% of codebase) ` +
          `depend on this`,
        action: "volatile and widely imported — stabilize or split it",
        volatility: bd.volatility,
        items: rows.map((r) => ({ name: r.n, tail: `${r.loc} LOC`, why: pathWhy(r.id) })),
      });
    }
    if (d.errors > 0) {
      drivers.push({
        key: "types",
        label: "type errors",
        color: RED,
        share: null,
        meta:
          `${d.errors} own ${d.errors === 1 ? "error" : "errors"} — this file's flaws cost ` +
          `full price (typed files pay a fraction, the compiler carries the rest)`,
        action: `fix the ${d.errors} ${d.errors === 1 ? "error" : "errors"} here`,
        items: [],
      });
    }
    if (cycle) {
      drivers.push({
        key: "cycle",
        label: "import cycle",
        color: RED,
        share: null,
        meta: `${cycle.members.length} files: ${cycle.label}`,
        action: cycle.cut ? `break ${cycle.cut.label}` : undefined,
        items: [],
      });
    }
    if (bd && bd.mass > 0) {
      drivers.push({
        key: "mass",
        label: "complexity mass",
        color: DRIVER_COLOR.mass,
        share: share(bd.mass),
        meta: `${d.cc} branches × ${d.size} lines — each branch costs more in a bigger file`,
        action:
          d.size > 300 ? "split the file — smaller files make every branch cheaper" : undefined,
        items: [],
      });
    }
    return { atFloor: drivers.length === 0, drivers };
  }

  // Assemble the full structured detail for the hovered/selected node.
  function buildDetail(d: RNode, source: "hover" | "select"): NodeDetail {
    const status = d.analyzing ? "analyzing" : isGreen(d) ? "typed" : "red";
    const ownStatus = d.analyzing
      ? "type-check pending"
      : d.errors
        ? `${d.errors} own ${d.errors === 1 ? "error" : "errors"}`
        : d.strictRed
          ? "self typed · subtree red"
          : null;
    const ext = d.file.includes(".") ? d.file.split(".").pop()! : d.kind;
    const slash = d.file.lastIndexOf("/");
    const fileDir = slash < 0 ? "" : d.file.slice(0, slash + 1);
    const fileBase = slash < 0 ? d.file : d.file.slice(slash + 1);
    const blame = Object.entries(d.blame)
      .sort((a, b) => b[1] - a[1])
      .map(([author, loc]) => ({ author, loc }));
    return {
      id: d.id,
      name: d.name,
      file: d.file,
      fileDir,
      fileBase,
      ext,
      status,
      ownStatus,
      height: d.height,
      loc: d.size,
      cc: d.cc,
      errors: d.errors,
      fanIn: ga.inn.get(d.id)?.size ?? 0,
      fanOut: ga.out.get(d.id)?.size ?? 0,
      blame,
      breakdown: buildBreakdown(d),
      source,
    };
  }

  // Push the current hover/selection detail to the panel. The live hover wins;
  // otherwise the isolated (selected) node keeps the panel populated. Null hides it.
  function emitDetail(): void {
    const target = hovered ?? (focus ? (byId.get(focus.root) ?? null) : null);
    onNodeDetail(target ? buildDetail(target, hovered ? "hover" : "select") : null);
  }

  // Recompute the blame rollup over the shown set (green-only by default; red folds errored in).
  function blameReadout(): Readouts["blame"] {
    const { blameGreen, blameRed } = controls;
    const sel = shownNodes.filter((n) => (isGreen(n) && blameGreen) || (!isGreen(n) && blameRed));
    const totals = new Map<string, number>();
    for (const n of sel)
      for (const [a, c] of Object.entries(n.blame)) totals.set(a, (totals.get(a) ?? 0) + c);
    const sorted = [...totals].sort((x, y) => y[1] - x[1]);
    const sumLoc = sorted.reduce((s, [, c]) => s + c, 0);
    const denom = sumLoc || 1;
    const set = blameGreen && blameRed ? "all" : blameGreen ? "green" : blameRed ? "red" : "none";
    const available = shownNodes.some((n) => Object.keys(n.blame).length > 0);
    return {
      available,
      set,
      files: sel.length,
      sumLoc,
      rows: sorted.map(([author, loc]) => ({ author, loc, pct: (loc / denom) * 100 })),
    };
  }

  // Recolour + recompute every mode-dependent readout. No relayout — this is
  // what the colour-mode / only-red / depth toggles call.
  function refresh(): void {
    if (!current || !nodeSel || !linkSel || !labelSel || !fileLabelSel) return;
    nodeSel.attr("fill", color);

    shownNodes = current.nodes.filter((d) => !isHidden(d));
    const shownIds = new Set(shownNodes.map((n) => n.id));
    const green = shownNodes.filter(isGreen);
    const totalLoc = shownNodes.reduce((s, n) => s + n.size, 0);
    const greenLoc = green.reduce((s, n) => s + n.size, 0);
    const locPct = totalLoc ? (greenLoc / totalLoc) * 100 : 0;

    // Edges / leaves / roots of the induced subgraph on the shown nodes.
    let edges = 0;
    const imported = new Set<string>();
    for (const n of shownNodes)
      for (const t of ga.out.get(n.id) ?? []) {
        if (shownIds.has(t)) {
          edges++;
          imported.add(t);
        }
      }
    const leaves = shownNodes.filter((n) => {
      for (const t of ga.out.get(n.id) ?? []) if (shownIds.has(t)) return false;
      return true;
    }).length;
    const roots = shownNodes.filter((n) => !imported.has(n.id)).length;

    // Depth table ignores the depth filter itself so every depth stays clickable;
    // under a node focus it reads as that subtree's per-depth progress.
    const ringSet = current.nodes.filter((d) => !hideBase(d));
    const depths: DepthRow[] = [];
    for (let h = current.maxHeight; h >= 0; h--) {
      const ring = ringSet.filter((n) => n.height === h);
      if (!ring.length) continue;
      const g = ring.filter(isGreen);
      const tl = ring.reduce((s, n) => s + n.size, 0);
      const gl = g.reduce((s, n) => s + n.size, 0);
      depths.push({
        height: h,
        pct: tl ? (gl / tl) * 100 : 0,
        green: g.length,
        total: ring.length,
        done: g.length === ring.length,
        active: depthFocus === h,
      });
    }

    onReadouts({
      locPct,
      greenFiles: green.length,
      greenLoc,
      redFiles: shownNodes.length - green.length,
      redLoc: totalLoc - greenLoc,
      files: shownNodes.length,
      edges,
      leaves,
      roots,
      depths,
      blame: blameReadout(),
    });

    applyControls();
  }

  // Reapply the persistent view controls to the freshly-built selections.
  function applyControls(): void {
    if (!nodeSel || !linkSel || !labelSel || !fileLabelSel) return;
    labelG.attr("display", controls.showRings ? null : "none");
    fileLabelG.attr("display", controls.showLabels ? null : "none");
    nodeSel.style("display", (d) => (isHidden(d) ? "none" : null));
    // The focused root (set by a node click or a hotspot-row click) gets a
    // subtle glow so it's findable among its isolated dependents/subtree.
    nodeSel.classed("focus-root", (d) => focus !== null && d.id === focus.root);
    labelSel.style("display", (d) => (isHidden(d) ? "none" : null));
    fileLabelSel.style("display", (d) => (isHidden(d) ? "none" : null));
    renderLinks();
    applySearch();
    renderHalos();
  }

  // Driver-highlight rings: a coloured ring around each node — a translucent
  // disc behind it (so only the annulus past the node shows) plus a crisp
  // stroke, both at an opacity driven by the node's normalised contribution to
  // the selected driver (with a floor so faint contributors stay visible). One
  // circle per node (far cheaper than per-node drop-shadow filters); hidden
  // entirely when no driver is selected or the contribution is negligible.
  function renderHalos(): void {
    if (!haloSel || !nodeSel) return;
    if (driver === null || contrib === null) {
      haloSel.attr("display", "none");
      return;
    }
    const key = driver;
    const data = contrib;
    // Change blast rings are red for contrast (purple reads poorly on the dark
    // canvas); the panel/legend keeps blast purple to stay distinct from types.
    const col = key === "blast" ? RED : DRIVER_COLOR[key];
    const intensity = (d: RNode) => data[d.id]?.[key] ?? 0;
    haloSel
      .attr("display", (d) => (intensity(d) >= HALO_EPS && !isHidden(d) ? null : "none"))
      .attr("cx", (d) => d.x!)
      .attr("cy", (d) => d.y!)
      .attr("r", (d) => nodeR(d) + HALO_OFFSET)
      .attr("fill", col)
      .attr("fill-opacity", (d) => intensity(d) * 0.5)
      .attr("stroke", col)
      .attr("stroke-width", HALO_STROKE)
      .attr("stroke-opacity", (d) => Math.max(0.3, intensity(d)));
  }

  function applySearch(): void {
    if (!nodeSel || !labelSel) return;
    const q = controls.search.trim().toLowerCase();
    const cm = controls.contentMatches;
    // Two independent filters, ANDed: the name/id query and the content-search
    // set. A node is a hit only when it passes both active filters.
    const nameHit = (d: RNode) =>
      !q || d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
    const contentHit = (d: RNode) => cm === null || cm.has(d.file);
    const hit = (d: RNode) => nameHit(d) && contentHit(d);
    if (!q && cm === null) {
      nodeSel.classed("dim", false).attr("r", (d) => nodeR(d));
      labelSel.classed("dim", false);
      fileLabelSel?.classed("dim", false);
      return;
    }
    nodeSel.classed("dim", (d) => !hit(d)).attr("r", (d) => (hit(d) ? nodeR(d) + 4 : nodeR(d)));
    labelSel.classed("dim", (d) => !hit(d));
    fileLabelSel?.classed("dim", (d) => !hit(d));
  }

  function setGraph(graph: Graph): void {
    // Ids/depths are graph-specific — a graph switch drops any focus.
    focus = null;
    depthFocus = null;
    if (sim) sim.stop();

    const nodes = graph.nodes.map(toRNode);
    const links: RLink[] = graph.edges.map((e) => ({
      source: e.from,
      target: e.to,
      type: e.type ?? false,
      lazy: e.lazy ?? false,
    }));
    const maxHeight = graph.maxHeight;
    current = { nodes, links, maxHeight };

    const radiusOf = (h: number) => (maxHeight - h) * RING + 40;
    const sizes = nodes.map((n) => n.size);
    const rScale = d3
      .scaleSqrt()
      .domain([d3.min(sizes) ?? 1, d3.max(sizes) ?? 1])
      .range([5, 24]);
    nodeR = (n: RNode) => rScale(n.size);

    // Deterministic angular seeding by folder wedge on each height ring.
    const groups = [...new Set(nodes.map((n) => n.group))].sort();
    let acc = 0;
    for (const g of groups) {
      const members = nodes
        .filter((n) => n.group === g)
        .sort((a, b) => b.height - a.height || a.name.localeCompare(b.name));
      const wedge = (members.length / nodes.length) * TAU;
      const start = (acc / nodes.length) * TAU;
      members.forEach((n, i) => {
        const a = start + (wedge * (i + 0.5)) / members.length;
        n._sx = Math.cos(a) * radiusOf(n.height);
        n._sy = Math.sin(a) * radiusOf(n.height);
        n.x = n._sx;
        n.y = n._sy;
      });
      acc += members.length;
    }

    ringG.selectAll("*").remove();
    linkG.selectAll("*").remove();
    nodeG.selectAll("*").remove();
    labelG.selectAll("*").remove();
    fileLabelG.selectAll("*").remove();
    haloG.selectAll("*").remove();

    ringG
      .selectAll<SVGCircleElement, number>("circle")
      .data(d3.range(0, maxHeight + 1))
      .join("circle")
      .attr("class", "ring")
      .attr("r", (h) => radiusOf(h));

    // Links are not rendered by default (performance): with thousands of edges,
    // keeping every <line> in the DOM is the dominant cost. renderLinks() binds
    // only the focused node's subtree edges; the simulation below still uses the
    // full `links` array for layout, so positions are unchanged.
    linkSel = linkG.selectAll<SVGLineElement, RLink>("line");

    const drag = d3
      .drag<SVGCircleElement, RNode>()
      .on("start", (e, d) => {
        if (!e.active) sim?.alphaTarget(0.15).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (e, d) => {
        d.fx = e.x;
        d.fy = e.y;
      })
      .on("end", (e, d) => {
        if (!e.active) sim?.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeSel = nodeG
      .selectAll<SVGCircleElement, RNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("class", (d) => (d.kind === "ts" ? "node ts" : "node"))
      .attr("r", (d) => nodeR(d))
      .attr("fill", color)
      .call(drag);

    haloSel = haloG
      .selectAll<SVGCircleElement, RNode>("circle")
      .data(nodes)
      .join("circle")
      .attr("class", "halo")
      .attr("display", "none");

    labelSel = labelG
      .selectAll<SVGTextElement, RNode>("text")
      .data(nodes)
      .join("text")
      .attr("class", "rlabel")
      .attr("text-anchor", "middle")
      .attr("dy", ".34em")
      .attr("font-size", (d) => (nodeR(d) * 1.35).toFixed(1))
      .text((d) => d.height);

    fileLabelSel = fileLabelG
      .selectAll<SVGTextElement, RNode>("text")
      .data(nodes)
      .join("text")
      .attr("class", "flabel")
      .attr("text-anchor", "middle")
      .text((d) => baseOf(d.file));

    const tick = () => {
      linkSel!
        .attr("x1", (d) => (d.source as RNode).x!)
        .attr("y1", (d) => (d.source as RNode).y!)
        .attr("x2", (d) => (d.target as RNode).x!)
        .attr("y2", (d) => (d.target as RNode).y!);
      nodeSel!.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
      labelSel!.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
      fileLabelSel!.attr("x", (d) => d.x!).attr("y", (d) => d.y! - nodeR(d) - 2);
      if (driver !== null) haloSel!.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
    };

    sim = d3
      .forceSimulation<RNode, RLink>(nodes)
      .force(
        "link",
        d3
          .forceLink<RNode, RLink>(links)
          .id((d) => d.id)
          .distance(24)
          .strength(0.04),
      )
      .force("charge", d3.forceManyBody<RNode>().strength(-10).distanceMax(180))
      .force("r", d3.forceRadial<RNode>((d) => radiusOf(d.height), 0, 0).strength(1))
      .force("ax", d3.forceX<RNode>((d) => d._sx).strength(0.06))
      .force("ay", d3.forceY<RNode>((d) => d._sy).strength(0.06))
      .force(
        "collide",
        d3
          .forceCollide<RNode>((d) => nodeR(d) + 2)
          .strength(1)
          .iterations(2),
      )
      .on("tick", tick)
      .stop();
    for (let i = 0; i < PRETICKS; i++) sim.tick();
    tick();

    // Fit the settled bounding box into the viewport (empty graph => identity).
    const fit = fitTransform(nodes, width(), height());
    svg.call((s) => zoom.transform(s, fit));

    ga = buildAdjacency(
      nodes.map((n) => n.id),
      links.map((l) => ({ source: linkId(l.source), target: linkId(l.target) })),
    );
    byId = new Map(nodes.map((node) => [node.id, node]));

    nodeSel
      .on("click", (e: MouseEvent, d) => {
        e.stopPropagation();
        // Ctrl/Cmd-click opens the file's source. Otherwise isolate: shift-click
        // isolates the supertree (everything that depends on this node — what
        // breaks if it changes), a plain click isolates the import subtree.
        // Re-clicking the same node in the same direction clears it.
        if (e.ctrlKey || e.metaKey) {
          onOpenSource({ id: d.id, file: d.file });
          return;
        }
        isolate(d.id, e.shiftKey ? "up" : "down");
      })
      .on("mouseover", (e: MouseEvent, d) => {
        const nbr = ga.adj.get(d.id)!;
        // While a search is active it owns the node/label dimming — hover must
        // not reveal filtered-out nodes, so only the link highlight + tooltip
        // react. Without a search, hover dims everything outside the neighbourhood.
        if (!controls.search.trim() && controls.contentMatches === null) {
          nodeSel!.classed("dim", (o) => o !== d && !nbr.has(o.id));
          labelSel!.classed("dim", (o) => o !== d && !nbr.has(o.id));
        }
        linkSel!
          .classed("hl", (l) => l.source === d || l.target === d)
          .classed("dim", (l) => l.source !== d && l.target !== d);
        hovered = d;
        tooltip.innerHTML = tooltipHtml(d);
        tooltip.style.opacity = "1";
        emitDetail();
      })
      .on("mousemove", (e: MouseEvent) => {
        tooltip.style.left = `${e.clientX + 14}px`;
        tooltip.style.top = `${e.clientY + 14}px`;
      })
      .on("mouseout", () => {
        hovered = null;
        // Restore the baseline: keep every edge blue when "highlight links" is
        // on, otherwise clear the hover emphasis entirely.
        linkSel!.classed("hl", controls.highlightLinks).classed("dim", false);
        // Restore the search baseline (clears dimming when no search is active).
        applySearch();
        tooltip.style.opacity = "0";
        // Fall back to the selected node's detail (or clear the panel).
        emitDetail();
      });

    refresh();
    // A rebuilt graph drops focus/hover; sync the panel to the empty state.
    hovered = null;
    emitDetail();
  }

  // Click empty space to clear node + depth focus.
  svg.on("click", () => {
    if (focus !== null || depthFocus !== null) {
      focus = null;
      depthFocus = null;
      refresh();
    }
    emitDetail();
  });

  function setControls(next: Controls): void {
    controls = next;
    refresh();
    // Colour mode changes the shown node's status line.
    emitDetail();
  }

  function toggleDepth(h: number): void {
    depthFocus = depthFocus === h ? null : h;
    refresh();
  }

  function setDriverHighlight(
    d: MaintainabilityDriver | null,
    contributions: MaintainabilityContributions | null,
  ): void {
    driver = d;
    contrib = contributions;
    renderHalos();
  }

  function setBreakdown(
    next: Record<string, MaintainabilityBreakdown> | null,
    vol: Record<string, number> | null,
  ): void {
    breakdown = next;
    volatility = vol;
    // The breakdown collapsible fills in once the score arrives — and edge
    // weights re-style, since an edge's weight is its target's shipped
    // volatility (0 until then).
    renderLinks();
    emitDetail();
  }

  // Toggle a node-focus isolate; `refresh()` reapplies visibility + link overlay.
  function isolate(id: string, dir: FocusDir): void {
    const already = focus !== null && focus.root === id && focus.dir === dir;
    focus = already ? null : { root: id, dir, set: isolateSet(id, dir, ga) };
    refresh();
    emitDetail();
  }

  // Panel hotspot-row click: isolate a node's dependents (its supertree), just
  // like shift-clicking it. Ignored when the id isn't a node in the current
  // graph view (e.g. a `.ts` hotspot while the `.vue`-only graph is shown).
  function focusDependents(id: string): void {
    if (!ga.out.has(id)) return;
    isolate(id, "up");
  }

  // Panel cycle-row click: isolate exactly the cycle's members (whichever are
  // nodes in the current view). The app shell switches the view to the module
  // graph first when needed.
  function focusSet(ids: string[]): void {
    const present = ids.filter((id) => byId.has(id));
    if (present.length === 0) return;
    focus = { root: present[0]!, dir: "down", set: new Set(present) };
    depthFocus = null;
    refresh();
    emitDetail();
  }

  // Full module-graph context for the breakdown + cycle rows (see the
  // GraphController doc). Cheap to rebuild: maps only, no DOM.
  function setFullGraph(full: Graph | null, cycles: CycleInfo[] | null): void {
    if (!full) {
      fullAdj = buildAdjacency([], []);
      fullNodes = new Map();
      fullEdgeInfo = new Map();
      cycleOf = new Map();
      return;
    }
    fullAdj = buildAdjacency(
      full.nodes.map((n) => n.id),
      full.edges.map((e) => ({ source: e.from, target: e.to })),
    );
    fullNodes = new Map(full.nodes.map((n) => [n.id, { name: n.name, loc: n.loc ?? 0 }]));
    fullEdgeInfo = new Map(full.edges.map((e) => [`${e.from}\n${e.to}`, e]));
    cycleOf = new Map();
    for (const info of cycles ?? []) {
      for (const member of info.members) {
        cycleOf.set(member, info);
      }
    }
    // The detail panel's breakdown reads all of the above.
    emitDetail();
  }

  function destroy(): void {
    if (sim) sim.stop();
    svg.on(".zoom", null);
    svg.on("click", null);
    root.remove();
    tooltip.style.opacity = "0";
  }

  return {
    setGraph,
    setFullGraph,
    setControls,
    toggleDepth,
    focusDependents,
    focusSet,
    setDriverHighlight,
    setBreakdown,
    destroy,
  };
}
