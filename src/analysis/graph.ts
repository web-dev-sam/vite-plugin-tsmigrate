import { dirname, extname, join, sep } from "node:path";
import type { ComponentEdge } from "../shared/types.ts";
import { buildEdges, type EdgeSources, toWireEdges } from "./dependencies.ts";
import type { AnalysisHost } from "./host.ts";
import { extractSfcScripts, isTypedModule, type ModuleRecord, parseModule } from "./imports.ts";
import { makeResolver } from "./resolve.ts";
import type { Terminality } from "./symbols.ts";

const SCRIPT_EXTS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".mts": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
};

/** A reachable module, its kind (from the file extension), and its type status. */
export interface CrawlFile {
  id: string;
  kind: "vue" | "ts";
  /** Already carries TypeScript contracts (see `isTypedModule`) — nothing to migrate. */
  typed: boolean;
}

/**
 * Result of a crawl. `nodes`/`componentEdges` are the `.vue` component view
 * with barrel-collapsed, symbol-resolved edges (the existing semantics).
 * `files`/`moduleEdges` are the full module view: every reachable file with
 * its kind and symbol-resolved definition edges among them — value/type
 * imports narrowed to their definers, whole-module dependencies as a single
 * edge to the module itself (docs/maintainability-score.md "The graph").
 */
export interface CrawlResult {
  nodes: string[];
  componentEdges: ComponentEdge[];
  files: CrawlFile[];
  moduleEdges: ComponentEdge[];
  /** Detected auto-import manifests (§12): their targets are crawled as nodes, but their importer edges stay invisible. */
  autoImportManifests: string[];
}

/** Whether the crawl can follow this entry (a script module or an SFC). */
const isCrawlableEntry = (id: string): boolean => {
  const ext = extname(id.split("?")[0]);
  return ext === ".vue" || SCRIPT_EXTS[ext] === true;
};

/** Last-resort entry paths when nothing is configured and there's no index.html. */
const DEFAULT_ENTRIES = [
  "./src/main.ts",
  "./src/main.tsx",
  "./src/main.js",
  "./src/main.jsx",
  "./src/main.mts",
  "./src/main.mjs",
];

/**
 * Every crawlable source file under the root — the coverage universe the
 * graph is measured against. Declaration files are excluded (not editable
 * logic); `node_modules` is excluded by the host glob. Files here that no
 * entry reaches are the "unreached" readout: dead code, intentional archives,
 * or crawler blind spots.
 */
export async function findSourceFiles(host: AnalysisHost): Promise<string[]> {
  const hits = await host.glob(
    ["**/*.vue", ...Object.keys(SCRIPT_EXTS).map((ext) => `**/*${ext}`)],
    host.root,
  );
  return hits.filter((hit) => !hit.endsWith(".d.ts"));
}

/**
 * Resolve the app's crawl roots, in priority order:
 *   1. build-configured entries (`build.rollupOptions.input`) — for apps that
 *      serve their module script from outside a static `index.html`, e.g.
 *      Laravel's `@vite('resources/js/app.ts')` in a Blade template, or
 *      library / multi-page builds. Non-script/SFC entries (CSS) are dropped.
 *   2. the root `index.html`'s first `<script type="module" src>` (Vite's
 *      default single-page convention).
 *   3. `src/main.{ts,tsx,js,jsx,mts,mjs}` as a last resort.
 *
 * Returns every resolved root (deduped); empty only when nothing resolves.
 */
export async function findEntries(host: AnalysisHost): Promise<string[]> {
  const configured: string[] = [];
  for (const entry of host.configuredEntries()) {
    if (isCrawlableEntry(entry) && (await host.readFile(entry)) !== null) {
      configured.push(entry);
    }
  }
  if (configured.length > 0) {
    return [...new Set(configured)];
  }

  const indexHtml = join(host.root, "index.html");
  const html = await host.readFile(indexHtml);
  // First `<script type="module">` that has a `src`, regardless of attribute
  // order (HTML attribute order is arbitrary — do not assume type precedes src).
  let src: string | undefined;
  for (const tag of html?.matchAll(/<script\b[^>]*>/gi) ?? []) {
    const attrs = tag[0];
    if (!/\btype\s*=\s*["']module["']/i.test(attrs)) {
      continue;
    }
    const match = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (match) {
      src = match[1];
      break;
    }
  }
  const candidates = src ? [src] : DEFAULT_ENTRIES;
  for (const candidate of candidates) {
    const resolved = await host.resolve(candidate, indexHtml);
    if (resolved) {
      return [resolved];
    }
  }
  return [];
}

/**
 * BFS the import graph from one or more entry roots to build two views:
 *
 *   - `nodes`/`edges`: the `.vue` component graph. Edges are resolved at the
 *     *symbol* level — importing a binding from a module links only to the
 *     components that binding actually resolves to (following re-export
 *     chains), so a hub module that internally imports many components does not
 *     spill them onto consumers that import an unrelated name (e.g. a
 *     `routes.ts` importing 175 views but exporting only route-name strings).
 *   - `files`/`rawEdges`: every reachable module and the raw importer→imported
 *     edges among them, uncollapsed.
 */
export async function crawlGraph(host: AnalysisHost, entries: string[]): Promise<CrawlResult> {
  const directImports = new Map<string, string[]>();
  const records = new Map<string, ModuleRecord>();
  // Per-file specifier → resolved absolute path (null = external/out-of-root),
  // captured during discovery so symbol resolution below stays synchronous.
  const resolvedOf = new Map<string, Map<string, string | null>>();
  const globHitsOf = new Map<string, string[]>();
  const vueNodes = new Set<string>();
  const typedOf = new Map<string, boolean>();

  // A resolved target is a crawlable project module: under the root, not a
  // virtual module or a dependency, and a script/SFC by extension.
  const accept = (target: string | null): string | null => {
    if (!target) {
      return null;
    }
    const clean = target.split("?")[0];
    if (
      clean.startsWith("\0") ||
      (clean !== host.root && !clean.startsWith(host.root + sep)) ||
      clean.includes("/node_modules/")
    ) {
      return null;
    }
    const ext = extname(clean);
    return ext === ".vue" || SCRIPT_EXTS[ext] ? clean : null;
  };

  // Parse a file, resolve every specifier it names, and return the reachable
  // project modules (feeding discovery and the raw full-graph edges).
  const visit = async (file: string): Promise<string[]> => {
    const code = await host.readFile(file);
    typedOf.set(file, isTypedModule(file, code ?? ""));
    if (!code) {
      records.set(file, { imports: [], exports: [], dynamic: [], globs: [], nsUsage: [] });
      return [];
    }
    const source = file.endsWith(".vue") ? extractSfcScripts(code) : code;
    const record = parseModule(source, file);
    records.set(file, record);

    const specs = new Set<string>();
    for (const imp of record.imports) {
      specs.add(imp.source);
    }
    for (const exp of record.exports) {
      if ("source" in exp) {
        specs.add(exp.source);
      }
    }
    for (const spec of record.dynamic) {
      specs.add(spec);
    }

    const resolved = new Map<string, string | null>();
    const targets = new Set<string>();
    for (const spec of specs) {
      const clean = accept(await host.resolve(spec, file));
      resolved.set(spec, clean);
      if (clean) {
        targets.add(clean);
      }
    }
    resolvedOf.set(file, resolved);

    if (record.globs.length > 0) {
      const hits: string[] = [];
      for (const hit of await host.glob(record.globs, dirname(file))) {
        const clean = accept(hit);
        if (clean) {
          hits.push(clean);
          targets.add(clean);
        }
      }
      globHitsOf.set(file, hits);
    }

    return [...targets];
  };

  // Discover every project module reachable from a set of roots (BFS).
  const discover = async (roots: string[]): Promise<void> => {
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (directImports.has(file)) {
        continue;
      }
      const targets = await visit(file);
      directImports.set(file, targets);
      if (file.endsWith(".vue")) {
        vueNodes.add(file);
      }
      queue.push(...targets);
    }
  };
  await discover(entries);

  // Known blind spot (docs/maintainability-score.md "Limits"): Nuxt / `unplugin-*`
  // auto-imports bind components and composables with NO import statement, so
  // their edges are invisible to the crawl and blast radius reads falsely low.
  // Detect the generated manifests and surface them; recovering the edges
  // (manifest + template scan) is deliberately out of scope. A hit counts only
  // when the app it belongs to was actually crawled (some reachable file lives
  // beside it), so an unrelated monorepo sibling never triggers the banner.
  const manifestHits = await host.glob(
    ["**/.nuxt/components.d.ts", "**/components.d.ts", "**/auto-imports.d.ts"],
    host.root,
  );
  const crawled = [...directImports.keys()];
  const autoImportManifests = manifestHits
    .filter((hit) => {
      let dir = dirname(hit);
      if (dir.endsWith(`${sep}.nuxt`)) {
        dir = dirname(dir);
      }
      const prefix = dir + sep;
      return crawled.some((f) => f.startsWith(prefix));
    })
    .sort();

  // The manifests name their targets as `typeof import("…")` — modules that
  // are real, reachable code (via auto-import) yet invisible to the import
  // scan. Crawl them as nodes so they stop reading as dead/unreached; their
  // *importer* edges stay unrecoverable (the banner above still applies), so
  // they enter the graph with fan-in 0.
  const manifestTargets: string[] = [];
  for (const manifest of autoImportManifests) {
    const content = await host.readFile(manifest);
    if (!content) {
      continue;
    }
    for (const match of content.matchAll(/typeof import\(["']([^"']+)["']\)/g)) {
      const target = accept(await host.resolve(match[1]!, manifest));
      if (target && !directImports.has(target)) {
        manifestTargets.push(target);
      }
    }
  }
  await discover(manifestTargets);

  const isVue = (id: string): boolean => id.endsWith(".vue");
  const resolveSpec = (from: string, spec: string): string | null =>
    resolvedOf.get(from)?.get(spec) ?? null;
  const sources: EdgeSources = {
    records,
    resolveSpec,
    globHits: (from) => globHitsOf.get(from) ?? [],
  };

  // Component view: `.vue` nodes only, `.ts` locals are not definers — barrels
  // collapse to the components they surface. Module view: every reachable file
  // is a node and every locally-defined export a definer.
  const componentTerm: Terminality = { isComponent: isVue, localsAreDefiners: false };
  const moduleTerm: Terminality = { isComponent: isVue, localsAreDefiners: true };

  const componentEdges = toWireEdges(
    buildEdges(
      vueNodes,
      sources,
      makeResolver(records, resolveSpec, componentTerm),
      componentTerm,
      "component",
    ),
    "component",
  );

  const files: CrawlFile[] = [...directImports.keys()]
    .sort()
    .map((id) => ({ id, kind: id.endsWith(".vue") ? "vue" : "ts", typed: typedOf.get(id)! }));
  const moduleEdges = toWireEdges(
    buildEdges(
      files.map((f) => f.id),
      sources,
      makeResolver(records, resolveSpec, moduleTerm),
      moduleTerm,
      "module",
    ),
    "module",
  );

  return {
    nodes: [...vueNodes].sort(),
    componentEdges,
    files,
    moduleEdges,
    autoImportManifests,
  };
}
