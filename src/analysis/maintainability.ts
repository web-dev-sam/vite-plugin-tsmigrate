import type { FileChurn } from "./churn.ts";
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
 * The model prices the *structural overhead* of change: to change a file you
 * must understand it (and the interface of what it imports), navigate its
 * branching, and re-verify everything that transitively imports it. Types
 * are a cost **discount** on every flaw, not a penalty term — the compiler
 * carries most of the re-verification wherever code is typed. Each file's
 * cost, in LoC-equivalent units (one unit = reading one line once), is
 *
 *   cost(m) = loc(m) + t(m)·( comprehension(m) + mass(m) )
 *                    + ( D + (1−D)·u_dep(m) )·blast(m)
 *
 *   comprehension(m) = loc(m) · α·max(0, Ceʷ(m) − K)
 *   blast(m)         = loc(m) · β·vol(m)·r(m)
 *   mass(m)          = κ · cc(m) · (loc(m)/L₀)^p
 *   t(m)             = red(m) ? 1 : D          (red = carries own type errors)
 *   u_dep(m)         = red-LoC share of m's transitive structural dependents
 *
 * Own-file flaws (comprehension, mass) discount by the file's own typedness;
 * blast discounts by the *dependents'* typedness — re-verifying typed
 * downstream code is cheap regardless of the changed file's colour. A fully
 * typed repo prices every flaw at D; a fully red one at full price.
 *
 * **Volatility** ∈ [0,1] is how likely a module is to actually change — the
 * pinned, production-validated form:
 *
 *   x(m)   = damped deleted-lines per month / loc(m)
 *   vol(m) = max( x(m)/(x(m) + x½), floor·I₀(m) )     (I₀ = Ce/(Ce+Ca))
 *
 * Deleted lines only: appending to a registry/barrel is risk-free, modifying
 * existing lines is risk. The saturation scale x½ is **absolute** (1% of the
 * file's lines deleted per month = half volatile), never a per-repo
 * percentile — a becalmed maintenance-mode codebase must not read like one
 * whose core churns daily, or cross-repo criterion referencing dies. With
 * thin or no history the floor·I₀ term is the fallback: Martin instability,
 * shrunk hard because presumed volatility is weak evidence (`churn.ts`).
 *
 * **Comprehension**: each import priced by its target's volatility —
 * depending on a stable module (an icon/constants barrel) is nearly free
 * while depending on a churning store costs a full edge. Only weighted
 * fan-out above the budget K costs anything.
 *
 * **Blast**: β·vol(m)·r(m) — a module that measurably changes with the
 * codebase downstream (r = fraction of total LoC transitively importing m)
 * forces re-verification on every change. MEASURED churn is what lets a
 * weekly-edited hub with 400 importers cost something: under pure structural
 * instability, fan-in drives the prior → 0 and popular-but-churning god
 * files score free — history breaks the tie the structure cannot. Import
 * cycles fold their whole LoC into every member's blast radius (mutual
 * dependents), so a cycle is penalised through blast without an ad-hoc term.
 *
 * **Mass**: each decision point (script cc + template branches) costs more
 * the bigger the file it is buried in — a branch in a 1,400-line composable
 * is ~4.7× a branch in a 300-line module. cc-gating keeps prose and flat
 * declaration files free (legal text, URL tables); splitting a god file
 * genuinely lowers the score.
 *
 * Edges feed the terms through per-kind projections (docs/maintainability-score.md
 * "Edge projections"): type-only edges leave every structural term (the compiler re-verifies
 * those dependents); lazy dynamic-import/glob edges charge no comprehension
 * to the importer but keep their targets' fan-in, reachability and blast
 * radius.
 *
 * **Score** — criterion-referenced, two legible constants: Ω = overhead ratio
 * (cost − floor)/floor, and
 *
 *   score = min(100, 30 − 25·log₂(Ω / Ω_typ))
 *
 * Ω_typ is the overhead ratio of a typical production Vue app, pinned to
 * score 30 (the average project does NOT get a passing grade); every halving
 * of Ω is worth +25 points, every doubling −25. The 100 cap is principled
 * (Ω = 0 — changes cost only the reading — is a true floor); the bottom is
 * open — negatives are reserved for genuine disasters.
 * `docs/maintainability-score.md` has the full derivation and its limits.
 */

/** Volatility-weighted imports allowed before comprehension cost begins — an import of a stable module counts as a fraction of one edge (the healthy fan-out budget). */
const HEALTHY_FANOUT = 8;
/** Comprehension surcharge per weighted import above the budget, as a fraction of the file's LoC. */
const ALPHA = 0.05;
/** Structural blast weight: a maximally volatile file the whole codebase imports (vol·r → 1) costs β× its LoC extra. */
const BETA = 3;
/** Mass scale: LoC-equivalents charged per decision point in a file of pivot size. */
const KAPPA = 1;
/** Mass pivot size L₀ — a branch in a file this big costs exactly κ; smaller files discount, bigger escalate. */
const MASS_PIVOT_LOC = 300;
/** Mass size exponent p — raise above 1 to make god files escalate superlinearly. */
const MASS_EXPONENT = 1;
/** Typed discount D: the compiler carries all but this fraction of a typed file's flaw cost (own flaws by own typedness, blast by the dependents'). */
const TYPED_DISCOUNT = 0.2;
/** Churn half-saturation x½: deleting 1% of a file's lines per month reads as half volatile. Absolute scale — NEVER per-repo-normalised. */
const CHURN_X_HALF = 0.01;
/** Structural fallback floor: with thin/no history, volatility bottoms out at this fraction of Martin instability I₀. */
const PRIOR_FLOOR = 0.15;
/** Overhead ratio of a typical production Vue app, pinned to score 30. Provisional anchor — re-measure against taste-rated repos per calibration epoch. */
const OMEGA_TYP = 0.1;
/** Points per doubling of Ω (Weber–Fechner, sayable out loud). */
const SLOPE = 25;
/** The score a typical production Vue app gets — deliberately not a passing grade. */
const SCORE_TYP = 30;
/** Bump when the model/anchors change so recorded scores stay interpretable. */
export const CALIBRATION_EPOCH = "v2.1-2026-08";
/** Max hotspots returned — the actionable shortlist, not the whole graph. */
const MAX_HOTSPOTS = 12;
/** Max cycles shipped (largest by LoC) — enough to act on, not an SCC dump. */
const MAX_CYCLES = 8;

/** Tuning knobs threaded from plugin options. */
export interface ScoreOptions {
  /**
   * Score type risk. `false` treats every file as typed (t = D, u_dep = 0
   * everywhere) — "score the structure as if the migration were finished",
   * the post-migration structural ceiling, on the same scale as typed repos.
   * `typeHealth` still reports the typed fraction when the type pass ran —
   * it is progress information, not a cost.
   */
  scoreTypeRisk?: boolean;
  /**
   * Per-file churn (absolute module id → stats) from `collectChurn`.
   * `undefined` = the churn pass is disabled or has not completed — volatility
   * falls back to the structural prior everywhere and `churnCoverage` is
   * null. An empty map = the pass ran and found no history (no repo, shallow
   * clone), which reads as coverage 0.
   */
  churn?: ReadonlyMap<string, FileChurn>;
}

export function scoreMaintainability(
  graph: Graph,
  { scoreTypeRisk = true, churn }: ScoreOptions = {},
): Maintainability {
  const { nodes, edges } = graph;
  const n = nodes.length;

  const loc = (i: number) => nodes[i]!.loc ?? 0;
  const cc = (i: number) => nodes[i]!.cc ?? 0;
  const totalLoc = nodes.reduce((sum, node) => sum + (node.loc ?? 0), 0);

  // Type coverage: available iff the type-check pass ran (some node has a
  // non-null count). A node is "red" when it carries at least one own error.
  const typeAvailable = nodes.some((node) => node.typeErrors !== null);
  const isRed = (i: number) => scoreTypeRisk && (nodes[i]!.typeErrors ?? 0) > 0;

  if (n === 0 || totalLoc === 0) {
    return {
      score: 100,
      omega: 0,
      calibrationEpoch: CALIBRATION_EPOCH,
      floorLoc: totalLoc,
      costLoc: totalLoc,
      drivers: { comprehension: 0, blast: 0, mass: 0 },
      cycleLoc: 0,
      nodes: n,
      edges: edges.length,
      typeHealth: typeAvailable ? typedFraction(nodes, totalLoc) : null,
      churnCoverage: churn === undefined ? null : 0,
      volatility: {},
      hotspots: [],
      contributions: {},
      breakdown: {},
      cycles: [],
    };
  }

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node.id, i));

  // Per-term edge projections (docs/maintainability-score.md "Edge projections"):
  // - TYPE-ONLY edges leave the structural terms entirely (Ce^w, Ca, blast
  //   radius): a type-only dependent is re-verified by the compiler, not by a
  //   human re-reasoning about behavior.
  // - LAZY edges (dynamic import / glob) leave only the importer's
  //   comprehension side (Ce^w): a route table globbing 200 pages is a
  //   declarative registry, not comprehension load. The targets keep their
  //   fan-in, reachability and blast radius — a broken page still breaks
  //   navigation.
  // - Everything else (incl. synchronous side-effect imports) counts everywhere.
  const children: number[][] = Array.from({ length: n }, () => []); // structural (value)
  const parents: number[][] = Array.from({ length: n }, () => []); // structural (value)
  const syncChildren: number[][] = Array.from({ length: n }, () => []); // comprehension
  for (const edge of edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined || a === b || edge.type) {
      continue;
    }
    children[a]!.push(b);
    parents[b]!.push(a);
    if (!edge.lazy) {
      syncChildren[a]!.push(b);
    }
  }

  // Volatility — the pinned, production-validated form. Measured existing-line
  // change rate x = damped deleted-lines/month ÷ loc, saturated on an ABSOLUTE
  // scale (never a per-repo percentile), floored by shrunk Martin instability:
  //
  //   vol = max( x/(x + x½), PRIOR_FLOOR·I₀ )
  //
  // Deleted lines only — appending to a registry/barrel is risk-free. Thin or
  // no history (x = 0) bottoms out at the structural floor, so history-less
  // repos still order by structure without presuming every mid-layer module
  // churns. One vol per node: it prices the node's incoming edges (Ceʷ) and
  // its own blast term alike.
  const i0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ce = syncChildren[i]!.length;
    const ca = parents[i]!.length;
    i0[i] = ce + ca === 0 ? 0 : ce / (ce + ca);
  }
  const vol = new Float64Array(n);
  let churnLoc = 0;
  for (let i = 0; i < n; i++) {
    const stats = churn?.get(nodes[i]!.id);
    let x = 0;
    if (stats !== undefined && stats.nEff > 0) {
      churnLoc += loc(i);
      x = stats.deletedPerMonth / Math.max(loc(i), 1);
    }
    vol[i] = Math.max(x / (x + CHURN_X_HALF), PRIOR_FLOOR * i0[i]!);
  }
  const fanoutW = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let ceW = 0;
    for (const d of syncChildren[i]!) {
      ceW += vol[d]!;
    }
    fanoutW[i] = ceW;
  }

  // One reachability pass over the structural projection (value edges — sync
  // + lazy): it drives blast radius, cycle detection, and — when red files
  // exist — the red-LoC dependent reach behind the blast discount (u_dep).
  // `import type` cycles are legal TS and carry no runtime hazard, so cycle
  // flags come from this pass only.
  const anyRed = scoreTypeRisk && nodes.some((_, i) => isRed(i));
  const structural = dependentReach(
    children,
    n,
    loc,
    anyRed ? (i) => (isRed(i) ? loc(i) : 0) : null,
  );
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

  // Assemble per-file cost and the overhead decomposition. Every overhead
  // (never the read floor) carries a typed discount: own flaws
  // (comprehension, mass) × t = red ? 1 : D; blast × (D + (1−D)·u_dep), the
  // dependents' untyped share — re-verifying typed downstream code is cheap.
  let costLoc = 0;
  let overheadComprehension = 0;
  let overheadBlast = 0;
  let overheadMass = 0;
  let cycleLoc = 0;
  const hotspots: MaintainabilityHotspot[] = [];
  const contribC = new Float64Array(n);
  const contribB = new Float64Array(n);
  const contribM = new Float64Array(n);
  let maxC = 0;
  let maxB = 0;
  let maxM = 0;
  const breakdown: Record<string, MaintainabilityBreakdown> = {};
  const volatility: Record<string, number> = {};

  for (let i = 0; i < n; i++) {
    const li = loc(i);
    const c = structural.comp[i]!;
    const ce = children[i]!.length;
    const ca = parents[i]!.length;
    // Volatility-weighted fan-out (precomputed): each SYNCHRONOUS value
    // import counts by its target's volatility, so importing stable
    // foundations is nearly free and only importing churning/unstable modules
    // drives comprehension up. Lazy registry edges charge no comprehension (§2).
    const ceW = fanoutW[i]!;

    // Dependents of i: everything reaching its component, plus the *other*
    // members of its own cycle (mutual dependents), minus i itself.
    const depLoc = structural.depLocOfComp[c]! + (structural.compLoc[c]! - li);
    const blastRadius = depLoc / totalLoc;
    // Typed discounts: own flaws by own colour; blast by the dependents'
    // untyped LoC share (same reach, weighted by red LoC).
    const t = isRed(i) ? 1 : TYPED_DISCOUNT;
    let uDep = 0;
    if (anyRed && depLoc > 0) {
      const depRed = structural.depRedOfComp[c]! + (structural.compRed[c]! - (isRed(i) ? li : 0));
      uDep = depRed / depLoc;
    }
    const blastDiscount = TYPED_DISCOUNT + (1 - TYPED_DISCOUNT) * uDep;

    const comprehend = ALPHA * Math.max(0, ceW - HEALTHY_FANOUT);
    const blast = BETA * vol[i]! * blastRadius;
    // Mass: an absolute charge (not a per-LoC surcharge) — each decision
    // point costs κ scaled by how big the file is relative to the pivot.
    const mass = KAPPA * cc(i) * (li / MASS_PIVOT_LOC) ** MASS_EXPONENT;
    const cost = li + t * (li * comprehend + mass) + blastDiscount * li * blast;

    costLoc += cost;
    contribC[i] = t * li * comprehend;
    contribB[i] = blastDiscount * li * blast;
    contribM[i] = t * mass;
    overheadComprehension += contribC[i]!;
    overheadBlast += contribB[i]!;
    overheadMass += contribM[i]!;
    if (contribC[i]! > maxC) maxC = contribC[i]!;
    if (contribB[i]! > maxB) maxB = contribB[i]!;
    if (contribM[i]! > maxM) maxM = contribM[i]!;
    if (inCycle(i)) {
      cycleLoc += li;
    }
    if (vol[i]! > 0) {
      volatility[nodes[i]!.id] = Math.round(vol[i]! * 1000) / 1000;
    }

    // Ship a per-file breakdown for the alt-hover detail view, and a hotspot
    // row — both only for files that actually drag the score (carry
    // overhead). Clean files at their floor are omitted: they can never be
    // "where to look", however big they are, and shipping them makes the
    // hotspot list read as arbitrary.
    if (contribC[i]! > 0 || contribB[i]! > 0 || contribM[i]! > 0) {
      breakdown[nodes[i]!.id] = {
        comprehension: Math.round(contribC[i]! * 10) / 10,
        blast: Math.round(contribB[i]! * 10) / 10,
        mass: Math.round(contribM[i]! * 10) / 10,
        weightedFanout: Math.round(ceW * 10) / 10,
        volatility: Math.round(vol[i]! * 1000) / 1000,
        blastRadius: Math.round(blastRadius * 1000) / 1000,
      };
      hotspots.push({
        id: nodes[i]!.id,
        file: nodes[i]!.file,
        loc: li,
        cc: cc(i),
        fanOut: ce,
        fanIn: ca,
        volatility: vol[i]!,
        blastRadius,
        inCycle: inCycle(i),
        cost,
      });
    }
  }

  const overhead = overheadComprehension + overheadBlast + overheadMass;
  const drivers =
    overhead > 0
      ? {
          comprehension: overheadComprehension / overhead,
          blast: overheadBlast / overhead,
          mass: overheadMass / overhead,
        }
      : { comprehension: 0, blast: 0, mass: 0 };

  // The mapping: Ω = overhead per floor-LoC; 25 points per doubling around
  // the "typical production Vue app = 30" anchor; capped at 100 (Ω = 0 is a
  // true floor), open below. The typed discount lives inside Ω, so there is
  // no post-mapping deduction.
  const omega = overhead / totalLoc;
  const score = omega <= 0 ? 100 : Math.min(100, SCORE_TYP - SLOPE * Math.log2(omega / OMEGA_TYP));

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
    const m = norm(contribM[i]!, maxM);
    if (c > 0 || b > 0 || m > 0) {
      contributions[nodes[i]!.id] = { comprehension: c, blast: b, mass: m };
    }
  }

  return {
    score: Math.round(score),
    omega: Math.round(omega * 10_000) / 10_000,
    calibrationEpoch: CALIBRATION_EPOCH,
    floorLoc: totalLoc,
    costLoc: Math.round(costLoc),
    drivers,
    cycleLoc: cycleLoc / totalLoc,
    nodes: n,
    edges: edges.length,
    typeHealth: typeAvailable ? typedFraction(nodes, totalLoc) : null,
    churnCoverage: churn === undefined ? null : Math.round((churnLoc / totalLoc) * 1000) / 1000,
    volatility,
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
  /** SCC → summed member red LoC (zero-filled when no red weight given). */
  compRed: Float64Array;
  /** SCC → total red LoC of every component that transitively imports it. */
  depRedOfComp: Float64Array;
}

/**
 * Transitive dependent LoC per component: SCC-condense `children`, then
 * accumulate dependent-direction reachability with bitsets in
 * reverse-topological order. `red` is an optional second weight accumulated
 * over the SAME reach sets (red LoC — the blast discount's u_dep numerator),
 * so one pass serves blast radius, cycles, and typedness of dependents.
 */
function dependentReach(
  children: number[][],
  n: number,
  loc: (i: number) => number,
  red: ((i: number) => number) | null = null,
): DependentReach {
  const { comp, compCount } = stronglyConnected(children, n);

  const compLoc = new Float64Array(compCount);
  const compSize = new Int32Array(compCount);
  const compRed = new Float64Array(compCount);
  for (let i = 0; i < n; i++) {
    const c = comp[i]!;
    compLoc[c]! += loc(i);
    compSize[c]! += 1;
    if (red !== null) {
      compRed[c]! += red(i);
    }
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
  const depRedOfComp = new Float64Array(compCount);
  for (let c = 0; c < compCount; c++) {
    const bits = reach[c]!;
    for (let w = 0; w < words; w++) {
      let bit = bits[w]!;
      while (bit !== 0) {
        const s = (w << 5) + trailingZeros(bit);
        depLocOfComp[c]! += compLoc[s]!;
        depRedOfComp[c]! += compRed[s]!;
        bit &= bit - 1;
      }
    }
  }

  return { comp, compLoc, compSize, depLocOfComp, compRed, depRedOfComp };
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
