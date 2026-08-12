import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { parseBlamePorcelain } from "../src/analysis/analyzers/blame.ts";
import { locAnalyzer } from "../src/analysis/analyzers/loc.ts";
import { AnalysisEngine } from "../src/analysis/engine.ts";
import { crawlGraph, findEntry } from "../src/analysis/graph.ts";
import type { AnalysisHost } from "../src/analysis/host.ts";

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

function fakeHost(): AnalysisHost {
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

test("engine produces a complete snapshot with all facts", async () => {
  const engine = new AnalysisEngine(fakeHost());
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  expect(graph.nodes).toHaveLength(3);
  const app = graph.nodes.find((node) => node.file === "src/App.vue")!;
  expect(app.name).toBe("App");
  expect(app.loc).toBe(5);
  expect(app.status).toEqual({ loc: "ready", blame: "ready" });
  expect(app.blame?.authorLines).toEqual({ Alice: 2, Bob: 1 });

  // Snapshot version is stable once everything is computed — the cheap
  // `?since=` probe contract relies on this.
  expect((await engine.getGraph()).version).toBe(graph.version);
});
