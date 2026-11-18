import * as d3 from "d3";
import type { ComponentNode, Graph } from "../../../src/shared/types.ts";
import { DISC_COLORS, DISC_GEOM, Scene } from "./gl.ts";
import { INPUT_STRIDE, LayoutClient } from "./layout.ts";
import { type Adjacency, buildAdjacency, type FocusDir, isolateSet } from "./select.ts";

/**
 * Framework-agnostic renderer for the radial typing-progress graph. Vue owns
 * the chrome (panel, tooltip element, control state); this module owns the
 * scene and every graph interaction, and hands view-local readouts back
 * through a callback so the panel can render them.
 *
 * Rendering is WebGL2 (`./gl.ts`: rings, edges, focus glow, nodes, one draw
 * call each) with a Canvas2D overlay for text; the force layout runs off the main
 * thread in Rust/WASM (`./layout.ts`). The main thread only rebuilds typed
 * arrays when the *styling* changes (filters, hover, search) — layout ticks
 * and pan/zoom never touch per-element state.
 *
 * Interactions: deterministic angular seeding by folder wedge per depth ring,
 * a settling force simulation with fit-to-bounds, ring circles + depth labels,
 * drag, zoom/pan, hover neighbour-highlight with tooltip, click-to-isolate an
 * import subtree, a clickable depth-row isolate, strict/naive recolour, and
 * the only-red / show-rings / show-blame / search view filters.
 */

// GitHub-dark tokens (mirrors the prototype stylesheet).
const GREEN = "#3fb950";
const RED = "#f85149";
// Neutral fill for files still being type-checked — never red-on-unknown.
const NEUTRAL = "#8b949e";
type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
};
const GREEN_RGB = rgb(GREEN);
const RED_RGB = rgb(RED);
const NEUTRAL_RGB = rgb(NEUTRAL);
const TS_STROKE_RGB = rgb("#3178c6");
const NODE_STROKE_RGB = rgb("#0d1117");
const RING_RGB = rgb("#21262d");
const WHITE_RGB = rgb("#ffffff");
/** `.dim` opacity of nodes and labels. */
const DIM = 0.12;

const TAU = 2 * Math.PI;
const RING = 150;
/** Settling ticks before the layout counts as placed (d3's pre-tick count). */
const PRETICKS = 340;
/**
 * A topology change that keeps at least this share of nodes on their depth
 * ring restarts the layout warm from the previous positions instead of
 * re-seeding (progressive analysis adds/removes a few modules at a time).
 */
const WARM_SHARE = 0.9;
/** Labels smaller than this many CSS pixels are not drawn (unreadable anyway). */
const MIN_LABEL_PX = 3;
/** Canvas font size the label glyphs are laid out at, then scaled per label. */
const FONT_UNIT = 100;
/** `.flabel` font size, in user units. */
const FILE_FONT = 5;
/** A zoom gesture counts as paused (crisp re-raster) after this long without a scale change. */
const ZOOM_SETTLE_MS = 150;

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
  errors: number;
  /** Files that import this one ("X consume it"). */
  fanIn: number;
  /** Files this one imports ("consumes Y deps"). */
  fanOut: number;
  blame: { author: string; loc: number }[];
  /** Whether this reflects a live hover or the current selection. */
  source: "hover" | "select";
}

export interface InitOptions {
  /** Positioned element the renderer fills with its canvases and listens on. */
  host: HTMLElement;
  /** Fixed tooltip element the renderer fills and positions on hover. */
  tooltip: HTMLElement;
  /** Fires whenever the shown set or colour mode changes. */
  onReadouts: (readouts: Readouts) => void;
  /** Fires on a node Ctrl/Cmd-click — opens the source-view modal. */
  onOpenSource: (node: { id: string; file: string }) => void;
  /** Fires with the hovered/selected node's structured detail (null clears the panel). */
  onNodeDetail: (detail: NodeDetail | null) => void;
}

export interface GraphController {
  /**
   * Show a graph. Same topology as the current one (progressive analysis
   * facts) → restyle in place, keeping layout, focus and zoom; otherwise
   * rebuild the scene and relayout.
   */
  setGraph(graph: Graph): void;
  /** Reapply the persistent view controls without a relayout. */
  setControls(controls: Controls): void;
  /** Toggle a depth-row isolate (clears it when already active). */
  toggleDepth(height: number): void;
  /** Tear down the layout worker, listeners and canvases. */
  destroy(): void;
}

/** Internal node — the wire node adapted to the prototype's model. */
interface RNode {
  /** Position in the node arrays (layout positions, GPU instances). */
  index: number;
  id: string;
  /** Path relative to the project root (used for display). */
  file: string;
  name: string;
  group: string;
  kind: "vue" | "ts";
  /** Lines of code (prototype `size`). */
  size: number;
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

interface RLink {
  /** Importer node index. */
  s: number;
  /** Imported node index. */
  t: number;
  /** Type-only import edge — rendered dashed, zero structural weight. */
  type: boolean;
  /** Lazy-only edge (dynamic import / glob) — distinct dash, zero comprehension weight. */
  lazy: boolean;
}

/** A d3-drag subject: the grabbed node and its screen position. */
interface DragSubject {
  index: number;
  x: number;
  y: number;
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const baseOf = (f: string): string => f.slice(f.lastIndexOf("/") + 1);

/** Adapt a wire node into the internal node. */
function toRNode(n: ComponentNode, index: number): RNode {
  return {
    index,
    id: n.id,
    file: n.file,
    name: n.name,
    group: n.group,
    kind: n.kind,
    size: n.loc ?? 1,
    errors: n.typeErrors ?? 0,
    strictRed: n.strictRed,
    analyzing: n.typeErrors === null && n.status.typecheck !== "ready",
    height: n.height,
    blame: n.blame?.authorLines ?? {},
    _sx: 0,
    _sy: 0,
  };
}

/** Same node ids, edges and depth count, in the same order — i.e. the layout still applies. */
function sameTopology(a: Graph, b: Graph): boolean {
  if (
    a.maxHeight !== b.maxHeight ||
    a.nodes.length !== b.nodes.length ||
    a.edges.length !== b.edges.length
  ) {
    return false;
  }
  for (let i = 0; i < a.nodes.length; i++) {
    if (a.nodes[i]!.id !== b.nodes[i]!.id) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    const x = a.edges[i]!;
    const y = b.edges[i]!;
    if (
      x.from !== y.from ||
      x.to !== y.to ||
      (x.type ?? false) !== (y.type ?? false) ||
      (x.lazy ?? false) !== (y.lazy ?? false)
    ) {
      return false;
    }
  }
  return true;
}

export function initGraph(opts: InitOptions): GraphController {
  const { host, tooltip, onReadouts, onOpenSource, onNodeDetail } = opts;
  const hostSel = d3.select<HTMLElement, unknown>(host);
  const glCanvas = document.createElement("canvas");
  const textCanvas = document.createElement("canvas");
  for (const c of [glCanvas, textCanvas]) {
    c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    host.append(c);
  }
  const scene = new Scene(glCanvas);
  const ctx = textCanvas.getContext("2d")!;

  const width = () => host.clientWidth || window.innerWidth;
  const height = () => host.clientHeight || window.innerHeight;

  // Current pan/zoom, and whether the user moved it since the last fresh
  // layout (a settled layout only refits an untouched view).
  let view = d3.zoomIdentity;
  let userMoved = false;
  let frame = 0;
  const requestFrame = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  // While the user is mid-zoom, the scene resamples its cached frame instead
  // of re-rasterizing; a crisp frame follows once the gesture pauses.
  let lastUserZoom = -Infinity;
  let refine: ReturnType<typeof setTimeout> | undefined;

  const zoom = d3
    .zoom<HTMLElement, unknown>()
    .scaleExtent([0.03, 8])
    .on("zoom", (e: d3.D3ZoomEvent<HTMLElement, unknown>) => {
      if (e.sourceEvent) {
        userMoved = true;
        if (e.transform.k !== view.k) lastUserZoom = performance.now();
      }
      view = e.transform;
      requestFrame();
    });

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

  // Current scene, rebuilt whenever the topology changes.
  let current: { graph: Graph; nodes: RNode[]; links: RLink[]; maxHeight: number } | null = null;
  // Latest layout positions (x, y per node index) — owned by the worker's stream.
  let pos: Float32Array = new Float32Array(0);
  // Base node radius per index (LoC-scaled), and the drawn radius after
  // filters/search (0 = hidden) that hit-testing and labels follow.
  let radii = new Float32Array(0);
  let drawR = new Float32Array(0);
  let maxDrawR = 0;
  // Per-node styling buffers, reused across repaints.
  let nodeIndex = new Uint32Array(0);
  let nodeGeom = new Float32Array(0);
  let nodeColors = new Uint8Array(0);
  // `.dim` per node (search or hover) — shared by the node pass and depth labels.
  let nodeDim = new Uint8Array(0);
  // Filename label per node (basename), built once per topology.
  let labelText: string[] = [];
  // Search hits per node, or null when no name/content search is active.
  let searchHits: Uint8Array | null = null;
  // A fresh layout fits the view once it settles.
  let pendingFit = false;

  // Drawn edges: hover incidence per edge, and per-node incident edge lists
  // (CSR) so hover flips only the hovered node's edges.
  let edgeHover = new Uint8Array(0);
  let incidentStart = new Uint32Array(1);
  let incidentList = new Uint32Array(0);

  // Hit-testing index over the shown nodes; rebuilt lazily after moves/filters.
  let pickTree: d3.Quadtree<number> | null = null;

  // Adjacency for hover (undirected), the import subtree ("down"/out) and the
  // supertree ("up"/inn). Rebuilt per graph; see ./select.ts for the contract.
  let ga: Adjacency = buildAdjacency([], []);
  // id→node map for lookups, and the current hover target that drives the
  // tooltip + detail panel.
  let byId = new Map<string, RNode>();
  let hovered: RNode | null = null;
  let dragging = false;

  // Click-to-isolate: ids reachable from the focused node. `dir` picks the walk
  // — "down" = its import subtree (what it uses), "up" = its supertree (what
  // uses it, i.e. what changes if it changes). null = no focus.
  let focus: { root: string; dir: FocusDir; set: Set<string> } | null = null;
  // Depth-row isolate: show only this depth (null = no depth filter).
  let depthFocus: number | null = null;
  // The on-screen subset — recomputed each refresh, reused by the blame rollup.
  let shownNodes: RNode[] = [];

  const layout = new LayoutClient((positions, settled) => {
    if (!current || positions.length !== current.nodes.length * 2) return;
    pos = positions;
    scene.setPositions(pos);
    pickTree = null;
    if (settled && pendingFit) {
      pendingFit = false;
      if (!userMoved) fitView();
    }
    requestFrame();
  });

  const isGreen = (n: RNode): boolean =>
    controls.mode === "naive" ? n.errors === 0 : !n.strictRed;
  const fillOf = (n: RNode): Rgb => (n.analyzing ? NEUTRAL_RGB : isGreen(n) ? GREEN_RGB : RED_RGB);

  // only-red / only-green + node focus (ignores the depth filter); isHidden adds the depth filter.
  const hideBase = (d: RNode): boolean =>
    (controls.onlyRed && isGreen(d)) ||
    (controls.onlyGreen && !isGreen(d)) ||
    (focus !== null && !focus.set.has(d.id));
  const isHidden = (d: RNode): boolean =>
    hideBase(d) || (depthFocus !== null && d.height !== depthFocus);

  // Which links are worth drawing right now (link indices; see the body for the rules).
  function visibleLinks(): number[] {
    if (!current) return [];
    // Default (no focus, links off): draw nothing. With a focus, restrict to
    // the focused set's internal edges; with "show links" or "highlight links"
    // on, every currently-shown edge.
    if (!controls.showLinks && !controls.highlightLinks && focus === null) return [];
    const inFocus = focus?.set ?? null;
    const { nodes, links } = current;
    const out: number[] = [];
    for (let k = 0; k < links.length; k++) {
      const s = nodes[links[k]!.s]!;
      const t = nodes[links[k]!.t]!;
      if (isHidden(s) || isHidden(t)) continue;
      if (inFocus !== null && !(inFocus.has(s.id) && inFocus.has(t.id))) continue;
      out.push(k);
    }
    return out;
  }

  // Upload the visible edge set: endpoints, dash kind, and the per-node
  // incidence lists hover uses.
  function renderLinks(): void {
    if (!current) return;
    const { nodes, links } = current;
    const vis = visibleLinks();
    const m = vis.length;
    const ends = new Uint32Array(m * 2);
    const dash = new Uint8Array(m);
    edgeHover = new Uint8Array(m);
    incidentStart = new Uint32Array(nodes.length + 1);
    for (let k = 0; k < m; k++) {
      const l = links[vis[k]!]!;
      ends[k * 2] = l.s;
      ends[k * 2 + 1] = l.t;
      // `.link.lazy` is declared after `.link.type`, so lazy's dash wins.
      dash[k] = l.lazy ? 2 : l.type ? 1 : 0;
      incidentStart[l.s + 1]!++;
      incidentStart[l.t + 1]!++;
    }
    for (let i = 0; i < nodes.length; i++) incidentStart[i + 1]! += incidentStart[i]!;
    incidentList = new Uint32Array(m * 2);
    const fill = incidentStart.slice(0, nodes.length);
    for (let k = 0; k < m; k++) {
      incidentList[fill[ends[k * 2]!]!++] = k;
      incidentList[fill[ends[k * 2 + 1]!]!++] = k;
    }
    if (hovered) markIncident(hovered.index, 1);
    scene.setEdges({ ends, dash, count: m });
    scene.setEdgeHover(edgeHover);
    scene.setEdgeMode(hovered !== null, controls.highlightLinks);
    requestFrame();
  }

  // Flag (1) or clear (0) the hover incidence of node `i`'s drawn edges.
  function markIncident(i: number, flag: number): void {
    for (let j = incidentStart[i]!; j < incidentStart[i + 1]!; j++) {
      edgeHover[incidentList[j]!] = flag;
    }
  }

  // The tooltip is now a terse summary: filename, LOC, and the import links in
  // the "X consume it · consumes Y deps" form. Everything else (status, path,
  // depth, blame) lives in the sidebar detail panel.
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
      errors: d.errors,
      fanIn: ga.inn.get(d.id)?.size ?? 0,
      fanOut: ga.out.get(d.id)?.size ?? 0,
      blame,
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
    if (!current) return;

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

  // Reapply the persistent view controls: visibility, search, links, glow.
  function applyControls(): void {
    computeSearchHits();
    paintNodes();
    renderLinks();
    renderGlow();
  }

  // The focused root (node click) gets a soft white glow behind it so it's
  // findable among its isolated subtree. It stands in for the old node
  // drop-shadow, so it dims with its node.
  function renderGlow(): void {
    if (!current) return;
    const index = new Uint32Array(1);
    const geom = new Float32Array(DISC_GEOM);
    const colors = new Uint8Array(DISC_COLORS);
    const root = focus ? byId.get(focus.root) : undefined;
    const shown = root !== undefined && !isHidden(root);
    if (shown) {
      index[0] = root.index;
      geom.set([radii[root.index]!, 0, 6]);
      const a = Math.round(0.55 * (nodeDim[root.index] ? DIM : 1) * 255);
      colors.set([WHITE_RGB[0], WHITE_RGB[1], WHITE_RGB[2], a, 0, 0, 0, 0]);
    }
    scene.setGlow({ index, geom, colors, count: shown ? 1 : 0 });
    requestFrame();
  }

  // Two independent filters, ANDed: the name/id query and the content-search
  // set. A node is a hit only when it passes both active filters.
  function computeSearchHits(): void {
    if (!current) return;
    const q = controls.search.trim().toLowerCase();
    const cm = controls.contentMatches;
    if (!q && cm === null) {
      searchHits = null;
      return;
    }
    searchHits = new Uint8Array(current.nodes.length);
    for (const d of current.nodes) {
      const nameHit = !q || d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
      searchHits[d.index] = nameHit && (cm === null || cm.has(d.file)) ? 1 : 0;
    }
  }

  function applySearch(): void {
    computeSearchHits();
    paintNodes();
  }

  // Rebuild the node instances: fill by status, TS-blue stroke for modules,
  // `.dim` (an active search owns dimming; otherwise hover dims everything
  // outside the hovered neighbourhood), search hits grown by 4, hidden nodes
  // collapsed to radius 0.
  function paintNodes(): void {
    if (!current) return;
    const nbr = hovered && !searchHits ? ga.adj.get(hovered.id)! : null;
    maxDrawR = 0;
    for (const d of current.nodes) {
      const i = d.index;
      const hit = searchHits ? searchHits[i] === 1 : false;
      const dim = searchHits ? !hit : nbr !== null && d !== hovered && !nbr.has(d.id);
      nodeDim[i] = dim ? 1 : 0;
      const r = isHidden(d) ? 0 : radii[i]! + (hit ? 4 : 0);
      drawR[i] = r;
      if (r > maxDrawR) maxDrawR = r;
      const ts = d.kind === "ts";
      nodeGeom[i * DISC_GEOM] = r;
      nodeGeom[i * DISC_GEOM + 1] = ts ? 1.2 : 0.6;
      const a = Math.round((dim ? DIM : 1) * 255);
      const fill = fillOf(d);
      const stroke = ts ? TS_STROKE_RGB : NODE_STROKE_RGB;
      nodeColors.set(
        [fill[0], fill[1], fill[2], a, stroke[0], stroke[1], stroke[2], a],
        i * DISC_COLORS,
      );
    }
    scene.setNodes({
      index: nodeIndex,
      geom: nodeGeom,
      colors: nodeColors,
      count: current.nodes.length,
    });
    pickTree = null;
    // The focus glow follows its node's dimming.
    if (focus) renderGlow();
    requestFrame();
  }

  function draw(): void {
    frame = 0;
    const crisp = scene.render(view, performance.now() - lastUserZoom < ZOOM_SETTLE_MS);
    if (!crisp) {
      clearTimeout(refine);
      refine = setTimeout(requestFrame, ZOOM_SETTLE_MS);
    }
    drawLabels();
  }

  // Text overlay: filename labels (`showLabels`) and depth numbers inside the
  // nodes (`showRings`), in user units like the old SVG text. Glyphs are laid
  // out at FONT_UNIT and scaled per label; off-screen and sub-legible labels
  // are skipped, so cost tracks what is actually readable.
  function drawLabels(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
    if (!current || (!controls.showLabels && !controls.showRings)) return;
    const dpr = window.devicePixelRatio || 1;
    const w = width();
    const h = height();
    const k = view.k;
    const nodes = current.nodes;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const place = (sx: number, sy: number, px: number) =>
      ctx.setTransform((dpr * px) / FONT_UNIT, 0, 0, (dpr * px) / FONT_UNIT, dpr * sx, dpr * sy);
    if (controls.showLabels && FILE_FONT * k >= MIN_LABEL_PX) {
      ctx.font = `600 ${FONT_UNIT}px ui-monospace, monospace`;
      ctx.fillStyle = "#c9d1d9";
      ctx.strokeStyle = "#05080d";
      ctx.lineWidth = 0.18 * FONT_UNIT;
      for (const d of nodes) {
        const i = d.index;
        if (drawR[i] === 0) continue;
        const sx = view.applyX(pos[i * 2]!);
        const sy = view.applyY(pos[i * 2 + 1]! - radii[i]! - 2);
        if (sx < -200 || sx > w + 200 || sy < -20 || sy > h + 20) continue;
        ctx.globalAlpha = searchHits && !searchHits[i] ? DIM : 1;
        place(sx, sy, FILE_FONT * k);
        ctx.strokeText(labelText[i]!, 0, 0);
        ctx.fillText(labelText[i]!, 0, 0);
      }
    }
    if (controls.showRings) {
      ctx.font = `700 ${FONT_UNIT}px ui-monospace, monospace`;
      ctx.fillStyle = "#05080d";
      for (const d of nodes) {
        const i = d.index;
        const px = radii[i]! * 1.35 * k;
        if (drawR[i] === 0 || px < MIN_LABEL_PX) continue;
        const sx = view.applyX(pos[i * 2]!);
        const sy = view.applyY(pos[i * 2 + 1]!);
        if (sx < -px || sx > w + px || sy < -px || sy > h + px) continue;
        ctx.globalAlpha = nodeDim[i] ? DIM : 1;
        place(sx, sy, px);
        ctx.fillText(String(d.height), 0, 0.34 * FONT_UNIT);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Topmost shown node under a CSS-pixel point (later instances draw on top).
  function pick(px: number, py: number): RNode | null {
    if (!current) return null;
    if (!pickTree) {
      const shown: number[] = [];
      for (let i = 0; i < drawR.length; i++) if (drawR[i]! > 0) shown.push(i);
      pickTree = d3
        .quadtree<number>()
        .x((i) => pos[i * 2]!)
        .y((i) => pos[i * 2 + 1]!)
        .addAll(shown);
    }
    const [ux, uy] = view.invert([px, py]);
    const reach = maxDrawR;
    let best = -1;
    pickTree.visit((q, x0, y0, x1, y1) => {
      if (!q.length) {
        let leaf: d3.QuadtreeLeaf<number> | undefined = q as d3.QuadtreeLeaf<number>;
        do {
          const i = leaf.data;
          const dx = pos[i * 2]! - ux;
          const dy = pos[i * 2 + 1]! - uy;
          if (dx * dx + dy * dy <= drawR[i]! ** 2 && i > best) best = i;
          leaf = leaf.next;
        } while (leaf);
        return true;
      }
      return x0 > ux + reach || x1 < ux - reach || y0 > uy + reach || y1 < uy - reach;
    });
    return best < 0 ? null : current.nodes[best]!;
  }

  function fitView(): void {
    if (!current) return;
    const pts = current.nodes.map((d) => ({ x: pos[d.index * 2]!, y: pos[d.index * 2 + 1]! }));
    zoom.transform(hostSel, fitTransform(pts, width(), height()));
  }

  // LoC-scaled node radii; returns whether any radius changed.
  function updateRadii(nodes: RNode[]): boolean {
    const sizes = nodes.map((n) => n.size);
    const rScale = d3
      .scaleSqrt()
      .domain([d3.min(sizes) ?? 1, d3.max(sizes) ?? 1])
      .range([5, 24]);
    let changed = radii.length !== nodes.length;
    if (changed) radii = new Float32Array(nodes.length);
    for (const n of nodes) {
      const r = Math.fround(rScale(n.size));
      if (radii[n.index] !== r) {
        radii[n.index] = r;
        changed = true;
      }
    }
    return changed;
  }

  // Collision radius per node: the drawn radius plus a 2-unit gap.
  function collideRadii(): Float32Array {
    return radii.map((r) => r + 2);
  }

  function moveTooltip(e: MouseEvent): void {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  }

  function hoverOver(d: RNode, e: MouseEvent): void {
    hovered = d;
    markIncident(d.index, 1);
    scene.setEdgeHover(edgeHover);
    scene.setEdgeMode(true, controls.highlightLinks);
    // Hover dims outside the neighbourhood unless a search owns the dimming.
    paintNodes();
    host.style.cursor = "pointer";
    tooltip.innerHTML = tooltipHtml(d);
    tooltip.style.opacity = "1";
    moveTooltip(e);
    emitDetail();
  }

  function hoverOut(): void {
    if (!hovered) return;
    markIncident(hovered.index, 0);
    hovered = null;
    scene.setEdgeHover(edgeHover);
    // Restore the baseline: every edge blue when "highlight links" is on,
    // otherwise no hover emphasis; the search baseline owns node dimming.
    scene.setEdgeMode(false, controls.highlightLinks);
    paintNodes();
    host.style.cursor = "";
    tooltip.style.opacity = "0";
    // Fall back to the selected node's detail (or clear the panel).
    emitDetail();
  }

  function setGraph(graph: Graph): void {
    if (current && sameTopology(current.graph, graph)) patchGraph(graph);
    else buildGraph(graph);
  }

  // Progressive analysis facts on an unchanged topology: restyle in place —
  // layout, zoom, focus and hover survive. Only changed node sizes reach the
  // layout (new collide radii, gently reheated).
  function patchGraph(graph: Graph): void {
    const c = current!;
    c.graph = graph;
    graph.nodes.forEach((wire, i) => {
      const node = c.nodes[i]!;
      const { _sx, _sy } = node;
      Object.assign(node, toRNode(wire, i), { _sx, _sy });
    });
    if (updateRadii(c.nodes)) layout.radii(collideRadii(), 0.1);
    refresh();
    emitDetail();
  }

  function buildGraph(graph: Graph): void {
    // Ids/depths are graph-specific — a graph switch drops any focus.
    hoverOut();
    focus = null;
    depthFocus = null;
    const prev = current ? { pos, byId } : null;

    const nodes = graph.nodes.map(toRNode);
    const indexOf = new Map(nodes.map((d) => [d.id, d.index]));
    const at = (id: string): number => {
      const i = indexOf.get(id);
      if (i === undefined) throw new Error(`node not found: ${id}`);
      return i;
    };
    const links: RLink[] = graph.edges.map((e) => ({
      s: at(e.from),
      t: at(e.to),
      type: e.type ?? false,
      lazy: e.lazy ?? false,
    }));
    const maxHeight = graph.maxHeight;
    current = { graph, nodes, links, maxHeight };
    const radiusOf = (h: number) => (maxHeight - h) * RING + 40;
    updateRadii(nodes);

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
      });
      acc += members.length;
    }

    // Start from the previous layout when the topology barely moved (nodes
    // kept on their ring); otherwise from the seeds with a full settle.
    const n = nodes.length;
    pos = new Float32Array(n * 2);
    let kept = 0;
    for (const d of nodes) {
      const old = prev?.byId.get(d.id);
      const reuse = prev !== null && old !== undefined && old.height === d.height;
      pos[d.index * 2] = reuse ? prev.pos[old.index * 2]! : d._sx;
      pos[d.index * 2 + 1] = reuse ? prev.pos[old.index * 2 + 1]! : d._sy;
      if (reuse) kept++;
    }
    const warm = n > 0 && kept >= WARM_SHARE * n;
    const input = new Float32Array(n * INPUT_STRIDE);
    for (const d of nodes) {
      const i = d.index;
      input.set(
        [pos[i * 2]!, pos[i * 2 + 1]!, d._sx, d._sy, radiusOf(d.height), radii[i]! + 2],
        i * INPUT_STRIDE,
      );
    }
    const pairs = new Uint32Array(links.length * 2);
    links.forEach((l, k) => {
      pairs[k * 2] = l.s;
      pairs[k * 2 + 1] = l.t;
    });
    layout.load(input, pairs, warm ? 0.3 : 1, warm ? 0 : PRETICKS);

    byId = new Map(nodes.map((d) => [d.id, d]));
    ga = buildAdjacency(
      nodes.map((d) => d.id),
      links.map((l) => ({ source: nodes[l.s]!.id, target: nodes[l.t]!.id })),
    );
    labelText = nodes.map((d) => baseOf(d.file));
    drawR = new Float32Array(n);
    nodeDim = new Uint8Array(n);
    nodeIndex = Uint32Array.from(nodes, (d) => d.index);
    nodeGeom = new Float32Array(n * DISC_GEOM);
    nodeColors = new Uint8Array(n * DISC_COLORS);

    const rings = maxHeight + 1;
    const ringGeom = new Float32Array(rings * DISC_GEOM);
    const ringColors = new Uint8Array(rings * DISC_COLORS);
    for (let h = 0; h < rings; h++) {
      ringGeom.set([radiusOf(h), 1, 0], h * DISC_GEOM);
      ringColors.set([0, 0, 0, 0, RING_RGB[0], RING_RGB[1], RING_RGB[2], 255], h * DISC_COLORS);
    }
    scene.setRings({
      index: new Uint32Array(rings),
      geom: ringGeom,
      colors: ringColors,
      count: rings,
    });
    scene.setPositions(pos);
    pickTree = null;

    // Fit the seeds now, and the settled layout once the worker finishes
    // (unless the user has panned/zoomed by then).
    if (!warm) {
      userMoved = false;
      pendingFit = true;
      fitView();
    }

    refresh();
    emitDetail();
  }

  // Each control only redoes its own work: filters recompute readouts and
  // visibility, search restyles nodes, link toggles rebuild edges, label
  // toggles just redraw.
  function setControls(next: Controls): void {
    const prev = controls;
    controls = next;
    const changed = (keys: (keyof Controls)[]) => keys.some((k) => prev[k] !== next[k]);
    if (changed(["mode", "onlyRed", "onlyGreen", "blameGreen", "blameRed"])) {
      refresh();
    } else {
      if (changed(["search", "contentMatches"])) applySearch();
      if (changed(["showLinks", "highlightLinks"])) renderLinks();
      if (changed(["showRings", "showLabels"])) requestFrame();
    }
    // Colour mode changes the shown node's status line.
    if (prev.mode !== next.mode) emitDetail();
  }

  function toggleDepth(h: number): void {
    depthFocus = depthFocus === h ? null : h;
    refresh();
  }

  // Toggle a node-focus isolate; `refresh()` reapplies visibility + link overlay.
  function isolate(id: string, dir: FocusDir): void {
    const already = focus !== null && focus.root === id && focus.dir === dir;
    focus = already ? null : { root: id, dir, set: isolateSet(id, dir, ga) };
    refresh();
    emitDetail();
  }

  const drag = d3
    .drag<HTMLElement, unknown, DragSubject | null>()
    .container(host)
    .subject((e: { x: number; y: number }) => {
      const d = pick(e.x, e.y);
      if (!d) return null;
      const i = d.index;
      return { index: i, x: view.applyX(pos[i * 2]!), y: view.applyY(pos[i * 2 + 1]!) };
    })
    .on("start", (e: d3.D3DragEvent<HTMLElement, unknown, DragSubject>) => {
      dragging = true;
      const i = e.subject.index;
      layout.drag("start", i, pos[i * 2]!, pos[i * 2 + 1]!);
    })
    .on("drag", (e: d3.D3DragEvent<HTMLElement, unknown, DragSubject>) => {
      const i = e.subject.index;
      const [x, y] = view.invert([e.x, e.y]);
      pos[i * 2] = x;
      pos[i * 2 + 1] = y;
      scene.setPositions(pos);
      pickTree = null;
      requestFrame();
      layout.drag("move", i, x, y);
    })
    .on("end", (e: d3.D3DragEvent<HTMLElement, unknown, DragSubject>) => {
      dragging = false;
      layout.drag("end", e.subject.index, 0, 0);
    });
  // Drag first: a press on a node starts a drag and stops the zoom's pan.
  hostSel.call(drag).call(zoom);

  const onPointerMove = (e: PointerEvent) => {
    if (hovered) moveTooltip(e);
    if (dragging || e.buttons) return;
    const [px, py] = d3.pointer(e, host);
    const d = pick(px, py);
    if (d === hovered) return;
    hoverOut();
    if (d) hoverOver(d, e);
  };
  const onPointerLeave = () => hoverOut();
  // Ctrl/Cmd-click opens the file's source. Otherwise isolate: shift-click
  // isolates the supertree (everything that depends on this node — what
  // breaks if it changes), a plain click the import subtree; re-clicking the
  // same node in the same direction clears it. Empty space clears node +
  // depth focus. (Drag and pan suppress the click that ends them.)
  const onClick = (e: MouseEvent) => {
    const [px, py] = d3.pointer(e, host);
    const d = pick(px, py);
    if (d) {
      if (e.ctrlKey || e.metaKey) onOpenSource({ id: d.id, file: d.file });
      else isolate(d.id, e.shiftKey ? "up" : "down");
      return;
    }
    if (focus !== null || depthFocus !== null) {
      focus = null;
      depthFocus = null;
      refresh();
    }
    emitDetail();
  };
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerleave", onPointerLeave);
  host.addEventListener("click", onClick);

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    scene.resize(width(), height(), dpr);
    textCanvas.width = Math.round(width() * dpr);
    textCanvas.height = Math.round(height() * dpr);
    requestFrame();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  function destroy(): void {
    layout.destroy();
    cancelAnimationFrame(frame);
    clearTimeout(refine);
    observer.disconnect();
    hostSel.on(".zoom", null).on(".drag", null);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerleave", onPointerLeave);
    host.removeEventListener("click", onClick);
    scene.destroy();
    glCanvas.remove();
    textCanvas.remove();
    tooltip.style.opacity = "0";
  }

  return {
    setGraph,
    setControls,
    toggleDepth,
    destroy,
  };
}
