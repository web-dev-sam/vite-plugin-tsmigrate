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
import { cyclomaticComplexity, parseModule, templateBranches } from "../src/analysis/imports.ts";
import {
  collectChurn,
  estimateChurn,
  type FileChurn,
  parseNumstatLog,
} from "../src/analysis/churn.ts";

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

// --- symbol-resolved module edges (docs/maintainability-score.md "The graph") ---

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

// --- namespace precision (docs/maintainability-score.md "The graph") -----------

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
  // type-check pass is off here, so typeHealth is null (not a fake 100%);
  // the churn pass is off by default, so churnCoverage is null too.
  const m = graph.maintainability;
  expect(m.nodes).toBe(graph.full.nodes.length);
  expect(m.score).toBeLessThanOrEqual(100);
  expect(m.floorLoc).toBeGreaterThan(0);
  expect(m.costLoc).toBeGreaterThanOrEqual(m.floorLoc);
  expect(m.typeHealth).toBeNull();
  expect(m.churnCoverage).toBeNull();
  expect(m.calibrationEpoch).toBeTruthy();
  expect(Array.isArray(m.hotspots)).toBe(true);

  // Crawl coverage: the fixture host globs nothing, so the graph covers all.
  expect(graph.coverage.graphFiles).toBe(graph.full.nodes.length);
  expect(graph.coverage.unreached).toEqual([]);

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

test("engine scoreTypeRisk:false scores the post-migration ceiling, keeping typed %", async () => {
  const diagnostics = "src/components/Child.vue(2,7): error TS2322: boom\n";
  const run = (scoreTypeRisk: boolean, diag: string) => {
    const engine = new AnalysisEngine(
      fakeHost(async () => ({ stdout: diag, stderr: "", code: diag === "" ? 0 : 1 })),
      { typeCheckCommand: ["tsc", "--noEmit", "--pretty", "false"], scoreTypeRisk },
    );
    return expect
      .poll(async () => (await engine.getGraph()).complete, { timeout: 2000 })
      .toBe(true)
      .then(() => engine.getGraph());
  };
  const structural = await run(false, diagnostics);

  // Coloring / typing progress intact: the type pass ran and marked the file.
  const child = structural.vue.nodes.find((node) => node.file === "src/components/Child.vue")!;
  expect(child.typeErrors).toBe(1);
  expect(child.strictRed).toBe(true);
  expect(structural.maintainability.typeHealth).toBeLessThan(1);

  // "As if the migration were finished": treating every file as typed
  // reproduces the all-green score exactly; with type risk on, the red
  // file's flaws price at full cost instead of the typed discount.
  const scored = await run(true, diagnostics);
  const finished = await run(true, "");
  expect(structural.maintainability.score).toBe(finished.maintainability.score);
  expect(structural.maintainability.costLoc).toBe(finished.maintainability.costLoc);
  expect(scored.maintainability.costLoc).toBeGreaterThanOrEqual(structural.maintainability.costLoc);
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
  // A branch-dense mid-size file (real mass overhead) vs a huge flat file
  // sitting exactly at its own floor (huge cost, zero overhead).
  const g = graphOf(
    [],
    facts({
      "/r/god.ts": { loc: 600, cc: 60 },
      "/r/flat.ts": { loc: 2000, cc: 0 },
    }),
  );
  const h = scoreMaintainability(g).hotspots;
  const god = h.find((x) => x.file === "god.ts")!;
  const flat = h.find((x) => x.file === "flat.ts")!;
  // Sorted by overhead (cost − loc): the branchy file tops the list; the huge
  // flat file ranks below it despite dwarfing it in raw cost.
  expect(h[0]!.file).toBe("god.ts");
  expect(god.cost - god.loc).toBeGreaterThan(flat.cost - flat.loc);
  expect(flat.cost).toBeGreaterThan(god.cost);
  expect(h.indexOf(god)).toBeLessThan(h.indexOf(flat));
});

test("per-node driver contributions are populated and normalised to the top contributor", () => {
  const g = graphOf(
    [
      ["/r/i1.ts", "/r/hub.ts"],
      ["/r/i2.ts", "/r/hub.ts"],
      ["/r/i3.ts", "/r/hub.ts"],
    ],
    facts({
      "/r/hub.ts": { loc: 10, cc: 3 },
      "/r/i1.ts": { loc: 10 },
      "/r/i2.ts": { loc: 10 },
      "/r/i3.ts": { loc: 10 },
      "/r/big.ts": { loc: 1000 },
    }),
  );
  const c = scoreMaintainability(g, {
    churn: new Map([["/r/hub.ts", { nEff: 20, deletedPerMonth: 5 }]]),
  }).contributions;
  // The churning, widely-imported hub is the only (thus top) blast contributor → 1.
  expect(c["/r/hub.ts"]!.blast).toBe(1);
  // The large, clean, isolated island has zero overhead → absent from the map.
  expect(c["/r/big.ts"]).toBeUndefined();
  // Every intensity is a normalised [0,1] fraction.
  for (const v of Object.values(c)) {
    for (const x of [v.comprehension, v.blast, v.mass]) {
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

test("complexity analyzer counts script decision points plus template branches", async () => {
  const sfc =
    '<script setup lang="ts">\nconst x = a ? 1 : 2;\n</script>\n' +
    '<template><div v-if="x" /><i v-for="y in x" :key="y" /></template>\n';
  const host = { readFile: async () => sfc } as unknown as AnalysisHost;
  // The `?:` in the script (1) plus the template's `v-if` and `v-for` (2).
  expect(await complexityAnalyzer.analyze({ host, file: "/c.vue" })).toBe(3);
});

test("templateBranches counts branch directives, not prose or v-else", () => {
  const sfc = [
    "<template>",
    '  <div v-if="a" />',
    '  <div v-else-if="b" />',
    "  <div v-else />",
    '  <li v-for="x in xs" :key="x" />',
    '  <p v-show="c">v-if is mentioned in prose here</p>',
    "</template>",
    "<script>",
    "const s = 1;",
    "</script>",
  ].join("\n");
  // v-if + v-else-if + v-for + v-show; `v-else` is the arm of its v-if, and
  // the prose mention has no `=` binding.
  expect(templateBranches(sfc)).toBe(4);
  expect(templateBranches("<script>const x = 1;</script>")).toBe(0);
});

test("mass prices branches by file size — splitting a god file lowers the cost", () => {
  // Same total LoC (1200) and total branches (40): one god file vs four
  // pivot-sized slices. The escalator makes the god file 4× as expensive.
  const god = scoreMaintainability(graphOf([], facts({ "/r/god.ts": { loc: 1200, cc: 40 } })));
  const split = scoreMaintainability(
    graphOf(
      [],
      facts({
        "/r/s1.ts": { loc: 300, cc: 10 },
        "/r/s2.ts": { loc: 300, cc: 10 },
        "/r/s3.ts": { loc: 300, cc: 10 },
        "/r/s4.ts": { loc: 300, cc: 10 },
      }),
    ),
  );
  expect(god.costLoc - god.floorLoc).toBe(4 * (split.costLoc - split.floorLoc));
  expect(split.score).toBeGreaterThan(god.score);

  // cc-gating: a flat file (prose, plain declarations) is free however long.
  const flat = scoreMaintainability(graphOf([], facts({ "/r/legal.ts": { loc: 900, cc: 0 } })));
  expect(flat.score).toBe(100);
  expect(flat.costLoc).toBe(flat.floorLoc);
});

test("score mapping: Ω_typ anchors 30, 25 points per halving, capped, open below", () => {
  // A single isolated typed file has no coupling or blast — its Ω is exactly
  // the discounted mass ratio D·cc/300 (D = 0.2), so the mapping is
  // observable in isolation.
  const at = (cc: number) =>
    scoreMaintainability(graphOf([], facts({ "/r/a.ts": { loc: 300, cc } })));
  expect(at(150).omega).toBeCloseTo(0.1, 10); // Ω_typ →
  expect(at(150).score).toBe(30); //   the typical-app anchor
  expect(at(75).score).toBe(55); // halve Ω → +25
  expect(at(300).score).toBe(5); // double Ω → −25
  expect(at(1200).score).toBe(-45); // Ω 0.8 = 3 doublings → open bottom
  expect(at(0).score).toBe(100); // Ω = 0 is the principled cap
});

test("per-file breakdown carries the ingredients the alt-hover detail shows", () => {
  //  A ─┐
  //     ├─> B ─> C ─> E     (E is a clean floor leaf: imported, imports nothing)
  //  D ─┘
  // B is imported by A and D (blast radius), imports C, and is itself red and
  // branch-dense — so its cost splits across blast + mass, the mass at full
  // price (t = 1) because B carries its own type error.
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
  // Structural ingredients the contributor lists are built from. With no
  // churn input, volatility is the floored structural prior 0.15·I₀.
  expect(b.weightedFanout).toBe(0.1); // one import: vol(C) = 0.15 · 0.5
  expect(b.volatility).toBe(0.05); // 0.15 · I₀(B) = 0.15 · ⅓
  expect(b.blastRadius).toBe(0.4); // A + D (20 LoC) of 50 total
  // Cost splits across blast + mass; no excess coupling. B is red, so its
  // mass ships at full price — a typed twin would pay D× of it.
  expect(b.comprehension).toBe(0);
  expect(b.blast).toBeGreaterThan(0);
  expect(b.mass).toBeCloseTo(0.2, 5); // 6 branches · (10/300) · t = 1
  // A file at its own floor carries no overhead and is omitted.
  expect(m.breakdown["/r/E.ts"]).toBeUndefined();
  // The breakdown agrees with the hotspot row for the same file.
  const hot = m.hotspots.find((h) => h.id === "/r/B.ts")!;
  expect(b.volatility).toBe(Math.round(hot.volatility * 1000) / 1000);
  expect(b.blastRadius).toBe(Math.round(hot.blastRadius * 1000) / 1000);
});

test("excess coupling in the breakdown counts only volatile imports", () => {
  // `core` imports 15 modules that git history shows churning, so every
  // import prices near a full edge and the weighted fan-out clears the budget.
  const edges: [string, string][] = [];
  const spec: Record<string, { loc?: number; cc?: number }> = {
    "/r/core.ts": { loc: 100, cc: 10 },
  };
  const churn = new Map<string, FileChurn>();
  for (let k = 0; k < 15; k++) {
    const mod = `/r/m${k}.ts`;
    spec[mod] = {};
    edges.push(["/r/core.ts", mod]);
    churn.set(mod, { nEff: 10, deletedPerMonth: 2 });
  }
  const b = scoreMaintainability(graphOf(edges, facts(spec)), { churn }).breakdown["/r/core.ts"]!;
  expect(b.comprehension).toBeGreaterThan(0);
  // 15 imports × vol ≈ 0.95 — above the healthy budget of 8.
  expect(b.weightedFanout).toBeGreaterThan(8);
});

test("maintainability penalises adding a cycle to an acyclic chain", () => {
  // Branchy files keep both variants below the 100 cap so the cycle's extra
  // blast (whole SCC LoC in every member's radius) is visible in the score.
  const spec = () =>
    facts({
      "/r/a.ts": { cc: 30 },
      "/r/b.ts": { cc: 30 },
      "/r/c.ts": { cc: 30 },
    });
  const chain = graphOf(
    [
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
    ],
    spec(),
  );
  const cyclic = graphOf(
    [
      ["/r/a.ts", "/r/b.ts"],
      ["/r/b.ts", "/r/c.ts"],
      ["/r/c.ts", "/r/a.ts"],
    ],
    spec(),
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
  // A: H is a pure sink with five importers and no measured churn — stable
  // however popular it is (I₀ = 0, and no history to override it).
  const stable = scoreMaintainability(graphOf(importsH, spec()));
  // B: identical shape, but git history shows H rewriting its own lines every
  // month — a hub that REALLY changes makes every importer re-verify.
  const volatile = scoreMaintainability(graphOf(importsH, spec()), {
    churn: new Map([["/r/h.ts", { nEff: 12, deletedPerMonth: 5 }]]),
  });
  // High fan-in alone costs nothing; measured churn on the same hub does.
  expect(stable.score).toBe(100);
  expect(volatile.score).toBeLessThan(stable.score);
});

test("volatility: deleted-lines rate saturates absolutely, floored by structure", () => {
  // One importer, one import → I₀(c) = 0.5; the no-history floor is 0.15·I₀.
  const shape = () =>
    graphOf(
      [
        ["/r/x.ts", "/r/c.ts"],
        ["/r/c.ts", "/r/t.ts"],
      ],
      facts({ "/r/x.ts": {}, "/r/c.ts": {}, "/r/t.ts": {} }),
    );
  const volOf = (m: Maintainability) => m.hotspots.find((h) => h.file === "c.ts")!.volatility;

  // No churn map: the structural floor stands and churnCoverage is null
  // (pass off/pending).
  const prior = scoreMaintainability(shape());
  expect(volOf(prior)).toBeCloseTo(0.075, 10); // 0.15 · I₀ = 0.15 · 0.5
  expect(prior.churnCoverage).toBeNull();

  // The saturation scale is absolute (deleted lines/month ÷ loc, half-way at
  // 1% of the file per month): a hub that rewrites its lines reads hot, a
  // becalmed file falls back to the floor — never a per-repo percentile.
  const churned = (stats: FileChurn) =>
    scoreMaintainability(shape(), { churn: new Map([["/r/c.ts", stats]]) });
  const hot = churned({ nEff: 40, deletedPerMonth: 2 }); // 20%/month on 10 LoC
  const calm = churned({ nEff: 40, deletedPerMonth: 0.001 });
  expect(volOf(hot)).toBeGreaterThan(0.9);
  expect(volOf(calm)).toBeCloseTo(0.075, 10); // the floor holds — never below structure
  expect(hot.volatility["/r/c.ts"]!).toBeGreaterThan(0.9); // the edge price too
  // LoC-weighted coverage: 10 of the 30 LoC carry usable history.
  expect(hot.churnCoverage).toBe(0.333);

  // Append-only history (adds, no deletions) reads calm: deleted lines are
  // the risk signal — growing a registry/barrel is free.
  const appendOnly = churned({ nEff: 40, deletedPerMonth: 0 });
  expect(volOf(appendOnly)).toBeCloseTo(0.075, 10);
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

  // Same shape, but git history shows every imported module churning — the
  // hub's volatility-weighted fan-out crosses the budget and comprehension
  // charges.
  const churn = new Map<string, FileChurn>();
  const volEdges: [string, string][] = [];
  const volSpec: Record<string, { loc?: number; te?: number | null }> = { "/r/hub.ts": {} };
  for (let i = 0; i < 12; i++) {
    volEdges.push(["/r/hub.ts", `/r/mod${i}.ts`]);
    volSpec[`/r/mod${i}.ts`] = {};
    churn.set(`/r/mod${i}.ts`, { nEff: 10, deletedPerMonth: 2 });
  }
  const volatile = scoreMaintainability(graphOf(volEdges, facts(volSpec)), { churn });
  expect(volatile.drivers.comprehension).toBeGreaterThan(0);
});

test("typed discount: red files pay full price, red dependents undo the blast discount", () => {
  // Own flaws: the same god file typed vs red — typed pays D (= 1/5) of it.
  const godFacts = (te: number) => facts({ "/r/god.ts": { loc: 300, cc: 50, te } });
  const typed = scoreMaintainability(graphOf([], godFacts(0)));
  const red = scoreMaintainability(graphOf([], godFacts(3)));
  expect(red.costLoc - red.floorLoc).toBe(5 * (typed.costLoc - typed.floorLoc));
  expect(red.score).toBeLessThan(typed.score);

  // Blast: a churning foundation with four dependents — the more of the
  // dependent LoC is red, the less the compiler carries (u_dep rises).
  const shape = (redDeps: number) => {
    const spec: Record<string, { te?: number }> = { "/r/f.ts": {} };
    const edges: [string, string][] = [];
    for (let i = 0; i < 4; i++) {
      spec[`/r/d${i}.ts`] = { te: i < redDeps ? 1 : 0 };
      edges.push([`/r/d${i}.ts`, "/r/f.ts"]);
    }
    return scoreMaintainability(graphOf(edges, facts(spec)), {
      churn: new Map([["/r/f.ts", { nEff: 20, deletedPerMonth: 5 }]]),
    });
  };
  const greenDeps = shape(0);
  const halfRed = shape(2);
  const allRed = shape(4);
  const blastOf = (m: Maintainability) => m.breakdown["/r/f.ts"]!.blast;
  expect(blastOf(halfRed)).toBeGreaterThan(blastOf(greenDeps));
  expect(blastOf(allRed)).toBeGreaterThan(blastOf(halfRed));
  // Fully red dependents = full price: D + (1−D)·1 = 1, i.e. 5× the typed run.
  expect(blastOf(allRed)).toBeCloseTo(blastOf(greenDeps) * 5, 0);
  expect(allRed.score).toBeLessThan(greenDeps.score);

  // A red file with no flaws costs nothing — types discount flaws, they are
  // not a penalty of their own.
  const flatRed = scoreMaintainability(graphOf([], facts({ "/r/flat.ts": { loc: 400, te: 9 } })));
  expect(flatRed.score).toBe(100);
  expect(flatRed.typeHealth).toBe(0);
});

test("maintainability reports typeHealth null when the type pass is off", () => {
  const graph = graphOf(
    [["/r/a.ts", "/r/b.ts"]],
    facts({ "/r/a.ts": { te: null }, "/r/b.ts": { te: null } }),
  );
  const result = scoreMaintainability(graph);
  expect(result.typeHealth).toBeNull();
});

test("scoreTypeRisk:false scores the post-migration structural ceiling", () => {
  // A red branch-dense foundation everything imports — the worst case.
  const edges: Array<[string, string]> = [
    ["/r/a.ts", "/r/red.ts"],
    ["/r/b.ts", "/r/red.ts"],
    ["/r/c.ts", "/r/red.ts"],
  ];
  const redFacts = () =>
    facts({
      "/r/red.ts": { loc: 300, cc: 40, te: 5 },
      "/r/a.ts": {},
      "/r/b.ts": {},
      "/r/c.ts": {},
    });
  const greenFacts = () =>
    facts({
      "/r/red.ts": { loc: 300, cc: 40 },
      "/r/a.ts": {},
      "/r/b.ts": {},
      "/r/c.ts": {},
    });

  const scored = scoreMaintainability(graphOf(edges, redFacts()));
  const structural = scoreMaintainability(graphOf(edges, redFacts()), { scoreTypeRisk: false });
  const green = scoreMaintainability(graphOf(edges, greenFacts()));

  // "As if the migration were finished": treating every file as typed
  // reproduces the all-green score exactly; with type risk on, the red
  // file's flaws price at full cost (1/D more).
  expect(structural.score).toBe(green.score);
  expect(structural.costLoc).toBe(green.costLoc);
  expect(scored.costLoc).toBeGreaterThan(green.costLoc);
  expect(scored.score).toBeLessThan(green.score);
  expect(structural.hotspots).toEqual(green.hotspots);
  // Typing *progress* still reports — it is information, not a cost.
  expect(structural.typeHealth).toBeLessThan(1);
  expect(scored.typeHealth).toBe(structural.typeHealth);
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

// --- score projections (docs/maintainability-score.md "Edge projections") ------

test("lazy route registries charge no comprehension; targets keep fan-in and blast", () => {
  // A router registering N churning pages (git history shows each rewriting),
  // once via lazy glob edges and once synchronously.
  const build = (lazy: boolean, pages: number) => {
    const edges: Array<[string, string, { lazy?: boolean }]> = [];
    const spec: Record<string, { loc?: number }> = {
      "/r/router.ts": {},
      "/r/util.ts": {},
      "/r/deep.ts": {},
    };
    const churn = new Map<string, FileChurn>();
    edges.push(["/r/util.ts", "/r/deep.ts", {}]);
    for (let i = 0; i < pages; i++) {
      const page = `/r/pages/p${i}.ts`;
      spec[page] = {};
      edges.push(["/r/router.ts", page, lazy ? { lazy: true } : {}]);
      edges.push([page, "/r/util.ts", {}]);
      churn.set(page, { nEff: 10, deletedPerMonth: 2 });
    }
    return scoreMaintainability(graphOf(edges, facts(spec)), { churn });
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

test("type-only dependents free the target structurally — the compiler re-verifies them", () => {
  // A red types module with three type-only consumers, vs the same shape with
  // value consumers. The module imports a dep so its instability is non-zero
  // when structural fan-in exists.
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

// --- churn estimation (git history → volatility input) ----------------------

const DAY = 86_400;

test("parseNumstatLog parses commits, renames and binary rows", () => {
  const log = [
    "\x011700000000",
    "5\t3\tsrc/app.ts",
    "-\t-\tassets/logo.png",
    "",
    "\x011699000000",
    "0\t0\tsrc/{old.ts => new.ts}",
    "2\t1\tlib.ts => moved.ts",
    "1\t1\t{ => src}/root.ts",
    "noise line without tabs",
  ].join("\n");
  const commits = parseNumstatLog(log);
  expect(commits).toHaveLength(2);
  expect(commits[0]!.time).toBe(1_700_000_000);
  expect(commits[0]!.files).toEqual([
    { path: "src/app.ts", deleted: 3, renamedFrom: null },
    { path: "assets/logo.png", deleted: 0, renamedFrom: null },
  ]);
  expect(commits[1]!.files).toEqual([
    { path: "src/new.ts", deleted: 0, renamedFrom: "src/old.ts" },
    { path: "moved.ts", deleted: 1, renamedFrom: "lib.ts" },
    { path: "src/root.ts", deleted: 1, renamedFrom: "root.ts" },
  ]);
});

test("estimateChurn chains renames so old history lands on the current path", () => {
  const t = (daysAgo: number) => 1_700_000_000 - daysAgo * DAY;
  const commits = parseNumstatLog(
    [
      `\x01${t(1)}`,
      "0\t9\tb.ts", // newest: rewrites the current name
      `\x01${t(2)}`,
      "0\t0\ta.ts => b.ts", // rename record
      `\x01${t(3)}`,
      "0\t9\ta.ts", // oldest: rewrites the pre-rename name
    ].join("\n"),
  );
  const churn = estimateChurn(commits, new Map([["b.ts", 10]]));
  const b = churn.get("b.ts")!;
  // All three touches accrue to the present-day path…
  expect(b.nEff).toBe(3);
  // …and both 9-line deletions land there: 18 deleted / 18 months.
  expect(b.deletedPerMonth).toBeCloseTo(1, 10);
  expect(churn.has("a.ts")).toBe(false);
});

test("estimateChurn damps bulk commits and drops codemods", () => {
  const loc = new Map([["f.ts", 100]]);
  // A k-file commit carries touch weight min(1, √(30/k)).
  const bulk = (k: number) => {
    const rows = ["\x011700000000", "10\t18\tf.ts"];
    for (let i = 1; i < k; i++) {
      rows.push(`10\t18\tother${i}.ts`);
    }
    return parseNumstatLog(rows.join("\n"));
  };
  // 120 files → weight √(30/120) = 0.5: half the observation, half the lines.
  const damped = estimateChurn(bulk(120), loc).get("f.ts")!;
  expect(damped.nEff).toBeCloseTo(0.5, 5);
  expect(damped.deletedPerMonth).toBeCloseTo(0.5, 5); // 0.5 · 18 / 18 months
  // Small commits carry full weight; deleted lines only (adds are free).
  const small = estimateChurn(bulk(1), loc).get("f.ts")!;
  expect(small.nEff).toBe(1);
  expect(small.deletedPerMonth).toBe(1);
  // >200-file codemods carry no churn signal at all.
  expect(estimateChurn(bulk(201), loc).get("f.ts")).toBeUndefined();
});

test("collectChurn attributes files to their nearest repo (submodule boundary)", async () => {
  // /app is the parent repo; /app/sub is a submodule — `git log` at /app
  // NEVER reports files inside it, so per-file repo resolution is load-bearing.
  const now = Date.now();
  const t = Math.floor(now / 1000 - DAY);
  const gitCalls: string[][] = [];
  const host = {
    async runGit(args: string[]) {
      gitCalls.push(args);
      if (args[2] === "rev-parse") {
        return args[1]!.startsWith("/app/sub") ? "/app/sub\n" : "/app\n";
      }
      if (args.includes("log")) {
        return args[1] === "/app/sub" ? `\x01${t}\n9\t0\tlib.ts\n` : `\x01${t}\n9\t0\tsrc/a.ts\n`;
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  };
  const churn = await collectChurn(
    host,
    new Map([
      ["/app/src/a.ts", 10],
      ["/app/sub/lib.ts", 10],
    ]),
  );
  expect(churn.get("/app/src/a.ts")!.nEff).toBeGreaterThan(0.9);
  expect(churn.get("/app/sub/lib.ts")!.nEff).toBeGreaterThan(0.9);
  // One log per involved repo, each run at ITS toplevel.
  const logs = gitCalls.filter((a) => a.includes("log")).map((a) => a[1]);
  expect(logs.sort()).toEqual(["/app", "/app/sub"]);
});

test("engine churn pass blends git history into volatility and reports coverage", async () => {
  // 15 recent commits rewriting App.vue — main.ts and friends stay untouched.
  const nowSec = Math.floor(Date.now() / 1000);
  const rows: string[] = [];
  for (let i = 0; i < 15; i++) {
    rows.push(`\x01${nowSec - (i + 1) * DAY}`, "8\t4\tsrc/App.vue", "");
  }
  const gitLog = rows.join("\n");
  const churnHost: AnalysisHost = {
    ...fakeHost(),
    async runGit(args) {
      if (args[0] === "rev-parse") {
        return "abc123\n"; // HEAD probe
      }
      if (args[2] === "rev-parse") {
        return "/app\n"; // per-directory toplevel
      }
      return gitLog;
    },
  };
  const run = async (churn: boolean, host: AnalysisHost) => {
    const engine = new AnalysisEngine(host, { churn });
    await expect.poll(async () => (await engine.getGraph()).complete, { timeout: 2000 }).toBe(true);
    return (await engine.getGraph()).maintainability;
  };
  const off = await run(false, fakeHost());
  const on = await run(true, churnHost);

  // Churn off → coverage null, volatility is the structural prior.
  expect(off.churnCoverage).toBeNull();
  // Churn on → App.vue's measured churn drags its volatility above the prior;
  // coverage reports the measured fraction honestly (only App.vue has history).
  expect(on.churnCoverage).toBeGreaterThan(0);
  expect(on.churnCoverage!).toBeLessThan(1);
  const app = "/app/src/App.vue";
  expect(on.volatility[app]!).toBeGreaterThan(off.volatility[app]!);
});

// --- crawl coverage + auto-import manifests ---------------------------------

test("engine reports crawl coverage with unreached source files", async () => {
  const files = { ...FILES, "/app/src/orphan.ts": "export const dead = 1;\n" };
  const base = fakeHost(undefined, files);
  const host: AnalysisHost = {
    ...base,
    glob: async (patterns) =>
      patterns.includes("**/*.vue") ? Object.keys(files).filter((f) => /\.(vue|ts)$/.test(f)) : [],
  };
  const engine = new AnalysisEngine(host);
  const graph = await engine.getGraph();
  // The orphan is visible to the readout but enters neither floor nor cost.
  expect(graph.coverage.unreached).toEqual([{ file: "src/orphan.ts", loc: 1 }]);
  expect(graph.coverage.graphFiles).toBe(graph.full.nodes.length);
  expect(graph.coverage.sourceFiles).toBe(graph.coverage.graphFiles + 1);
  expect(graph.coverage.sourceLoc).toBe(graph.coverage.graphLoc + 1);
  expect(graph.full.nodes.some((n) => n.file === "src/orphan.ts")).toBe(false);
});

test("auto-import manifest targets are crawled as nodes with no importer edges", async () => {
  const files: Record<string, string> = {
    "/app/index.html": '<script type="module" src="/src/main.ts"></script>',
    "/app/src/main.ts": "export const app = 1;\n",
    "/app/components.d.ts":
      "declare module 'vue' {\n" +
      "  export interface GlobalComponents {\n" +
      "    Auto: typeof import('./src/components/Auto.vue')['default'];\n" +
      "  }\n" +
      "}\n",
    "/app/src/components/Auto.vue":
      '<script setup lang="ts">\nimport { util } from "../util";\n</script>\n' +
      "<template><p>{{ util }}</p></template>\n",
    "/app/src/util.ts": "export const util = 1;\n",
  };
  const base = fakeHost(undefined, files);
  const host: AnalysisHost = {
    ...base,
    glob: async (patterns) =>
      patterns.includes("**/components.d.ts") ? ["/app/components.d.ts"] : [],
  };
  const crawl = await crawlGraph(host, ["/app/src/main.ts"]);
  expect(crawl.autoImportManifests).toEqual(["/app/components.d.ts"]);
  // The manifest target joins the graph (no longer reads as dead code) and its
  // own imports are followed — but nothing points AT it: the auto-import
  // binding sites stay invisible (the banner's job).
  const ids = crawl.files.map((f) => f.id);
  expect(ids).toContain("/app/src/components/Auto.vue");
  expect(ids).toContain("/app/src/util.ts");
  expect(crawl.nodes).toContain("/app/src/components/Auto.vue");
  expect(crawl.moduleEdges.some((e) => e.to === "/app/src/components/Auto.vue")).toBe(false);
});
