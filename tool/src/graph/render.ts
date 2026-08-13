import * as d3 from "d3";
import type { ComponentNode, Graph } from "../../../src/shared/types.ts";

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

const TAU = 2 * Math.PI;
const RING = 150;
/** Pre-tick count that settles the layout before the first paint. */
const PRETICKS = 340;

export type Mode = "strict" | "naive";

/** The persistent view controls Vue mirrors into the scene. */
export interface Controls {
  mode: Mode;
  onlyRed: boolean;
  showRings: boolean;
  showBlame: boolean;
  search: string;
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

export interface InitOptions {
  svg: SVGSVGElement;
  /** Fixed tooltip element the renderer fills and positions on hover. */
  tooltip: HTMLElement;
  /** Fires whenever the shown set or colour mode changes. */
  onReadouts: (readouts: Readouts) => void;
}

export interface GraphController {
  /** Rebuild the whole scene for a graph (vue ↔ full swap or fresh data). */
  setGraph(graph: Graph): void;
  /** Reapply the persistent view controls without a relayout. */
  setControls(controls: Controls): void;
  /** Toggle a depth-row isolate (clears it when already active). */
  toggleDepth(height: number): void;
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
}

const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Adapt a wire node into the internal simulation node. */
function toRNode(n: ComponentNode): RNode {
  return {
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

export function initGraph(opts: InitOptions): GraphController {
  const { tooltip, onReadouts } = opts;
  const svg = d3.select(opts.svg);
  const root = svg.append("g");
  const ringG = root.append("g");
  const linkG = root.append("g");
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
    showRings: true,
    showBlame: false,
    search: "",
    blameGreen: true,
    blameRed: false,
    showLinks: false,
    highlightLinks: false,
  };

  // Current scene, rebuilt whenever the graph (vue vs vue+ts) changes.
  let current: { nodes: RNode[]; links: RLink[]; maxHeight: number } | null = null;
  let sim: d3.Simulation<RNode, RLink> | null = null;
  let nodeSel: d3.Selection<SVGCircleElement, RNode, SVGGElement, unknown> | null = null;
  let linkSel: d3.Selection<SVGLineElement, RLink, SVGGElement, unknown> | null = null;
  let labelSel: d3.Selection<SVGTextElement, RNode, SVGGElement, unknown> | null = null;
  // Undirected adjacency (hover) and directed importer→imported (subtree).
  let adj = new Map<string, Set<string>>();
  let out = new Map<string, Set<string>>();
  let nodeR: (n: RNode) => number = () => 6;

  // Click-to-isolate: ids in the focused node's import subtree (null = none).
  let focus: { root: string; set: Set<string> } | null = null;
  // Depth-row isolate: show only this depth (null = no depth filter).
  let depthFocus: number | null = null;
  // The on-screen subset — recomputed each refresh, reused by the blame rollup.
  let shownNodes: RNode[] = [];

  const isGreen = (n: RNode): boolean =>
    controls.mode === "naive" ? n.errors === 0 : !n.strictRed;
  const color = (n: RNode): string => (n.analyzing ? NEUTRAL : isGreen(n) ? GREEN : RED);

  // only-red + node focus (ignores the depth filter); isHidden adds the depth filter.
  const hideBase = (d: RNode): boolean =>
    (controls.onlyRed && isGreen(d)) || (focus !== null && !focus.set.has(d.id));
  const isHidden = (d: RNode): boolean =>
    hideBase(d) || (depthFocus !== null && d.height !== depthFocus);

  // BFS the directed importer→imported edges to collect a node and its subtree.
  function subtree(start: string): Set<string> {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      for (const t of out.get(id) ?? [])
        if (!seen.has(t)) {
          seen.add(t);
          stack.push(t);
        }
    }
    return seen;
  }

  const linkId = (end: string | RNode): string => (typeof end === "string" ? end : end.id);

  // Which link lines are worth drawing right now (see the body for the rules).
  function visibleLinks(): RLink[] {
    if (!current) return [];
    // Default (no focus, links off): draw nothing. With a focus, restrict to
    // that node's subtree; with "show links" or "highlight links" on, every
    // currently-shown edge.
    if (!controls.showLinks && !controls.highlightLinks && focus === null) return [];
    const inFocus = focus?.set ?? null;
    return current.links.filter((l) => {
      const s = l.source as RNode;
      const t = l.target as RNode;
      if (isHidden(s) || isHidden(t)) return false;
      return inFocus === null || (inFocus.has(s.id) && inFocus.has(t.id));
    });
  }

  // Bind link <line> elements to the visible subset and position them. Called
  // whenever focus/filters change — the default (no focus) renders nothing, so
  // the thousands of edges never hit the DOM until a node is selected.
  function renderLinks(): void {
    linkSel = linkG
      .selectAll<SVGLineElement, RLink>("line")
      .data(visibleLinks(), (l) => `${linkId(l.source)}\n${linkId(l.target)}`)
      .join("line")
      .attr("class", linkClass());
    // Position each edge; x/y attrs land on the same selection.
    linkSel
      .attr("x1", (d) => (d.source as RNode).x!)
      .attr("y1", (d) => (d.source as RNode).y!)
      .attr("x2", (d) => (d.target as RNode).x!)
      .attr("y2", (d) => (d.target as RNode).y!);
  }

  // Base class for the link overlay: hover-blue when "highlight links" is on,
  // otherwise the muted default. Hover then toggles `.hl`/`.dim` on top.
  function linkClass(): string {
    return controls.highlightLinks ? "link hl" : "link";
  }

  function tooltipHtml(d: RNode): string {
    // Node colour already conveys green; only surface non-green status.
    const status = d.analyzing
      ? ' <span class="tip-mut">analyzing</span>'
      : isGreen(d)
        ? ""
        : ' <span class="tip-e">red</span>';
    // Omit the plain "typed" line (redundant with the green colour); keep
    // pending / error / subtree-red detail.
    const own = d.analyzing
      ? "type-check pending"
      : d.errors
        ? `${d.errors} own errors`
        : d.strictRed
          ? "self typed · subtree red"
          : null;
    // Actual file ending (e.g. `tsx`) rather than the coarse `vue`/`ts` kind.
    const ext = d.file.includes(".") ? d.file.split(".").pop()! : d.kind;
    const links = adj.get(d.id)?.size ?? 0;
    let html = `<b>${esc(d.name)}</b>${status} <span class="tip-p">${esc(ext)}</span>`;
    if (own) html += `<br><span class="tip-p">${esc(own)}</span>`;
    html +=
      `<br><span class="tip-p">${esc(d.file)}</span>` +
      `<br><span class="tip-p">depth ${d.height} · ${d.size} LOC · ${links} links</span>`;
    if (controls.showBlame) {
      const rows = Object.entries(d.blame).sort((a, b) => b[1] - a[1]);
      if (rows.length) {
        const top = rows
          .slice(0, 8)
          .map(([a, n]) => `${esc(a)}: ${n}`)
          .join("<br>");
        const more = rows.length > 8 ? `<br>+${rows.length - 8} more` : "";
        html += `<br><span class="tip-blame">${top}${more}</span>`;
      }
    }
    return html;
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
    if (!current || !nodeSel || !linkSel || !labelSel) return;
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
      for (const t of out.get(n.id) ?? []) {
        if (shownIds.has(t)) {
          edges++;
          imported.add(t);
        }
      }
    const leaves = shownNodes.filter((n) => {
      for (const t of out.get(n.id) ?? []) if (shownIds.has(t)) return false;
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
    if (!nodeSel || !linkSel || !labelSel) return;
    labelG.attr("display", controls.showRings ? null : "none");
    nodeSel.style("display", (d) => (isHidden(d) ? "none" : null));
    labelSel.style("display", (d) => (isHidden(d) ? "none" : null));
    renderLinks();
    applySearch();
  }

  function applySearch(): void {
    if (!nodeSel || !labelSel) return;
    const q = controls.search.trim().toLowerCase();
    const hit = (d: RNode) => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
    if (!q) {
      nodeSel.classed("dim", false).attr("r", (d) => nodeR(d));
      labelSel.classed("dim", false);
      return;
    }
    nodeSel.classed("dim", (d) => !hit(d)).attr("r", (d) => (hit(d) ? nodeR(d) + 4 : nodeR(d)));
    labelSel.classed("dim", (d) => !hit(d));
  }

  function setGraph(graph: Graph): void {
    // Ids/depths are graph-specific — a graph switch drops any focus.
    focus = null;
    depthFocus = null;
    if (sim) sim.stop();

    const nodes = graph.nodes.map(toRNode);
    const links: RLink[] = graph.edges.map((e) => ({ source: e.from, target: e.to }));
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

    labelSel = labelG
      .selectAll<SVGTextElement, RNode>("text")
      .data(nodes)
      .join("text")
      .attr("class", "rlabel")
      .attr("text-anchor", "middle")
      .attr("dy", ".34em")
      .attr("font-size", (d) => (nodeR(d) * 1.35).toFixed(1))
      .text((d) => d.height);

    const tick = () => {
      linkSel!
        .attr("x1", (d) => (d.source as RNode).x!)
        .attr("y1", (d) => (d.source as RNode).y!)
        .attr("x2", (d) => (d.target as RNode).x!)
        .attr("y2", (d) => (d.target as RNode).y!);
      nodeSel!.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);
      labelSel!.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
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

    // Fit the settled bounding box into the viewport.
    const xs = nodes.map((n) => n.x!);
    const ys = nodes.map((n) => n.y!);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs);
    const minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const pad = 50;
    const k = Math.min(width() / (w + 2 * pad), height() / (h + 2 * pad));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const fitTransform = d3.zoomIdentity
      .translate(width() / 2, height() / 2)
      .scale(k)
      .translate(-cx, -cy);
    svg.call((s) => zoom.transform(s, fitTransform));

    adj = new Map(nodes.map((n) => [n.id, new Set<string>()]));
    out = new Map(nodes.map((n) => [n.id, new Set<string>()]));
    for (const l of links) {
      const s = linkId(l.source);
      const t = linkId(l.target);
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
      out.get(s)!.add(t);
    }

    nodeSel
      .on("click", (e: MouseEvent, d) => {
        e.stopPropagation();
        const already = focus !== null && focus.root === d.id;
        focus = already ? null : { root: d.id, set: subtree(d.id) };
        refresh();
      })
      .on("mouseover", (e: MouseEvent, d) => {
        const nbr = adj.get(d.id)!;
        // While a search is active it owns the node/label dimming — hover must
        // not reveal filtered-out nodes, so only the link highlight + tooltip
        // react. Without a search, hover dims everything outside the neighbourhood.
        if (!controls.search.trim()) {
          nodeSel!.classed("dim", (o) => o !== d && !nbr.has(o.id));
          labelSel!.classed("dim", (o) => o !== d && !nbr.has(o.id));
        }
        linkSel!
          .classed("hl", (l) => l.source === d || l.target === d)
          .classed("dim", (l) => l.source !== d && l.target !== d);
        tooltip.innerHTML = tooltipHtml(d);
        tooltip.style.opacity = "1";
      })
      .on("mousemove", (e: MouseEvent) => {
        tooltip.style.left = `${e.clientX + 14}px`;
        tooltip.style.top = `${e.clientY + 14}px`;
      })
      .on("mouseout", () => {
        // Restore the baseline: keep every edge blue when "highlight links" is
        // on, otherwise clear the hover emphasis entirely.
        linkSel!.classed("hl", controls.highlightLinks).classed("dim", false);
        // Restore the search baseline (clears dimming when no search is active).
        applySearch();
        tooltip.style.opacity = "0";
      });

    refresh();
  }

  // Click empty space to clear node + depth focus.
  svg.on("click", () => {
    if (focus !== null || depthFocus !== null) {
      focus = null;
      depthFocus = null;
      refresh();
    }
  });

  function setControls(next: Controls): void {
    controls = next;
    refresh();
  }

  function toggleDepth(h: number): void {
    depthFocus = depthFocus === h ? null : h;
    refresh();
  }

  function destroy(): void {
    if (sim) sim.stop();
    svg.on(".zoom", null);
    svg.on("click", null);
    root.remove();
    tooltip.style.opacity = "0";
  }

  return { setGraph, setControls, toggleDepth, destroy };
}
