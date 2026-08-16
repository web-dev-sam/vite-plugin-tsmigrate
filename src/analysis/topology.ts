import { basename, extname, relative, sep } from "node:path";
import type { BlameSummary, ComponentEdge, ComponentNode, Graph } from "../shared/types.ts";

/**
 * Pure graph topology: heights, strict-red propagation, grouping, and the
 * induced-subgraph assembler. Mirrors the prototype's `generate.ts` so the
 * `vue` and `full` graphs are each self-consistent. No IO, no `vite`.
 */

/**
 * File-level facts injected per node id. Identical wherever a file appears;
 * the per-graph fields (`height`, `strictRed`, `group`) are derived by
 * `makeGraph` relative to the induced set it is building.
 */
export interface FileFacts {
  kind: "vue" | "ts";
  loc: number | null;
  cc: number | null;
  blame: BlameSummary | null;
  typeErrors: number | null;
  status: ComponentNode["status"];
  errors: ComponentNode["errors"];
}

/** Wire caps for merged edge provenance (mirror `dependencies.ts`). */
const EDGE_SYMBOL_CAP = 24;
const EDGE_VIA_CAP = 4;

/** Union `extra` into `base` preserving order, deduped, capped at `cap`. */
function unionCapped(base: string[] | undefined, extra: readonly string[], cap: number): string[] {
  const out = base ?? [];
  for (const s of extra) {
    if (out.length >= cap) {
      break;
    }
    if (!out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/**
 * Longest import path from each node down to a leaf, memoized and cycle-safe.
 * Leaves → 0; a back-edge (mutual import) contributes 0 so cycles terminate.
 */
export function computeHeights(
  ids: string[],
  children: Map<string, Set<string>>,
): Map<string, number> {
  const height = new Map<string, number>();
  // 0 unvisited, 1 on-stack, 2 done.
  const state = new Map<string, 0 | 1 | 2>();

  const visit = (id: string): number => {
    if (state.get(id) === 2) {
      return height.get(id) ?? 0;
    }
    if (state.get(id) === 1) {
      return 0; // back-edge: ignore
    }
    state.set(id, 1);
    let h = 0;
    for (const child of children.get(id) ?? []) {
      h = Math.max(h, 1 + visit(child));
    }
    state.set(id, 2);
    height.set(id, h);
    return h;
  };

  for (const id of ids) {
    visit(id);
  }
  return height;
}

/**
 * Mutual-import cycles: the members of every non-trivial SCC of `children`,
 * each component sorted, the list ordered by its first member.
 *
 * Depth is only a valid work order on a DAG. Inside a cycle no child-first
 * sequence exists, and `computeHeights` breaks the tie by traversal order — so
 * a consumer that orders work by depth must treat each cycle as ONE unit: the
 * members carry each other's contracts and have to move together (or an edge
 * has to be cut first).
 */
export function findCycles(ids: string[], children: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));
  const adjacency = ids.map((id) => {
    const out: number[] = [];
    for (const child of children.get(id) ?? []) {
      const at = index.get(child);
      if (at !== undefined) {
        out.push(at);
      }
    }
    return out;
  });

  const { comp, compCount } = stronglyConnected(adjacency, ids.length);
  const members: string[][] = Array.from({ length: compCount }, () => []);
  ids.forEach((id, i) => members[comp[i]!]!.push(id));
  return members
    .filter((component) => component.length > 1)
    .map((component) => [...component].sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/**
 * Group used for angular clustering, checked in order:
 *  1. Monorepo: a `<workspace-package>/src/…` path groups by the package dir
 *     (e.g. vben's `packages/effects/access/src/…` → `access`).
 *  2. Plain / framework layouts: drop a conventional frontend source root
 *     (`src/`, GitLab's `app/assets/javascripts/`, …) and take the first
 *     feature segment; files sitting directly in the source root → `(root)`.
 */
const SOURCE_ROOTS = ["app/assets/javascripts/", "resources/js/", "assets/javascripts/"];

export function groupOf(id: string, root: string): string {
  const rest = relative(root, id).split(sep).join("/");
  // Monorepo package: the dir immediately before a nested `/src/`.
  const srcAt = rest.indexOf("/src/");
  if (srcAt > 0) {
    const pkg = rest.slice(0, srcAt);
    return pkg.slice(pkg.lastIndexOf("/") + 1);
  }
  // Plain / framework layouts: strip a conventional source root, first segment.
  let feature = rest;
  for (const marker of SOURCE_ROOTS) {
    const at = feature.indexOf(marker);
    if (at !== -1) {
      feature = feature.slice(at + marker.length);
      break;
    }
  }
  feature = feature.replace(/^src\//, "");
  const slash = feature.indexOf("/");
  return slash === -1 ? "(root)" : feature.slice(0, slash);
}

/**
 * Build a `Graph` over `idSet`, keeping only edges whose BOTH endpoints are in
 * the set (an induced subgraph). Heights and strict-red are computed relative
 * to that set, so the vue-only and vue+ts graphs each describe a self-
 * consistent tree. Nodes are assembled from injected `facts` plus the derived
 * topology fields.
 */
export function makeGraph(
  idSet: Set<string>,
  edges: ComponentEdge[],
  facts: Map<string, FileFacts>,
  root: string,
): Graph {
  const ids = [...idSet];
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  for (const id of ids) {
    children.set(id, new Set());
    parents.set(id, new Set());
  }
  // Induced edges: keep only those with both endpoints in the set, deduped by
  // (from,to). Flags stay only when every occurrence carries them — a single
  // value occurrence clears `type`, a single synchronous one clears `lazy` —
  // and provenance (`symbols`/`via`) unions across occurrences (capped).
  const induced: ComponentEdge[] = [];
  const indexOf = new Map<string, number>();
  for (const e of edges) {
    if (e.from === e.to || !idSet.has(e.from) || !idSet.has(e.to)) {
      continue;
    }
    children.get(e.from)!.add(e.to);
    parents.get(e.to)!.add(e.from);
    const key = `${e.from}\n${e.to}`;
    const at = indexOf.get(key);
    if (at === undefined) {
      indexOf.set(key, induced.length);
      const copy: ComponentEdge = { from: e.from, to: e.to };
      if (e.type) {
        copy.type = true;
      }
      if (e.lazy) {
        copy.lazy = true;
      }
      if (e.symbols?.length) {
        copy.symbols = [...e.symbols];
      }
      if (e.via?.length) {
        copy.via = [...e.via];
      }
      induced.push(copy);
    } else {
      const merged = induced[at];
      if (!e.type && merged.type) {
        delete merged.type;
      }
      if (!e.lazy && merged.lazy) {
        delete merged.lazy;
      }
      if (e.symbols?.length) {
        merged.symbols = unionCapped(merged.symbols, e.symbols, EDGE_SYMBOL_CAP);
      }
      if (e.via?.length) {
        merged.via = unionCapped(merged.via, e.via, EDGE_VIA_CAP);
      }
    }
  }

  const heights = computeHeights(ids, children);

  // strictRed: red iff self OR anything it (transitively) imports is red. Seed
  // from files with own errors, then propagate UP through parents (importers).
  const strictRed = new Set<string>();
  const stack = ids.filter((id) => (facts.get(id)?.typeErrors ?? 0) > 0);
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === undefined || strictRed.has(v)) {
      continue;
    }
    strictRed.add(v);
    for (const parent of parents.get(v) ?? []) {
      if (!strictRed.has(parent)) {
        stack.push(parent);
      }
    }
  }

  const nodes: ComponentNode[] = ids.map((id) => {
    const fact = facts.get(id);
    if (!fact) {
      throw new Error(`missing facts for node: ${id}`);
    }
    return {
      id,
      file: relative(root, id),
      name: basename(id, extname(id)),
      group: groupOf(id, root),
      kind: fact.kind,
      loc: fact.loc,
      cc: fact.cc,
      height: heights.get(id) ?? 0,
      strictRed: strictRed.has(id),
      typeErrors: fact.typeErrors,
      blame: fact.blame,
      status: fact.status,
      errors: fact.errors,
    };
  });

  const maxHeight = nodes.reduce((max, node) => Math.max(max, node.height), 0);
  return { nodes, edges: induced, maxHeight };
}

/**
 * Iterative Tarjan SCC. Returns each node's component id and the component
 * count; ids are assigned in reverse-topological order of the condensation
 * (not relied upon by callers). Iterative to survive deep import chains.
 */
export function stronglyConnected(
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
