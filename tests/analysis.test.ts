import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { applyBlameAliases, parseBlamePorcelain } from "../src/analysis/analyzers/blame.ts";
import { locAnalyzer } from "../src/analysis/analyzers/loc.ts";
import { complexityAnalyzer } from "../src/analysis/analyzers/complexity.ts";
import { AnalysisEngine } from "../src/analysis/engine.ts";
import { crawlGraph, findEntries } from "../src/analysis/graph.ts";
import type { AnalysisHost } from "../src/analysis/host.ts";
import { scoreMaintainability } from "../src/analysis/maintainability.ts";
import { computeHeights, type FileFacts, groupOf, makeGraph } from "../src/analysis/topology.ts";
import type { Graph, Maintainability } from "../src/shared/types.ts";
import { parseTscErrors } from "../src/analysis/typecheck.ts";
import { cyclomaticComplexity, parseModule } from "../src/analysis/imports.ts";

const ROOT = "/app";

// The playground-shaped fixture: an entry chain, a direct component import,
// and a component imported through a barrel (must collapse to a direct edge).
const FILES: Record<string, string> = {
  "/app/index.html": '<script type="module" src="/src/main.ts"></script>',
  "/app/src/main.ts": 'import { createApp } from "vue";\nimport App from "./App.vue";\n',
  "/app/src/App.vue":
    '<script setup lang="ts">\nimport Child from "./components/Child.vue";\nimport { Deep } from "./shared";\n</script>\n<template><Child /><Deep /></template>\n',
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

function fakeHost(
  exec?: AnalysisHost["exec"],
  files: Record<string, string> = FILES,
): AnalysisHost {
  return {
    root: ROOT,
    configuredEntries: () => [],
    glob: async () => [],
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
        if (candidate in files) {
          return candidate;
        }
      }
      return null;
    },
    async readFile(path) {
      return files[path] ?? null;
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
  expect(await findEntries(fakeHost())).toEqual(["/app/src/main.ts"]);
});

test("crawls components and collapses barrels into direct edges", async () => {
  const { nodes, componentEdges: edges } = await crawlGraph(fakeHost(), ["/app/src/main.ts"]);
  expect(nodes).toEqual([
    "/app/src/App.vue",
    "/app/src/components/Child.vue",
    "/app/src/components/Deep.vue",
  ]);
  expect(edges).toContainEqual({
    from: "/app/src/App.vue",
    to: "/app/src/components/Child.vue",
  });
  // App imports the Deep component re-exported by the barrel → collapses to App → Deep.
  expect(edges).toContainEqual({
    from: "/app/src/App.vue",
    to: "/app/src/components/Deep.vue",
  });
  expect(edges).toHaveLength(2);
});

test("type-only imports produce dashed (type) edges; value/mixed do not", async () => {
  const files: Record<string, string> = {
    "/app/src/main.ts": 'import App from "./App.vue";\n',
    "/app/src/App.vue":
      '<script setup lang="ts">\n' +
      'import Val from "./Val.vue";\n' + // value → solid
      'import type { P } from "./Typ.vue";\n' + // type-only → dashed
      'import Mix, { type Only } from "./Mix.vue";\n' + // mixed (Mix is a value) → solid
      "</script>\n<template><Val /></template>\n",
    "/app/src/Val.vue": "<template><p>v</p></template>\n",
    "/app/src/Typ.vue": "<template><p>t</p></template>\n",
    "/app/src/Mix.vue": "<template><p>m</p></template>\n",
  };
  const { componentEdges, moduleEdges } = await crawlGraph(fakeHost(undefined, files), [
    "/app/src/main.ts",
  ]);

  // Only the `import type` edge carries `type: true` (rendered dashed).
  expect(componentEdges).toContainEqual({
    from: "/app/src/App.vue",
    to: "/app/src/Typ.vue",
    type: true,
  });
  expect(componentEdges).toContainEqual({ from: "/app/src/App.vue", to: "/app/src/Val.vue" });
  expect(componentEdges).toContainEqual({ from: "/app/src/App.vue", to: "/app/src/Mix.vue" });
  // The type edge is not a plain value edge — the flag must be present.
  expect(componentEdges).not.toContainEqual({ from: "/app/src/App.vue", to: "/app/src/Typ.vue" });

  // Same classification in the symbol-resolved full-module graph, which also
  // carries the crossing symbol names as provenance.
  expect(moduleEdges).toContainEqual({
    from: "/app/src/App.vue",
    to: "/app/src/Typ.vue",
    type: true,
    symbols: ["P"],
  });
  expect(moduleEdges).toContainEqual({
    from: "/app/src/main.ts",
    to: "/app/src/App.vue",
    symbols: ["App"],
  });
});

// Vue 2 support: options-API SFCs use a plain `<script>` (no `setup`) and a
// `.js` entry. The regex crawl is version-agnostic — it must still extract
// imports and build component edges.
test("crawls Vue 2 options-API SFCs and a .js entry", async () => {
  const V2: Record<string, string> = {
    "/v2/index.html": '<script type="module" src="/src/main.js"></script>',
    "/v2/src/main.js": 'import App from "./App.vue";\n',
    "/v2/src/App.vue":
      '<script>\nimport Widget from "./components/Widget.vue";\nexport default { components: { Widget } };\n</script>\n<template><Widget /></template>\n',
    "/v2/src/components/Widget.vue":
      '<script>\nexport default { name: "Widget" };\n</script>\n<template><div /></template>\n',
  };
  const host: AnalysisHost = {
    root: "/v2",
    configuredEntries: () => [],
    glob: async () => [],
    async resolve(spec, importer) {
      const base = spec.startsWith(".")
        ? join(dirname(importer), spec)
        : spec.startsWith("/")
          ? join("/v2", spec)
          : null;
      if (!base) {
        return null;
      }
      for (const candidate of [base, `${base}.js`, `${base}.vue`, join(base, "index.js")]) {
        if (candidate in V2) {
          return candidate;
        }
      }
      return null;
    },
    async readFile(path) {
      return V2[path] ?? null;
    },
    async runGit() {
      return "";
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  const entries = await findEntries(host);
  expect(entries).toEqual(["/v2/src/main.js"]);
  const { nodes, componentEdges: edges } = await crawlGraph(host, entries);
  expect(nodes).toContain("/v2/src/App.vue");
  expect(nodes).toContain("/v2/src/components/Widget.vue");
  expect(edges).toContainEqual({
    from: "/v2/src/App.vue",
    to: "/v2/src/components/Widget.vue",
  });
});

// Laravel/Vue (and any app served via a Blade/framework template with
// `@vite('resources/js/app.ts')`) has NO root index.html. The entry lives in
// the build config's `input`, surfaced by the host as `configuredEntries()`.
// Regression: findEntries must crawl from those roots, or the graph is empty
// despite a full project. See the empty-graph bug on real Laravel apps.
test("crawls from configured build entries when there is no index.html", async () => {
  const LARAVEL: Record<string, string> = {
    "/laravel/resources/js/app.ts": 'import App from "./App.vue";\n',
    "/laravel/resources/js/App.vue":
      '<script setup lang="ts">\nimport Child from "./components/Child.vue";\n</script>\n<template><Child /></template>\n',
    "/laravel/resources/js/components/Child.vue": "<template><p>child</p></template>\n",
  };
  const host: AnalysisHost = {
    root: "/laravel",
    // No index.html; laravel-vite-plugin declares the JS entry as input. CSS
    // entries are also configured and must be ignored by the crawl.
    configuredEntries: () => ["/laravel/resources/css/app.css", "/laravel/resources/js/app.ts"],
    glob: async () => [],
    async resolve(spec, importer) {
      const base = spec.startsWith(".") ? join(dirname(importer), spec) : null;
      if (!base) {
        return null;
      }
      for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, "index.ts")]) {
        if (candidate in LARAVEL) {
          return candidate;
        }
      }
      return null;
    },
    async readFile(path) {
      return LARAVEL[path] ?? null;
    },
    async runGit() {
      return "";
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  // No index.html anywhere — the entry comes purely from configuredEntries,
  // and the .css entry is dropped (not a script/SFC).
  const entries = await findEntries(host);
  expect(entries).toEqual(["/laravel/resources/js/app.ts"]);

  const { nodes, files } = await crawlGraph(host, entries);
  expect(nodes).toContain("/laravel/resources/js/App.vue");
  expect(nodes).toContain("/laravel/resources/js/components/Child.vue");
  // The full module view includes the .ts entry too.
  expect(files.map((f) => f.id)).toContain("/laravel/resources/js/app.ts");
});

// Large apps register lazy routes/components by glob or by computed dynamic
// import — the specifier is never a single literal path. Regression: the crawl
// must expand `import.meta.glob(...)` and ``import(`./x/${v}.vue`)`` (via
// host.glob) into real nodes, or such apps show an almost-empty graph.
test("expands import.meta.glob and computed dynamic imports into nodes", async () => {
  const GROOT = "/g";
  const GFILES: Record<string, string> = {
    "/g/src/main.ts": 'import "./router";\n',
    "/g/src/router.ts":
      'const pages = import.meta.glob("./views/*.vue");\n' +
      "export const load = (n: string) => import(`./widgets/${n}.vue`);\n",
    "/g/src/views/Home.vue": "<template><p>home</p></template>\n",
    "/g/src/views/About.vue": "<template><p>about</p></template>\n",
    "/g/src/widgets/Chart.vue": "<template><p>chart</p></template>\n",
    "/g/src/widgets/Table.vue": "<template><p>table</p></template>\n",
  };
  const host: AnalysisHost = {
    root: GROOT,
    configuredEntries: () => [],
    async resolve(spec, importer) {
      if (!spec.startsWith(".")) {
        return null;
      }
      const base = join(dirname(importer), spec);
      for (const candidate of [base, `${base}.ts`, `${base}.vue`]) {
        if (candidate in GFILES) {
          return candidate;
        }
      }
      return null;
    },
    async glob(patterns, fromDir) {
      const hits = new Set<string>();
      for (const pattern of patterns) {
        const abs = pattern.startsWith("/")
          ? join(GROOT, pattern.slice(1))
          : join(fromDir, pattern);
        const re = new RegExp(
          `^${abs
            .replace(/\./g, "\\.")
            .replace(/\*\*/g, "\uE000")
            .replace(/\*/g, "[^/]*")
            .replace(/\uE000/g, ".*")}$`,
        );
        for (const file of Object.keys(GFILES)) {
          if (re.test(file)) {
            hits.add(file);
          }
        }
      }
      return [...hits];
    },
    async readFile(path) {
      return GFILES[path] ?? null;
    },
    async runGit() {
      return "";
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  const { nodes } = await crawlGraph(host, ["/g/src/main.ts"]);
  // import.meta.glob("./views/*.vue")
  expect(nodes).toContain("/g/src/views/Home.vue");
  expect(nodes).toContain("/g/src/views/About.vue");
  // import(`./widgets/${n}.vue`) — computed path expanded to ./widgets/*.vue
  expect(nodes).toContain("/g/src/widgets/Chart.vue");
  expect(nodes).toContain("/g/src/widgets/Table.vue");
});

test("a hub module does not spill its internal imports onto consumers", async () => {
  // AuthSuite imports only a route-name string from routes.ts; routes.ts imports
  // many view components internally to build its table. Symbol-level resolution
  // must NOT link AuthSuite to those views (the production bug: one string
  // import produced 175 spurious edges).
  const HUB: Record<string, string> = {
    "/h/src/main.ts": 'import AuthSuite from "./AuthSuite.vue";\n',
    "/h/src/AuthSuite.vue":
      '<script setup lang="ts">\nimport { AUTH_ROUTE } from "./routes";\nconst go = () => AUTH_ROUTE;\n</script>\n<template><button /></template>\n',
    "/h/src/routes.ts":
      'import Login from "./views/Login.vue";\n' +
      'import Signup from "./views/Signup.vue";\n' +
      'import Reset from "./views/Reset.vue";\n' +
      'export const AUTH_ROUTE = "auth";\n' +
      "export const routes = [Login, Signup, Reset];\n",
    "/h/src/views/Login.vue": "<template><p>login</p></template>\n",
    "/h/src/views/Signup.vue": "<template><p>signup</p></template>\n",
    "/h/src/views/Reset.vue": "<template><p>reset</p></template>\n",
  };
  const host: AnalysisHost = {
    root: "/h",
    configuredEntries: () => [],
    glob: async () => [],
    async resolve(spec, importer) {
      if (!spec.startsWith(".")) {
        return null;
      }
      const base = join(dirname(importer), spec);
      for (const candidate of [base, `${base}.ts`, `${base}.vue`]) {
        if (candidate in HUB) {
          return candidate;
        }
      }
      return null;
    },
    async readFile(path) {
      return HUB[path] ?? null;
    },
    async runGit() {
      return "";
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  const { nodes, componentEdges: edges } = await crawlGraph(host, ["/h/src/main.ts"]);
  // The views are still discovered as nodes (via routes.ts) — not lost.
  expect(nodes).toContain("/h/src/AuthSuite.vue");
  expect(nodes).toContain("/h/src/views/Login.vue");
  expect(nodes).toContain("/h/src/views/Signup.vue");
  expect(nodes).toContain("/h/src/views/Reset.vue");
  // AuthSuite imported only a route-name value → zero spurious component edges.
  expect(edges.filter((e) => e.from === "/h/src/AuthSuite.vue")).toEqual([]);
});

// --- symbol-resolved module edges (docs/symbol-resolution.md) ------------------

// A minimal fake host over an in-memory file map rooted at `/s`, with the same
// relative-specifier resolution the crawl tests above use.
function symbolHost(files: Record<string, string>): AnalysisHost {
  return {
    root: "/s",
    configuredEntries: () => [],
    glob: async () => [],
    async resolve(spec, importer) {
      if (!spec.startsWith(".")) {
        return null; // bare specifier — external (node_modules)
      }
      const base = join(dirname(importer), spec);
      for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, "index.ts")]) {
        if (candidate in files) {
          return candidate;
        }
      }
      return null;
    },
    async readFile(path) {
      return files[path] ?? null;
    },
    async runGit() {
      return "";
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

test("module edges point at definers through barrels, with via + symbols", async () => {
  const { moduleEdges } = await crawlGraph(
    symbolHost({
      "/s/main.ts": 'import { helper } from "./barrel";\n',
      "/s/barrel.ts": 'export { helper } from "./lib/helper";\nexport * from "./lib/star";\n',
      "/s/lib/helper.ts": "export const helper = 1;\n",
      "/s/lib/star.ts": "export const starred = 2;\n",
    }),
    ["/s/main.ts"],
  );
  // Consumer → definer, barrel transparent, first hop recorded.
  expect(moduleEdges).toContainEqual({
    from: "/s/main.ts",
    to: "/s/lib/helper.ts",
    symbols: ["helper"],
    via: ["/s/barrel.ts"],
  });
  // The barrel value-depends on the definers it re-exports…
  expect(moduleEdges).toContainEqual({
    from: "/s/barrel.ts",
    to: "/s/lib/helper.ts",
    symbols: ["helper"],
  });
  // …and `export *` is a single value edge to its direct target (no expansion).
  expect(moduleEdges).toContainEqual({ from: "/s/barrel.ts", to: "/s/lib/star.ts" });
  // No raw main → barrel hop survives narrowing.
  expect(moduleEdges.filter((e) => e.from === "/s/main.ts")).toHaveLength(1);
});

test("whole-module reasons emit ONE edge to the module itself, never an expansion", async () => {
  const files = {
    "/s/main.ts":
      'import * as ns from "./barrel";\nimport "./barrel";\nconst p = import("./barrel");\nexport const use = ns;\n',
    "/s/barrel.ts":
      'export { default as A } from "./A.vue";\nexport { default as B } from "./B.vue";\n',
    "/s/A.vue": "<template><p>a</p></template>\n",
    "/s/B.vue": "<template><p>b</p></template>\n",
  };
  const { moduleEdges } = await crawlGraph(symbolHost(files), ["/s/main.ts"]);
  // Namespace + side-effect + dynamic import of the same barrel: exactly one
  // edge main → barrel; blast stays over-approximated through the barrel's own
  // edges, but no direct fan-out to A/B is fabricated.
  const fromMain = moduleEdges.filter((e) => e.from === "/s/main.ts");
  expect(fromMain).toEqual([{ from: "/s/main.ts", to: "/s/barrel.ts" }]);
  expect(moduleEdges).toContainEqual({
    from: "/s/barrel.ts",
    to: "/s/A.vue",
    symbols: ["A"],
  });
});

test("empty resolutions fall back to a whole-module edge — never dropped", async () => {
  const { moduleEdges } = await crawlGraph(
    symbolHost({
      // Re-export chain that leaves the project: externals resolve to null.
      "/s/main.ts":
        'import { useQuery } from "./barrel";\nimport { broken } from "./broken";\nimport { missing } from "./lib";\nimport "./setup";\nexport const all = [useQuery, broken, missing];\n',
      "/s/barrel.ts": 'export { useQuery } from "@tanstack/vue-query";\n',
      // Unparseable module: contributes no static record, edge must survive.
      "/s/broken.ts": "export const broken = ;;; syntax error {{{\n",
      // The name simply isn't there.
      "/s/lib.ts": "export const other = 1;\n",
      // Side-effect import of an export-less module.
      "/s/setup.ts": "globalThis.x = 1;\n",
    }),
    ["/s/main.ts"],
  );
  const fromMain = moduleEdges.filter((e) => e.from === "/s/main.ts").map((e) => e.to);
  expect(fromMain).toContain("/s/barrel.ts");
  expect(fromMain).toContain("/s/broken.ts");
  expect(fromMain).toContain("/s/lib.ts");
  expect(fromMain).toContain("/s/setup.ts");
});

test("export * never forwards default", async () => {
  const files = {
    "/s/main.ts": 'import Widget from "./facade";\nexport const w = Widget;\n',
    "/s/facade.ts": 'export * from "./Widget.vue";\n',
    "/s/Widget.vue": "<template><p>w</p></template>\n",
  };
  const { componentEdges, moduleEdges } = await crawlGraph(symbolHost(files), ["/s/main.ts"]);
  // ESM: `export *` forwards only NAMED exports. The default must not resolve
  // through the star in either view; the module view falls back to the direct
  // target (the import still executes the facade), the component view drops it.
  expect(moduleEdges.filter((e) => e.from === "/s/main.ts")).toEqual([
    { from: "/s/main.ts", to: "/s/facade.ts" },
  ]);
  expect(componentEdges).toEqual([]);
});

test("mutual export-* cycles resolve identically regardless of query order", async () => {
  const files = {
    // c1 (queried first, sorted order) resolves `x` from b; c2 from a. In the
    // old resolver the b-first query CACHED a truncated ∅ for (a, x) — computed
    // while b was still on the resolution stack — so c2's query returned ∅.
    "/s/a.ts": 'export * from "./b";\n',
    "/s/b.ts": 'export * from "./a";\nexport * from "./def";\n',
    "/s/c1.ts": 'import { x } from "./b";\nexport const useB = x;\n',
    "/s/c2.ts": 'import { x } from "./a";\nexport const useA = x;\n',
    "/s/def.ts": "export const x = 1;\n",
    "/s/main.ts": 'import "./c1";\nimport "./c2";\n',
  };
  const { moduleEdges } = await crawlGraph(symbolHost(files), ["/s/main.ts"]);
  expect(moduleEdges).toContainEqual({
    from: "/s/c1.ts",
    to: "/s/def.ts",
    symbols: ["x"],
    via: ["/s/b.ts"],
  });
  expect(moduleEdges).toContainEqual({
    from: "/s/c2.ts",
    to: "/s/def.ts",
    symbols: ["x"],
    via: ["/s/a.ts"],
  });
});

test("per-binding type precision: mixed imports split into type and value edges", async () => {
  const { moduleEdges } = await crawlGraph(
    symbolHost({
      "/s/main.ts": 'import { type A, B } from "./m";\nexport const b = B;\n',
      "/s/m.ts": 'export type { A } from "./a";\nexport { B } from "./b";\n',
      "/s/a.ts": "export type A = number;\n",
      "/s/b.ts": "export const B = 1;\n",
    }),
    ["/s/main.ts"],
  );
  expect(moduleEdges).toContainEqual({
    from: "/s/main.ts",
    to: "/s/a.ts",
    type: true,
    symbols: ["A"],
    via: ["/s/m.ts"],
  });
  expect(moduleEdges).toContainEqual({
    from: "/s/main.ts",
    to: "/s/b.ts",
    symbols: ["B"],
    via: ["/s/m.ts"],
  });
});

test("lazy boundaries are flagged; any synchronous occurrence clears the flag", async () => {
  const files = {
    "/s/main.ts": 'const a = import("./page");\nconst b = import("./both");\nimport "./both";\n',
    "/s/page.ts": "export const page = 1;\n",
    "/s/both.ts": "export const both = 1;\n",
  };
  const { moduleEdges } = await crawlGraph(symbolHost(files), ["/s/main.ts"]);
  expect(moduleEdges).toContainEqual({ from: "/s/main.ts", to: "/s/page.ts", lazy: true });
  expect(moduleEdges).toContainEqual({ from: "/s/main.ts", to: "/s/both.ts" });
});

test("strictRed no longer reddens consumers through barrels they use for unrelated symbols", async () => {
  const files = {
    "/s/main.ts": 'import { good } from "./barrel";\nexport const g = good;\n',
    "/s/barrel.ts": 'export { good } from "./good";\nexport { bad } from "./bad";\n',
    "/s/good.ts": "export const good = 1;\n",
    "/s/bad.ts": "export const bad: string = 1;\n",
  };
  const { moduleEdges, files: crawled } = await crawlGraph(symbolHost(files), ["/s/main.ts"]);
  const ids = new Set(crawled.map((f) => f.id));
  const facts = new Map(
    [...ids].map((id) => [
      id,
      {
        kind: "ts" as const,
        loc: 10,
        cc: 0,
        blame: null,
        typeErrors: id === "/s/bad.ts" ? 1 : 0,
        status: { loc: "ready", cc: "ready", blame: "ready", typecheck: "ready" } as const,
        errors: {},
      },
    ]),
  );
  const graph = makeGraph(ids, moduleEdges, facts, "/s");
  const red = new Set(graph.nodes.filter((n) => n.strictRed).map((n) => n.id));
  // The barrel re-exports the red module → red. The consumer only uses `good`
  // → NOT red (on raw file edges it was, through the barrel).
  expect(red.has("/s/bad.ts")).toBe(true);
  expect(red.has("/s/barrel.ts")).toBe(true);
  expect(red.has("/s/main.ts")).toBe(false);
});

test("auto-import manifests are detected only when their app was crawled", async () => {
  const host = symbolHost({
    "/s/app/main.ts": "export const x = 1;\n",
  });
  host.glob = async (patterns) =>
    patterns.some((p) => p.includes("components.d.ts"))
      ? ["/s/app/components.d.ts", "/s/other/components.d.ts"]
      : [];
  const { autoImportManifests } = await crawlGraph(host, ["/s/app/main.ts"]);
  // The sibling app's manifest is irrelevant — nothing crawled lives beside it.
  expect(autoImportManifests).toEqual(["/s/app/components.d.ts"]);
});

// --- Phase 5: namespace precision (docs/symbol-resolution.md §5) ---------------

test("namespace usage collection: members, escapes, shadowing, sfc blind spot", () => {
  // Static member reads — value, optional, string-key, and type positions.
  const collected = parseModule(
    'import * as api from "./api";\n' +
      "api.fetchUser();\n" +
      'const x = api["getX"];\n' +
      "const y = api?.maybe;\n" +
      "type T = api.Foo;\n" +
      "export const use = [x, y];\n",
    "/s/a.ts",
  ).nsUsage;
  expect(collected).toEqual([
    {
      local: "api",
      source: "./api",
      members: ["Foo", "fetchUser", "getX", "maybe"],
      cause: null,
    },
  ]);

  // Every escape form falls back to whole-module under `namespaceEscape`.
  const escapes = [
    "console.log(api);",
    "const all = { ...api };",
    "for (const k in api) { String(k); }",
    "const dyn = api[key];",
    "export { api };",
    "export default api;",
    "const keys = Object.keys(api);",
    "type Q = typeof api;",
  ];
  for (const use of escapes) {
    const [usage] = parseModule(
      `import * as api from "./api";\nconst key = "k";\n${use}\n`,
      "/s/a.ts",
    ).nsUsage;
    expect(usage, use).toEqual({
      local: "api",
      source: "./api",
      members: null,
      cause: "namespaceEscape",
    });
  }

  // A shadowing declaration anywhere in the file declines narrowing.
  const [shadowed] = parseModule(
    'import * as api from "./api";\nfunction f(api: number) {\n  return api;\n}\nexport const u = api.fetchUser();\n',
    "/s/a.ts",
  ).nsUsage;
  expect(shadowed.cause).toBe("namespaceShadowed");

  // `.vue` scripts are never narrowed — the template is invisible to the crawl.
  const [sfc] = parseModule(
    'import * as api from "./api";\nexport const u = api.fetchUser();\n',
    "/s/App.vue",
  ).nsUsage;
  expect(sfc.cause).toBe("sfcTemplateBlindSpot");
});

test("namespace imports narrow to used members in the module graph", async () => {
  const { moduleEdges } = await crawlGraph(
    symbolHost({
      "/s/main.ts": 'import * as api from "./api";\nexport const user = api.fetchUser();\n',
      "/s/api.ts": 'export { fetchUser } from "./fetch";\nexport { postUser } from "./post";\n',
      "/s/fetch.ts": "export const fetchUser = () => 1;\n",
      "/s/post.ts": "export const postUser = () => 2;\n",
    }),
    ["/s/main.ts"],
  );
  // Only the used member's definer gains a consumer edge, through the barrel.
  expect(moduleEdges.filter((e) => e.from === "/s/main.ts")).toEqual([
    { from: "/s/main.ts", to: "/s/fetch.ts", symbols: ["fetchUser"], via: ["/s/api.ts"] },
  ]);
});

test("escaped namespace usage keeps the whole-module edge", async () => {
  const { moduleEdges } = await crawlGraph(
    symbolHost({
      "/s/main.ts": 'import * as api from "./api";\nexport const all = { ...api };\n',
      "/s/api.ts": 'export { fetchUser } from "./fetch";\n',
      "/s/fetch.ts": "export const fetchUser = () => 1;\n",
    }),
    ["/s/main.ts"],
  );
  expect(moduleEdges.filter((e) => e.from === "/s/main.ts")).toEqual([
    { from: "/s/main.ts", to: "/s/api.ts" },
  ]);
});

test("counts lines of code", async () => {
  const loc = await locAnalyzer.analyze({
    host: fakeHost(),
    file: "/app/src/main.ts",
  });
  expect(loc).toBe(2);
});

test("loc counts maintainable lines — <style>/<svg> bulk does not inflate it", async () => {
  const host = (content: string): AnalysisHost =>
    ({ readFile: async () => content }) as unknown as AnalysisHost;
  const analyze = (content: string) => locAnalyzer.analyze({ host: host(content), file: "/x.vue" });
  const small = [
    `<script setup lang="ts">`,
    `const n = 1`,
    `</script>`,
    `<template><svg><path /></svg></template>`,
    `<style>.a {}</style>`,
  ].join("\n");
  // Balloon the vector data and the CSS: neither should change the LoC.
  const huge = small
    .replace("<path />", Array.from({ length: 500 }, () => "<path />").join("\n"))
    .replace(".a {}", Array.from({ length: 500 }, (_, i) => `.c${i} { color: red }`).join("\n"));
  expect(await analyze(huge)).toBe(await analyze(small));
  // What's left is just the script logic plus the (now-empty) block wrappers.
  expect(await analyze(small)).toBeLessThan(6);
});

test("parses blame porcelain into lines per author", () => {
  expect(parseBlamePorcelain(BLAME_FIXTURE).authorLines).toEqual({
    Alice: 2,
    Bob: 1,
  });
});

test("engine produces a complete two-graph snapshot with all facts", async () => {
  // typeCheckCommand disabled (deterministic, no runner); blame enabled to
  // assert the queued git-blame path resolves.
  const engine = new AnalysisEngine(fakeHost(), { blame: true });
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();

  // vue graph: `.vue` nodes only, with barrel-collapsed edges.
  expect(graph.vue.nodes).toHaveLength(3);
  const app = graph.vue.nodes.find((node) => node.file === "src/App.vue")!;
  expect(app.name).toBe("App");
  expect(app.kind).toBe("vue");
  expect(app.loc).toBe(5);
  expect(app.status).toEqual({ loc: "ready", cc: "ready", blame: "ready", typecheck: "ready" });
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

  // full graph: reachable `.vue` + `.ts`, with symbol-resolved definition edges.
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
  // Definition edges: value imports point at definers. `main` → App directly;
  // App's `import { Deep } from "./shared"` narrows THROUGH the barrel to
  // Deep.vue (first re-export hop recorded in `via`); the barrel keeps its own
  // edge to the definer it re-exports.
  expect(graph.full.edges).toContainEqual({
    from: mainNode.id,
    to: appFull.id,
    symbols: ["App"],
  });
  expect(graph.full.edges).toContainEqual({
    from: appFull.id,
    to: deepFull.id,
    symbols: ["Deep"],
    via: [shared.id],
  });
  expect(graph.full.edges).toContainEqual({
    from: shared.id,
    to: deepFull.id,
    symbols: ["Deep"],
  });
  // The barrel is transparent to its consumers: no raw App → shared hop.
  expect(graph.full.edges.some((e) => e.from === appFull.id && e.to === shared.id)).toBe(false);
  // No auto-import manifests in the fixture — and the field always ships.
  expect(graph.autoImportManifests).toEqual([]);

  // Maintainability rides the snapshot, computed over the full graph. The
  // type-check pass is off here, so typeHealth is null (not a fake 100%).
  const m = graph.maintainability;
  expect(m.nodes).toBe(graph.full.nodes.length);
  expect(m.score).toBeGreaterThanOrEqual(0);
  expect(m.score).toBeLessThanOrEqual(100);
  expect(m.floorLoc).toBeGreaterThan(0);
  expect(m.costLoc).toBeGreaterThanOrEqual(m.floorLoc);
  expect(m.typeHealth).toBeNull();
  expect(Array.isArray(m.hotspots)).toBe(true);

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
  // Monorepo: a `<package>/src/…` path clusters by the workspace package dir.
  expect(groupOf("/r/packages/effects/access/src/index.ts", "/r")).toBe("access");
  expect(groupOf("/r/apps/web-antd/src/views/x.vue", "/r")).toBe("web-antd");

  // strictRed seeds on C's own errors and propagates UP through importers.
  const fact = (typeErrors: number | null): FileFacts => ({
    kind: "ts",
    loc: 1,
    cc: 0,
    blame: null,
    typeErrors,
    status: { loc: "ready", cc: "ready", blame: "ready", typecheck: "ready" },
    errors: {},
  });
  const facts = new Map<string, FileFacts>([
    [A, fact(0)],
    [B, fact(0)],
    [C, fact(2)],
  ]);
  const graph = makeGraph(
    new Set(ids),
    [
      { from: A, to: B },
      { from: B, to: C },
    ],
    facts,
    "/r",
  );
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
    { typeCheckCommand: ["tsc", "--noEmit", "--pretty", "false"] },
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
    { typeCheckCommand: ["tsc", "--noEmit", "--pretty", "false"] },
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
  const engine = new AnalysisEngine(fakeHost(), { typeCheckCommand: false });
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  expect(graph.vue.nodes.length).toBeGreaterThan(0);
  for (const node of [...graph.vue.nodes, ...graph.full.nodes]) {
    expect(node.typeErrors).toBeNull();
    expect(node.status.typecheck).toBe("ready");
    expect(node.strictRed).toBe(false);
  }
});

test("blame is off by default — status ready, empty blame, no git", async () => {
  let gitCalls = 0;
  const base = fakeHost();
  const host: AnalysisHost = {
    ...base,
    runGit: (args) => {
      gitCalls++;
      return base.runGit(args);
    },
  };
  const engine = new AnalysisEngine(host);
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  expect(graph.vue.nodes.length).toBeGreaterThan(0);
  for (const node of [...graph.vue.nodes, ...graph.full.nodes]) {
    expect(node.status.blame).toBe("ready");
    expect(node.blame).toBeNull();
  }
  // Blame off ⇒ neither `git blame` nor the HEAD probe runs.
  expect(gitCalls).toBe(0);
});

test("applyBlameAliases merges mapped authors and is a no-op when empty", () => {
  expect(
    applyBlameAliases(
      { authorLines: { "web-dev-sam": 4, "Samuel Braun": 2, Bob: 1 } },
      { "web-dev-sam": "Sam", "Samuel Braun": "Sam" },
    ).authorLines,
  ).toEqual({ Sam: 6, Bob: 1 });

  const summary = { authorLines: { Alice: 2 } };
  expect(applyBlameAliases(summary, {})).toBe(summary);
});

test("engine applies blameAliases to the rollup", async () => {
  // fakeHost blame yields { Alice: 2, Bob: 1 } for App.vue; alias Bob -> Alice.
  const engine = new AnalysisEngine(fakeHost(), {
    blame: true,
    blameAliases: { Bob: "Alice" },
  });
  await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);

  const graph = await engine.getGraph();
  const app = graph.vue.nodes.find((node) => node.file === "src/App.vue")!;
  expect(app.blame?.authorLines).toEqual({ Alice: 3 });
});

// --- maintainability score -------------------------------------------------

// Build a `full`-shaped graph from an edge list (importer -> imported) and a
// per-file spec, reusing `makeGraph` so nodes carry real facts. Defaults: 10
// LoC, zero type errors (green). `te: null` models the type pass being off.
function facts(
  spec: Record<string, { loc?: number; te?: number | null; cc?: number }>,
): Map<string, FileFacts> {
  const map = new Map<string, FileFacts>();
  for (const [id, s] of Object.entries(spec)) {
    map.set(id, {
      kind: "ts",
      loc: s.loc ?? 10,
      cc: s.cc ?? 0,
      blame: null,
      typeErrors: s.te === undefined ? 0 : s.te,
      status: { loc: "ready", cc: "ready", blame: "ready", typecheck: "ready" },
      errors: {},
    });
  }
  return map;
}
function graphOf(
  edges: Array<[string, string] | [string, string, { type?: boolean; lazy?: boolean }]>,
  f: Map<string, FileFacts>,
): Graph {
  return makeGraph(
    new Set(f.keys()),
    edges.map(([from, to, flags]) => ({ from, to, ...flags })),
    f,
    "/r",
  );
}

test("hotspots surface the biggest score-draggers first, not the biggest files", () => {
  // A small red file imported widely (real overhead) vs a large, clean, isolated
  // file that sits exactly at its own floor (huge cost, zero overhead).
  const g = graphOf(
    [
      ["/r/i1.ts", "/r/hub.ts"],
      ["/r/i2.ts", "/r/hub.ts"],
      ["/r/i3.ts", "/r/hub.ts"],
    ],
    facts({
      "/r/hub.ts": { loc: 10, te: 1 },
      "/r/i1.ts": { loc: 10 },
      "/r/i2.ts": { loc: 10 },
      "/r/i3.ts": { loc: 10 },
      "/r/big.ts": { loc: 1000 },
    }),
  );
  const h = scoreMaintainability(g).hotspots;
  const hub = h.find((x) => x.file === "hub.ts")!;
  const big = h.find((x) => x.file === "big.ts")!;
  // Sorted by overhead (cost − loc): the widely-imported red hub tops the list;
  // the large clean island ranks below it despite dwarfing it in raw cost.
  expect(h[0]!.file).toBe("hub.ts");
  expect(hub.cost - hub.loc).toBeGreaterThan(big.cost - big.loc);
  expect(big.cost).toBeGreaterThan(hub.cost);
  expect(h.indexOf(hub)).toBeLessThan(h.indexOf(big));
});

test("per-node driver contributions are populated and normalised to the top contributor", () => {
  const g = graphOf(
    [
      ["/r/i1.ts", "/r/hub.ts"],
      ["/r/i2.ts", "/r/hub.ts"],
      ["/r/i3.ts", "/r/hub.ts"],
    ],
    facts({
      "/r/hub.ts": { loc: 10, te: 1 },
      "/r/i1.ts": { loc: 10 },
      "/r/i2.ts": { loc: 10 },
      "/r/i3.ts": { loc: 10 },
      "/r/big.ts": { loc: 1000 },
    }),
  );
  const c = scoreMaintainability(g).contributions;
  // The red, widely-imported hub is the only (thus top) types contributor → 1.
  expect(c["/r/hub.ts"]!.types).toBe(1);
  // The large, clean, isolated island has zero overhead → absent from the map.
  expect(c["/r/big.ts"]).toBeUndefined();
  // Every intensity is a normalised [0,1] fraction.
  for (const v of Object.values(c)) {
    for (const x of [v.comprehension, v.blast, v.types]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  }
});

test("maintainability scores a clean tree far above a tangled ball", () => {
  // Shallow tree: entry imports leaves; leaves import nothing. No cycles.
  const tree = graphOf(
    [
      ["/r/e.ts", "/r/a.ts"],
      ["/r/e.ts", "/r/b.ts"],
      ["/r/e.ts", "/r/c.ts"],
    ],
    facts({ "/r/e.ts": {}, "/r/a.ts": {}, "/r/b.ts": {}, "/r/c.ts": {} }),
  );
  // Same four files, mutually importing — one big cycle.
  const ball = graphOf(
    [
      ["/r/e.ts", "/r/a.ts"],
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
      ["/r/c.ts", "/r/e.ts"],
      ["/r/a.ts", "/r/e.ts"],
      ["/r/b.ts", "/r/a.ts"],
    ],
    facts({ "/r/e.ts": {}, "/r/a.ts": {}, "/r/b.ts": {}, "/r/c.ts": {} }),
  );

  const clean = scoreMaintainability(tree);
  const tangled = scoreMaintainability(ball);
  expect(clean.score).toBeGreaterThan(80);
  expect(clean.cycleLoc).toBe(0);
  expect(tangled.score).toBeLessThan(clean.score);
  expect(tangled.cycleLoc).toBeGreaterThan(0);
});

test("cyclomatic complexity counts decision points, not lines", () => {
  const flat = "const a = 1;\nconst b = 2;\nexport const c = a;\n";
  expect(cyclomaticComplexity(flat, "/x.ts")).toBe(0);

  const branchy = [
    "export function f(n: number, a: boolean, b: boolean, c: boolean) {",
    "  if (n > 0) return 1;", // if +1
    "  for (let i = 0; i < n; i++) {", // for +1
    "    while (i > 2) i--;", // while +1
    "  }",
    "  switch (n) {",
    "    case 1:", // case +1
    "      return 2;",
    "    case 2:", // case +1
    "      return 3;",
    "    default:", // default +0
    "      break;",
    "  }",
    "  const x = n > 0 ? 1 : 2;", // ?: +1
    "  return (a && b) || c;", // && +1, || +1
    "}",
  ].join("\n");
  expect(cyclomaticComplexity(branchy, "/x.ts")).toBe(8);

  // Unparseable source is graceful, not a throw.
  expect(cyclomaticComplexity("function (( {", "/x.ts")).toBe(0);
});

test("complexity analyzer measures only the <script> of an SFC", async () => {
  const sfc =
    '<script setup lang="ts">\nconst x = a ? 1 : 2;\n</script>\n<template><div v-if="x" /></template>\n';
  const host = { readFile: async () => sfc } as unknown as AnalysisHost;
  // The `?:` in the script counts (1); the template `v-if` is not parsed.
  expect(await complexityAnalyzer.analyze({ host, file: "/c.vue" })).toBe(1);
});

test("complexity amplifies a file's flaw cost but never punishes on its own", () => {
  const edges: [string, string][] = [
    ["/r/i1.ts", "/r/hub.ts"],
    ["/r/i2.ts", "/r/hub.ts"],
    ["/r/i3.ts", "/r/hub.ts"],
  ];
  const build = (hubCc: number) =>
    scoreMaintainability(
      graphOf(
        edges,
        facts({
          "/r/hub.ts": { loc: 20, te: 1, cc: hubCc },
          "/r/i1.ts": { loc: 20 },
          "/r/i2.ts": { loc: 20 },
          "/r/i3.ts": { loc: 20 },
        }),
      ),
    );
  const simple = build(0);
  const complex = build(20); // density 1.0 → strong amplification
  // The same type flaw in branch-dense code costs more → lower score, and the
  // overhead is partly attributed to complexity.
  expect(complex.score).toBeLessThan(simple.score);
  expect(simple.complexityAmplification).toBe(0);
  expect(complex.complexityAmplification).toBeGreaterThan(0);

  // A flawless file is untouched by complexity: no coupling, no type debt →
  // perfect score however branch-dense it is.
  const flawlessSimple = scoreMaintainability(
    graphOf([], facts({ "/r/a.ts": { loc: 50, cc: 0 } })),
  );
  const flawlessComplex = scoreMaintainability(
    graphOf([], facts({ "/r/a.ts": { loc: 50, cc: 100 } })),
  );
  expect(flawlessComplex.score).toBe(flawlessSimple.score);
  expect(flawlessComplex.complexityAmplification).toBe(0);
});

test("per-file breakdown carries the ingredients the alt-hover detail shows", () => {
  //  A ─┐
  //     ├─> B ─> C ─> E     (E is a clean floor leaf: imported, imports nothing)
  //  D ─┘
  // B is imported by A and D (blast radius), imports the volatile C, and is
  // itself red and branch-dense — so its cost splits across blast + types,
  // amplified by complexity.
  const g = graphOf(
    [
      ["/r/A.ts", "/r/B.ts"],
      ["/r/D.ts", "/r/B.ts"],
      ["/r/B.ts", "/r/C.ts"],
      ["/r/C.ts", "/r/E.ts"],
    ],
    facts({
      "/r/A.ts": {},
      "/r/B.ts": { loc: 10, te: 1, cc: 6 },
      "/r/C.ts": {},
      "/r/D.ts": {},
      "/r/E.ts": {},
    }),
  );
  const m = scoreMaintainability(g);
  const b = m.breakdown["/r/B.ts"]!;
  expect(b).toBeDefined();
  // Structural ingredients the contributor lists are built from.
  expect(b.weightedFanout).toBe(0.5); // one volatile import (C), i0 = 0.5
  expect(b.instability).toBe(0.2); // 0.5 / (0.5 + 2 importers)
  expect(b.blastRadius).toBe(0.4); // A + D (20 LoC) of 50 total
  // Cost splits across blast + types, amplified by complexity; no excess coupling.
  expect(b.comprehension).toBe(0);
  expect(b.blast).toBeGreaterThan(0);
  expect(b.types).toBeGreaterThan(0);
  expect(b.cxWeight).toBe(2.33); // density 0.6 → 1 + 2·(0.6/0.9)
  // A file at its own floor carries no overhead and is omitted.
  expect(m.breakdown["/r/E.ts"]).toBeUndefined();
  // The breakdown agrees with the hotspot row for the same file.
  const hot = m.hotspots.find((h) => h.id === "/r/B.ts")!;
  expect(b.instability).toBe(Math.round(hot.instability * 1000) / 1000);
  expect(b.blastRadius).toBe(Math.round(hot.blastRadius * 1000) / 1000);
});

test("excess coupling in the breakdown counts only volatile imports", () => {
  // `core` imports 15 modules that each import two shared leaves, so every
  // import is volatile (i0 = 2/3) and the weighted fan-out clears the budget.
  const edges: [string, string][] = [];
  const spec: Record<string, { loc?: number; cc?: number }> = {
    "/r/core.ts": { loc: 100, cc: 10 },
    "/r/La.ts": {},
    "/r/Lb.ts": {},
  };
  for (let k = 0; k < 15; k++) {
    const mod = `/r/m${k}.ts`;
    spec[mod] = {};
    edges.push(["/r/core.ts", mod], [mod, "/r/La.ts"], [mod, "/r/Lb.ts"]);
  }
  const b = scoreMaintainability(graphOf(edges, facts(spec))).breakdown["/r/core.ts"]!;
  expect(b.comprehension).toBeGreaterThan(0);
  // 15 imports × i0(2/3) ≈ 10 weighted edges — above the healthy budget of 8.
  expect(b.weightedFanout).toBeGreaterThan(8);
  // Density 10/100 = 0.1 → the flaw cost is amplified ×1.5.
  expect(b.cxWeight).toBe(1.5);
});

test("maintainability penalises adding a cycle to an acyclic chain", () => {
  const spec = facts({ "/r/a.ts": {}, "/r/b.ts": {}, "/r/c.ts": {} });
  const chain = graphOf(
    [
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
    ],
    spec,
  );
  const cyclic = graphOf(
    [
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
      ["/r/c.ts", "/r/a.ts"],
    ],
    spec,
  );
  const acyclic = scoreMaintainability(chain);
  const withCycle = scoreMaintainability(cyclic);
  expect(acyclic.cycleLoc).toBe(0);
  expect(withCycle.cycleLoc).toBe(1);
  expect(withCycle.score).toBeLessThan(acyclic.score);
});

test("maintainability does not punish a stable high-fan-in foundation", () => {
  const spec = () =>
    facts({
      "/r/h.ts": {},
      "/r/v1.ts": {},
      "/r/v2.ts": {},
      "/r/v3.ts": {},
      "/r/v4.ts": {},
      "/r/v5.ts": {},
    });
  const importsH: [string, string][] = [
    ["/r/v1.ts", "/r/h.ts"],
    ["/r/v2.ts", "/r/h.ts"],
    ["/r/v3.ts", "/r/h.ts"],
    ["/r/v4.ts", "/r/h.ts"],
    ["/r/v5.ts", "/r/h.ts"],
  ];
  // A: H is a pure sink (imports nothing) — stable despite five importers.
  const stable = scoreMaintainability(graphOf(importsH, spec()));
  // B: same fan-in, but H now imports three *volatile* modules (each pulls its
  // own private leaves, so their instability is high) → H becomes a volatile
  // hub. Importing *stable* leaves instead would leave H stable (next test).
  const volatile = scoreMaintainability(
    graphOf(
      [
        ...importsH,
        ["/r/h.ts", "/r/m1.ts"],
        ["/r/h.ts", "/r/m2.ts"],
        ["/r/h.ts", "/r/m3.ts"],
        ["/r/m1.ts", "/r/m1a.ts"],
        ["/r/m1.ts", "/r/m1b.ts"],
        ["/r/m2.ts", "/r/m2a.ts"],
        ["/r/m2.ts", "/r/m2b.ts"],
        ["/r/m3.ts", "/r/m3a.ts"],
        ["/r/m3.ts", "/r/m3b.ts"],
      ],
      facts({
        "/r/h.ts": {},
        "/r/v1.ts": {},
        "/r/v2.ts": {},
        "/r/v3.ts": {},
        "/r/v4.ts": {},
        "/r/v5.ts": {},
        "/r/m1.ts": {},
        "/r/m2.ts": {},
        "/r/m3.ts": {},
        "/r/m1a.ts": {},
        "/r/m1b.ts": {},
        "/r/m2a.ts": {},
        "/r/m2b.ts": {},
        "/r/m3a.ts": {},
        "/r/m3b.ts": {},
      }),
    ),
  );
  // High fan-in alone barely dents the score; volatility on the same hub does.
  expect(stable.score).toBeGreaterThan(90);
  expect(volatile.score).toBeLessThan(stable.score);
});

test("importing a stable target keeps the importer stable; a volatile target does not", () => {
  // C is imported by X and imports one target T; only T's own stability varies.
  // Weighted fan-out means C's instability tracks what it depends on.
  const cInstability = (
    extra: [string, string][],
    extraSpec: Record<string, { loc?: number; te?: number | null }>,
  ) => {
    const g = graphOf(
      [["/r/x.ts", "/r/c.ts"], ["/r/c.ts", "/r/t.ts"], ...extra],
      facts({ "/r/x.ts": {}, "/r/c.ts": {}, "/r/t.ts": {}, ...extraSpec }),
    );
    return scoreMaintainability(g).hotspots.find((h) => h.file === "c.ts")!.instability;
  };
  // T is a pure sink (stable) → importing it leaves C perfectly stable.
  expect(cInstability([], {})).toBe(0);
  // T imports three leaves (volatile) → importing it makes C look unstable.
  const withVolatileT = cInstability(
    [
      ["/r/t.ts", "/r/l1.ts"],
      ["/r/t.ts", "/r/l2.ts"],
      ["/r/t.ts", "/r/l3.ts"],
    ],
    { "/r/l1.ts": {}, "/r/l2.ts": {}, "/r/l3.ts": {} },
  );
  expect(withVolatileT).toBeGreaterThan(0);
});

test("comprehension charges volatile fan-out, not a wall of stable imports", () => {
  // A hub importing a dozen stable leaves (each imports nothing) exceeds the raw
  // fan-out budget but pays no comprehension — its weighted fan-out is ~0.
  const stableEdges: [string, string][] = [];
  const stableSpec: Record<string, { loc?: number; te?: number | null }> = { "/r/hub.ts": {} };
  for (let i = 0; i < 12; i++) {
    stableEdges.push(["/r/hub.ts", `/r/leaf${i}.ts`]);
    stableSpec[`/r/leaf${i}.ts`] = {};
  }
  const stable = scoreMaintainability(graphOf(stableEdges, facts(stableSpec)));
  expect(stable.drivers.comprehension).toBe(0);

  // Same shape, but each imported module is itself volatile (pulls four private
  // leaves), so the hub's weighted fan-out crosses the budget.
  const volEdges: [string, string][] = [];
  const volSpec: Record<string, { loc?: number; te?: number | null }> = { "/r/hub.ts": {} };
  for (let i = 0; i < 12; i++) {
    volEdges.push(["/r/hub.ts", `/r/mod${i}.ts`]);
    volSpec[`/r/mod${i}.ts`] = {};
    for (let j = 0; j < 4; j++) {
      volEdges.push([`/r/mod${i}.ts`, `/r/mod${i}_${j}.ts`]);
      volSpec[`/r/mod${i}_${j}.ts`] = {};
    }
  }
  const volatile = scoreMaintainability(graphOf(volEdges, facts(volSpec)));
  expect(volatile.drivers.comprehension).toBeGreaterThan(0);
});

test("maintainability penalises type errors, more when the red file is widely imported", () => {
  // v1..v3 import h, which imports the shared util u — so u is reachable from
  // (imported by) the whole graph, while a view v1 is imported by nobody.
  const edges: [string, string][] = [
    ["/r/v1.ts", "/r/h.ts"],
    ["/r/v2.ts", "/r/h.ts"],
    ["/r/v3.ts", "/r/h.ts"],
    ["/r/h.ts", "/r/u.ts"],
  ];
  const ids = { "/r/h.ts": {}, "/r/u.ts": {}, "/r/v1.ts": {}, "/r/v2.ts": {}, "/r/v3.ts": {} };
  const green = scoreMaintainability(graphOf(edges, facts(ids)));
  // One red file, same LoC, at a leaf view (blast radius 0) vs the shared util (high blast radius).
  const redLeaf = scoreMaintainability(graphOf(edges, facts({ ...ids, "/r/v1.ts": { te: 1 } })));
  const redUtil = scoreMaintainability(graphOf(edges, facts({ ...ids, "/r/u.ts": { te: 1 } })));

  // A type error lowers the score; the same error in a widely-imported file
  // lowers it more (blast radius amplifies the type term).
  expect(redLeaf.score).toBeLessThan(green.score);
  expect(redUtil.score).toBeLessThan(redLeaf.score);
  expect(redUtil.drivers.types).toBeGreaterThan(0);
  expect(green.drivers.types).toBe(0);
  expect(green.typeHealth).toBe(1);
  expect(redUtil.typeHealth).toBeLessThan(1);
});

test("maintainability reports typeHealth null when the type pass is off", () => {
  const graph = graphOf(
    [["/r/a.ts", "/r/b.ts"]],
    facts({ "/r/a.ts": { te: null }, "/r/b.ts": { te: null } }),
  );
  const result = scoreMaintainability(graph);
  expect(result.typeHealth).toBeNull();
  expect(result.drivers.types).toBe(0);
});

test("maintainability is size-invariant across disjoint identical subgraphs", () => {
  const oneEdges: [string, string][] = [
    ["/r/e.ts", "/r/a.ts"],
    ["/r/e.ts", "/r/b.ts"],
  ];
  const one = scoreMaintainability(
    graphOf(oneEdges, facts({ "/r/e.ts": {}, "/r/a.ts": {}, "/r/b.ts": {} })),
  );
  // Three disjoint copies of the same tree — per-file costs are identical, so
  // the normalised score must not move with sheer size.
  const tripleEdges: [string, string][] = [];
  const tripleSpec: Record<string, { loc?: number }> = {};
  for (const k of [0, 1, 2]) {
    tripleEdges.push([`/r/e${k}.ts`, `/r/a${k}.ts`], [`/r/e${k}.ts`, `/r/b${k}.ts`]);
    tripleSpec[`/r/e${k}.ts`] = {};
    tripleSpec[`/r/a${k}.ts`] = {};
    tripleSpec[`/r/b${k}.ts`] = {};
  }
  const triple = scoreMaintainability(graphOf(tripleEdges, facts(tripleSpec)));
  expect(Math.abs(triple.score - one.score)).toBeLessThanOrEqual(1);
});

// --- Phase 6: score projections (docs/symbol-resolution.md §2) ------------------

test("lazy route registries charge no comprehension; targets keep fan-in and blast", () => {
  // A router registering N pages (each volatile: it imports a util that in
  // turn imports deeper), once via lazy glob edges and once synchronously.
  const build = (lazy: boolean, pages: number) => {
    const edges: Array<[string, string, { lazy?: boolean }]> = [];
    const spec: Record<string, { loc?: number }> = {
      "/r/router.ts": {},
      "/r/util.ts": {},
      "/r/deep.ts": {},
    };
    edges.push(["/r/util.ts", "/r/deep.ts", {}]);
    for (let i = 0; i < pages; i++) {
      const page = `/r/pages/p${i}.ts`;
      spec[page] = {};
      edges.push(["/r/router.ts", page, lazy ? { lazy: true } : {}]);
      edges.push([page, "/r/util.ts", {}]);
    }
    return scoreMaintainability(graphOf(edges, facts(spec)));
  };

  // 20 pages blow past the healthy fan-out budget when counted synchronously —
  // the declarative registry pays no comprehension surcharge.
  const lazyScore = build(true, 20);
  const syncScore = build(false, 20);
  expect(lazyScore.breakdown["/r/router.ts"]?.comprehension ?? 0).toBe(0);
  expect(syncScore.breakdown["/r/router.ts"]!.comprehension).toBeGreaterThan(0);
  expect(lazyScore.costLoc).toBeLessThan(syncScore.costLoc);

  // …but the pages' fan-in, reachability and blast radius are unchanged — a
  // broken page still breaks navigation. (Small fixture: every node fits in
  // the capped hotspot list, which carries the per-node readouts.)
  const lazySmall = build(true, 6);
  const syncSmall = build(false, 6);
  const page = (m: Maintainability) => m.hotspots.find((h) => h.id === "/r/pages/p0.ts")!;
  const util = (m: Maintainability) => m.hotspots.find((h) => h.id === "/r/util.ts")!;
  expect(page(lazySmall).fanIn).toBe(page(syncSmall).fanIn);
  expect(page(lazySmall).blastRadius).toBeCloseTo(page(syncSmall).blastRadius, 10);
  expect(util(lazySmall).blastRadius).toBeCloseTo(util(syncSmall).blastRadius, 10);
  expect(util(lazySmall).blastRadius).toBeGreaterThan(0);
});

test("type-only dependents free the target structurally but still carry type risk", () => {
  // A red types module with three type-only consumers, vs the same shape with
  // value consumers. The module imports a volatile dep so its instability is
  // non-zero when structural fan-in exists.
  const build = (type: boolean) => {
    const flags = type ? { type: true } : {};
    return scoreMaintainability(
      graphOf(
        [
          ["/r/c1.ts", "/r/types.ts", flags],
          ["/r/c2.ts", "/r/types.ts", flags],
          ["/r/c3.ts", "/r/types.ts", flags],
          ["/r/types.ts", "/r/dep.ts", {}],
          ["/r/dep.ts", "/r/deep.ts", {}],
        ],
        facts({
          "/r/c1.ts": {},
          "/r/c2.ts": {},
          "/r/c3.ts": {},
          "/r/types.ts": { te: 1 },
          "/r/dep.ts": {},
          "/r/deep.ts": {},
        }),
      ),
    );
  };
  const typed = build(true);
  const valued = build(false);
  const hot = (m: Maintainability) => m.hotspots.find((h) => h.id === "/r/types.ts")!;

  // Structural terms: type-only importers leave Ca and the blast radius —
  // the module is FREER to change, the compiler re-verifies its dependents.
  expect(hot(typed).fanIn).toBe(0);
  expect(hot(typed).blastRadius).toBe(0);
  expect(hot(valued).fanIn).toBe(3);
  expect(hot(valued).blastRadius).toBeGreaterThan(0);
  expect(typed.costLoc).toBeLessThan(valued.costLoc);

  // Type risk: a broken type propagates to exactly its type-dependents — the
  // types term is amplified by the SAME radius in both variants.
  expect(typed.breakdown["/r/types.ts"]!.types).toBe(valued.breakdown["/r/types.ts"]!.types);
});

test("cycles lists structural SCC members; type-only backlinks are not cycles", () => {
  const spec = { "/r/a.ts": {}, "/r/b.ts": {}, "/r/c.ts": {} };
  const real = scoreMaintainability(
    graphOf(
      [
        ["/r/a.ts", "/r/b.ts"],
        ["/r/b.ts", "/r/a.ts"],
        ["/r/c.ts", "/r/a.ts"],
      ],
      facts(spec),
    ),
  );
  expect(real.cycles).toEqual([["/r/a.ts", "/r/b.ts"]]);
  expect(real.cycleLoc).toBeGreaterThan(0);

  // `import type` backlinks are legal TS and carry no runtime hazard.
  const typeBack = scoreMaintainability(
    graphOf(
      [
        ["/r/a.ts", "/r/b.ts"],
        ["/r/b.ts", "/r/a.ts", { type: true }],
        ["/r/c.ts", "/r/a.ts"],
      ],
      facts(spec),
    ),
  );
  expect(typeBack.cycles).toEqual([]);
  expect(typeBack.cycleLoc).toBe(0);
});
