import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { type CliIo, run } from "../src/cli.ts";

// A hermetic half-migrated app: two leaves (one .js, one .ts), an untyped SFC
// and a typed one, a grandparent entry, and a mutual-import cycle behind a
// legacy module. Small enough to reason about every expected depth.
const root = fileURLToPath(new URL("./fixtures/migrating", import.meta.url));

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  };
}

/** Parse the default `<depth>\t<file>` payload into file → depth. */
function depthOf(lines: string[]): Map<string, number> {
  const depths = new Map<string, number>();
  for (const line of lines) {
    const [depth, file] = line.split("\t");
    depths.set(file!, Number(depth));
  }
  return depths;
}

// The contract the whole CLI exists for: a parent extends the contract of
// everything it imports, so it must never be listed before its children.
test("orders every module child-first", async () => {
  const { io, out } = capture();
  expect(await run(["depth", "--root", root], io)).toBe(0);

  // stdout is a data channel: no summary, no colour, nothing but the payload.
  for (const line of out) {
    expect(line).toMatch(/^\d+\t[^\s]/);
  }

  const depth = depthOf(out);
  // Leaves — they import nothing else in the project, so nothing gates them.
  expect(depth.get("src/util/format.js")).toBe(0);
  expect(depth.get("src/util/typed.ts")).toBe(0);
  // Every importer sits strictly deeper than what it imports.
  expect(depth.get("src/components/Legacy.vue")!).toBeGreaterThan(depth.get("src/util/format.js")!);
  expect(depth.get("src/components/Typed.vue")!).toBeGreaterThan(depth.get("src/util/typed.ts")!);
  expect(depth.get("src/App.vue")!).toBeGreaterThan(depth.get("src/components/Legacy.vue")!);
  expect(depth.get("src/App.vue")!).toBeGreaterThan(depth.get("src/components/Typed.vue")!);
  expect(depth.get("src/util/legacy.js")!).toBeGreaterThan(depth.get("src/util/cycle-a.js")!);
  expect(depth.get("src/main.ts")!).toBeGreaterThan(depth.get("src/App.vue")!);
  expect(depth.get("src/main.ts")!).toBeGreaterThan(depth.get("src/util/legacy.js")!);
  // The entry is last: everything else is somebody's child.
  const deepest = Math.max(...depth.values());
  expect([...depth].filter(([, d]) => d === deepest)).toEqual([["src/main.ts", deepest]]);
  // Layers are printed in ascending depth — the work order, top to bottom.
  expect(out.map((line) => Number(line.split("\t")[0]))).toEqual(
    out.map((line) => Number(line.split("\t")[0])).sort((a, b) => a - b),
  );
});

test("a bare depth prints only that layer's paths", async () => {
  const { io, out } = capture();
  expect(await run(["depth", "0", "-r", root], io)).toBe(0);
  expect(out).toEqual(["src/util/format.js", "src/util/typed.ts"]);
});

// The point of the filter: a todo list of already-typed files is noise. An SFC
// counts as untyped when its <script> has no lang="ts", even next to typed ones.
test("--untyped keeps only files that still need typing", async () => {
  const { io, out } = capture();
  expect(await run(["depth", "--untyped", "-r", root], io)).toBe(0);
  expect([...depthOf(out).keys()].sort()).toEqual([
    "src/components/Legacy.vue",
    "src/util/cycle-a.js",
    "src/util/cycle-b.js",
    "src/util/format.js",
    "src/util/legacy.js",
  ]);
  // Depths stay the graph's own numbering — a filtered list is still in order.
  expect(depthOf(out).get("src/util/format.js")).toBe(0);
});

// Depth is only a work order on a DAG. Inside a cycle the number is a DFS
// artifact, so the CLI has to say so instead of quietly implying an order.
test("warns that a cycle has no child-first order", async () => {
  const { io, err } = capture();
  await run(["depth", "-r", root], io);
  const warning = err.join("\n");
  expect(warning).toContain("1 import cycle");
  expect(warning).toContain("src/util/cycle-a.js + src/util/cycle-b.js");
});

test("the vue graph carries components only, barrel hops collapsed", async () => {
  const { io, out } = capture();
  expect(await run(["depth", "--graph", "vue", "-r", root], io)).toBe(0);
  expect(out).toEqual([
    "0\tsrc/components/Legacy.vue",
    "0\tsrc/components/Typed.vue",
    "1\tsrc/App.vue",
  ]);
});

test("--json carries the layers and the cycles", async () => {
  const { io, out } = capture();
  expect(await run(["depth", "--json", "-r", root], io)).toBe(0);
  const report = JSON.parse(out.join("\n")) as {
    root: string;
    graph: string;
    maxDepth: number;
    files: number;
    layers: Array<{ depth: number; files: string[] }>;
    cycles: string[][];
  };
  expect(report.root).toBe(root);
  expect(report.graph).toBe("full");
  expect(report.files).toBe(9);
  expect(report.layers[0]).toEqual({
    depth: 0,
    files: ["src/util/format.js", "src/util/typed.ts"],
  });
  expect(report.layers.map((layer) => layer.depth)).toEqual([0, 1, 2, 3, 4]);
  expect(report.maxDepth).toBe(4);
  expect(report.cycles).toEqual([["src/util/cycle-a.js", "src/util/cycle-b.js"]]);
});

test("usage problems exit 2 and keep stdout empty", async () => {
  const bad = capture();
  expect(await run(["depth", "--nope", "-r", root], bad.io)).toBe(2);
  expect(bad.out).toEqual([]);
  expect(bad.err[0]).toContain('unknown option "--nope"');

  const noCommand = capture();
  expect(await run([], noCommand.io)).toBe(2);
  expect(noCommand.err[0]).toContain("no command given");

  const fractional = capture();
  expect(await run(["depth", "1.5"], fractional.io)).toBe(2);
  expect(fractional.err[0]).toContain("non-negative integer");

  const help = capture();
  expect(await run(["--help"], help.io)).toBe(0);
  expect(help.out[0]).toContain("Usage: tsmigrate depth");
  expect(help.err).toEqual([]);
});

// A wrong --root is the likely first mistake; it must say so, not print zero
// files and exit 0 as if the app were fully typed.
test("an app with no discoverable entry fails loudly", async () => {
  const { io, out, err } = capture();
  expect(await run(["depth", "-r", fileURLToPath(new URL(".", import.meta.url))], io)).toBe(1);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("no entry module");
});
