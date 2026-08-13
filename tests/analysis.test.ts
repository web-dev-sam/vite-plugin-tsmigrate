import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { parseBlamePorcelain } from "../src/analysis/analyzers/blame.ts";
import { locAnalyzer } from "../src/analysis/analyzers/loc.ts";
import { AnalysisEngine } from "../src/analysis/engine.ts";
import { crawlGraph, findEntry } from "../src/analysis/graph.ts";
import type { AnalysisHost } from "../src/analysis/host.ts";
import { computeHeights, type FileFacts, groupOf, makeGraph } from "../src/analysis/topology.ts";
import { parseTscErrors } from "../src/analysis/typecheck.ts";

const ROOT = "/app";

// The playground-shaped fixture: an entry chain, a direct component import,
// and a component imported through a barrel (must collapse to a direct edge).
const FILES: Record<string, string> = {
  "/app/index.html": '<script type="module" src="/src/main.ts"></script>',
  "/app/src/main.ts": 'import { createApp } from "vue";\nimport App from "./App.vue";\n',
  "/app/src/App.vue":
    '<script setup lang="ts">\nimport Child from "./components/Child.vue";\nimport { helper } from "./shared";\n</script>\n<template><Child /></template>\n',
  "/app/src/shared/index.ts":
    'export { default as Deep } from "../components/Deep.vue";\nexport const helper = 1;\n',
  "/app/src/components/Child.vue":
    '<script setup lang="ts">\nconst x = 1;\n</script>\n<template><p>{{ x }}</p></template>\n',
  "/app/src/components/Deep.vue": "<template><p>deep</p></template>\n",
};

const BLAME_FIXTURE = [
  "sha1 1 1 2",
  "author Alice",
  "author-mail <alice@x>",
  "\tline one",
  "sha1 2 2",
  "author Alice",
  "\tline two",
  "sha2 3 3 1",
  "author Bob",
  "\tline three",
].join("\n");

function fakeHost(exec?: AnalysisHost["exec"]): AnalysisHost {
  return {
    root: ROOT,
    async resolve(spec, importer) {
      const base = spec.startsWith(".")
        ? join(dirname(importer), spec)
        : spec.startsWith("/")
          ? join(ROOT, spec)
          : null;
      if (!base) {
        return null; // bare specifier (npm package) — external
      }
      for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
        if (candidate in FILES) {
          return candidate;
        }
      }
      return null;
    },
    async readFile(path) {
      return FILES[path] ?? null;
    },
    async runGit(args) {
      if (args[0] === "rev-parse") {
        return "abc123\n";
      }
      return BLAME_FIXTURE;
    },
    exec: exec ?? (async () => ({ stdout: "", stderr: "", code: 0 })),
  };
}

test("finds the entry from index.html", async () => {
  expect(await findEntry(fakeHost())).toBe("/app/src/main.ts");
});

test("crawls components and collapses barrels into direct edges", async () => {
  const { nodes, edges } = await crawlGraph(fakeHost(), "/app/src/main.ts");
  expect(nodes).toEqual([
    "/app/src/App.vue",
    "/app/src/components/Child.vue",
    "/app/src/components/Deep.vue",
  ]);
  expect(edges).toContainEqual({
    from: "/app/src/App.vue",
    to: "/app/src/components/Child.vue",
  });
  // App → shared/index.ts → Deep.vue collapses to App → Deep.
  expect(edges).toContainEqual({
    from: "/app/src/App.vue",
    to: "/app/src/components/Deep.vue",
  });
  expect(edges).toHaveLength(2);
});

test("counts lines of code", async () => {
  const loc = await locAnalyzer.analyze({
    host: fakeHost(),
    file: "/app/src/main.ts",
  });
  expect(loc).toBe(2);
});

test("parses blame porcelain into lines per author", () => {
  expect(parseBlamePorcelain(BLAME_FIXTURE).authorLines).toEqual({
    Alice: 2,
    Bob: 1,
  });
});

test("engine produces a complete two-graph snapshot with all facts", async () => {
  // typeCheckCommand defaults to disabled — deterministic, no runner needed.
  const engine = new AnalysisEngine(fakeHost());
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();

  // vue graph: `.vue` nodes only, with barrel-collapsed edges.
  expect(graph.vue.nodes).toHaveLength(3);
  const app = graph.vue.nodes.find((node) => node.file === "src/App.vue")!;
  expect(app.name).toBe("App");
  expect(app.kind).toBe("vue");
  expect(app.loc).toBe(5);
  expect(app.status).toEqual({ loc: "ready", blame: "ready", typecheck: "ready" });
  expect(app.blame?.authorLines).toEqual({ Alice: 2, Bob: 1 });
  // Disabled type-check: typed everywhere, no red.
  expect(app.typeErrors).toBeNull();
  expect(app.strictRed).toBe(false);

  const child = graph.vue.nodes.find((node) => node.file === "src/components/Child.vue")!;
  const deep = graph.vue.nodes.find((node) => node.file === "src/components/Deep.vue")!;
  // App → Child direct; App → shared/index.ts → Deep collapses to App → Deep.
  expect(graph.vue.edges).toContainEqual({ from: app.id, to: child.id });
  expect(graph.vue.edges).toContainEqual({ from: app.id, to: deep.id });
  // Heights are relative to the induced set: App sits one hop above its leaves.
  expect(app.height).toBe(1);
  expect(child.height).toBe(0);
  expect(graph.vue.maxHeight).toBe(1);

  // full graph: reachable `.vue` + `.ts`, raw (uncollapsed) edges.
  const fullFiles = graph.full.nodes.map((node) => node.file);
  expect(fullFiles).toContain("src/main.ts");
  expect(fullFiles).toContain("src/shared/index.ts");
  expect(fullFiles).toContain("src/App.vue");
  expect(graph.full.nodes.length).toBeGreaterThan(graph.vue.nodes.length);
  const mainNode = graph.full.nodes.find((node) => node.file === "src/main.ts")!;
  const appFull = graph.full.nodes.find((node) => node.file === "src/App.vue")!;
  const shared = graph.full.nodes.find((node) => node.file === "src/shared/index.ts")!;
  const deepFull = graph.full.nodes.find((node) => node.file === "src/components/Deep.vue")!;
  expect(mainNode.kind).toBe("ts");
  // Raw edges: no collapsing — App → shared → Deep are distinct hops.
  expect(graph.full.edges).toContainEqual({ from: mainNode.id, to: appFull.id });
  expect(graph.full.edges).toContainEqual({ from: appFull.id, to: shared.id });
  expect(graph.full.edges).toContainEqual({ from: shared.id, to: deepFull.id });

  // Snapshot version is stable once everything is computed — the cheap
  // `?since=` probe contract relies on this.
  expect((await engine.getGraph()).version).toBe(graph.version);
});

test("parseTscErrors counts per-file errors keyed to absolute ids", () => {
  const output = [
    "src/App.vue(1,1): error TS1000: bad",
    "src/App.vue(2,3): error TS1001: worse",
    "src/lib/util.ts(4,5): error TS2000: nope",
    "not a diagnostic line",
    "/abs/Other.ts(1,1): error TS3000: absolute path stays put",
  ].join("\n");
  const counts = parseTscErrors(output, "/root");
  expect(counts.get("/root/src/App.vue")).toBe(2);
  expect(counts.get("/root/src/lib/util.ts")).toBe(1);
  expect(counts.get("/abs/Other.ts")).toBe(1);
  expect(counts.size).toBe(3);
});

test("topology computes heights, strict-red propagation, and groups", () => {
  // Clean chain a → b → c: heights are the longest path down to a leaf.
  const A = "/r/src/a.ts";
  const B = "/r/src/b.ts";
  const C = "/r/src/c.ts";
  const children = new Map<string, Set<string>>([
    [A, new Set([B])],
    [B, new Set([C])],
    [C, new Set()],
  ]);
  const ids = [A, B, C];

  const heights = computeHeights(ids, children);
  expect(heights.get(A)).toBe(2);
  expect(heights.get(B)).toBe(1);
  expect(heights.get(C)).toBe(0);

  // Cycle-safe: a mutual import terminates (back-edge contributes 0) instead
  // of looping forever, and every node still gets a finite height.
  const X = "/r/x.ts";
  const Y = "/r/y.ts";
  const cyclic = computeHeights(
    [X, Y],
    new Map<string, Set<string>>([
      [X, new Set([Y])],
      [Y, new Set([X])],
    ]),
  );
  expect(cyclic.get(X)).toBe(2);
  expect(cyclic.get(Y)).toBe(1);

  expect(groupOf("/r/src/components/X.vue", "/r")).toBe("components");
  expect(groupOf("/r/src/a.ts", "/r")).toBe("(root)");

  // strictRed seeds on C's own errors and propagates UP through importers.
  const fact = (typeErrors: number | null): FileFacts => ({
    kind: "ts",
    loc: 1,
    blame: null,
    typeErrors,
    status: { loc: "ready", blame: "ready", typecheck: "ready" },
    errors: {},
  });
  const facts = new Map<string, FileFacts>([
    [A, fact(0)],
    [B, fact(0)],
    [C, fact(2)],
  ]);
  const graph = makeGraph(new Set(ids), children, facts, "/r");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  expect(byId.get(C)?.strictRed).toBe(true);
  expect(byId.get(B)?.strictRed).toBe(true);
  expect(byId.get(A)?.strictRed).toBe(true);
  expect(graph.maxHeight).toBe(2);
  expect(graph.edges).toContainEqual({ from: A, to: B });
});

test("engine flows type errors into typeErrors and strictRed", async () => {
  // Canned `--pretty false` diagnostics for one component; a checker exits
  // nonzero when it has errors, which is normal (not a failure).
  const diagnostics = "src/components/Child.vue(2,7): error TS2322: boom\n";
  const engine = new AnalysisEngine(
    fakeHost(async () => ({ stdout: diagnostics, stderr: "", code: 1 })),
    ["tsc", "--noEmit", "--pretty", "false"],
  );
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  const app = graph.vue.nodes.find((node) => node.file === "src/App.vue")!;
  const child = graph.vue.nodes.find((node) => node.file === "src/components/Child.vue")!;
  const deep = graph.vue.nodes.find((node) => node.file === "src/components/Deep.vue")!;

  // The file with the diagnostic owns the error.
  expect(child.typeErrors).toBe(1);
  expect(child.status.typecheck).toBe("ready");
  expect(child.strictRed).toBe(true);
  // strictRed propagates UP to the importer (App imports Child).
  expect(app.typeErrors).toBe(0);
  expect(app.strictRed).toBe(true);
  // Untouched leaf stays green.
  expect(deep.typeErrors).toBe(0);
  expect(deep.strictRed).toBe(false);

  // Typed (green) count over the vue graph: only Child has own errors.
  const withErrors = graph.vue.nodes.filter((node) => (node.typeErrors ?? 0) > 0);
  const red = graph.vue.nodes.filter((node) => node.strictRed);
  expect(withErrors).toHaveLength(1);
  expect(red).toHaveLength(2); // Child + App
});

test("engine treats type-check failure as an error status", async () => {
  // No parseable diagnostics + nonzero exit → the pass failed.
  const engine = new AnalysisEngine(
    fakeHost(async () => ({ stdout: "", stderr: "command not found: tsc", code: 127 })),
    ["tsc", "--noEmit", "--pretty", "false"],
  );
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  const app = graph.vue.nodes.find((node) => node.file === "src/App.vue")!;
  expect(app.status.typecheck).toBe("error");
  expect(app.typeErrors).toBeNull();
  expect(app.strictRed).toBe(false);
  expect(app.errors.typecheck).toContain("command not found");
});

test("typeCheckCommand:false disables the pass without blocking complete", async () => {
  const engine = new AnalysisEngine(fakeHost(), false);
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  expect(graph.vue.nodes.length).toBeGreaterThan(0);
  for (const node of [...graph.vue.nodes, ...graph.full.nodes]) {
    expect(node.typeErrors).toBeNull();
    expect(node.status.typecheck).toBe("ready");
    expect(node.strictRed).toBe(false);
  }
});
