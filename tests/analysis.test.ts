import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { applyBlameAliases, parseBlamePorcelain } from "../src/analysis/analyzers/blame.ts";
import { locAnalyzer } from "../src/analysis/analyzers/loc.ts";
import { AnalysisEngine } from "../src/analysis/engine.ts";
import { crawlGraph, findEntries } from "../src/analysis/graph.ts";
import type { AnalysisHost } from "../src/analysis/host.ts";
import { computeHeights, type FileFacts, groupOf, makeGraph } from "../src/analysis/topology.ts";
import { parseTscErrors } from "../src/analysis/typecheck.ts";
import { parseModule } from "../src/analysis/imports.ts";

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

// --- symbol-resolved module edges ---------------------------------------------

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
        blame: null,
        typeErrors: id === "/s/bad.ts" ? 1 : 0,
        status: { loc: "ready", blame: "ready", typecheck: "ready" } as const,
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

// --- namespace precision -------------------------------------------------------

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

test("overlapping getGraph() polls share one pass", async () => {
  // An open tool tab plus any second poller overlap the very first pass. A
  // re-entrant traversal would skip the already-cleared crawl and publish a
  // zero-node snapshot.
  const engine = new AnalysisEngine(fakeHost());
  const [a, b] = await Promise.all([engine.getGraph(), engine.getGraph()]);
  expect(a.full.nodes.length).toBeGreaterThan(0);
  expect(b.full.nodes.length).toBe(a.full.nodes.length);
});

// --- auto-import manifests ------------------------------------------------------

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
