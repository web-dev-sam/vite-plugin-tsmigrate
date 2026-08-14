/**
 * Pure graph-selection logic for the click-to-isolate interaction, lifted out
 * of the d3 renderer so the direction contract can be unit-tested without a
 * DOM.
 *
 * Direction contract (the whole pipeline agrees on this):
 *   - Edges are importer→imported: `{ source, target }` means `source` imports
 *     `target`.
 *   - A node's depth is its `height`: the longest import path down to a leaf.
 *     Leaves import nothing → depth 0; the entry sits at the max depth. So the
 *     things a node imports have a STRICTLY LOWER depth, and the things that
 *     import it a STRICTLY HIGHER depth.
 *
 * Therefore, isolating around a clicked node:
 *   - `"down"` (plain click) → the import SUBTREE: the node plus everything it
 *     transitively imports — its descendants, every one at a LOWER depth. This
 *     is the "show what's below this node" selection.
 *   - `"up"` (shift-click) → the SUPERTREE: the node plus everything that
 *     transitively imports it — its ancestors, every one at a HIGHER depth.
 *     This is the "show what leads to this node" selection.
 *
 * Only nodes reachable from the clicked node are ever included: an unrelated
 * node at a lower depth is NOT part of a plain click's subtree.
 */

/** Walk direction: `"down"` = imports (subtree), `"up"` = importers (supertree). */
export type FocusDir = "down" | "up";

/** A directed import edge: `source` imports `target`. */
export interface Edge {
  source: string;
  target: string;
}

/** Adjacency maps keyed by node id, all three derived from the same edges. */
export interface Adjacency {
  /** importer → imported. Walk this for a node's import subtree (descendants). */
  out: Map<string, Set<string>>;
  /** imported → importer. Walk this for a node's supertree (dependents). */
  inn: Map<string, Set<string>>;
  /** Undirected neighbours, for the hover highlight. */
  adj: Map<string, Set<string>>;
}

/** Build the three adjacency maps for `ids` from the directed `edges`. */
export function buildAdjacency(ids: Iterable<string>, edges: Iterable<Edge>): Adjacency {
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const adj = new Map<string, Set<string>>();
  for (const id of ids) {
    out.set(id, new Set());
    inn.set(id, new Set());
    adj.set(id, new Set());
  }
  for (const { source, target } of edges) {
    out.get(source)?.add(target);
    inn.get(target)?.add(source);
    adj.get(source)?.add(target);
    adj.get(target)?.add(source);
  }
  return { out, inn, adj };
}

/**
 * Every id reachable from `start` along the directed `edges` map, `start`
 * included. Cycle-safe: each id is visited at most once.
 */
export function reachSet(start: string, edges: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of edges.get(id) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
  }
  return seen;
}

/**
 * The isolate set for clicking `id` in direction `dir`. `"down"` walks imports
 * (the subtree, lower depth); `"up"` walks importers (the supertree, higher
 * depth). Always includes `id` itself.
 */
export function isolateSet(id: string, dir: FocusDir, a: Adjacency): Set<string> {
  return reachSet(id, dir === "up" ? a.inn : a.out);
}
