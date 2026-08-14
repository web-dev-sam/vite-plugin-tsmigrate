import { dirname, extname, join, sep } from "node:path";
import type { ComponentEdge } from "../shared/types.ts";
import type { AnalysisHost } from "./host.ts";
import {
  extractSfcScripts,
  type ImportedName,
  type ImportRef,
  type ModuleRecord,
  parseModule,
} from "./imports.ts";

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

/** A reachable module and its kind, derived from the file extension. */
export interface CrawlFile {
  id: string;
  kind: "vue" | "ts";
}

/**
 * Result of a crawl. `nodes`/`edges` are the `.vue` component view with
 * barrel-collapsed edges (the existing semantics). `files`/`rawEdges` are the
 * full module view: every reachable file with its kind and the raw
 * importer→imported edges among them, uncollapsed.
 */
export interface CrawlResult {
  nodes: string[];
  edges: ComponentEdge[];
  files: CrawlFile[];
  rawEdges: ComponentEdge[];
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
    if (!code) {
      records.set(file, { imports: [], exports: [], dynamic: [], globs: [] });
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

  // Discover every reachable project module.
  const queue = [...entries];
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

  const isVue = (id: string): boolean => id.endsWith(".vue");
  const target = (from: string, spec: string): string | null =>
    resolvedOf.get(from)?.get(spec) ?? null;
  const bindingOf = (
    rec: ModuleRecord,
    local: string,
  ): { source: string; imported: ImportedName } | undefined => {
    for (const imp of rec.imports) {
      for (const b of imp.bindings) {
        if (b.local === local) {
          return { source: imp.source, imported: b.imported };
        }
      }
    }
    return undefined;
  };

  // Which components does an export — or a whole module namespace — surface,
  // following re-export chains? A `.vue` is a terminal component; a `.ts` local
  // export is a plain value (no component). Memoized + cycle-guarded.
  const exportMemo = new Map<string, Set<string>>();
  const moduleMemo = new Map<string, Set<string>>();

  function resolveExport(mod: string, name: string, seen: Set<string>): Set<string> {
    if (isVue(mod)) {
      return new Set([mod]);
    }
    const rec = records.get(mod);
    if (!rec) {
      return new Set();
    }
    const key = `${mod}\n${name}`;
    const cached = exportMemo.get(key);
    if (cached) {
      return cached;
    }
    if (seen.has(key)) {
      return new Set();
    }
    seen.add(key);
    const out = new Set<string>();
    let matched = false;
    for (const exp of rec.exports) {
      if (exp.kind === "reexport" && exp.exportName === name) {
        matched = true;
        const t = target(mod, exp.source);
        if (t) {
          for (const v of resolveExport(t, exp.importName, seen)) {
            out.add(v);
          }
        }
      } else if (exp.kind === "ns" && exp.exportName === name) {
        matched = true;
        const t = target(mod, exp.source);
        if (t) {
          for (const v of resolveModule(t, seen)) {
            out.add(v);
          }
        }
      } else if (exp.kind === "local" && exp.exportName === name) {
        matched = true;
        const binding = exp.local ? bindingOf(rec, exp.local) : undefined;
        if (binding) {
          for (const v of resolveBinding(mod, binding, seen)) {
            out.add(v);
          }
        }
        // else: a locally-defined value in a `.ts` — terminal, not a component.
      }
    }
    // `export * from "x"` forwards named (non-default) exports not matched above.
    if (!matched) {
      for (const exp of rec.exports) {
        if (exp.kind === "star") {
          const t = target(mod, exp.source);
          if (t) {
            for (const v of resolveExport(t, name, seen)) {
              out.add(v);
            }
          }
        }
      }
    }
    seen.delete(key);
    exportMemo.set(key, out);
    return out;
  }

  function resolveBinding(
    mod: string,
    binding: { source: string; imported: ImportedName },
    seen: Set<string>,
  ): Set<string> {
    const t = target(mod, binding.source);
    if (!t) {
      return new Set();
    }
    if (binding.imported.kind === "namespace") {
      return resolveModule(t, seen);
    }
    if (binding.imported.kind === "default") {
      return resolveExport(t, "default", seen);
    }
    return resolveExport(t, binding.imported.name, seen);
  }

  function resolveModule(mod: string, seen: Set<string>): Set<string> {
    if (isVue(mod)) {
      return new Set([mod]);
    }
    const rec = records.get(mod);
    if (!rec) {
      return new Set();
    }
    const cached = moduleMemo.get(mod);
    if (cached) {
      return cached;
    }
    const key = `*${mod}`;
    if (seen.has(key)) {
      return new Set();
    }
    seen.add(key);
    const out = new Set<string>();
    for (const exp of rec.exports) {
      if (exp.kind === "star") {
        const t = target(mod, exp.source);
        if (t) {
          for (const v of resolveModule(t, seen)) {
            out.add(v);
          }
        }
      } else {
        for (const v of resolveExport(mod, exp.exportName, seen)) {
          out.add(v);
        }
      }
    }
    seen.delete(key);
    moduleMemo.set(mod, out);
    return out;
  }

  // Component edges: for each `.vue`, follow its imports (and any re-exports,
  // dynamic imports and glob matches) to the components they resolve to.
  const edges: ComponentEdge[] = [];
  const seenEdges = new Set<string>();
  // An import statement is type-only when it has bindings and every one is a TS
  // type import; a side-effect import (no bindings) is a value dependency.
  const importIsTypeOnly = (imp: ImportRef): boolean =>
    imp.bindings.length > 0 && imp.bindings.every((b) => b.isType);
  // Accumulate per-target reachability into `acc` (true = type-only so far). A
  // value contribution is sticky: an edge is type-only only when every specifier
  // that reaches the target is a type import.
  const contribute = (
    acc: Map<string, boolean>,
    to: string | Iterable<string>,
    typeOnly: boolean,
  ): void => {
    for (const id of typeof to === "string" ? [to] : to) {
      acc.set(id, typeOnly && (acc.get(id) ?? true));
    }
  };
  const addEdge = (from: string, to: string, typeOnly: boolean): void => {
    if (to === from) {
      return;
    }
    const key = `${from}\n${to}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      edges.push(typeOnly ? { from, to, type: true } : { from, to });
    }
  };

  for (const from of vueNodes) {
    const rec = records.get(from);
    if (!rec) {
      continue;
    }
    const seen = new Set<string>();
    const out = new Map<string, boolean>();
    const wholeModule = (t: string | null, typeOnly: boolean): void => {
      if (!t) {
        return;
      }
      contribute(out, isVue(t) ? t : resolveModule(t, seen), typeOnly);
    };
    for (const imp of rec.imports) {
      const t = target(from, imp.source);
      if (!t) {
        continue;
      }
      if (isVue(t)) {
        // Importing anything from a component is a dependency on it.
        contribute(out, t, importIsTypeOnly(imp));
        continue;
      }
      for (const b of imp.bindings) {
        if (b.imported.kind === "namespace") {
          contribute(out, resolveModule(t, seen), b.isType);
        } else if (b.imported.kind === "default") {
          contribute(out, resolveExport(t, "default", seen), b.isType);
        } else {
          contribute(out, resolveExport(t, b.imported.name, seen), b.isType);
        }
      }
    }
    for (const exp of rec.exports) {
      if (exp.kind === "reexport") {
        const t = target(from, exp.source);
        if (t && isVue(t)) {
          contribute(out, t, exp.isType);
        } else if (t) {
          contribute(out, resolveExport(t, exp.importName, seen), exp.isType);
        }
      } else if (exp.kind === "ns" || exp.kind === "star") {
        wholeModule(target(from, exp.source), exp.isType);
      }
    }
    for (const spec of rec.dynamic) {
      wholeModule(target(from, spec), false);
    }
    for (const hit of globHitsOf.get(from) ?? []) {
      wholeModule(hit, false);
    }
    for (const [to, typeOnly] of out) {
      addEdge(from, to, typeOnly);
    }
  }

  // Full module view: every reachable file with its kind, plus the raw
  // importer→imported edges among them (no barrel collapsing).
  const files: CrawlFile[] = [];
  const rawEdges: ComponentEdge[] = [];
  for (const from of [...directImports.keys()].sort()) {
    files.push({ id: from, kind: from.endsWith(".vue") ? "vue" : "ts" });
    // Classify each raw importer→imported edge: type-only when every specifier
    // resolving to the target is a type import (dynamic/glob are runtime).
    const rec = records.get(from);
    const contrib = new Map<string, boolean>();
    if (rec) {
      for (const imp of rec.imports) {
        contribute(contrib, target(from, imp.source) ?? [], importIsTypeOnly(imp));
      }
      for (const exp of rec.exports) {
        if ("source" in exp) {
          contribute(contrib, target(from, exp.source) ?? [], exp.isType);
        }
      }
      for (const spec of rec.dynamic) {
        contribute(contrib, target(from, spec) ?? [], false);
      }
      contribute(contrib, globHitsOf.get(from) ?? [], false);
    }
    const seenRaw = new Set<string>();
    for (const to of directImports.get(from) ?? []) {
      if (to === from || seenRaw.has(to)) {
        continue;
      }
      seenRaw.add(to);
      rawEdges.push(contrib.get(to) === true ? { from, to, type: true } : { from, to });
    }
  }

  return { nodes: [...vueNodes].sort(), edges, files, rawEdges };
}
