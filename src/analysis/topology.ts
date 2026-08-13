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
  blame: BlameSummary | null;
  typeErrors: number | null;
  status: ComponentNode["status"];
  errors: ComponentNode["errors"];
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
 * Top-level folder used for angular clustering. Relative to `root`, dropping a
 * conventional `src/` source dir, the first path segment is the group; files
 * that sit directly in the source dir fall back to `(root)`.
 */
export function groupOf(id: string, root: string): string {
  const rest = relative(root, id)
    .split(sep)
    .join("/")
    .replace(/^src\//, "");
  const slash = rest.indexOf("/");
  return slash === -1 ? "(root)" : rest.slice(0, slash);
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
  childrenAll: Map<string, Set<string>>,
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
  for (const id of ids) {
    for (const kid of childrenAll.get(id) ?? []) {
      if (!idSet.has(kid)) {
        continue;
      }
      children.get(id)?.add(kid);
      parents.get(kid)?.add(id);
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
      height: heights.get(id) ?? 0,
      strictRed: strictRed.has(id),
      typeErrors: fact.typeErrors,
      blame: fact.blame,
      status: fact.status,
      errors: fact.errors,
    };
  });

  const edges: ComponentEdge[] = [];
  for (const [from, kids] of children) {
    for (const to of kids) {
      edges.push({ from, to });
    }
  }

  const maxHeight = nodes.reduce((max, node) => Math.max(max, node.height), 0);
  return { nodes, edges, maxHeight };
}
