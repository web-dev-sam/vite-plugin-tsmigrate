import { expect, test } from "vite-plus/test";
import {
  buildAdjacency,
  type Edge,
  isolateSet,
  reachSet,
} from "../tool/src/graph/select.ts";
import type { FileFacts } from "../src/analysis/topology.ts";
import { makeGraph } from "../src/analysis/topology.ts";

// The click-to-isolate contract, stated in the user's terms:
//   - a plain click ("down") shows the node and everything BELOW it — its
//     import subtree (descendants), every one at a LOWER depth;
//   - a shift-click ("up") shows the node and everything that LEADS TO it — its
//     supertree (ancestors), every one at a HIGHER depth.
// "depth" is a node's height (leaves = 0, the entry = max).

// A branching DAG with a diamond and an unrelated island. Edges are
// importer→imported (source imports target), exactly as render.ts feeds them
// (`{ source: e.from, target: e.to }`).
//
//        E(3)
//       /    \
//     A(2)   B(2)
//       \    /
//        C(1)
//         |
//        L(0)          X(1) → Y(0)   (unrelated island)
const EDGES: Edge[] = [
  { source: "E", target: "A" },
  { source: "E", target: "B" },
  { source: "A", target: "C" },
  { source: "B", target: "C" },
  { source: "C", target: "L" },
  { source: "X", target: "Y" },
];
const IDS = ["E", "A", "B", "C", "L", "X", "Y"];
const DEPTH: Record<string, number> = { E: 3, A: 2, B: 2, C: 1, L: 0, X: 1, Y: 0 };

function sorted(s: Set<string>): string[] {
  return [...s].sort();
}

test("buildAdjacency keys imports by importer and reverses them for dependents", () => {
  const { out, inn, adj } = buildAdjacency(IDS, EDGES);
  // out = importer → imported.
  expect(sorted(out.get("E")!)).toEqual(["A", "B"]);
  expect(sorted(out.get("C")!)).toEqual(["L"]);
  expect(sorted(out.get("L")!)).toEqual([]);
  // inn = imported → importer (the diamond: C is imported by both A and B).
  expect(sorted(inn.get("C")!)).toEqual(["A", "B"]);
  expect(sorted(inn.get("E")!)).toEqual([]);
  // adj = undirected union of both.
  expect(sorted(adj.get("C")!)).toEqual(["A", "B", "L"]);
});

test("plain click isolates the node and everything BELOW it (lower depth)", () => {
  const a = buildAdjacency(IDS, EDGES);

  // Click A (depth 2): its import subtree is A, C, L — nothing else.
  const down = isolateSet("A", "down", a);
  expect(sorted(down)).toEqual(["A", "C", "L"]);
  // The node itself is included, and every OTHER node is strictly below it.
  expect(down.has("A")).toBe(true);
  for (const id of down) if (id !== "A") expect(DEPTH[id]).toBeLessThan(DEPTH.A!);
  // Crucially: NOT "all nodes at a lower depth". B is depth 2, C is depth 1,
  // Y is depth 0 — none are under A, so none appear.
  expect(down.has("B")).toBe(false); // sibling at the same depth
  expect(down.has("E")).toBe(false); // ancestor (higher depth)
  expect(down.has("X")).toBe(false); // unrelated island
  expect(down.has("Y")).toBe(false); // unrelated island, lower depth
});

test("shift-click isolates the node and everything that LEADS TO it (higher depth)", () => {
  const a = buildAdjacency(IDS, EDGES);

  // Shift-click A (depth 2): only E imports (transitively) A.
  const up = isolateSet("A", "up", a);
  expect(sorted(up)).toEqual(["A", "E"]);
  expect(up.has("A")).toBe(true);
  for (const id of up) if (id !== "A") expect(DEPTH[id]).toBeGreaterThan(DEPTH.A!);
  // Not the subtree, not siblings, not the island.
  expect(up.has("C")).toBe(false);
  expect(up.has("B")).toBe(false);
  expect(up.has("Y")).toBe(false);
});

test("isolate walks the FULL sub/supertree across a diamond", () => {
  const a = buildAdjacency(IDS, EDGES);

  // Down from E reaches the whole reachable component below it.
  expect(sorted(isolateSet("E", "down", a))).toEqual(["A", "B", "C", "E", "L"]);
  // Up from C climbs both diamond arms and on to the entry.
  expect(sorted(isolateSet("C", "up", a))).toEqual(["A", "B", "C", "E"]);
  // Down from C is just the tail below it.
  expect(sorted(isolateSet("C", "down", a))).toEqual(["C", "L"]);
});

test("click and shift-click on the same node are complementary (share only the node)", () => {
  const a = buildAdjacency(IDS, EDGES);
  const down = isolateSet("C", "down", a);
  const up = isolateSet("C", "up", a);
  const overlap = [...down].filter((id) => up.has(id));
  expect(overlap).toEqual(["C"]);
});

test("a leaf click shows only itself; a root shift-click shows only itself", () => {
  const a = buildAdjacency(IDS, EDGES);
  expect(sorted(isolateSet("L", "down", a))).toEqual(["L"]); // leaf imports nothing
  expect(sorted(isolateSet("E", "up", a))).toEqual(["E"]); // entry has no importer
});

test("reachSet is cycle-safe (a mutual import terminates)", () => {
  const cyclic = new Map<string, Set<string>>([
    ["P", new Set(["Q"])],
    ["Q", new Set(["P"])],
  ]);
  expect(sorted(reachSet("P", cyclic))).toEqual(["P", "Q"]);
});

// End-to-end: the depth contract must hold against REAL analysis output, not
// just hand-built edges. makeGraph derives heights from the same
// importer→imported edges the renderer isolates over, so this guards the whole
// pipeline (a reversed edge here would flip depths and break the assertions).
test("isolate obeys the depth contract on real makeGraph output", () => {
  // App imports Page; Page imports Widget; Widget imports Button (a leaf).
  const APP = "/r/src/App.vue";
  const PAGE = "/r/src/Page.vue";
  const WIDGET = "/r/src/Widget.vue";
  const BUTTON = "/r/src/Button.vue";
  const children = new Map<string, Set<string>>([
    [APP, new Set([PAGE])],
    [PAGE, new Set([WIDGET])],
    [WIDGET, new Set([BUTTON])],
    [BUTTON, new Set()],
  ]);
  const fact = (): FileFacts => ({
    kind: "vue",
    loc: 1,
    blame: null,
    typeErrors: 0,
    status: { loc: "ready", blame: "ready", typecheck: "ready" },
    errors: {},
  });
  const facts = new Map([APP, PAGE, WIDGET, BUTTON].map((id) => [id, fact()]));
  const graph = makeGraph(new Set([APP, PAGE, WIDGET, BUTTON]), children, facts, "/r");

  const depth = new Map(graph.nodes.map((n) => [n.id, n.height]));
  // Sanity: the entry sits at the top, the leaf at depth 0.
  expect(depth.get(APP)).toBe(3);
  expect(depth.get(PAGE)).toBe(2);
  expect(depth.get(BUTTON)).toBe(0);

  // Feed the renderer's own edge shape: source = importer (e.from).
  const a = buildAdjacency(
    graph.nodes.map((n) => n.id),
    graph.edges.map((e) => ({ source: e.from, target: e.to })),
  );

  // Click PAGE (depth 2) → shows PAGE and everything below (depths < 2).
  const down = isolateSet(PAGE, "down", a);
  expect(sorted(down)).toEqual([BUTTON, PAGE, WIDGET].sort());
  for (const id of down) if (id !== PAGE) expect(depth.get(id)!).toBeLessThan(2);

  // Shift-click PAGE (depth 2) → shows PAGE and everything that leads to it (depths > 2).
  const up = isolateSet(PAGE, "up", a);
  expect(sorted(up)).toEqual([APP, PAGE].sort());
  for (const id of up) if (id !== PAGE) expect(depth.get(id)!).toBeGreaterThan(2);
});
