import type {
  Graph,
  Maintainability,
  MaintainabilityBreakdown,
  MaintainabilityContributions,
  MaintainabilityHotspot,
} from "../shared/types.ts";

/**
 * Pure maintainability scoring over the `full` module graph. No IO, no `vite`.
 *
 * The model treats maintainability as the inverse of the expected cost of a
 * *safe* change: to change a file you must understand it (and the interface of
 * what it imports), re-verify everything that transitively imports it, and pay
 * extra wherever the compiler can't back you up (type errors). Each file's
 * cost, in LoC-equivalent units, is
 *
 *   cost(m) = loc(m) · ( 1 + α·max(0, Ceʷ(m) − K) + β·I(m)·r(m) + type(m) )
 *             └ read ┘   └──── comprehension ─────┘  └── blast ──┘  └ types ┘
 *   type(m) = red(m) ? γ·(1 + δ·r_type(m)) : 0
 *
 * where Ceʷ(m) = Σ_{d ∈ imports(m)} I₀(d) is the *volatility-weighted* fan-out:
 * each import counts by how unstable its target is, so depending on a stable
 * module (an icon or constants barrel, a pure types module — I₀ ≈ 0) is nearly
 * free while depending on a volatile one costs close to a full edge. I₀ is the
 * raw Ce/(Ce+Ca) from a first pass. K = the healthy fan-out budget (only
 * *excess* weighted fan-out costs comprehension, so ordinary modularity is
 * free). I(m) = Ceʷ(m)/(Ceʷ(m)+Ca(m)) is the instability, likewise weighted so
 * importing stable code never marks you volatile (a change-likelihood proxy per
 * the Stable-Dependencies Principle). r = the *blast radius*, the fraction of
 * the codebase that transitively imports m, and `red` = the file carries at
 * least one type error. Type errors are a first-class term amplified by blast
 * radius — a bad type in a foundational module is far worse than in a leaf —
 * because the graph is a TypeScript-migration view and the score tracks red →
 * green.
 *
 * Import cycles fold their whole LoC into every member's blast radius (mutual
 * dependents), so a cycle is penalised through blast without an ad-hoc term.
 *
 * Edges feed the terms through per-kind projections (docs/symbol-resolution.md
 * §2): type-only edges are compiler-verified and leave every structural term —
 * Ceʷ, Ca, I and r — driving only the type-risk radius r_type (reachability
 * over ALL edges) that amplifies `type(m)`; lazy dynamic-import/glob edges
 * charge no comprehension to the importer (out of Ceʷ and the instability
 * numerator) but keep their targets' fan-in, reachability and blast radius.
 *
 * The score normalises the summed cost against the floor Σ loc (every file
 * read once, no excess coupling, fully typed): `score = 100 · floorLoc /
 * costLoc`. A clean, fully-typed, modular codebase approaches 100; the score
 * is size-invariant because every surcharge is bounded and size-independent
 * (Ce is local; I, r ∈ [0,1]; the type term is per-file). See
 * `docs/maintainability-score.md` for the full derivation and its limits.
 */

/** Volatility-weighted imports allowed before comprehension cost begins — an import of a stable module counts as a fraction of one edge (the healthy fan-out budget). */
const HEALTHY_FANOUT = 8;
/** Comprehension surcharge per import above the budget, as a fraction of the file's LoC. */
const ALPHA = 0.05;
/** Structural blast weight: an unstable file the whole codebase imports (I·r → 1) costs β× its LoC extra. */
const BETA = 3;
/** Direct cost of a type error, as a multiple of the red file's LoC. */
const GAMMA = 1.2;
/** How much a red file's blast radius amplifies its type cost (a red foundation hurts more than a red leaf). */
const DELTA = 4;
/** Max flaw-cost amplification from complexity: a maximally branch-dense file's structural/type overhead is multiplied by up to 1+λ. */
const LAMBDA = 2;
/** Decision density (branches per maintainable line) at which complexity amplification reaches half its max. */
const DENSITY_HALF = 0.3;
/** Max hotspots returned — the actionable shortlist, not the whole graph. */
const MAX_HOTSPOTS = 12;
/** Max cycles shipped (largest by LoC) — enough to act on, not an SCC dump. */
const MAX_CYCLES = 8;

export function scoreMaintainability(graph: Graph): Maintainability {
  const { nodes, edges } = graph;
  const n = nodes.length;

  const loc = (i: number) => nodes[i]!.loc ?? 0;
  const cc = (i: number) => nodes[i]!.cc ?? 0;
  const totalLoc = nodes.reduce((sum, node) => sum + (node.loc ?? 0), 0);

  // Type coverage: available iff the type-check pass ran (some node has a
  // non-null count). A node is "red" when it carries at least one own error.
  const typeAvailable = nodes.some((node) => node.typeErrors !== null);
  const isRed = (i: number) => (nodes[i]!.typeErrors ?? 0) > 0;

  if (n === 0 || totalLoc === 0) {
    return {
      score: 100,
      floorLoc: totalLoc,
      costLoc: totalLoc,
      drivers: { comprehension: 0, blast: 0, types: 0 },
      complexityAmplification: 0,
      cycleLoc: 0,
      nodes: n,
      edges: edges.length,
      typeHealth: typeAvailable ? typedFraction(nodes, totalLoc) : null,
      hotspots: [],
      contributions: {},
      breakdown: {},
      cycles: [],
    };
  }

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node.id, i));

  // Per-term edge projections (docs/symbol-resolution.md §2):
  // - TYPE-ONLY edges leave the structural terms entirely (Ce^w, Ca, I, blast
  //   radius): a type-only dependent is re-verified by the compiler, not by a
  //   human re-reasoning about behavior. They still carry type risk, so they
  //   count in the type-risk radius that amplifies the `types` term.
  // - LAZY edges (dynamic import / glob) leave only the importer's
  //   comprehension side (Ce^w and the instability numerator): a route table
  //   globbing 200 pages is a declarative registry, not comprehension load.
  //   The targets keep their fan-in, reachability and blast radius — a broken
  //   page still breaks navigation.
  // - Everything else (incl. synchronous side-effect imports) counts everywhere.
  const children: number[][] = Array.from({ length: n }, () => []); // structural (value)
  const parents: number[][] = Array.from({ length: n }, () => []); // structural (value)
  const syncChildren: number[][] = Array.from({ length: n }, () => []); // comprehension
  const childrenAll: number[][] = Array.from({ length: n }, () => []); // type risk
  for (const edge of edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    childrenAll[a]!.push(b);
    if (edge.type) {
      continue;
    }
    children[a]!.push(b);
    parents[b]!.push(a);
    if (!edge.lazy) {
      syncChildren[a]!.push(b);
    }
  }

  // Base (unweighted) instability per node, used to weight each import edge:
  // I₀ = Ce/(Ce+Ca) on the projections — synchronous value imports over
  // structural importers. A first pass so the volatility-weighted fan-out
  // below is well-defined without a fixpoint. An import of a stable target
  // (low I₀, e.g. an icon/constants barrel) is nearly free; a volatile one
  // costs a full edge.
  const i0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ce = syncChildren[i]!.length;
    const ca = parents[i]!.length;
    i0[i] = ce + ca === 0 ? 0 : ce / (ce + ca);
  }

  // Two reachability passes over the projections (§2): the structural one
  // (value edges — sync + lazy) drives blast radius and cycle detection; the
  // full one (every edge, incl. type-only) drives the type-risk radius — a
  // broken type propagates to precisely its type-dependents, which is what
  // `strictRed` already models. `import type` cycles are legal TS and carry no
  // runtime hazard, so cycle flags come from the structural pass only.
  const structural = dependentReach(children, n, loc);
  const typeRisk = dependentReach(childrenAll, n, loc);
  const inCycle = (i: number) => structural.compSize[structural.comp[i]!]! > 1;

  // The actionable cycle shortlist: members of the largest structural SCCs.
  const cycleMembers = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const c = structural.comp[i]!;
    if (structural.compSize[c]! > 1) {
      const members = cycleMembers.get(c);
      if (members) {
        members.push(nodes[i]!.id);
      } else {
        cycleMembers.set(c, [nodes[i]!.id]);
      }
    }
  }
  const cycles = [...cycleMembers.entries()]
    .sort((a, b) => structural.compLoc[b[0]]! - structural.compLoc[a[0]]!)
    .slice(0, MAX_CYCLES)
    .map(([, members]) => members.sort());

  // Assemble per-file cost and the overhead decomposition.
  let costLoc = 0;
  let overheadComprehension = 0;
  let overheadBlast = 0;
  let overheadTypes = 0;
  let cycleLoc = 0;
  let baseFlawLoc = 0;
  const hotspots: MaintainabilityHotspot[] = [];
  const contribC = new Float64Array(n);
  const contribB = new Float64Array(n);
  const contribT = new Float64Array(n);
  let maxC = 0;
  let maxB = 0;
  let maxT = 0;
  const breakdown: Record<string, MaintainabilityBreakdown> = {};

  for (let i = 0; i < n; i++) {
    const li = loc(i);
    const c = structural.comp[i]!;
    const ce = children[i]!.length;
    const ca = parents[i]!.length;
    // Volatility-weighted fan-out: each SYNCHRONOUS value import counts by its
    // target's base instability, so importing stable foundations is nearly
    // free and only importing volatile modules drives comprehension and
    // instability up. Lazy registry edges charge no comprehension (§2).
    let ceW = 0;
    for (const d of syncChildren[i]!) {
      ceW += i0[d]!;
    }
    const instability = ceW + ca === 0 ? 0 : ceW / (ceW + ca);

    // Dependents of i: everything reaching its component, plus the *other*
    // members of its own cycle (mutual dependents), minus i itself.
    const blastRadius = (structural.depLocOfComp[c]! + (structural.compLoc[c]! - li)) / totalLoc;
    const ct = typeRisk.comp[i]!;
    const typeRadius = (typeRisk.depLocOfComp[ct]! + (typeRisk.compLoc[ct]! - li)) / totalLoc;

    const comprehend = ALPHA * Math.max(0, ceW - HEALTHY_FANOUT);
    const blast = BETA * instability * blastRadius;
    const types = isRed(i) ? GAMMA * (1 + DELTA * typeRadius) : 0;
    const flaws = comprehend + blast + types;
    // Complexity is a flaw *amplifier*, never a standalone penalty: a dense,
    // branch-heavy file makes each structural/type flaw costlier to change
    // safely. A flawless file costs `li` no matter how complex it is, and a
    // simple file (density → 0) weights its flaws by `li` exactly as before.
    const density = li > 0 ? cc(i) / li : 0;
    const cxWeight = 1 + LAMBDA * (density / (density + DENSITY_HALF));
    const cost = li * (1 + cxWeight * flaws);

    costLoc += cost;
    baseFlawLoc += li * flaws;
    overheadComprehension += li * cxWeight * comprehend;
    overheadBlast += li * cxWeight * blast;
    overheadTypes += li * cxWeight * types;
    contribC[i] = li * cxWeight * comprehend;
    contribB[i] = li * cxWeight * blast;
    contribT[i] = li * cxWeight * types;
    if (contribC[i]! > maxC) maxC = contribC[i]!;
    if (contribB[i]! > maxB) maxB = contribB[i]!;
    if (contribT[i]! > maxT) maxT = contribT[i]!;
    if (inCycle(i)) {
      cycleLoc += li;
    }

    // Ship a per-file breakdown for the alt-hover detail view — but only for
    // files that actually drag the score (carry overhead) or amplify via
    // complexity. Clean files at their floor are omitted to keep the payload small.
    if (contribC[i]! > 0 || contribB[i]! > 0 || contribT[i]! > 0 || cxWeight > 1) {
      breakdown[nodes[i]!.id] = {
        comprehension: Math.round(contribC[i]! * 10) / 10,
        blast: Math.round(contribB[i]! * 10) / 10,
        types: Math.round(contribT[i]! * 10) / 10,
        weightedFanout: Math.round(ceW * 10) / 10,
        instability: Math.round(instability * 1000) / 1000,
        blastRadius: Math.round(blastRadius * 1000) / 1000,
        cxWeight: Math.round(cxWeight * 100) / 100,
      };
    }

    hotspots.push({
      id: nodes[i]!.id,
      file: nodes[i]!.file,
      loc: li,
      cc: cc(i),
      fanOut: ce,
      fanIn: ca,
      instability,
      blastRadius,
      inCycle: inCycle(i),
      cost,
    });
  }

  const overhead = overheadComprehension + overheadBlast + overheadTypes;
  const drivers =
    overhead > 0
      ? {
          comprehension: overheadComprehension / overhead,
          blast: overheadBlast / overhead,
          types: overheadTypes / overhead,
        }
      : { comprehension: 0, blast: 0, types: 0 };

  // How much of the flaw-cost exists because flaws sit in complex code.
  const complexityAmplification = overhead > 0 ? (overhead - baseFlawLoc) / overhead : 0;

  // Most negative effect first: a file's overhead above its own floor
  // (cost − loc) is exactly its contribution to costLoc − floorLoc, i.e. how
  // much it drags the score down. A large file sitting at its floor is not a
  // hotspot, so sort by overhead, not absolute cost.
  hotspots.sort((a, b) => b.cost - b.loc - (a.cost - a.loc));

  // Per-node contribution to each driver, normalised to [0,1] by the top
  // contributor in that driver — the intensity of the graph's driver-highlight
  // rings. Files at their own floor (zero overhead) are omitted.
  const norm = (v: number, max: number) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0);
  const contributions: MaintainabilityContributions = {};
  for (let i = 0; i < n; i++) {
    const c = norm(contribC[i]!, maxC);
    const b = norm(contribB[i]!, maxB);
    const t = norm(contribT[i]!, maxT);
    if (c > 0 || b > 0 || t > 0) {
      contributions[nodes[i]!.id] = { comprehension: c, blast: b, types: t };
    }
  }

  return {
    score: Math.round((100 * totalLoc) / costLoc),
    floorLoc: totalLoc,
    costLoc: Math.round(costLoc),
    drivers,
    complexityAmplification,
    cycleLoc: cycleLoc / totalLoc,
    nodes: n,
    edges: edges.length,
    typeHealth: typeAvailable ? typedFraction(nodes, totalLoc) : null,
    hotspots: hotspots.slice(0, MAX_HOTSPOTS),
    contributions,
    breakdown,
    cycles,
  };
}

/** LoC-weighted fraction of nodes with zero type errors. */
function typedFraction(nodes: Graph["nodes"], totalLoc: number): number {
  if (totalLoc === 0) {
    return 1;
  }
  let green = 0;
  for (const node of nodes) {
    if ((node.typeErrors ?? 0) === 0) {
      green += node.loc ?? 0;
    }
  }
  return green / totalLoc;
}

/** Condensation-based transitive-dependent reach for one edge projection. */
interface DependentReach {
  /** Node → SCC id (Tarjan). */
  comp: Int32Array;
  /** SCC → summed member LoC. */
  compLoc: Float64Array;
  /** SCC → member count (>1 = a real cycle). */
  compSize: Int32Array;
  /** SCC → total LoC of every component that transitively imports it. */
  depLocOfComp: Float64Array;
}

/**
 * Transitive dependent LoC per component: SCC-condense `children`, then
 * accumulate dependent-direction reachability with bitsets in
 * reverse-topological order. Runs once per edge projection (§2) — structural
 * blast and type risk read different projections of the same graph.
 */
function dependentReach(
  children: number[][],
  n: number,
  loc: (i: number) => number,
): DependentReach {
  const { comp, compCount } = stronglyConnected(children, n);

  const compLoc = new Float64Array(compCount);
  const compSize = new Int32Array(compCount);
  for (let i = 0; i < n; i++) {
    const c = comp[i]!;
    compLoc[c]! += loc(i);
    compSize[c]! += 1;
  }

  // Condensation edges in the *dependents* direction: if `from` imports `to`,
  // then comp(to) has comp(from) as a dependent. Dedup per source component.
  const depAdj: Set<number>[] = Array.from({ length: compCount }, () => new Set<number>());
  for (let a = 0; a < n; a++) {
    for (const b of children[a]!) {
      const cf = comp[a]!;
      const ct = comp[b]!;
      if (cf !== ct) {
        depAdj[ct]!.add(cf);
      }
    }
  }

  // Transitive dependent LoC per component via bitset reach over the
  // condensation DAG, accumulated in reverse-topological (post) order so a
  // component's successors are resolved before it.
  const words = (compCount + 31) >>> 5;
  const reach: Uint32Array[] = Array.from({ length: compCount }, () => new Uint32Array(words));
  for (const c of postOrder(depAdj, compCount)) {
    const acc = reach[c]!;
    for (const s of depAdj[c]!) {
      acc[s >>> 5]! |= 1 << (s & 31);
      const sReach = reach[s]!;
      for (let w = 0; w < words; w++) {
        acc[w]! |= sReach[w]!;
      }
    }
  }

  const depLocOfComp = new Float64Array(compCount);
  for (let c = 0; c < compCount; c++) {
    const bits = reach[c]!;
    for (let w = 0; w < words; w++) {
      let bit = bits[w]!;
      while (bit !== 0) {
        depLocOfComp[c]! += compLoc[(w << 5) + trailingZeros(bit)]!;
        bit &= bit - 1;
      }
    }
  }

  return { comp, compLoc, compSize, depLocOfComp };
}

/**
 * Iterative Tarjan SCC. Returns each node's component id and the component
 * count; ids are assigned in reverse-topological order of the condensation
 * (not relied upon here). Iterative to survive deep import chains.
 */
function stronglyConnected(
  children: number[][],
  n: number,
): { comp: Int32Array; compCount: number } {
  const comp = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const disc = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let idx = 0;
  let compCount = 0;

  // Explicit DFS stack of (node, next-child-cursor).
  const call: number[] = [];
  const cursor: number[] = [];

  for (let start = 0; start < n; start++) {
    if (disc[start]! !== -1) {
      continue;
    }
    call.push(start);
    cursor.push(0);
    while (call.length > 0) {
      const v = call[call.length - 1]!;
      if (cursor[cursor.length - 1] === 0 && disc[v]! === -1) {
        disc[v] = low[v] = idx++;
        stack.push(v);
        onStack[v] = 1;
      }
      const kids = children[v]!;
      let ci = cursor[cursor.length - 1]!;
      let descended = false;
      while (ci < kids.length) {
        const w = kids[ci]!;
        ci++;
        if (disc[w]! === -1) {
          cursor[cursor.length - 1] = ci;
          call.push(w);
          cursor.push(0);
          descended = true;
          break;
        } else if (onStack[w] === 1) {
          low[v] = Math.min(low[v]!, disc[w]!);
        }
      }
      if (descended) {
        continue;
      }
      cursor[cursor.length - 1] = ci;
      // All children processed: fold the just-returned child's low, then close.
      call.pop();
      cursor.pop();
      if (call.length > 0) {
        const parent = call[call.length - 1]!;
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v]! === disc[v]!) {
        let w = -1;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = compCount;
        } while (w !== v);
        compCount++;
      }
    }
  }
  return { comp, compCount };
}

/** Post-order (successors-first) traversal of a DAG given as adjacency sets. */
function postOrder(adj: Set<number>[], count: number): number[] {
  const order: number[] = [];
  const state = new Uint8Array(count); // 0 unseen, 1 open, 2 done
  const call: number[] = [];
  const iter: Iterator<number>[] = [];
  for (let start = 0; start < count; start++) {
    if (state[start] !== 0) {
      continue;
    }
    call.push(start);
    iter.push(adj[start]!.values());
    state[start] = 1;
    while (call.length > 0) {
      const v = call[call.length - 1]!;
      const next = iter[iter.length - 1]!.next();
      if (next.done) {
        state[v] = 2;
        order.push(v);
        call.pop();
        iter.pop();
        continue;
      }
      const w = next.value;
      if (state[w] === 0) {
        state[w] = 1;
        call.push(w);
        iter.push(adj[w]!.values());
      }
    }
  }
  return order;
}

/** Index of the lowest set bit of a non-zero 32-bit word. */
function trailingZeros(x: number): number {
  let count = 0;
  let v = x >>> 0;
  while ((v & 1) === 0) {
    v >>>= 1;
    count++;
  }
  return count;
}
